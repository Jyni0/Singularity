/// Agent tools — the file and command operations the model can call.
///
/// Every tool takes a workspace root and refuses paths that escape it, so a
/// model cannot read `C:\Windows` or write outside the project it was given.
/// Commands run through the platform shell with a timeout and a captured exit
/// code, and their output is truncated before it goes back into the context.
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;
use std::time::Duration;

/// Largest file we will read into the model context.
const MAX_READ_BYTES: usize = 200_000;
/// Largest command output returned to the model.
const MAX_OUTPUT_BYTES: usize = 20_000;
/// Lines read_file returns when no end_line is given — a whole 5k-line
/// file used to land in the context (and be re-sent on every step).
const READ_DEFAULT_LINES: usize = 2_000;
/// Longer lines (minified bundles, data blobs) are cut in read_file.
const READ_MAX_LINE_CHARS: usize = 2_000;
/// How long a single command may run.
const COMMAND_TIMEOUT_SECS: u64 = 120;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub ok: bool,
    /// Text handed back to the model.
    pub output: String,
    /// File touched by a write/edit, for the UI's Changes panel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Content before the change (None when the file did not exist).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_text: Option<String>,
    /// Content after the change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_text: Option<String>,
    /// Picture the tool produced (generate_image) — a file the chat shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

/// Cap on the before/after snapshots attached to a result — the Changes panel
/// does not need multi-megabyte files, and they ride along in UI events.
const MAX_SNAPSHOT_BYTES: usize = 200_000;

fn clip(text: String) -> String {
    if text.len() <= MAX_SNAPSHOT_BYTES {
        text
    } else {
        text.chars().take(MAX_SNAPSHOT_BYTES).collect()
    }
}

impl ToolResult {
    pub fn ok(output: impl Into<String>) -> Self {
        Self {
            ok: true,
            output: output.into(),
            path: None,
            old_text: None,
            new_text: None,
            image: None,
        }
    }
    pub fn err(output: impl Into<String>) -> Self {
        Self {
            ok: false,
            output: output.into(),
            path: None,
            old_text: None,
            new_text: None,
            image: None,
        }
    }
    /// Attaches the before/after snapshot so the UI can render a diff.
    pub fn with_change(mut self, path: &str, old: Option<String>, new: String) -> Self {
        self.path = Some(path.to_string());
        self.old_text = old.map(clip);
        self.new_text = Some(clip(new));
        self
    }
}

/* ---------- Path resolution ---------- */

/// Resolves a path the model asked for.
///
/// Relative paths resolve against `root` (the workspace). Absolute paths are
/// accepted as-is, because a coding agent has to be able to work on any project
/// on disk — not only inside its own scratch folder. The workspace therefore
/// acts as the default location, not as a prison.
pub fn resolve(root: &Path, path: &str) -> Result<PathBuf, String> {
    let cleaned = normalize_path(path);
    if cleaned.is_empty() || cleaned == "." {
        return Ok(root.to_path_buf());
    }

    let candidate = Path::new(&cleaned);
    if candidate.is_absolute() {
        return Ok(candidate.to_path_buf());
    }

    // A relative path is joined onto the workspace root.
    Ok(root.join(candidate))
}

/// The user's home folder.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// `/c/Users/..` and `/mnt/c/Users/..` (Git Bash / WSL spellings).
static MSYS_DRIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/(?:mnt/)?([a-zA-Z])(/|$)").unwrap());

/// Repairs the path spellings models keep producing, so a path that exists
/// is not reported missing: quotes or backticks around it, `file://` URLs,
/// `~`, `$HOME` / `%USERPROFILE%`, and on Windows the Git Bash / WSL drive
/// form `/c/Users/..`.
pub fn normalize_path(path: &str) -> String {
    let mut p = path.trim();
    for q in ['"', '\'', '`'] {
        if p.len() >= 2 && p.starts_with(q) && p.ends_with(q) {
            p = p[1..p.len() - 1].trim();
        }
    }
    let mut p = p.to_string();
    if let Some(rest) = p.strip_prefix("file://") {
        p = rest.to_string();
        // file:///C:/x → C:/x
        if cfg!(windows) && p.len() > 2 && p.starts_with('/') && p.as_bytes()[2] == b':' {
            p.remove(0);
        }
    }
    for var in ["$HOME", "${HOME}", "%USERPROFILE%", "$env:USERPROFILE"] {
        if let Some(rest) = p.strip_prefix(var) {
            if let Some(home) = home_dir() {
                p = format!("{}{rest}", home.display());
            }
            break;
        }
    }
    if p == "~" || p.starts_with("~/") || p.starts_with("~\\") {
        if let Some(home) = home_dir() {
            p = format!("{}{}", home.display(), &p[1..]);
        }
    }
    if cfg!(windows) {
        if let Some(c) = MSYS_DRIVE.captures(&p) {
            let drive = c[1].to_uppercase();
            let rest = p[c[0].len()..].to_string();
            p = format!("{drive}:/{rest}");
        }
    }
    p
}

/// Error text for a path that does not exist, with the workspace's paths
/// whose file name matches — the model usually guessed the folder wrong,
/// and a list of real candidates ends the guessing loop.
pub fn not_found(root: &Path, path: &str) -> String {
    let full = resolve(root, path).unwrap_or_else(|_| root.join(path));
    let mut msg = format!("not found: {} (relative paths start at {})", full.display(), root.display());
    let name = Path::new(&normalize_path(path))
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name.is_empty() {
        return msg;
    }
    let files = workspace_files(root);
    // An absolute path inside the workspace compares as its relative part.
    let rel = full.strip_prefix(root).map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| normalize_path(path));
    let hits = similar_paths(&files, &rel);
    if hits.is_empty() {
        msg.push_str("\nNothing with that name exists under the workspace. Use find_files or list_dir to look around instead of guessing.");
    } else {
        msg.push_str("\nDid you mean one of these (relative to the workspace)?");
        for h in hits {
            msg.push_str("\n  ");
            msg.push_str(h);
        }
    }
    msg
}

/// Binary / asset extensions — never what a code path meant unless asked.
const ASSET_EXT: [&str; 12] = ["png", "jpg", "jpeg", "gif", "ico", "icns", "svg", "webp", "bmp", "woff", "woff2", "ttf"];

/// Workspace paths that look most like `wanted` (a path that does not
/// exist), best first: the same name, the same name before its first dot
/// (`App.c.tsx` → `App.tsx`), the same extension, the same folder. A loose
/// "name contains" match used to list every icon of the app for `App.c.tsx`.
fn similar_paths<'a>(files: &'a [String], wanted: &str) -> Vec<&'a String> {
    let wanted = wanted.trim_start_matches("./").replace('\\', "/").to_lowercase();
    let (dir, name) = match wanted.rsplit_once('/') {
        Some((d, n)) => (d.to_string(), n.to_string()),
        None => (String::new(), wanted.clone()),
    };
    let stem = name.split('.').next().unwrap_or(&name).to_string();
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_string()).unwrap_or_default();
    let dirs: Vec<&str> = dir.split('/').filter(|d| !d.is_empty()).collect();
    let mut scored: Vec<(i32, &String)> = files
        .iter()
        .filter_map(|f| {
            let is_dir = f.ends_with('/');
            let low = f.trim_end_matches('/').to_lowercase();
            let (fdir, fname) = low.rsplit_once('/').unwrap_or(("", low.as_str()));
            let fstem = fname.split('.').next().unwrap_or(fname);
            let fext = fname.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
            let mut score = if fname == name {
                100
            } else if fstem == stem {
                60
            } else if stem.len() >= 3 && fstem.contains(stem.as_str()) {
                20
            } else {
                return None;
            };
            if !ext.is_empty() && fext == ext {
                score += 25;
            }
            if fdir == dir {
                score += 30;
            } else {
                // Shared leading folders: src/features/… beats src-tauri/icons/….
                let fdirs: Vec<&str> = fdir.split('/').collect();
                score += 5 * dirs.iter().zip(&fdirs).take_while(|(a, b)| a == b).count() as i32;
            }
            if ASSET_EXT.contains(&fext) && !ASSET_EXT.contains(&ext.as_str()) {
                score -= 50;
            }
            if is_dir && !ext.is_empty() {
                score -= 30;
            }
            (score > 0).then_some((score, f))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.len().cmp(&b.1.len())));
    scored.into_iter().take(8).map(|(_, f)| f).collect()
}

fn is_missing(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::NotFound
}

/// Finds the ONE place `needle` occurs in `hay` and returns its byte range
/// plus the replacement to put there. Exact match first; when that finds
/// nothing, lines are compared with their indentation and trailing spaces
/// ignored (the model's usual copy error) and the replacement is
/// re-indented to the file's actual indentation. Err(n) = found n times.
pub fn locate(hay: &str, needle: &str, replace: &str) -> Result<(usize, usize, String), usize> {
    let exact = hay.matches(needle).count();
    if exact == 1 {
        let at = hay.find(needle).unwrap_or(0);
        return Ok((at, at + needle.len(), replace.to_string()));
    }
    if exact > 1 {
        return Err(exact);
    }
    let mut want: Vec<&str> = needle.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    while want.first().is_some_and(|l| l.trim().is_empty()) {
        want.remove(0);
    }
    while want.last().is_some_and(|l| l.trim().is_empty()) {
        want.pop();
    }
    if want.is_empty() {
        return Err(0);
    }
    let mut lines: Vec<(usize, &str)> = Vec::new();
    let mut off = 0usize;
    for raw in hay.split('\n') {
        lines.push((off, raw.strip_suffix('\r').unwrap_or(raw)));
        off += raw.len() + 1;
    }
    if lines.len() < want.len() {
        return Err(0);
    }
    let find = |same: &dyn Fn(&str, &str) -> bool| -> Vec<usize> {
        (0..=lines.len() - want.len())
            .filter(|&i| (0..want.len()).all(|j| same(lines[i + j].1, want[j])))
            .collect()
    };
    let mut hits = find(&|a, b| a.trim() == b.trim());
    if hits.is_empty() {
        // Spacing inside the lines differs too ("a=b" vs "a = b", tabs).
        let squash = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        hits = find(&|a, b| squash(a) == squash(b));
    }
    if hits.is_empty() {
        return locate_ignoring_blank_lines(&lines, &want, replace);
    }
    if hits.len() != 1 {
        return Err(hits.len());
    }
    let i = hits[0];
    let last = lines[i + want.len() - 1];
    let (start, end) = (lines[i].0, last.0 + last.1.len());
    let indent = |l: &str| l[..l.len() - l.trim_start().len()].to_string();
    let (have, real) = (indent(want[0]), indent(lines[i].1));
    let replace = if have == real {
        replace.to_string()
    } else {
        replace
            .split('\n')
            .map(|l| {
                if l.trim().is_empty() {
                    l.to_string()
                } else if let Some(rest) = l.strip_prefix(have.as_str()) {
                    format!("{real}{rest}")
                } else {
                    l.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok((start, end, replace))
}

/// Last lenient pass of `locate`: blank lines dropped on both sides (models
/// often lose or add one inside SEARCH), whitespace ignored. The match spans
/// from the first to the last matched line of the file.
fn locate_ignoring_blank_lines(lines: &[(usize, &str)], want: &[&str], replace: &str) -> Result<(usize, usize, String), usize> {
    let squash = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
    let want: Vec<String> = want.iter().map(|l| squash(l)).filter(|l| !l.is_empty()).collect();
    let body: Vec<(usize, String)> =
        lines.iter().enumerate().map(|(i, (_, l))| (i, squash(l))).filter(|(_, l)| !l.is_empty()).collect();
    if want.is_empty() || body.len() < want.len() {
        return Err(0);
    }
    let hits: Vec<usize> =
        (0..=body.len() - want.len()).filter(|&k| (0..want.len()).all(|j| body[k + j].1 == want[j])).collect();
    if hits.len() != 1 {
        return Err(hits.len());
    }
    let (first, last) = (body[hits[0]].0, body[hits[0] + want.len() - 1].0);
    let indent = |l: &str| l[..l.len() - l.trim_start().len()].to_string();
    let (have, real) = (indent(replace.lines().find(|l| !l.trim().is_empty()).unwrap_or("")), indent(lines[first].1));
    let replace = if have == real || have.is_empty() && replace.trim().is_empty() {
        replace.to_string()
    } else {
        replace
            .split('\n')
            .map(|l| match l.strip_prefix(have.as_str()) {
                Some(rest) if !l.trim().is_empty() => format!("{real}{rest}"),
                _ => l.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok((lines[first].0, lines[last].0 + lines[last].1.len(), replace))
}

/// Where a SEARCH that matched nowhere was probably aimed: the lines around
/// its most distinctive line (the longest one) that still exists in the
/// file, so the model sees the current text instead of guessing again.
fn anchor_excerpt(file: &str, needle: &str) -> Option<String> {
    let lines: Vec<&str> = file.lines().collect();
    let mut candidates: Vec<&str> = needle.lines().map(str::trim).filter(|l| l.len() >= 12).collect();
    candidates.sort_by_key(|l| std::cmp::Reverse(l.len()));
    let at = candidates.iter().find_map(|c| lines.iter().position(|l| l.trim() == *c || l.contains(c)))?;
    let from = at.saturating_sub(12);
    let to = (at + 13).min(lines.len());
    let body: String = (from..to).map(|n| format!("{:>5}  {}\n", n + 1, lines[n])).collect();
    Some(format!(" The lines around where it was aimed, as they are NOW ({}-{}):\n{body}", from + 1, to))
}

/// Brings SEARCH/REPLACE text to the file's line endings (a CRLF file never
/// matched the model's LF text).
fn match_endings(file: &str, text: &str) -> String {
    let lf = text.replace("\r\n", "\n");
    if file.contains("\r\n") {
        lf.replace('\n', "\r\n")
    } else {
        lf
    }
}

/* ---------- Filesystem tools ---------- */

/// Reads a file as UTF-8, with line numbers so the model can cite positions.
pub fn read_file(root: &Path, path: &str, start_line: Option<usize>, end_line: Option<usize>) -> ToolResult {
    let full = match resolve(root, path) {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    if full.is_dir() {
        return ToolResult::err(format!("{path} is a directory — use list_dir or find_files"));
    }
    let bytes = match std::fs::read(&full) {
        Ok(b) => b,
        Err(e) if is_missing(&e) => return ToolResult::err(not_found(root, path)),
        Err(e) => return ToolResult::err(format!("cannot read {path}: {e}")),
    };
    if bytes.len() > MAX_READ_BYTES {
        return ToolResult::err(format!(
            "{path} is {} bytes, which exceeds the {MAX_READ_BYTES}-byte read limit. Use grep to find the relevant part.",
            bytes.len()
        ));
    }
    // Legacy files (Windows-1251 and friends) are decoded instead of rejected:
    // a Russian-locale codebase often carries cp1251 sources, and refusing to
    // read them at all was the "не видит кириллицу" complaint for files.
    let text = match String::from_utf8(bytes) {
        Ok(t) => t,
        Err(e) => {
            let bytes = e.into_bytes();
            let (cow, _, had_errors) = encoding_rs::WINDOWS_1251.decode(&bytes);
            if had_errors {
                return ToolResult::err(format!("{path} is not valid UTF-8 text"));
            }
            cow.into_owned()
        }
    };

    let lines: Vec<&str> = text.lines().collect();
    let from = start_line.unwrap_or(1).max(1);
    let to = end_line
        .unwrap_or_else(|| from.saturating_add(READ_DEFAULT_LINES - 1))
        .min(lines.len());

    if from > lines.len() {
        return ToolResult::err(format!(
            "{path} has only {} lines, but line {from} was requested",
            lines.len()
        ));
    }

    let mut out = format!("{path} (lines {from}-{to} of {})\n", lines.len());
    for (i, line) in lines[from - 1..to].iter().enumerate() {
        match line.char_indices().nth(READ_MAX_LINE_CHARS) {
            Some((cut, _)) => out.push_str(&format!(
                "{:>5}  {} … [line cut, {} more chars]\n",
                from + i,
                &line[..cut],
                line[cut..].chars().count()
            )),
            None => out.push_str(&format!("{:>5}  {}\n", from + i, line)),
        }
    }
    if end_line.is_none() && to < lines.len() {
        out.push_str(&format!(
            "… {} more lines. Read on with start_line={} (or grep for what you need).\n",
            lines.len() - to,
            to + 1
        ));
    }
    ToolResult::ok(out)
}

/// Writes (or creates) a file, making parent directories as needed.
pub fn write_file(root: &Path, path: &str, content: &str) -> ToolResult {
    let full = match resolve(root, path) {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    if let Some(parent) = full.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return ToolResult::err(format!("cannot create directory for {path}: {e}"));
        }
    }
    // Snapshot the previous content (None for a brand-new file) so the UI can
    // show what exactly changed.
    let old = std::fs::read_to_string(&full).ok();
    let broken = crate::syntax::introduced(&full, old.as_deref(), content).unwrap_or_default();
    match std::fs::write(&full, content) {
        Ok(()) => {
            let summary = format!("wrote {path} ({} bytes, {} lines)", content.len(), content.lines().count());
            let res = if broken.is_empty() {
                ToolResult::ok(summary)
            } else {
                ToolResult::err(format!("{summary}\n\n{}", crate::syntax::report(path, content, &broken)))
            };
            res.with_change(path, old, content.to_string())
        }
        Err(e) => ToolResult::err(format!("cannot write {path}: {e}")),
    }
}

/// Replaces an exact string in a file — the usual way to edit code.
pub fn edit_file(root: &Path, path: &str, old: &str, new: &str) -> ToolResult {
    let full = match resolve(root, path) {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let text = match std::fs::read_to_string(&full) {
        Ok(t) => t,
        Err(e) if is_missing(&e) => return ToolResult::err(not_found(root, path)),
        Err(e) => return ToolResult::err(format!("cannot read {path}: {e}")),
    };

    let (old, new) = (match_endings(&text, old), match_endings(&text, new));
    let (start, end, new) = match locate(&text, &old, &new) {
        Ok(found) => found,
        Err(0) => {
            return ToolResult::err(format!(
                "the search text was not found in {path}. Read the file first and copy the exact text."
            ))
        }
        Err(count) => {
            return ToolResult::err(format!(
                "the search text appears {count} times in {path}; include more surrounding lines to make it unique."
            ))
        }
    };
    let updated = format!("{}{}{}", &text[..start], new, &text[end..]);
    let broken = crate::syntax::introduced(&full, Some(&text), &updated).unwrap_or_default();
    match std::fs::write(&full, &updated) {
        Ok(()) if broken.is_empty() => ToolResult::ok(format!("edited {path}")).with_change(path, Some(text), updated),
        Ok(()) => ToolResult::err(format!("edited {path}

{}", crate::syntax::report(path, &updated, &broken)))
            .with_change(path, Some(text), updated),
        Err(e) => ToolResult::err(format!("cannot write {path}: {e}")),
    }
}

/// Lists a directory, marking subdirectories with a trailing slash.
pub fn list_dir(root: &Path, path: &str) -> ToolResult {
    let dir = match resolve(root, path) {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    if !dir.exists() {
        return ToolResult::err(not_found(root, path));
    }
    if !dir.is_dir() {
        return ToolResult::err(format!("{} is a file, not a directory — use read_file", dir.display()));
    }
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) => return ToolResult::err(format!("cannot list {}: {e}", dir.display())),
    };

    let mut names: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip noise that only clutters the listing.
        if name == ".git" || name == "node_modules" || name == "target" || name == ".DS_Store" {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        names.push(if is_dir { format!("{name}/") } else { name });
    }
    names.sort();

    // Report the real path so the model always knows where it actually is.
    let shown = dir.display().to_string();
    if names.is_empty() {
        return ToolResult::ok(format!("{shown} is empty"));
    }
    ToolResult::ok(format!("{shown}:\n{}", names.join("\n")))
}

/// Folders never offered by the @-mention picker (build output, deps, VCS).
const INDEX_SKIP: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit",
    ".venv", "venv", "__pycache__", ".cache", ".turbo", "coverage", ".gradle", ".idea", ".DS_Store",
];
/// Entries returned by `workspace_files` at most.
const INDEX_MAX: usize = 20_000;

/// Every file and folder under `root`, relative with `/` separators; folders
/// end with `/`. Breadth-first, so a huge tree still yields its top levels.
pub fn workspace_files(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut queue = std::collections::VecDeque::from([root.to_path_buf()]);
    while let Some(dir) = queue.pop_front() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            if out.len() >= INDEX_MAX {
                return out;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if INDEX_SKIP.contains(&name.as_str()) {
                continue;
            }
            let path = e.path();
            let Ok(rel) = path.strip_prefix(root) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                out.push(format!("{rel}/"));
                queue.push_back(path);
            } else {
                out.push(rel);
            }
        }
    }
    out
}

/// Recursive text search across the workspace.
pub fn grep(root: &Path, pattern: &str, subdir: Option<&str>) -> ToolResult {
    let base = match subdir {
        Some(s) if !s.is_empty() => match resolve(root, s) {
            Ok(p) => p,
            Err(e) => return ToolResult::err(e),
        },
        _ => root.to_path_buf(),
    };

    // A literal substring search keeps this dependency-free and predictable.
    let needle = pattern.to_string();
    let mut hits: Vec<String> = Vec::new();
    let mut scanned = 0usize;

    fn walk(dir: &Path, needle: &str, hits: &mut Vec<String>, scanned: &mut usize) {
        if hits.len() >= 200 || *scanned > 5000 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name == ".git" || name == "node_modules" || name == "target" || name == "dist" {
                continue;
            }
            if path.is_dir() {
                walk(&path, needle, hits, scanned);
                continue;
            }
            // Only look at text-ish files, and skip anything large.
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > 400_000 {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            *scanned += 1;
            for (i, line) in text.lines().enumerate() {
                if line.contains(needle) {
                    hits.push(format!("{}:{}: {}", path.display(), i + 1, line.trim()));
                    if hits.len() >= 200 {
                        return;
                    }
                }
            }
        }
    }

    walk(&base, &needle, &mut hits, &mut scanned);

    if hits.is_empty() {
        return ToolResult::ok(format!("no matches for {pattern:?}"));
    }
    ToolResult::ok(hits.join("\n"))
}

/* ---------- Patch application (diff-only edits) ---------- */

/// Parses SEARCH/REPLACE hunks out of a diff body. The expected shape is:
///
/// ```text
/// <<<<<<< SEARCH
/// exact existing code
/// =======
/// replacement code
/// >>>>>>> REPLACE
/// ```
///
/// Several hunks may follow each other in one diff. An empty SEARCH side
/// means "create the file with the REPLACE content" (new-file hunk).
///
/// Models get the markers slightly wrong all the time (6 or 8 angle
/// brackets, lowercase, a missing final `>>>>>>> REPLACE`, code fences
/// around the code), and some send a unified diff instead — all of that is
/// accepted rather than failing with "no blocks found" in a loop.
pub fn parse_patch(diff: &str) -> Vec<(String, String)> {
    static OPEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^<{5,9}\s*(SEARCH|ORIGINAL|FIND)\b").unwrap());
    static MID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^={5,9}\s*$").unwrap());
    static CLOSE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^>{5,9}\s*(REPLACE|UPDATED)\b").unwrap());
    // A diff JSON-escaped twice arrives as ONE line with literal "\n"s —
    // no marker was ever on its own line ("no SEARCH/REPLACE blocks found").
    let unescaped;
    let diff = if !diff.contains('\n') && diff.contains("\\n") {
        unescaped = diff.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\t", "\t").replace("\\\"", "\"");
        unescaped.as_str()
    } else {
        diff
    };
    let mut hunks: Vec<(String, String)> = Vec::new();
    let mut search: Option<Vec<String>> = None;
    let mut replace: Option<Vec<String>> = None;
    let push = |hunks: &mut Vec<(String, String)>, s: Vec<String>, r: Vec<String>| {
        let (s, r) = (unfence(&s), unfence(&r));
        // SEARCH copied from read_file output WITH its line numbers.
        let s_numbered = has_line_numbers(&s);
        let r_numbered = s_numbered && has_line_numbers(&r);
        let s = if s_numbered { strip_line_numbers(&s) } else { s };
        let r = if r_numbered { strip_line_numbers(&r) } else { r };
        hunks.push((s.join("\n"), r.join("\n")));
    };
    for line in diff.lines() {
        let t = line.trim();
        if OPEN.is_match(t) {
            // A new block while one is still open closes the previous one.
            if let (Some(s), Some(r)) = (search.take(), replace.take()) {
                push(&mut hunks, s, r);
            }
            search = Some(Vec::new());
            replace = None;
            continue;
        }
        if MID.is_match(t) && search.is_some() && replace.is_none() {
            replace = Some(Vec::new());
            continue;
        }
        if CLOSE.is_match(t) {
            if let (Some(s), Some(r)) = (search.take(), replace.take()) {
                push(&mut hunks, s, r);
            }
            continue;
        }
        if let Some(r) = replace.as_mut() {
            r.push(line.to_string());
        } else if let Some(s) = search.as_mut() {
            s.push(line.to_string());
        }
    }
    // The last block without its closing marker.
    if let (Some(s), Some(r)) = (search, replace) {
        let mut r = r;
        while r.last().is_some_and(|l| l.trim().starts_with("```") || l.trim().is_empty()) {
            r.pop();
        }
        push(&mut hunks, s, r);
    }
    if hunks.is_empty() {
        hunks = parse_unified(diff);
    }
    hunks
}

/// read_file's line prefix: the number right-aligned in 5 columns + 2 spaces.
static LINE_NO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s{0,6}\d{1,6}(  |\t)").unwrap());

/// Every non-blank line starts with a read_file line number.
fn has_line_numbers(lines: &[String]) -> bool {
    let mut any = false;
    for l in lines.iter().filter(|l| !l.trim().is_empty()) {
        if !LINE_NO.is_match(l) {
            return false;
        }
        any = true;
    }
    any
}

fn strip_line_numbers(lines: &[String]) -> Vec<String> {
    lines.iter().map(|l| LINE_NO.replace(l, "").into_owned()).collect()
}

/// Drops a code fence the model wrapped around one side of a block.
fn unfence(lines: &[String]) -> Vec<String> {
    let mut v: Vec<String> = lines.to_vec();
    if v.first().is_some_and(|l| l.trim_start().starts_with("```")) {
        v.remove(0);
        if v.last().is_some_and(|l| l.trim() == "```") {
            v.pop();
        }
    }
    v
}

/// A unified diff (`@@ … @@` hunks with ` `/`-`/`+` lines) as SEARCH/REPLACE
/// pairs: context + removed lines are what to find, context + added lines
/// what to put there. Line numbers in the headers are ignored.
fn parse_unified(diff: &str) -> Vec<(String, String)> {
    let mut hunks = Vec::new();
    let (mut old, mut new): (Vec<&str>, Vec<&str>) = (Vec::new(), Vec::new());
    let mut inside = false;
    // `*** Add File:` (Codex's apply_patch format): the whole body is new.
    let mut adding = false;
    let mut flush = |old: &mut Vec<&str>, new: &mut Vec<&str>, adding: bool| {
        let fresh = adding && old.is_empty() && !new.is_empty();
        if fresh || (old.iter().any(|l| !l.trim().is_empty()) && old != new) {
            hunks.push((old.join("\n"), new.join("\n")));
        }
        old.clear();
        new.clear();
    };
    for line in diff.lines() {
        // Codex's format: `*** Update File: p` opens hunks that may come
        // without any `@@` line; `*** Begin/End Patch` only frame them.
        if line.starts_with("*** Update File:") || line.starts_with("*** Add File:") {
            flush(&mut old, &mut new, adding);
            inside = true;
            adding = line.starts_with("*** Add File:");
            continue;
        }
        if line.starts_with("@@") {
            flush(&mut old, &mut new, adding);
            inside = true;
            continue;
        }
        if line.starts_with("---") || line.starts_with("+++") || line.starts_with("diff ") || line.starts_with("index ") {
            flush(&mut old, &mut new, adding);
            inside = false;
            continue;
        }
        if !inside {
            continue;
        }
        if let Some(rest) = line.strip_prefix('-') {
            old.push(rest);
        } else if let Some(rest) = line.strip_prefix('+') {
            new.push(rest);
        } else if let Some(rest) = line.strip_prefix(' ') {
            old.push(rest);
            new.push(rest);
        } else if line.is_empty() {
            old.push("");
            new.push("");
        } else if line.starts_with('\\') {
            // "\ No newline at end of file"
        } else {
            flush(&mut old, &mut new, adding);
            inside = false;
        }
    }
    flush(&mut old, &mut new, adding);
    hunks
}

/// Character-bigram similarity (Dice) of two texts, whitespace-insensitive.
fn similarity(a: &str, b: &str) -> f64 {
    let norm = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let (a, b) = (norm(a), norm(b));
    if a == b {
        return 1.0;
    }
    let grams = |s: &str| {
        let c: Vec<char> = s.chars().collect();
        let mut m: std::collections::HashMap<(char, char), usize> = std::collections::HashMap::new();
        for w in c.windows(2) {
            *m.entry((w[0], w[1])).or_default() += 1;
        }
        (m, c.len().saturating_sub(1))
    };
    let ((ga, na), (gb, nb)) = (grams(&a), grams(&b));
    if na + nb == 0 {
        return 0.0;
    }
    let common: usize = ga.iter().map(|(k, n)| (*n).min(*gb.get(k).unwrap_or(&0))).sum();
    2.0 * common as f64 / (na + nb) as f64
}

/// The region of `hay` most similar to `needle`, as (first line index,
/// line count, score, best score of a DIFFERENT region). A window always
/// holds exactly as many non-blank lines as the needle — a window one line
/// longer used to swallow the next line (a closing tag) when replaced.
fn closest_region(hay: &str, needle: &str) -> Option<(usize, usize, f64, f64)> {
    let lines: Vec<&str> = hay.lines().collect();
    let want: Vec<&str> = needle.lines().filter(|l| !l.trim().is_empty()).collect();
    if want.is_empty() || lines.is_empty() || lines.len() > 20_000 {
        return None;
    }
    let target = want.join("\n");
    let first = want[0].trim();
    let mut scored: Vec<(usize, usize, f64)> = Vec::new();
    for i in 0..lines.len() {
        if lines[i].trim().is_empty() {
            continue;
        }
        // Cheap prefilter: the window must start near the needle's first line.
        if want.len() > 2 && similarity(lines[i], first) < 0.5 {
            continue;
        }
        let mut j = i;
        let mut window: Vec<&str> = Vec::with_capacity(want.len());
        while j < lines.len() && window.len() < want.len() {
            if !lines[j].trim().is_empty() {
                window.push(lines[j]);
            }
            j += 1;
        }
        if window.len() < want.len() {
            break;
        }
        scored.push((i, j - i, similarity(&window.join("\n"), &target)));
    }
    let best = scored.iter().copied().max_by(|a, b| a.2.total_cmp(&b.2))?;
    // Runner-up that does not overlap the best window.
    let second = scored
        .iter()
        .filter(|c| c.0 + c.1 <= best.0 || c.0 >= best.0 + best.1)
        .map(|c| c.2)
        .fold(0.0f64, f64::max);
    Some((best.0, best.1, best.2, second))
}

/// Similarity above which a unique closest region is patched directly.
const FUZZY_APPLY: f64 = 0.9;

/// Applies a SEARCH/REPLACE diff to one file — the diff-only edit path.
///
/// Rules mirror `edit_file`: every SEARCH side must match the current file
/// content EXACTLY ONCE (hunks apply sequentially, so later hunks see the
/// result of earlier ones). A single hunk with an empty SEARCH creates the
/// file. Failures are reported per hunk with its index so the model can fix
/// exactly the broken block and retry.
pub fn apply_patch(root: &Path, path: &str, diff: &str, create: bool) -> ToolResult {
    let full = match resolve(root, path) {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let hunks = parse_patch(diff);
    if hunks.is_empty() {
        return ToolResult::err(
            "no SEARCH/REPLACE blocks found in the diff. Put each change in `diff` exactly like this (markers on their own lines):\n\
             <<<<<<< SEARCH\n<exact existing lines>\n=======\n<new lines>\n>>>>>>> REPLACE\n\
             To replace the whole file use write_file instead.",
        );
    }

    let text = std::fs::read_to_string(&full).ok();
    let original = text.clone();

    // New file: absent + create:true + exactly one hunk with an empty
    // SEARCH. Without the explicit flag a mistyped / invented path used to
    // be "edited" into existence as a stray new file.
    if text.is_none() {
        let create_only = hunks.len() == 1 && hunks[0].0.trim().is_empty();
        if !create || !create_only {
            return ToolResult::err(format!(
                "{}\nThis file does not exist, so there is nothing to edit — find the real path first. \
                 Only if you really mean to create a NEW file: set create:true and send ONE hunk with an empty SEARCH side.",
                not_found(root, path)
            ));
        }
        // A same-named file elsewhere + a folder that does not exist yet is
        // almost always a wrong guess at an existing file's path.
        let parent_missing = full.parent().is_some_and(|p| !p.exists());
        let hint = not_found(root, path);
        if parent_missing && hint.contains("Did you mean") {
            return ToolResult::err(format!(
                "refusing to create {path}: its folder does not exist and a file with the same name is already in the workspace.\n{hint}\n\
                 Edit the existing file instead, or create the folder first with file_op mkdir if a new file is really intended."
            ));
        }
        if let Some(parent) = full.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return ToolResult::err(format!("cannot create directory for {path}: {e}"));
            }
        }
        let content = format!("{}\n", hunks[0].1);
        let broken = crate::syntax::introduced(&full, None, &content).unwrap_or_default();
        return match std::fs::write(&full, &content) {
            Ok(()) if broken.is_empty() => ToolResult::ok(format!("created {path} ({} bytes)", content.len()))
                .with_change(path, None, content),
            Ok(()) => ToolResult::err(format!(
                "created {path} ({} bytes)\n\n{}",
                content.len(),
                crate::syntax::report(path, &content, &broken)
            ))
            .with_change(path, None, content),
            Err(e) => ToolResult::err(format!("cannot write {path}: {e}")),
        };
    }

    if hunks.iter().any(|(s, _)| s.trim().is_empty()) {
        return ToolResult::err(format!(
            "{path} already exists — an empty SEARCH side is only for new files. Read the file and put the exact lines to change in SEARCH."
        ));
    }
    let mut current = text.unwrap_or_default();
    let mut applied = 0usize;
    let mut errors: Vec<String> = Vec::new();
    let mut fuzzy: Vec<String> = Vec::new();
    for (i, (search, replace)) in hunks.iter().enumerate() {
        let (needle, replace) = (match_endings(&current, search), match_endings(&current, replace));
        match locate(&current, &needle, &replace) {
            Ok((start, end, replace)) => {
                current = format!("{}{}{}", &current[..start], replace, &current[end..]);
                applied += 1;
            }
            Err(0) => match closest_region(&current, &needle) {
                // Nearly identical and clearly the only candidate: the model
                // mistyped a character or two — apply to the real lines.
                Some((at, len, score, second)) if score >= FUZZY_APPLY && second < score - 0.1 => {
                    let eol = if current.contains("\r\n") { "\r\n" } else { "\n" };
                    let mut lines: Vec<&str> = current.split(eol).collect();
                    let tail_nl = current.ends_with(eol);
                    if tail_nl {
                        lines.pop();
                    }
                    let mut out: Vec<String> = lines[..at].iter().map(|l| l.to_string()).collect();
                    out.extend(replace.split(eol).map(|l| l.trim_end_matches('\r').to_string()));
                    out.extend(lines[at + len..].iter().map(|l| l.to_string()));
                    current = out.join(eol);
                    if tail_nl {
                        current.push_str(eol);
                    }
                    applied += 1;
                    fuzzy.push(format!("hunk {i}: SEARCH did not match exactly — applied to the closest lines {}-{} ({:.0}% similar); read them back to check", at + 1, at + len, score * 100.0));
                }
                Some((at, len, score, _)) if score >= 0.5 => {
                    let lines: Vec<&str> = current.lines().collect();
                    let from = at.saturating_sub(6);
                    let to = (at + len + 6).min(lines.len());
                    let snippet: String = (from..to).map(|n| format!("{:>5}  {}\n", n + 1, lines[n])).collect();
                    errors.push(format!(
                        "hunk {i}: SEARCH text not found in {path}. The closest part of the file ({:.0}% similar) is lines {}-{} — copy SEARCH from it EXACTLY (without the line numbers):\n{snippet}",
                        score * 100.0,
                        at + 1,
                        at + len
                    ));
                }
                _ => {
                    // Usually SEARCH came from an older version of the file
                    // (an earlier edit changed it). Show what is there now.
                    let lines: Vec<&str> = current.lines().collect();
                    let now = if lines.len() <= 150 {
                        let body: String = lines.iter().enumerate().map(|(n, l)| format!("{:>5}  {l}\n", n + 1)).collect();
                        format!(" The file as it is NOW ({} lines):\n{body}", lines.len())
                    } else if let Some(excerpt) = anchor_excerpt(&current, &needle) {
                        excerpt
                    } else {
                        format!(" It has {} lines now — read_file the part you mean (its content may have changed since you read it).", lines.len())
                    };
                    errors.push(format!(
                        "hunk {i}: SEARCH text not found in {path} and nothing similar exists — copy SEARCH exactly from the current file, or use write_file to rewrite the whole file.{now}"
                    ))
                }
            },
            Err(count) => errors.push(format!(
                "hunk {i}: SEARCH text appears {count} times in {path} — add surrounding lines to make it unique"
            )),
        }
    }

    // Syntax check (tree-sitter): what did this edit break?
    let broken = crate::syntax::introduced(&full, original.as_deref(), &current).unwrap_or_default();
    if !broken.is_empty() && !fuzzy.is_empty() {
        // A guessed (non-exact) placement that breaks the syntax is almost
        // certainly the wrong place — keep the file as it was.
        return ToolResult::err(format!(
            "{}\nNothing was changed: SEARCH did not match exactly, and applying it to the closest lines broke the syntax. \
             read_file the region and send SEARCH copied exactly.",
            crate::syntax::report(path, &current, &broken)
        ));
    }
    if applied == 0 {
        return ToolResult::err(format!(
            "{}\nNothing was changed. Do not resend the same diff: fix SEARCH from the lines above, \
             or rewrite the whole file with write_file if most of it changes.",
            errors.join("\n")
        ));
    }
    match std::fs::write(&full, &current) {
        Ok(()) => {
            let mut out = format!("patched {path}: {applied}/{} hunks applied", hunks.len());
            if !fuzzy.is_empty() {
                out.push('\n');
                out.push_str(&fuzzy.join("\n"));
            }
            if !errors.is_empty() {
                out.push_str("\nFAILED:\n");
                out.push_str(&errors.join("\n"));
            }
            if !broken.is_empty() {
                out.push_str("\n\n");
                out.push_str(&crate::syntax::report(path, &current, &broken));
            }
            let res = if errors.is_empty() && broken.is_empty() {
                ToolResult::ok(out)
            } else {
                // Partially applied — report as an error so the model reacts,
                // but the successful hunks are already on disk.
                ToolResult::err(out)
            };
            res.with_change(path, original, current)
        }
        Err(e) => ToolResult::err(format!("cannot write {path}: {e}")),
    }
}

/* ---------- Shell ---------- */

/// The shells a command can run in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shell {
    /// Git Bash on Windows, bash (or sh) elsewhere.
    Bash,
    /// Windows PowerShell 5.1.
    PowerShell,
    Cmd,
}

impl Shell {
    pub fn name(self) -> &'static str {
        match self {
            Shell::Bash => "bash",
            Shell::PowerShell => "powershell",
            Shell::Cmd => "cmd",
        }
    }

    fn parse(s: &str) -> Option<Shell> {
        match s.trim().to_lowercase().as_str() {
            "bash" | "sh" | "zsh" | "git-bash" | "gitbash" => Some(Shell::Bash),
            "powershell" | "pwsh" | "ps" | "ps1" => Some(Shell::PowerShell),
            "cmd" | "cmd.exe" | "batch" => Some(Shell::Cmd),
            _ => None,
        }
    }
}

/// Git for Windows' bash.exe, looked up once: the usual install folders,
/// then next to a git.exe on PATH. (NOT System32\bash.exe — that is WSL.)
#[cfg(windows)]
pub fn git_bash() -> Option<PathBuf> {
    use std::sync::OnceLock;
    static FOUND: OnceLock<Option<PathBuf>> = OnceLock::new();
    FOUND
        .get_or_init(|| {
            let mut candidates = Vec::new();
            for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)", "LOCALAPPDATA"] {
                if let Some(base) = std::env::var_os(var).map(PathBuf::from) {
                    candidates.push(base.join("Git").join("bin").join("bash.exe"));
                    candidates.push(base.join("Programs").join("Git").join("bin").join("bash.exe"));
                }
            }
            if let Some(path) = std::env::var_os("PATH") {
                for dir in std::env::split_paths(&path) {
                    if dir.join("git.exe").is_file() {
                        // <git>/cmd/git.exe or <git>/mingw64/bin/git.exe
                        for up in dir.ancestors().skip(1).take(2) {
                            candidates.push(up.join("bin").join("bash.exe"));
                        }
                    }
                }
            }
            candidates.into_iter().find(|p| p.is_file())
        })
        .clone()
}

/// Where a command runs when the model does not pick a shell. Models write
/// bash far more reliably than anything else, so bash wins wherever it
/// exists; plain Windows falls back to PowerShell, whose aliases (ls, cat,
/// rm, cp, mv, pwd) forgive much more than cmd.
pub fn default_shell() -> Shell {
    #[cfg(windows)]
    {
        if git_bash().is_some() {
            Shell::Bash
        } else {
            Shell::PowerShell
        }
    }
    #[cfg(not(windows))]
    {
        Shell::Bash
    }
}

/// One paragraph for the prompt: OS and shell facts the model must know
/// before writing its first command.
pub fn shell_summary() -> String {
    #[cfg(windows)]
    {
        if git_bash().is_some() {
            "OS: Windows. run_command uses Git Bash by default: write bash (ls, cat, grep, rm -rf, &&, $VAR). \
             Paths: C:/Users/me/x or /c/Users/me/x (never unquoted backslashes). \
             Windows programs (npm, python, cargo, git, dotnet) work as usual. \
             Pass shell:\"powershell\" or shell:\"cmd\" only for Windows-specific commands."
                .into()
        } else {
            "OS: Windows, no bash installed. run_command uses Windows PowerShell 5.1 by default: \
             write PowerShell (Get-ChildItem, Remove-Item -Recurse -Force, New-Item -ItemType Directory, \
             $env:NAME = 'x', `;` between commands — `&&` is not supported). \
             Unix tools (grep, sed, awk, touch, which, head) do NOT exist; use the built-in tools instead. \
             shell:\"cmd\" is also available."
                .into()
        }
    }
    #[cfg(not(windows))]
    {
        format!("OS: {}. run_command uses bash.", std::env::consts::OS)
    }
}

/// Environment for every agent command: no pagers, no prompts, no colour
/// codes, UTF-8 Python — the classic ways a command hangs or garbles.
fn quiet_env(c: &mut Command) {
    for (k, v) in [
        ("GIT_PAGER", "cat"),
        ("PAGER", "cat"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_EDITOR", "true"),
        ("NO_COLOR", "1"),
        ("FORCE_COLOR", "0"),
        ("TERM", "dumb"),
        ("npm_config_yes", "true"),
        ("npm_config_fund", "false"),
        ("npm_config_audit", "false"),
        ("PIP_NO_INPUT", "1"),
        ("PYTHONIOENCODING", "utf-8"),
        ("PYTHONUTF8", "1"),
        ("PYTHONUNBUFFERED", "1"),
        ("DEBIAN_FRONTEND", "noninteractive"),
    ] {
        c.env(k, v);
    }
    // cmd ignores a PATH longer than 8191 chars — it then cannot find even
    // ping or chcp. System folders first, duplicates and missing folders
    // dropped, the rest kept while it fits.
    #[cfg(windows)]
    if let Some(path) = std::env::var_os("PATH") {
        let sys = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()));
        let first = [
            sys.join("System32"),
            sys.clone(),
            sys.join("System32").join("Wbem"),
            sys.join("System32").join("WindowsPowerShell").join("v1.0"),
        ];
        let mut seen = std::collections::HashSet::new();
        let mut len = 0usize;
        let dirs: Vec<PathBuf> = first
            .into_iter()
            .chain(std::env::split_paths(&path))
            .filter(|d| {
                let key = d.to_string_lossy().to_lowercase().trim_end_matches(['\\', '/']).to_string();
                // `cargo run` / `tauri dev` prepend hundreds of native build
                // folders (target\debug\build\…) that pushed node, git and
                // python past the limit — "'npm' is not recognized".
                let cargo_build = key.contains(r"\target\debug\build\") || key.contains(r"\target\release\build\");
                let keep = !cargo_build && d.is_dir() && len + key.len() < 8000 && seen.insert(key.clone());
                if keep {
                    len += key.len() + 1;
                }
                keep
            })
            .collect();
        if let Ok(joined) = std::env::join_paths(dirs) {
            c.env("PATH", joined);
        }
    }
    c.stdin(std::process::Stdio::null());
}

/// `a && b` for Windows PowerShell 5.1, which has no `&&`: `a; if ($?) { b }`.
/// Only for commands without quotes — inside a string `&&` is text.
#[cfg(any(windows, test))]
fn ps_and_chain(command: &str) -> String {
    if !command.contains("&&") || command.contains(['"', '\'']) {
        return command.to_string();
    }
    let parts: Vec<&str> = command.split("&&").map(str::trim).collect();
    let mut out = parts[0].to_string();
    for part in &parts[1..] {
        out.push_str("; if ($?) { ");
        out.push_str(part);
    }
    out.push_str(&" }".repeat(parts.len() - 1));
    out
}

/// The OS process for `command` in `shell`.
fn shell_process(shell: Shell, command: &str) -> Command {
    #[cfg(windows)]
    {
        use base64::Engine;
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW keeps a console window from flashing on every call.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let bash = if shell == Shell::Bash { git_bash() } else { None };
        let mut c = match (shell, bash) {
            (Shell::Bash, Some(bash)) => {
                let mut c = Command::new(bash);
                // chcp: native Windows programs then print UTF-8, not cp866.
                c.args(["-c", &format!("chcp.com 65001 >/dev/null 2>&1; {command}")]);
                c
            }
            (Shell::Cmd, _) => {
                let mut c = Command::new("cmd");
                c.args(["/C", &format!("chcp 65001>nul & {command}")]);
                c
            }
            // PowerShell — also the stand-in when bash was asked for but is
            // not installed. -EncodedCommand sidesteps every quoting rule.
            _ => {
                let script = format!(
                    "[Console]::OutputEncoding=[Text.Encoding]::UTF8\n$OutputEncoding=[Text.Encoding]::UTF8\n\
                     $ProgressPreference='SilentlyContinue'\n{}\n\
                     if (-not $?) {{ if ($LASTEXITCODE) {{ exit $LASTEXITCODE }} else {{ exit 1 }} }}\nexit 0",
                    ps_and_chain(command)
                );
                let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
                let mut c = Command::new("powershell");
                c.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"])
                    .arg(base64::engine::general_purpose::STANDARD.encode(utf16));
                c
            }
        };
        c.creation_flags(CREATE_NO_WINDOW);
        c
    }
    #[cfg(not(windows))]
    {
        let sh = match shell {
            Shell::Bash if Path::new("/bin/bash").exists() => "/bin/bash",
            _ => "/bin/sh",
        };
        let mut c = Command::new(sh);
        c.args(["-c", command]);
        c
    }
}

static ANSI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\r(?:[^\n])").unwrap());

/// Drops colour codes and progress-bar carriage returns.
fn strip_ansi(text: &str) -> String {
    ANSI.replace_all(text, |c: &regex::Captures| {
        let m = c.get(0).map(|m| m.as_str()).unwrap_or("");
        // "\rX" (progress redraw) → keep X on a fresh line.
        if let Some(rest) = m.strip_prefix('\r') {
            format!("\n{rest}")
        } else {
            String::new()
        }
    })
    .into_owned()
}

/// Commands that exist in bash but not in cmd / PowerShell 5.1.
const UNIX_ONLY: &[&str] = &[
    "grep", "sed", "awk", "touch", "which", "head", "tail", "export", "chmod", "wc", "xargs", "find",
    "rm", "cp", "mv", "ls", "cat", "source", "unzip", "tar", "less",
];

/// A one-line next step for the classic failures, so the model changes
/// approach instead of retrying the same broken command.
/// A command that quit on an interactive question it could not ask
/// (commands get no input) — the hint says how to answer it up front.
fn cancelled_prompt(text: &str) -> Option<String> {
    let low = text.to_lowercase();
    let cancelled = ["operation cancelled", "operation canceled", "aborted by user", "prompt was cancelled", "user force closed the prompt"]
        .iter()
        .any(|m| low.contains(m));
    if !cancelled {
        return None;
    }
    let mut hint = String::from(
        "NOT DONE: the command stopped at an interactive question — commands get no input, so it was cancelled. \
         Answer it with flags instead (--yes / -y / --force / --template …).",
    );
    if low.contains("create-vite") || low.contains("create vite") {
        hint.push_str(
            " create-vite cancels in a non-empty folder: scaffold into a new empty folder \
             (npm create vite@latest my-app -- --template react-ts) or pass --overwrite to empty this one.",
        );
    }
    Some(hint)
}

fn failure_hint(shell: Shell, command: &str, code: i32, text: &str) -> Option<String> {
    let low = text.to_lowercase();
    let first = command
        .split(|c: char| c.is_whitespace() || c == ';' || c == '&' || c == '|')
        .find(|w| !w.is_empty())
        .unwrap_or("")
        .trim_matches(['"', '\''])
        .to_string();
    let not_found = (shell == Shell::Bash && code == 127)
        || low.contains("command not found")
        || low.contains("is not recognized as")
        || low.contains("не является внутренней или внешней")
        || low.contains("не распознано как имя");
    if not_found {
        if shell != Shell::Bash && UNIX_ONLY.contains(&first.as_str()) {
            let bash = if default_shell() == Shell::Bash {
                "pass shell:\"bash\" to run it in Git Bash, or "
            } else {
                ""
            };
            return Some(format!(
                "hint: `{first}` is a Unix command and this ran in {}. Either {bash}use the built-in tools \
                 (list_dir, read_file, find_files, grep, file_op) instead.",
                shell.name()
            ));
        }
        let check = if shell == Shell::Bash { "command -v NAME" } else { "where.exe NAME" };
        return Some(format!(
            "hint: a program in this command is not installed or not on PATH. Check with `{check}` \
             (or look for a local one, e.g. `npx NAME`, `python -m NAME`); do not retry the same command."
        ));
    }
    if shell == Shell::PowerShell && command.contains("&&") {
        return Some("hint: Windows PowerShell 5.1 has no `&&` — use `;` or `cmd1; if ($?) { cmd2 }`.".into());
    }
    if low.contains("no such file or directory")
        || low.contains("cannot find the path")
        || low.contains("cannot find path")
        || low.contains("не удается найти")
        || low.contains("системе не удается")
    {
        return Some(
            "hint: a path in the command does not exist. Relative paths start at the working directory \
             shown above; locate files with find_files or list_dir instead of guessing."
                .into(),
        );
    }
    if low.contains("permission denied") || low.contains("access is denied") || low.contains("отказано в доступе") {
        return Some(
            "hint: access denied — the file may be open in another program (a running dev server, the IDE) \
             or need admin rights. Do not retry unchanged."
                .into(),
        );
    }
    None
}

/// Truncates from the middle so both the start and the end stay visible.
/// Slices on CHAR boundaries — byte slicing panicked on Cyrillic output.
fn clip_middle(text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    fn cut(s: &str, at: usize) -> usize {
        let mut i = at.min(s.len());
        while i > 0 && !s.is_char_boundary(i) {
            i -= 1;
        }
        i
    }
    let head_end = cut(&text, max / 2);
    let tail_start = cut(&text, text.len().saturating_sub(max / 2));
    format!("{}\n\n… output truncated …\n\n{}", &text[..head_end], &text[tail_start..])
}

/// Commands that start a server or watcher and never exit on their own.
/// Models kept running `npm run dev` in the foreground, waited out the
/// timeout and got it killed — these go to the background by themselves.
static LONG_RUNNING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?x)
        \b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch|preview)\b
        | (^|[\s&;|])(npx\s+)?(vite|nodemon|live-server|http-server|webpack-dev-server|serve)\s*($|[\s&;|])
        | \bvite\s+(dev|serve|preview)\b
        | \b(next|nuxt|astro|remix|gatsby|expo)\s+(dev|start|develop)\b
        | \bng\s+serve\b | \btauri\s+dev\b | \bcargo\s+watch\b | \bwebpack\s+serve\b
        | \bpython[0-9.]*\s+-m\s+http\.server\b | \bflask\s+run\b | \buvicorn\b | \bgunicorn\b
        | \bmanage\.py\s+runserver\b | \brails\s+s(erver)?\b | \bphp\s+-S\b | \bartisan\s+serve\b
        | \bhugo\s+server\b | \bjekyll\s+serve\b | \bjupyter\s+(notebook|lab)\b | \bdotnet\s+watch\b
        | \bdocker(-|\s+)compose\s+up\b
        | \s--watch\b",
    )
    .unwrap()
});

/// A dev server / watcher / `compose up` without `-d`.
pub fn looks_long_running(command: &str) -> bool {
    let c = command.to_lowercase();
    if c.contains("compose") && (c.contains(" -d") || c.contains("--detach")) {
        return false;
    }
    LONG_RUNNING.is_match(&c) && !c.contains("vite build")
}

/// Files a fresh repository may already hold; scaffolders still refuse
/// such a folder, but nothing in it conflicts with a new project.
const SCAFFOLD_IGNORABLE: &[&str] = &[
    ".git", ".gitignore", ".gitattributes", ".github", ".vscode", ".idea", ".singularity", ".claude",
    "readme.md", "readme", "readme.txt", "license", "license.md", "license.txt", ".ds_store", "thumbs.db",
];

/// `npm create vite@latest . -- --template react-ts` → the target folder
/// token ("."), with its byte offset in the command. Only a lone project
/// generator command (no `&&` chains) is recognized.
fn scaffold_target(command: &str) -> Option<(String, usize)> {
    let c = command.trim();
    if c.contains("&&") || c.contains(';') || c.contains('|') {
        return None;
    }
    let tokens: Vec<(usize, &str)> = c
        .split_whitespace()
        .scan(0usize, |pos, t| {
            let at = c[*pos..].find(t).map(|i| *pos + i).unwrap_or(*pos);
            *pos = at + t.len();
            Some((at, t))
        })
        .collect();
    let word = |i: usize| tokens.get(i).map(|t| t.1.to_lowercase()).unwrap_or_default();
    // Index of the generator package token.
    let pkg = match word(0).as_str() {
        "npm" | "pnpm" | "yarn" | "bun" if matches!(word(1).as_str(), "create" | "init") && tokens.len() > 2 => 2,
        "npx" | "bunx" => (1..tokens.len()).find(|&i| !tokens[i].1.starts_with('-'))?,
        "pnpm" if word(1) == "dlx" => (2..tokens.len()).find(|&i| !tokens[i].1.starts_with('-'))?,
        _ => return None,
    };
    let name = word(pkg);
    let bare = name.trim_start_matches('@');
    let is_generator = name.starts_with("create-") || bare.contains("/create-") || (pkg == 2 && matches!(word(1).as_str(), "create" | "init"));
    if !is_generator {
        return None;
    }
    // First positional argument after the package: the target folder.
    let mut i = pkg + 1;
    while i < tokens.len() {
        let t = tokens[i].1;
        if t == "--" {
            return None; // flags only — the generator asks for a name
        }
        if !t.starts_with('-') {
            return Some((t.trim_matches(['"', '\'']).to_string(), tokens[i].0));
        }
        i += 1;
    }
    None
}

/// Moves everything from `from` into `to`, keeping files that already
/// exist there. Returns the names kept.
fn merge_into(from: &Path, to: &Path) -> std::io::Result<Vec<String>> {
    let mut kept = Vec::new();
    for e in std::fs::read_dir(from)?.flatten() {
        let dest = to.join(e.file_name());
        if dest.exists() {
            kept.push(e.file_name().to_string_lossy().to_string());
            continue;
        }
        if std::fs::rename(e.path(), &dest).is_err() {
            copy_dir_or_file(&e.path(), &dest)?;
        }
    }
    let _ = std::fs::remove_dir_all(from);
    Ok(kept)
}

fn copy_dir_or_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for e in std::fs::read_dir(from)?.flatten() {
            copy_dir_or_file(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

/// Project generators (create-vite, create-next-app…) cancel with exit
/// code 0 in a non-empty folder — models kept retrying and giving up.
/// A folder holding only README / .git / .gitignore is scaffolded through
/// a temporary sibling and merged in; a folder with real files is refused
/// up front with the exact alternatives.
fn scaffold_guard(root: &Path, workdir: &Path, command: &str, shell: Shell, timeout_secs: Option<u64>) -> Option<ToolResult> {
    let (target, at) = scaffold_target(command)?;
    let dir = if target == "." || target == "./" {
        workdir.to_path_buf()
    } else if Path::new(&target).is_absolute() {
        PathBuf::from(&target)
    } else {
        workdir.join(&target)
    };
    let entries: Vec<String> = std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            if e.path().is_dir() { format!("{n}/") } else { n }
        })
        .collect();
    if entries.is_empty() {
        return None;
    }
    let real: Vec<&String> = entries
        .iter()
        .filter(|n| !SCAFFOLD_IGNORABLE.contains(&n.trim_end_matches('/').to_lowercase().as_str()))
        .collect();
    let tmp_name = format!(".scaffold-{}", std::process::id());
    let rewritten = format!("{}{}{}", &command[..at], tmp_name, &command[at + target.len()..]);
    if real.is_empty() {
        let parent = dir.parent().unwrap_or(workdir);
        let tmp = parent.join(&tmp_name);
        let _ = std::fs::remove_dir_all(&tmp);
        // Run the generator in the parent so the temporary folder lands next to the target.
        let rel_cmd = format!("{}{}{}", &command[..at], tmp_name, &command[at + target.len()..]);
        let res = run_command(root, &rel_cmd, Some(&parent.display().to_string()), timeout_secs, Some(shell.name()), false);
        if !res.ok || !tmp.is_dir() {
            let _ = std::fs::remove_dir_all(&tmp);
            return Some(res);
        }
        return Some(match merge_into(&tmp, &dir) {
            Ok(kept) => {
                let note = if kept.is_empty() {
                    String::new()
                } else {
                    format!(" Kept your existing {} (the template's version was not copied).", kept.join(", "))
                };
                ToolResult::ok(format!(
                    "{}\n\nScaffolded into {} (the folder already had {}, so the generator ran in a temporary folder and the files were moved in).{note}",
                    res.output,
                    dir.display(),
                    entries.join(", ")
                ))
            }
            Err(e) => ToolResult::err(format!("scaffolded into {} but could not move the files into {}: {e}", tmp.display(), dir.display())),
        });
    }
    let shown: Vec<&str> = real.iter().take(12).map(|s| s.as_str()).collect();
    let suggestion = rewritten.replace(&tmp_name, "app");
    Some(ToolResult::err(format!(
        "NOT RUN: {} is not empty ({}{}). Project generators cancel in a non-empty folder.\n\
         Do one of these:\n\
         - scaffold into a new subfolder: {suggestion}\n\
         - if these files are leftovers of YOUR earlier attempt in this task, delete them with file_op, then run the command again\n\
         - only if the user agreed to lose them: add --overwrite (create-vite) to empty the folder",
        dir.display(),
        shown.join(", "),
        if real.len() > shown.len() { ", …" } else { "" }
    )))
}

/// How long a background command is watched before the tool returns.
const BACKGROUND_WATCH: Duration = Duration::from_secs(5);

/// Runs a command in `cwd` (the workspace when unset) and returns its output.
///
/// `background` is for dev servers and watchers that never exit: the process
/// keeps running, its output goes to a log file, and the tool returns after
/// a few seconds with the pid and what it printed so far.
pub fn run_command(
    root: &Path,
    command: &str,
    cwd: Option<&str>,
    timeout_secs: Option<u64>,
    shell: Option<&str>,
    background: bool,
) -> ToolResult {
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(COMMAND_TIMEOUT_SECS).clamp(1, 600));
    let shell = shell.and_then(Shell::parse).unwrap_or_else(default_shell);
    let auto_bg = !background && looks_long_running(command);
    let background = background || auto_bg;

    // Relative cwd joins the workspace; unset means the workspace itself.
    let workdir = match cwd.map(str::trim) {
        Some(c) if !c.is_empty() => match resolve(root, c) {
            Ok(p) => p,
            Err(e) => return ToolResult::err(e),
        },
        _ => root.to_path_buf(),
    };
    if !workdir.is_dir() {
        return ToolResult::err(format!("working directory does not exist.\n{}", not_found(root, cwd.unwrap_or(""))));
    }
    let where_ = format!("[{} in {}]", shell.name(), workdir.display());
    if !background {
        if let Some(res) = scaffold_guard(root, &workdir, command, shell, timeout_secs) {
            return res;
        }
    }

    let mut proc = shell_process(shell, command);
    proc.current_dir(&workdir);
    quiet_env(&mut proc);

    let log_path = std::env::temp_dir().join(format!(
        "singularity-bg-{}.log",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    if background {
        let log = match std::fs::File::create(&log_path) {
            Ok(f) => f,
            Err(e) => return ToolResult::err(format!("cannot create the log file: {e}")),
        };
        let Ok(log2) = log.try_clone() else {
            return ToolResult::err("cannot create the log file");
        };
        proc.stdout(log).stderr(log2);
    } else {
        proc.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    }

    let mut child = match proc.spawn() {
        Ok(c) => c,
        Err(e) => return ToolResult::err(format!("cannot start {}: {e}", shell.name())),
    };
    let job = ProcJob::attach(&child, background);

    if background {
        let started = std::time::Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break Some(st),
                Ok(None) if started.elapsed() < BACKGROUND_WATCH => std::thread::sleep(Duration::from_millis(100)),
                _ => break None,
            }
        };
        let log = std::fs::read(&log_path).map(|b| strip_ansi(&decode_console(&b))).unwrap_or_default();
        let log = clip_middle(log, 6_000);
        let orphans = status.is_some() && job.as_ref().is_some_and(|j| j.active() > 0);
        if orphans {
            let id = crate::bg::register(child, job, command, &workdir.display().to_string(), shell.name(), log_path);
            return ToolResult::ok(format!(
                "the shell exited, but what it started keeps running — background task #{id} {where_}\n\
                 later output: background {{action:\"output\", id:{id}}} · stop: background {{action:\"stop\", id:{id}}}\n\
                 --- output so far ---\n{}",
                if log.trim().is_empty() { "(nothing yet)".into() } else { log }
            ));
        }
        return match status {
            Some(st) => {
                let code = st.code().unwrap_or(-1);
                let body = format!("exit code {code} {where_} — exited within {}s\n{log}", BACKGROUND_WATCH.as_secs());
                if st.success() { ToolResult::ok(body) } else { ToolResult::err(body) }
            }
            None => {
                let pid = child.id();
                let id = crate::bg::register(child, job, command, &workdir.display().to_string(), shell.name(), log_path);
                ToolResult::ok(format!(
                    "{}running in the background as task #{id} (pid {pid}) {where_}\n\
                     later output: background {{action:\"output\", id:{id}}} · stop: background {{action:\"stop\", id:{id}}}\n\
                     --- output so far ---\n{}",
                    if auto_bg { "(a server/watcher never exits, so it was started in the background) " } else { "" },
                    if log.trim().is_empty() { "(nothing yet)".into() } else { log }
                ))
            }
        };
    }

    // Read both pipes on their own threads: a chatty command blocks once a
    // pipe buffer fills, and polling try_wait alone then never saw it exit.
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_thread = std::thread::spawn(move || drain(out_pipe.take()));
    let err_thread = std::thread::spawn(move || drain(err_pipe.take()));

    // Poll instead of blocking so a hanging command cannot stall the agent.
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if started.elapsed() > timeout {
                    if let Some(j) = &job {
                        j.kill();
                    }
                    kill_tree(&mut child);
                    let partial = String::from_utf8_lossy(&out_thread.join().unwrap_or_default()).into_owned();
                    return ToolResult::err(format!(
                        "command timed out after {}s and was killed {where_}: {command}\n\
                         hint: if it is a dev server or watcher that never exits, run it with background:true; \
                         if it waits for input, pass the answer as a flag (--yes, -y).\n--- output before the kill ---\n{}",
                        timeout.as_secs(),
                        clip_middle(strip_ansi(&partial), 6_000)
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return ToolResult::err(format!("cannot wait for command: {e}")),
        }
    };

    let mut text = strip_ansi(&decode_console(&out_thread.join().unwrap_or_default()));
    let stderr = strip_ansi(&decode_console(&err_thread.join().unwrap_or_default()));
    if !stderr.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str("stderr:\n");
        text.push_str(&stderr);
    }
    let mut text = clip_middle(text, MAX_OUTPUT_BYTES);
    if text.trim().is_empty() {
        text = "(no output)".into();
    }

    let code = status.code().unwrap_or(-1);
    let mut body = format!("exit code {code} {where_}\n{text}");
    // Exit code 0 that is really a failure: an interactive prompt hit the
    // closed stdin and the tool gave up ("Operation cancelled" from
    // create-vite in a non-empty folder). Reported as success, the agent
    // carried on as if the project had been scaffolded.
    if status.success() {
        if let Some(hint) = cancelled_prompt(&text) {
            body.push_str("\n\n");
            body.push_str(&hint);
            return ToolResult::err(body);
        }
        ToolResult::ok(body)
    } else {
        if let Some(hint) = failure_hint(shell, command, code, &text) {
            body.push_str("\n\n");
            body.push_str(&hint);
        }
        ToolResult::err(body)
    }
}

/// Reads a child pipe to the end (on its own thread).
fn drain(pipe: Option<impl std::io::Read>) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Some(mut p) = pipe {
        let _ = p.read_to_end(&mut buf);
    }
    buf
}

/// Kills a command and everything it started (a shell's children survive a
/// plain kill on Windows).
/// Every process a command starts, grouped so they can be killed together.
/// On Windows a Job Object: `taskkill /T` walks parent links, and those
/// break in chains like bash → npm → cmd → node — the dev server survived
/// "Stop" and kept serving. Processes started inside the job stay in it,
/// and closing the handle (app exit) kills them too.
pub struct ProcJob {
    #[cfg(windows)]
    handle: isize,
}

// The handle is only used through thread-safe kernel calls.
unsafe impl Send for ProcJob {}
unsafe impl Sync for ProcJob {}

impl ProcJob {
    /// Puts a just-spawned process (and so all its future children) in a new
    /// job. `kill_on_close`: dropping the job kills what is left (background
    /// tasks — so nothing outlives the app); off for plain commands, whose
    /// deliberate leftovers (`code .`, a browser it opened) must survive.
    pub fn attach(child: &std::process::Child, kill_on_close: bool) -> Option<ProcJob> {
        #[cfg(windows)]
        unsafe {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::JobObjects::*;
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            if kill_on_close {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
            }
            if AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0 {
                CloseHandle(job);
                return None;
            }
            Some(ProcJob { handle: job as isize })
        }
        #[cfg(not(windows))]
        {
            let _ = (child, kill_on_close);
            None
        }
    }

    /// Processes still alive in the job (the shell may be gone while the
    /// server it started runs on). Unknown → 0.
    pub fn active(&self) -> u32 {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::JobObjects::*;
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            let ok = QueryInformationJobObject(
                self.handle as _,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            );
            if ok != 0 {
                return info.ActiveProcesses;
            }
        }
        0
    }

    /// Kills every process in the job.
    pub fn kill(&self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle as _, 1);
        }
    }
}

impl Drop for ProcJob {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle as _);
        }
    }
}

pub fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .creation_flags(0x0800_0000)
            .output();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/* ---------- Ready-made operations ----------
   Structured tools for what the model otherwise improvised as shell one-
   liners — the source of most "command not found" / quoting failures,
   especially on Windows. */

/// `*.tsx`, `src/**/test_*.py`, `config*` → a case-insensitive regex. A
/// pattern without `/` matches the file name anywhere in the tree.
fn glob_regex(pattern: &str) -> Option<Regex> {
    let pat = pattern.trim().replace('\\', "/");
    let pat = pat.trim_start_matches("./");
    let name_only = !pat.contains('/');
    let mut re = String::from("(?i)^");
    let chars: Vec<char> = pat.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' if chars.get(i + 1) == Some(&'*') => {
                // "**/" = any number of folders (including none)
                if chars.get(i + 2) == Some(&'/') {
                    re.push_str("(?:.*/)?");
                    i += 3;
                } else {
                    re.push_str(".*");
                    i += 2;
                }
                continue;
            }
            '*' => re.push_str("[^/]*"),
            '?' => re.push_str("[^/]"),
            '{' => re.push_str("(?:"),
            '}' => re.push(')'),
            ',' => re.push('|'),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
        i += 1;
    }
    re.push('$');
    let re = if name_only { re.replacen("(?i)^", "(?i)(?:^|/)", 1) } else { re };
    Regex::new(&re).ok()
}

/// Files (and folders) under `path` whose relative path matches `pattern`.
pub fn find_files(root: &Path, pattern: &str, path: Option<&str>) -> ToolResult {
    let base = match resolve(root, path.unwrap_or("")) {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    if !base.is_dir() {
        return ToolResult::err(not_found(root, path.unwrap_or("")));
    }
    let Some(re) = glob_regex(pattern) else {
        return ToolResult::err(format!("bad pattern: {pattern}"));
    };
    let hits: Vec<String> = workspace_files(&base)
        .into_iter()
        .filter(|f| re.is_match(f.trim_end_matches('/')))
        .take(300)
        .collect();
    if hits.is_empty() {
        return ToolResult::ok(format!("no files match {pattern:?} under {}", base.display()));
    }
    let more = if hits.len() == 300 { "\n… (first 300 shown — narrow the pattern)" } else { "" };
    ToolResult::ok(format!("{} (paths relative to it):\n{}{more}", base.display(), hits.join("\n")))
}

fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<u64> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        let mut n = 0;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            n += copy_recursive(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(n)
    } else {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(from, to).map(|_| 1)
    }
}

/// mkdir / move / copy / delete / info on files and folders — without a shell.
pub fn file_op(root: &Path, op: &str, path: &str, to: &str) -> ToolResult {
    let src = match resolve(root, path) {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let dest = || resolve(root, to);
    let shown = src.display().to_string();
    match op {
        "mkdir" => match std::fs::create_dir_all(&src) {
            Ok(()) => ToolResult::ok(format!("created folder {shown}")),
            Err(e) => ToolResult::err(format!("cannot create {shown}: {e}")),
        },
        "info" | "exists" => match std::fs::metadata(&src) {
            Ok(m) => ToolResult::ok(format!(
                "{shown}: {}, {} bytes",
                if m.is_dir() { "folder" } else { "file" },
                m.len()
            )),
            Err(_) => ToolResult::ok(format!("{shown} does not exist")),
        },
        "move" | "rename" | "copy" => {
            if to.trim().is_empty() {
                return ToolResult::err(format!("{op} needs `to`"));
            }
            if !src.exists() {
                return ToolResult::err(not_found(root, path));
            }
            let mut target = match dest() {
                Ok(p) => p,
                Err(e) => return ToolResult::err(e),
            };
            // Into an existing folder → keep the name, like mv/cp.
            if target.is_dir() {
                if let Some(name) = src.file_name() {
                    target = target.join(name);
                }
            }
            if target.exists() {
                return ToolResult::err(format!("{} already exists — delete it first or pick another name", target.display()));
            }
            if let Some(parent) = target.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let res = if op == "copy" {
                copy_recursive(&src, &target).map(|n| format!("copied {shown} → {} ({n} files)", target.display()))
            } else {
                std::fs::rename(&src, &target)
                    .or_else(|_| copy_recursive(&src, &target).and_then(|_| remove_any(&src)))
                    .map(|_| format!("moved {shown} → {}", target.display()))
            };
            match res {
                Ok(msg) => ToolResult::ok(msg),
                Err(e) => ToolResult::err(format!("{op} failed: {e}")),
            }
        }
        "delete" => {
            if !src.exists() {
                return ToolResult::ok(format!("{shown} does not exist (nothing to delete)"));
            }
            match remove_any(&src) {
                Ok(()) => ToolResult::ok(format!("deleted {shown}")),
                Err(e) => ToolResult::err(format!("cannot delete {shown}: {e}")),
            }
        }
        other => ToolResult::err(format!("unknown op {other:?} — use mkdir, move, copy, delete or info")),
    }
}

fn remove_any(p: &Path) -> std::io::Result<()> {
    if p.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    }
}

/// Git subcommands that never change anything.
pub const GIT_READ_ONLY: &[&str] = &["status", "diff", "log", "show", "blame", "branch", "remote", "rev-parse", "ls-files", "shortlog", "describe", "tag"];

/// Runs git directly (no shell, so no quoting problems) in `cwd`.
pub fn git(root: &Path, subcommand: &str, args: &[String], cwd: Option<&str>) -> ToolResult {
    let sub = subcommand.trim().trim_start_matches("git ").trim();
    if sub.is_empty() || sub.contains(char::is_whitespace) {
        return ToolResult::err("`subcommand` is ONE git subcommand (status, diff, commit…); put the rest in `args`");
    }
    let workdir = match cwd.map(str::trim) {
        Some(c) if !c.is_empty() => match resolve(root, c) {
            Ok(p) => p,
            Err(e) => return ToolResult::err(e),
        },
        _ => root.to_path_buf(),
    };
    let mut c = Command::new("git");
    c.arg("-c").arg("core.quotepath=off").arg("-c").arg("color.ui=never").arg(sub);
    // Default summaries that fit the context.
    if sub == "log" && !args.iter().any(|a| a.starts_with("-n") || a.starts_with("--max-count") || a.starts_with('-') && a[1..].parse::<u32>().is_ok()) {
        c.arg("-n").arg("20");
    }
    c.args(args).current_dir(&workdir);
    quiet_env(&mut c);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let out = match c.output() {
        Ok(o) => o,
        Err(e) => return ToolResult::err(format!("cannot run git (is it installed?): {e}")),
    };
    let mut text = decode_console(&out.stdout);
    let err = decode_console(&out.stderr);
    if !err.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&err);
    }
    let text = clip_middle(text, MAX_OUTPUT_BYTES);
    let body = format!(
        "git {sub} {} [in {}] → exit {}\n{}",
        args.join(" "),
        workdir.display(),
        out.status.code().unwrap_or(-1),
        if text.trim().is_empty() { "(no output)" } else { &text }
    );
    if out.status.success() { ToolResult::ok(body) } else { ToolResult::err(body) }
}

/// Decodes command output the way the user's console actually wrote it.
///
/// Windows cmd.exe emits the OEM codepage (cp866 on a Russian system, cp850
/// on Western ones) — decoding it as UTF-8 mangles every Cyrillic letter.
/// Strategy: strict UTF-8 first (cross-platform tools, modern builds); if that
/// fails, fall back to the system ANSI codepage via encoding_rs (which maps
/// cp866/cp1251 correctly for the Russian locale).
/// Process output as clean text: console code page decoded, ANSI stripped.
pub fn console_text(bytes: &[u8]) -> String {
    strip_ansi(&decode_console(bytes))
}

pub fn decode_console(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    // Not UTF-8: on a Russian Windows the OEM page is cp866 — decode that.
    // (run_command also forces "chcp 65001" so this path is rare.)
    let (cow, _, had_errors) = encoding_rs::IBM866.decode(bytes);
    if !had_errors {
        return cow.into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/* ---------- Dispatch ---------- */

/// Executes a tool by name. Unknown names are reported, not panicked on.
/// Serializes file-mutating tools: several tool calls (and helper agents)
/// run in parallel, and two read-modify-write patches of one file must not
/// interleave. Reads, searches and commands stay fully parallel.
static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn dispatch(root: &Path, name: &str, args: &serde_json::Value) -> ToolResult {
    let s = |key: &str| args.get(key).and_then(|v| v.as_str()).unwrap_or("");
    let _write = matches!(name, "write_file" | "edit_file" | "apply_patch" | "file_op")
        .then(|| WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner()));

    match name {
        "read_file" => read_file(
            root,
            s("path"),
            args.get("start_line").and_then(|v| v.as_u64()).map(|v| v as usize),
            args.get("end_line").and_then(|v| v.as_u64()).map(|v| v as usize),
        ),
        // The model rewrites EXISTING files only; new files go through
        // apply_patch create:true with its wrong-path guard.
        "write_file" => match resolve(root, s("path")) {
            Ok(full) if full.is_file() => write_file(root, s("path"), s("content")),
            Ok(_) => ToolResult::err(format!(
                "{}\nwrite_file only rewrites an existing file. For a NEW file use apply_patch with create:true.",
                not_found(root, s("path"))
            )),
            Err(e) => ToolResult::err(e),
        },
        "background" => crate::bg::tool(args),
        "edit_file" => edit_file(root, s("path"), s("old_text"), s("new_text")),
        "apply_patch" => apply_patch(
            root,
            // Codex's format names the file inside the diff.
            match s("path").trim() {
                "" => s("diff")
                    .lines()
                    .find_map(|l| l.strip_prefix("*** Update File:").or_else(|| l.strip_prefix("*** Add File:")))
                    .map(str::trim)
                    .unwrap_or(""),
                p => p,
            },
            s("diff"),
            args.get("create").and_then(|v| v.as_bool()).unwrap_or(false) || s("diff").contains("*** Add File:"),
        ),
        "list_dir" => list_dir(root, s("path")),
        "grep" => grep(root, s("pattern"), args.get("path").and_then(|v| v.as_str())),
        "run_command" => run_command(
            root,
            s("command"),
            args.get("cwd").and_then(|v| v.as_str()),
            args.get("timeout_secs").and_then(|v| v.as_u64()),
            args.get("shell").and_then(|v| v.as_str()),
            args.get("background").and_then(|v| v.as_bool()).unwrap_or(false),
        ),
        "find_files" => find_files(root, s("pattern"), args.get("path").and_then(|v| v.as_str())),
        "file_op" => file_op(root, s("op"), s("path"), s("to")),
        "git" => {
            let list: Vec<String> = match args.get("args") {
                Some(serde_json::Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
                // A model that sends one string gets it split on spaces.
                Some(serde_json::Value::String(t)) => t.split_whitespace().map(String::from).collect(),
                _ => Vec::new(),
            };
            git(root, s("subcommand"), &list, args.get("cwd").and_then(|v| v.as_str()))
        }
        other => ToolResult::err(format!("unknown tool: {other}")),
    }
}

/* ---------- Tests ---------- */

#[cfg(test)]
mod codex_patch_tests {
    use super::parse_patch;

    #[test]
    fn update_file_hunks_without_at_lines() {
        let diff = "*** Begin Patch\n*** Update File: src/a.ts\n const a = 1;\n-const b = 2;\n+const b = 3;\n*** End Patch";
        assert_eq!(parse_patch(diff), vec![("const a = 1;\nconst b = 2;".to_string(), "const a = 1;\nconst b = 3;".to_string())]);
    }

    #[test]
    fn add_file_is_one_create_hunk() {
        let diff = "*** Begin Patch\n*** Add File: src/new.ts\n+export const x = 1;\n+export const y = 2;\n*** End Patch";
        assert_eq!(parse_patch(diff), vec![(String::new(), "export const x = 1;\nexport const y = 2;".to_string())]);
    }
}

#[cfg(test)]
mod lenient_patch_tests {
    use super::{anchor_excerpt, locate};

    #[test]
    fn blank_lines_inside_search_do_not_matter() {
        let file = "fn a() {\n    let x = 1;\n\n    let y = 2;\n}\n";
        // The model dropped the blank line (and re-spaced a line).
        let (s, e, r) = locate(file, "    let x = 1;\n    let y=2;", "    let x = 1;\n    let y = 3;").unwrap();
        let out = format!("{}{}{}", &file[..s], r, &file[e..]);
        assert_eq!(out, "fn a() {\n    let x = 1;\n    let y = 3;\n}\n");
        // An extra blank line in SEARCH is fine too.
        assert!(locate(file, "let x = 1;\n\n\nlet y = 2;", "z").is_ok());
    }

    #[test]
    fn a_missed_search_shows_where_it_was_aimed() {
        let file: String = (1..=300).map(|i| format!("line {i} with some text\n")).collect();
        let needle = "stale line that is gone\nline 150 with some text\nanother stale line";
        let ex = anchor_excerpt(&file, needle).unwrap();
        assert!(ex.contains("  150  line 150 with some text"), "{ex}");
        assert!(anchor_excerpt(&file, "nothing\nof this\nexists anywhere here").is_none());
    }
}

#[cfg(test)]
mod similar_path_tests {
    use super::similar_paths;

    #[test]
    fn close_names_rank_above_assets() {
        let files: Vec<String> = [
            "src/app/",
            "src-tauri/app-icon.svg",
            "src/components/layout/AppShell.c.tsx",
            "src-tauri/icons/ios/AppIcon-20x20@1x.png",
            "src/App.tsx",
            "src/features/workspace/AppStatusBar.c.tsx",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let hits = similar_paths(&files, "src/App.c.tsx");
        assert_eq!(hits[0], "src/App.tsx");
        assert!(!hits.iter().any(|h| h.ends_with(".png")));
        assert!(hits.iter().position(|h| h.ends_with(".svg")).unwrap_or(usize::MAX) > 2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_hunk() {
        let diff = "<<<<<<< SEARCH\nold line\n=======\nnew line\n>>>>>>> REPLACE";
        let hunks = parse_patch(diff);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].0, "old line");
        assert_eq!(hunks[0].1, "new line");
    }

    #[test]
    fn parses_multi_hunk_and_markers_inside_fences() {
        let diff = [
            "<<<<<<< SEARCH",
            "a",
            "=======",
            "b",
            ">>>>>>> REPLACE",
            "<<<<<<< SEARCH",
            "c",
            "=======",
            "d",
            ">>>>>>> REPLACE",
        ]
        .join("\n");
        let hunks = parse_patch(&diff);
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[1].0, "c");
        assert_eq!(hunks[1].1, "d");
    }

    #[test]
    fn new_file_hunk_has_empty_search() {
        let diff = "<<<<<<< SEARCH\n=======\nnew content\n>>>>>>> REPLACE";
        let hunks = parse_patch(diff);
        assert_eq!(hunks.len(), 1);
        assert!(hunks[0].0.is_empty());
        assert_eq!(hunks[0].1, "new content");
    }

    #[test]
    fn normalizes_model_paths() {
        assert_eq!(normalize_path("  \"src/a.rs\" "), "src/a.rs");
        assert_eq!(normalize_path("`src/a.rs`"), "src/a.rs");
        if cfg!(windows) {
            assert_eq!(normalize_path("/c/Users/x"), "C:/Users/x");
            assert_eq!(normalize_path("/mnt/d/p"), "D:/p");
            assert_eq!(normalize_path("file:///C:/a/b"), "C:/a/b");
        }
    }

    #[test]
    fn locate_ignores_indentation_and_crlf() {
        let file = "fn a() {\r\n    let x = 1;\r\n    let y = 2;\r\n}\r\n";
        let search = match_endings(file, "let x = 1;\nlet y = 2;");
        let replace = match_endings(file, "let x = 10;\nlet y = 20;");
        let (s, e, r) = locate(file, &search, &replace).unwrap();
        let out = format!("{}{}{}", &file[..s], r, &file[e..]);
        assert_eq!(out, "fn a() {\r\n    let x = 10;\r\n    let y = 20;\r\n}\r\n");
        assert_eq!(locate("a\na\n", "a", "b"), Err(2));
    }

    #[test]
    fn glob_matches() {
        let re = glob_regex("*.tsx").unwrap();
        assert!(re.is_match("src/app/App.tsx"));
        assert!(!re.is_match("src/app/App.ts"));
        let re = glob_regex("src/**/*.rs").unwrap();
        assert!(re.is_match("src/a.rs") && re.is_match("src/x/y/a.rs"));
        assert!(glob_regex("*.{ts,tsx}").unwrap().is_match("a/b.ts"));
    }

    #[test]
    fn ps_chain_rewrites_and() {
        assert_eq!(ps_and_chain("cd a && npm i"), "cd a; if ($?) { npm i }");
        assert_eq!(ps_and_chain("echo \"a && b\""), "echo \"a && b\"");
    }

    #[test]
    fn runs_commands_in_default_shell() {
        let dir = std::env::temp_dir();
        let res = run_command(&dir, "echo hello", None, Some(30), None, false);
        assert!(res.ok, "{}", res.output);
        assert!(res.output.contains("hello"));
        let bad = run_command(&dir, "definitely-not-a-command-xyz", None, Some(30), None, false);
        assert!(!bad.ok);
        assert!(bad.output.contains("hint:"), "{}", bad.output);
    }

    #[cfg(windows)]
    #[test]
    fn runs_in_every_windows_shell() {
        let dir = std::env::temp_dir();
        for sh in ["powershell", "cmd", "bash"] {
            let res = run_command(&dir, "echo привет && echo two", None, Some(60), Some(sh), false);
            assert!(res.ok, "{sh}: {}", res.output);
            assert!(res.output.contains("привет") && res.output.contains("two"), "{sh}: {}", res.output);
        }
        let ps_fail = run_command(&dir, "Get-Item C:/definitely/missing", None, Some(60), Some("powershell"), false);
        assert!(!ps_fail.ok, "{}", ps_fail.output);
        for (sh, cmd) in [("bash", "echo started && sleep 30"), ("cmd", "ping -n 30 127.0.0.1")] {
            let bg = run_command(&dir, cmd, None, None, Some(sh), true);
            assert!(bg.ok && bg.output.contains("background"), "{sh}: {}", bg.output);
            let pid = bg.output.split("pid ").nth(1).unwrap().split_whitespace().next().unwrap().to_string();
            let _ = run_command(&dir, &format!("taskkill /T /F /PID {pid}"), None, None, Some("cmd"), false);
        }
    }

    #[test]
    fn edits_that_break_syntax_are_reported() {
        let dir = std::env::temp_dir().join(format!("sg-syntax-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("App.tsx"), "export function App() {
  return (
    <div>
      <h1>Hi</h1>
    </div>
  );
}
").unwrap();
        // Drops the closing </div>: written, but reported as an error with the line.
        let diff = "<<<<<<< SEARCH
      <h1>Hi</h1>
    </div>
=======
      <h1>Hello</h1>
>>>>>>> REPLACE";
        let res = apply_patch(&dir, "App.tsx", diff, false);
        assert!(!res.ok && res.output.contains("SYNTAX ERRORS"), "{}", res.output);
        // A clean edit stays a plain success.
        let fix = "<<<<<<< SEARCH
      <h1>Hello</h1>
=======
      <h1>Hello</h1>
    </div>
>>>>>>> REPLACE";
        let res = apply_patch(&dir, "App.tsx", fix, false);
        assert!(res.ok, "{}", res.output);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancelled_prompts_are_failures() {
        let out = "> npx\n> create-vite . --template react-ts\n\n—  Operation cancelled\n";
        let hint = cancelled_prompt(out).expect("detected");
        assert!(hint.contains("--overwrite"));
        assert!(cancelled_prompt("added 12 packages").is_none());
    }

    #[test]
    fn patch_parser_is_lenient() {
        // Wrong marker lengths, lowercase, fenced code, missing final marker.
        let odd = "<<<<<< search
```ts
old line
```
========
new line
";
        assert_eq!(parse_patch(odd), vec![("old line".to_string(), "new line".to_string())]);
        // A unified diff instead of SEARCH/REPLACE.
        let uni = "--- a/x.ts
+++ b/x.ts
@@ -1,3 +1,3 @@
 keep
-old
+new
 tail
";
        assert_eq!(parse_patch(uni), vec![("keep
old
tail".to_string(), "keep
new
tail".to_string())]);
    }

    #[test]
    fn near_miss_patches_apply_or_show_the_real_lines() {
        let dir = std::env::temp_dir().join(format!("sg-fuzzy-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let body = "export function Hero() {
  const title = \"Welcome to the site\";
  return <h1 className=\"hero\">{title}</h1>;
}
";
        std::fs::write(dir.join("Hero.tsx"), body).unwrap();
        // One character off ("Welcom"): applied to the real lines.
        let near = "<<<<<<< SEARCH
  const title = \"Welcom to the site\";
  return <h1 className=\"hero\">{title}</h1>;
=======
  const title = \"Hi\";
  return <h1 className=\"hero\">{title}</h1>;
>>>>>>> REPLACE";
        let res = apply_patch(&dir, "Hero.tsx", near, false);
        assert!(res.ok && res.output.contains("closest lines"), "{}", res.output);
        let now = std::fs::read_to_string(dir.join("Hero.tsx")).unwrap();
        assert!(now.contains("\"Hi\"") && now.starts_with("export function Hero()") && now.ends_with("}
"), "{now}");
        // Too different to apply: the error quotes the real lines.
        let far = "<<<<<<< SEARCH
export function Hero(props) {
  const heading = props.t;
=======
x
>>>>>>> REPLACE";
        let res = apply_patch(&dir, "Hero.tsx", far, false);
        assert!(!res.ok && res.output.contains("closest part") && res.output.contains("    1  export function Hero()"), "{}", res.output);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scaffold_targets_are_found() {
        assert_eq!(scaffold_target("npm create vite@latest . -- --template react-ts").map(|t| t.0), Some(".".into()));
        assert_eq!(scaffold_target("npx -y create-next-app@latest web --ts").map(|t| t.0), Some("web".into()));
        assert_eq!(scaffold_target("pnpm create vite my-app --template vue").map(|t| t.0), Some("my-app".into()));
        assert_eq!(scaffold_target("npm create vite@latest -- --template react").map(|t| t.0), None);
        assert_eq!(scaffold_target("npm install vite"), None);
        assert_eq!(scaffold_target("npx vite build"), None);
        let (t, at) = scaffold_target("npm create vite@latest . -- --template react-ts").unwrap();
        assert_eq!(&"npm create vite@latest . -- --template react-ts"[at..at + t.len()], ".");
    }

    #[test]
    fn scaffold_refuses_a_folder_with_real_files() {
        let dir = std::env::temp_dir().join(format!("sg-scaffold-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("public")).unwrap();
        std::fs::write(dir.join("index.html"), "x").unwrap();
        let res = scaffold_guard(&dir, &dir, "npm create vite@latest . -- --template react-ts", default_shell(), None).unwrap();
        assert!(!res.ok && res.output.contains("NOT RUN") && res.output.contains("index.html"), "{}", res.output);
        assert!(res.output.contains("npm create vite@latest app -- --template react-ts"), "{}", res.output);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "downloads create-vite"]
    fn scaffold_merges_into_a_fresh_repo() {
        let dir = std::env::temp_dir().join(format!("sg-scaffold-merge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("README.md"), "mine").unwrap();
        std::fs::write(dir.join(".gitignore"), "mine").unwrap();
        let res = run_command(&dir, "npm create vite@latest . -- --template react-ts", None, Some(180), None, false);
        assert!(res.ok, "{}", res.output);
        assert!(dir.join("package.json").is_file() && dir.join("src").is_dir(), "{}", res.output);
        assert_eq!(std::fs::read_to_string(dir.join("README.md")).unwrap(), "mine");
        assert!(!std::fs::read_dir(&dir).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with(".scaffold-")));
        println!("{}", res.output);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(windows)]
    fn stopping_a_background_task_kills_orphaned_servers() {
        // cmd starts node detached and exits at once: node is an orphan that
        // taskkill /T on the (dead) shell never reached.
        let dir = std::env::temp_dir();
        let port = 47000 + (std::process::id() % 1000) as u16;
        let script = dir.join(format!("sg-orphan-{port}.js"));
        std::fs::write(&script, format!("require('http').createServer((q,r)=>r.end('ok')).listen({port})")).unwrap();
        let cmd = format!("start /b node {}", script.display());
        let res = run_command(&dir, &cmd, None, None, Some("cmd"), true);
        let up = |p: u16| std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], p).into(), Duration::from_millis(300)).is_ok();
        let mut ready = false;
        for _ in 0..50 {
            if up(port) {
                ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let log = crate::bg::list().into_iter().find(|t| t.command == cmd).map(|t| crate::bg::output(t.id, 2000).map(|o| o.1).unwrap_or_default());
        assert!(ready, "server did not start: {}
{log:?}", res.output);
        let id = crate::bg::list().into_iter().find(|t| t.command == cmd).map(|t| t.id);
        if let Some(id) = id {
            crate::bg::stop(id).unwrap();
        } else {
            // cmd exited within the watch window: the job was dropped with it,
            // which must have killed the server as well.
        }
        std::thread::sleep(Duration::from_millis(500));
        assert!(!up(port), "the server survived the stop");
    }

    #[test]
    fn dev_servers_go_to_the_background() {
        for c in ["npm run dev", "pnpm dev", "yarn start", "cd web && npm run dev -- --port 3000", "npx vite", "vite", "python -m http.server 8000", "docker compose up", "tsc --watch", "npm run tauri dev"] {
            assert!(looks_long_running(c), "{c}");
        }
        for c in ["npm run build", "npm install", "npx vite build", "docker compose up -d", "cargo build", "npm test", "npm create vite@latest app", "git status", "npm i -D serve-static"] {
            assert!(!looks_long_running(c), "{c}");
        }
    }

    #[test]
    fn background_tasks_are_listed_read_and_stopped() {
        let dir = std::env::temp_dir();
        let cmd = if cfg!(windows) { "ping -n 30 127.0.0.1" } else { "sleep 30" };
        let started = run_command(&dir, cmd, None, None, None, true);
        assert!(started.ok && started.output.contains("task #"), "{}", started.output);
        let id: u64 = started.output.split("task #").nth(1).unwrap().split(|c: char| !c.is_ascii_digit()).next().unwrap().parse().unwrap();
        let list = crate::bg::tool(&serde_json::json!({"action": "list"}));
        assert!(list.output.contains(&format!("#{id} [running")), "{}", list.output);
        let out = crate::bg::tool(&serde_json::json!({"action": "output", "id": id}));
        assert!(out.ok, "{}", out.output);
        let stop = crate::bg::tool(&serde_json::json!({"action": "stop", "id": id}));
        assert!(stop.ok && stop.output.contains("stopped"), "{}", stop.output);
        assert!(crate::bg::list().iter().any(|t| t.id == id as u32 && !t.running));
    }

    #[test]
    fn patch_forgives_line_numbers_escapes_and_spacing() {
        let dir = std::env::temp_dir().join(format!("sing-patch2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = "function A() {\n  return (\n    <div className=\"a\">\n      <p>hi</p>\n    </div>\n  );\n}\n";
        std::fs::write(dir.join("A.tsx"), src).unwrap();
        let read = || std::fs::read_to_string(dir.join("A.tsx")).unwrap();

        // SEARCH copied with read_file's line numbers.
        let numbered = "<<<<<<< SEARCH\n    4        <p>hi</p>\n=======\n    4        <p>hello</p>\n>>>>>>> REPLACE";
        let res = apply_patch(&dir, "A.tsx", numbered, false);
        assert!(res.ok, "{}", res.output);
        assert!(read().contains("      <p>hello</p>\n"), "{}", read());

        // The whole diff JSON-escaped once more: one line with literal \n.
        let escaped = r"<<<<<<< SEARCH\n      <p>hello</p>\n=======\n      <p>hey</p>\n>>>>>>> REPLACE";
        let res = apply_patch(&dir, "A.tsx", escaped, false);
        assert!(res.ok, "{}", res.output);
        assert!(read().contains("<p>hey</p>"));

        // Different spacing inside the line.
        let spaced = "<<<<<<< SEARCH\n<div className = \"a\" >\n=======\n<div className=\"b\">\n>>>>>>> REPLACE";
        let res = apply_patch(&dir, "A.tsx", spaced, false);
        assert!(res.ok, "{}", res.output);
        assert!(read().contains("    <div className=\"b\">"), "{}", read());

        // Nothing similar: the current file comes back in the error.
        let stale = "<<<<<<< SEARCH\nconst zzz = qqq;\n=======\nx\n>>>>>>> REPLACE";
        let res = apply_patch(&dir, "A.tsx", stale, false);
        assert!(!res.ok && res.output.contains("as it is NOW") && res.output.contains("<p>hey</p>"), "{}", res.output);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_patch_edits_and_creates() {
        let dir = std::env::temp_dir().join(format!("sing-patch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "one\ntwo\nthree").unwrap();

        // Edit existing
        let diff = "<<<<<<< SEARCH\ntwo\n=======\nTWO\n>>>>>>> REPLACE";
        let res = apply_patch(&dir, "a.txt", diff, false);
        assert!(res.ok, "{}", res.output);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\nTWO\nthree");

        // Create new via empty SEARCH
        let create = "<<<<<<< SEARCH\n=======\nfresh\n>>>>>>> REPLACE";
        let refused = apply_patch(&dir, "b.txt", create, false);
        assert!(!refused.ok && !dir.join("b.txt").exists(), "{}", refused.output);
        let res2 = apply_patch(&dir, "b.txt", create, true);
        assert!(res2.ok, "{}", res2.output);
        assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "fresh\n");

        // Missing SEARCH side → error, file untouched
        let bad = "<<<<<<< SEARCH\nnope\n=======\nx\n>>>>>>> REPLACE";
        let res3 = apply_patch(&dir, "a.txt", bad, false);
        assert!(!res3.ok);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\nTWO\nthree");

        // A guessed path in a missing folder, same name as an existing file.
        let guess = apply_patch(&dir, "nope/a.txt", create, true);
        assert!(!guess.ok && guess.output.contains("refusing"), "{}", guess.output);
        assert!(!dir.join("nope").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}