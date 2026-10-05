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
use std::sync::{LazyLock, OnceLock};
use std::time::Duration;

/// Largest file we will read into the model context.
const MAX_READ_BYTES: usize = 200_000;
/// Most lines one read_file returns, even for an explicit range.
const READ_DEFAULT_LINES: usize = 2_000;
/// A file up to this size is read whole when no range is given…
const READ_WHOLE_LINES: usize = 400;
const READ_WHOLE_BYTES: usize = 32_000;
/// …a bigger one gives its first lines plus an outline with line ranges
/// (Roo Code's partial read + list_code_definition_names): every step
/// re-sends what was read, so a 3000-line file must not land whole.
const READ_PREVIEW_LINES: usize = 150;
/// start_line without end_line: this many lines from there.
const READ_ON_LINES: usize = 400;
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

/// Error text for a path that does not exist — written so the model's
/// NEXT call is the right one, not another round of guessing:
///
/// * The path is named as resolved (Roo Code's getReadablePath); the
///   "relative paths start at" note only appears for a relative path.
/// * A misspelled component (`src/compoents`) is corrected against the real
///   entries of its folder, Aider-style (difflib.get_close_matches, 0.8).
/// * Files with the same name elsewhere in the project — the workspace, or
///   for a path outside it the project that path lies in (its git /
///   package root).
/// * Otherwise what the deepest existing folder on the way contains, so no
///   extra list_dir round trip is needed.
pub fn not_found(root: &Path, path: &str) -> String {
    let full = resolve(root, path).unwrap_or_else(|_| root.join(path));
    let absolute = Path::new(&normalize_path(path)).is_absolute();
    let mut msg = if absolute {
        format!("not found: {}", full.display())
    } else {
        format!("not found: {} (relative paths start at {})", full.display(), root.display())
    };
    if let Some(fixed) = correct_path(&full, false) {
        msg.push_str(&format!("\nDid you mean {}?", fixed.display()));
        return msg;
    }
    let inside = !absolute || lexical(&full).starts_with(&lexical(root));
    let search_root = if inside { Some(root.to_path_buf()) } else { project_root_of(&full) };
    if let Some(base) = &search_root {
        let hits = name_matches(base, path);
        if !hits.is_empty() {
            let place = if inside { "the workspace".to_string() } else { base.display().to_string() };
            msg.push_str(&format!("\nDid you mean one of these (relative to {place})?"));
            for h in hits {
                msg.push_str("\n  ");
                msg.push_str(&h);
            }
            return msg;
        }
    }
    if let Some(parent) = deepest_existing(&full) {
        msg.push_str(&format!("\nNothing with that name nearby. {} contains: {}", parent.display(), dir_summary(&parent)));
    } else if inside {
        msg.push_str("\nNothing with that name exists under the workspace. Use find_files or list_dir to look around instead of guessing.");
    }
    msg
}

/// Paths under `base` whose file name is the one asked for (or contains
/// its stem), relative to `base`.
fn name_matches(base: &Path, path: &str) -> Vec<String> {
    let name = Path::new(&normalize_path(path))
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name.is_empty() {
        return Vec::new();
    }
    let files = workspace_files(base);
    let file_name = |f: &String| f.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_lowercase();
    let mut hits: Vec<String> = files.iter().filter(|f| file_name(f) == name).take(8).cloned().collect();
    if hits.is_empty() {
        let stem = name.split('.').next().unwrap_or(&name).to_string();
        if stem.len() >= 3 {
            hits = files.iter().filter(|f| file_name(f).contains(&stem)).take(8).cloned().collect();
        }
    }
    hits
}

/// The project a path lies in: the nearest existing ancestor with a git /
/// package marker — never a home folder or a drive root.
fn project_root_of(p: &Path) -> Option<PathBuf> {
    const MARKERS: &[&str] = &[".git", "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "pom.xml", "composer.json"];
    let home = home_dir();
    p.ancestors()
        .skip(1)
        .filter(|a| a.is_dir())
        .take_while(|a| a.parent().is_some() && home.as_deref() != Some(*a))
        .find(|a| MARKERS.iter().any(|m| a.join(m).exists()))
        .map(Path::to_path_buf)
}

/// Entries of a folder on one line (folders marked with /), at most 40.
fn dir_summary(dir: &Path) -> String {
    let Ok(rd) = std::fs::read_dir(dir) else { return "(unreadable)".into() };
    let mut names: Vec<String> = rd
        .flatten()
        .map(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { format!("{n}/") } else { n }
        })
        .filter(|n| !INDEX_SKIP.contains(&n.trim_end_matches('/')))
        .collect();
    names.sort();
    let total = names.len();
    if total == 0 {
        return "(empty)".into();
    }
    let mut out = names.into_iter().take(40).collect::<Vec<_>>().join(", ");
    if total > 40 {
        out.push_str(&format!(", … ({} more)", total - 40));
    }
    out
}

/// Read-only tools follow an obvious misspelling instead of failing: a
/// folder name off by a typo or case, or a file name off by case only
/// (two files `test1.ts` / `test2.ts` are too close to guess between).
/// Returns the corrected path and the note shown with the result.
fn autocorrect(root: &Path, path: &str, tool: &str) -> Option<(String, String)> {
    let file = tool == "read_file";
    if path.trim().is_empty() {
        return None;
    }
    let full = resolve(root, path).ok()?;
    if full.exists() {
        return None;
    }
    // `src/styles` when only `src/styles.css` is there: the extension was
    // left off. read_file reads that file; list_dir lists its folder.
    if let Some(sibling) = only_extension_missing(&full) {
        let (target, what) = match tool {
            "read_file" => (sibling.clone(), format!("showing the file {}", sibling.display())),
            "list_dir" => (sibling.parent()?.to_path_buf(), format!("{} is a file — listing its folder", sibling.display())),
            _ => (sibling.clone(), format!("using the file {}", sibling.display())),
        };
        let note = format!("[{} does not exist — {what}]\n", full.display());
        return Some((target.to_string_lossy().into_owned(), note));
    }
    let fixed = correct_path(&full, true)?;
    if file {
        let (a, b) = (full.file_name()?.to_string_lossy(), fixed.file_name()?.to_string_lossy());
        if !a.eq_ignore_ascii_case(&b) {
            return None;
        }
    }
    let note = format!("[{} does not exist — showing {} instead]\n", full.display(), fixed.display());
    Some((fixed.to_string_lossy().into_owned(), note))
}

/// The ONE file next to `p` named `p` + an extension (`styles` →
/// `styles.css`), when its folder exists.
fn only_extension_missing(p: &Path) -> Option<PathBuf> {
    let name = p.file_name()?.to_string_lossy().to_lowercase();
    let mut hits = std::fs::read_dir(p.parent()?).ok()?.flatten().filter(|e| {
        let n = e.file_name().to_string_lossy().to_lowercase();
        e.file_type().is_ok_and(|t| t.is_file())
            && n.strip_prefix(&name).is_some_and(|rest| rest.starts_with('.') && !rest[1..].contains('.'))
    });
    let first = hits.next()?;
    hits.next().is_none().then(|| first.path())
}

/// For a NEW file under a folder that does not exist: the existing file the
/// path most likely meant — the same path with the missing folder's name
/// corrected to an almost identical sibling (`src/layuot/Nav.tsx` →
/// `src/layout/Nav.tsx`). None when the folder is simply new: a same-named
/// file somewhere else (`index.html`) says nothing.
fn mistyped_folder(full: &Path) -> Option<PathBuf> {
    let mut missing = full.parent()?;
    if missing.exists() {
        return None;
    }
    while !missing.parent()?.exists() {
        missing = missing.parent()?;
    }
    let rest = full.strip_prefix(missing).ok()?;
    let name = missing.file_name()?.to_string_lossy().to_lowercase();
    std::fs::read_dir(missing.parent()?)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| typo_of(&e.file_name().to_string_lossy().to_lowercase(), &name))
        .map(|e| e.path().join(rest))
        .find(|p| p.is_file())
}

/// `p` relative to the workspace (`/`-separated) when it is inside it.
fn rel_to(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

/// `a` and `b` differ by a typo: 1 edit (2 for names of 6+ chars), a swap
/// of neighbours counting as one.
fn typo_of(a: &str, b: &str) -> bool {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let max = if a.len().min(b.len()) >= 6 { 2 } else { 1 };
    if a == b || a.len().abs_diff(b.len()) > max {
        return false;
    }
    // Optimal string alignment distance.
    let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for j in 0..=b.len() {
        d[0][j] = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut v = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                v = v.min(d[i - 2][j - 2] + 1);
            }
            d[i][j] = v;
        }
    }
    d[a.len()][b.len()] <= max
}

/// Lower-cased (on Windows), `/`-separated, `.`/`..`-folded form of a path,
/// for comparing paths that may not exist.
fn lexical(p: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    for c in p.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                parts.pop();
            }
            other => parts.push(other.as_os_str().to_string_lossy().trim_end_matches(['/', '\\']).to_string()),
        }
    }
    let s = parts.join("/");
    if cfg!(windows) { s.to_lowercase() } else { s }
}

/// The deepest ancestor of `p` that exists.
fn deepest_existing(p: &Path) -> Option<PathBuf> {
    p.ancestors().skip(1).find(|a| !a.as_os_str().is_empty() && a.is_dir()).map(Path::to_path_buf)
}

/// difflib's SequenceMatcher.ratio, approximated by the longest common
/// subsequence: 2·LCS / (len a + len b), case-insensitive.
fn name_similarity(a: &str, b: &str) -> f64 {
    let a: Vec<char> = a.to_lowercase().chars().collect();
    let b: Vec<char> = b.to_lowercase().chars().collect();
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let mut prev = vec![0usize; b.len() + 1];
    for ca in &a {
        let mut cur = vec![0usize; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = if ca == cb { prev[j] + 1 } else { prev[j + 1].max(cur[j]) };
        }
        prev = cur;
    }
    2.0 * prev[b.len()] as f64 / (a.len() + b.len()) as f64
}

/// Same cutoff as Aider's get_close_matches.
const CLOSE_MATCH: f64 = 0.8;

/// `p` with each missing component replaced by the closest real entry of
/// its folder (case or a typo), when every component can be fixed and the
/// result exists. None when nothing close enough exists — or, with
/// `unique`, when two entries are equally close.
fn correct_path(p: &Path, unique: bool) -> Option<PathBuf> {
    let mut cur = PathBuf::new();
    let mut changed = false;
    for c in p.components() {
        let next = cur.join(c.as_os_str());
        let std::path::Component::Normal(name) = c else {
            cur = next;
            continue;
        };
        if next.exists() {
            cur = next;
            continue;
        }
        let name = name.to_string_lossy();
        let mut close: Vec<(f64, String)> = std::fs::read_dir(&cur)
            .ok()?
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .map(|n| (name_similarity(&name, &n), n))
            .filter(|(score, _)| *score >= CLOSE_MATCH)
            .collect();
        close.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        let best = close.first()?.clone();
        if unique && close.get(1).is_some_and(|second| second.0 >= best.0) {
            return None;
        }
        cur = cur.join(best.1);
        changed = true;
    }
    (changed && cur.exists()).then_some(cur)
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
    let (from, to, preview) = read_window(lines.len(), text.len(), start_line, end_line);

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
    if preview {
        let outline = crate::syntax::outline(&full, &text);
        out.push_str(&format!("\n[Large file: only lines {from}-{to} of {} are shown. ", lines.len()));
        if outline.is_empty() {
            out.push_str("grep for what you need, then read just that range with start_line/end_line.]\n");
        } else {
            out.push_str("Its outline (line ranges) — read just the part you need with start_line/end_line, or grep:\n");
            out.push_str(&outline.join("\n"));
            out.push_str("]\n");
        }
    } else if end_line.is_none() && to < lines.len() {
        out.push_str(&format!(
            "… {} more lines. Read on with start_line={} (or grep for what you need).\n",
            lines.len() - to,
            to + 1
        ));
    }
    ToolResult::ok(out)
}

/// The lines a read_file call returns: (from, to, preview). `preview` = a
/// big file read without a range (first lines + outline). The agent loop
/// uses the same window to spot a re-read of lines it already has.
pub fn read_window(lines: usize, bytes: usize, start_line: Option<usize>, end_line: Option<usize>) -> (usize, usize, bool) {
    let from = start_line.unwrap_or(1).max(1);
    match (start_line, end_line) {
        (_, Some(end)) => (from, end.min(lines).min(from.saturating_add(READ_DEFAULT_LINES - 1)), false),
        (Some(_), None) => (from, from.saturating_add(READ_ON_LINES - 1).min(lines), false),
        (None, None) if lines <= READ_WHOLE_LINES && bytes <= READ_WHOLE_BYTES => (1, lines, false),
        (None, None) => (1, READ_PREVIEW_LINES.min(lines), true),
    }
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
/// grep output limits: whole lines of 200 files used to come back with
/// absolute paths — thousands of tokens re-sent on every later step.
const GREP_MAX_MATCHES: usize = 100;
const GREP_PER_FILE: usize = 12;
const GREP_LINE_CHARS: usize = 200;

pub fn grep(root: &Path, pattern: &str, subdir: Option<&str>) -> ToolResult {
    let base = match subdir {
        Some(s) if !s.is_empty() => match resolve(root, s) {
            Ok(p) => p,
            Err(e) => return ToolResult::err(e),
        },
        _ => root.to_path_buf(),
    };
    if !base.exists() {
        return ToolResult::err(not_found(root, subdir.unwrap_or("")));
    }

    // A literal substring search keeps this dependency-free and predictable.
    struct Hits {
        files: Vec<(PathBuf, Vec<(usize, String)>, usize)>,
        total: usize,
        scanned: usize,
    }
    fn search_file(path: &Path, needle: &str, hits: &mut Hits) {
        let Ok(meta) = std::fs::metadata(path) else { return };
        if meta.len() > 400_000 {
            return;
        }
        let Ok(text) = std::fs::read_to_string(path) else { return };
        hits.scanned += 1;
        let mut lines = Vec::new();
        let mut count = 0usize;
        for (i, line) in text.lines().enumerate() {
            if line.contains(needle) {
                count += 1;
                if lines.len() < GREP_PER_FILE {
                    let t = line.trim();
                    let t = match t.char_indices().nth(GREP_LINE_CHARS) {
                        Some((cut, _)) => format!("{}…", &t[..cut]),
                        None => t.to_string(),
                    };
                    lines.push((i + 1, t));
                }
            }
        }
        if count > 0 {
            hits.total += count;
            hits.files.push((path.to_path_buf(), lines, count));
        }
    }
    fn walk(dir: &Path, needle: &str, hits: &mut Hits) {
        if hits.scanned > 5000 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if INDEX_SKIP.contains(&name.as_str()) || name == "dist" {
                continue;
            }
            if path.is_dir() {
                walk(&path, needle, hits);
            } else {
                search_file(&path, needle, hits);
            }
        }
    }

    let mut hits = Hits { files: Vec::new(), total: 0, scanned: 0 };
    if base.is_file() {
        search_file(&base, pattern, &mut hits);
    } else {
        walk(&base, pattern, &mut hits);
    }
    if hits.files.is_empty() {
        return ToolResult::ok(format!("no matches for {pattern:?}"));
    }
    let rel = |p: &Path| p.strip_prefix(root).map(|r| r.display().to_string().replace('\\', "/")).unwrap_or_else(|_| p.display().to_string());
    let mut out = format!("{} matches in {} files", hits.total, hits.files.len());
    let mut shown = 0usize;
    let mut skipped_files = 0usize;
    for (path, lines, count) in &hits.files {
        if shown >= GREP_MAX_MATCHES {
            skipped_files += 1;
            continue;
        }
        out.push_str(&format!("\n{}:", rel(path)));
        for (n, l) in lines {
            out.push_str(&format!("\n{n:>6}: {l}"));
            shown += 1;
        }
        if *count > lines.len() {
            out.push_str(&format!("\n        … {} more in this file", count - lines.len()));
        }
    }
    if skipped_files > 0 {
        out.push_str(&format!("\n… {skipped_files} more files with matches — narrow the pattern or the path."));
    }
    ToolResult::ok(out)
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
    let mut flush = |old: &mut Vec<&str>, new: &mut Vec<&str>| {
        if old.iter().any(|l| !l.trim().is_empty()) && old != new {
            hunks.push((old.join("\n"), new.join("\n")));
        }
        old.clear();
        new.clear();
    };
    for line in diff.lines() {
        if line.starts_with("@@") {
            flush(&mut old, &mut new);
            inside = true;
            continue;
        }
        if line.starts_with("---") || line.starts_with("+++") || line.starts_with("diff ") || line.starts_with("index ") {
            flush(&mut old, &mut new);
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
            flush(&mut old, &mut new);
            inside = false;
        }
    }
    flush(&mut old, &mut new);
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
                 Only if you really mean to create a NEW file: write it whole with write_file.",
                not_found(root, path)
            ));
        }
        // A folder name one typo away from a folder that has this file is a
        // wrong guess at the existing file's path.
        if let Some(meant) = mistyped_folder(&full) {
            return ToolResult::err(format!(
                "refusing to create {path}: its folder does not exist, but {} does — a typo in the folder name? \
                 Edit that file instead, or create the folder first with file_op mkdir if a new file is really intended.",
                rel_to(root, &meant)
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
    let mut already = 0usize;
    for (i, (search, replace)) in hunks.iter().enumerate() {
        let (needle, replace) = (match_endings(&current, search), match_endings(&current, replace));
        match locate(&current, &needle, &replace) {
            Ok((start, end, replace)) => {
                current = format!("{}{}{}", &current[..start], replace, &current[end..]);
                applied += 1;
            }
            // SEARCH is gone but REPLACE is there: this change was already
            // made (an earlier call, a resent diff) — Aider's check.
            // (A one-liner like "}" is everywhere — that proves nothing.)
            Err(0) if replace.trim().len() >= 30 && !matches!(locate(&current, &replace, &replace), Err(0)) => {
                already += 1;
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
                    // A small file is shown whole: SEARCH this far off usually
                    // came from an outdated or misremembered version of it.
                    let (from, to) = if lines.len() <= 150 {
                        (0, lines.len())
                    } else {
                        (at.saturating_sub(5), (at + len + 5).min(lines.len()))
                    };
                    let snippet: String = (from..to).map(|n| format!("{:>5}  {}\n", n + 1, lines[n])).collect();
                    let shown = if from == 0 && to == lines.len() { "The whole file as it is NOW" } else { "Around them" };
                    errors.push(format!(
                        "hunk {i}: SEARCH text not found in {path}. The closest part of the file ({:.0}% similar) is lines {}-{} — your SEARCH does not match what is there; copy SEARCH EXACTLY from the current text (without the line numbers). {shown}:\n{snippet}",
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
    if applied == 0 && errors.is_empty() {
        return ToolResult::ok(format!(
            "{path} already contains these changes (the REPLACE text is there, SEARCH is gone) — nothing to do. Do not send this diff again."
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
            if already > 0 {
                out.push_str(&format!(", {already} already in the file"));
            }
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
/// Command output the model gets in full, lines / characters.
const OUT_HEAD_LINES: usize = 60;
const OUT_TAIL_LINES: usize = 100;
const OUT_MAX_CHARS: usize = 10_000;

/// Compiler / linter diagnostic: `src/a.ts(12,5): error TS2322: …`,
/// `src/a.rs:12:5: warning: …`, `error[E0308]: … --> src/a.rs:12:5`.
static DIAGNOSTIC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|-->\s*)([\w./\\@~-]+\.[a-z]{1,6})[(:](\d+)[,:]?(?:\d+)?\)?:?.*?\b(error|warning)\b(?:\s+(\w*\d+))?").unwrap()
});

/// Command output made cheap to read, the way Roo Code / Goose / Claude
/// Code keep a 2000-line `tsc` from flooding the context: progress-bar
/// redraws dropped, repeated lines folded, and a long output cut to its head
/// and tail with a diagnostics summary on top. The full output goes to a log
/// file the model can grep / read_file when it really needs the middle.
fn condense_output(raw: String) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut repeats = 0usize;
    for line in raw.lines() {
        // A progress bar redraws itself with \r: the terminal shows the last.
        let line = line.rsplit('\r').next().unwrap_or(line).trim_end();
        if lines.last().is_some_and(|l| l == line) {
            repeats += 1;
            continue;
        }
        if repeats > 0 {
            if let Some(last) = lines.last_mut() {
                last.push_str(&format!("  (×{})", repeats + 1));
            }
            repeats = 0;
        }
        lines.push(line.to_string());
    }
    if repeats > 0 {
        if let Some(last) = lines.last_mut() {
            last.push_str(&format!("  (×{})", repeats + 1));
        }
    }
    let total_chars: usize = lines.iter().map(|l| l.len() + 1).sum();
    if lines.len() <= OUT_HEAD_LINES + OUT_TAIL_LINES && total_chars <= OUT_MAX_CHARS {
        return lines.join("\n");
    }

    let log = save_full_output(&raw);
    let mut out = String::new();
    if let Some(summary) = diagnostics_summary(&lines) {
        out.push_str(&summary);
        out.push_str("\n\n");
    }
    let head = OUT_HEAD_LINES.min(lines.len());
    let tail_from = lines.len().saturating_sub(OUT_TAIL_LINES).max(head);
    out.push_str(&lines[..head].join("\n"));
    if tail_from > head {
        out.push_str(&format!("\n\n… {} lines omitted", tail_from - head));
        match &log {
            Some(p) => out.push_str(&format!(" — the full output is in {} (grep it / read_file a range; do not re-run the command just to see it)", p.display())),
            None => out.push_str(" — narrow the command (grep, head, a single file) to see them"),
        }
        out.push_str(" …\n\n");
        out.push_str(&lines[tail_from..].join("\n"));
    }
    clip_middle(out, OUT_MAX_CHARS)
}

/// "214 errors, 3 warnings in 23 files: src/a.ts (40), … · most common: TS2322 (80), …"
fn diagnostics_summary(lines: &[String]) -> Option<String> {
    let (mut errors, mut warnings) = (0usize, 0usize);
    let mut files: Vec<(String, usize)> = Vec::new();
    let mut codes: Vec<(String, usize)> = Vec::new();
    let bump = |v: &mut Vec<(String, usize)>, k: &str| match v.iter_mut().find(|(n, _)| n == k) {
        Some(e) => e.1 += 1,
        None => v.push((k.to_string(), 1)),
    };
    for l in lines {
        let Some(c) = DIAGNOSTIC.captures(l) else { continue };
        if c[3].eq_ignore_ascii_case("error") {
            errors += 1;
        } else {
            warnings += 1;
        }
        bump(&mut files, &c[1].replace('\\', "/"));
        if let Some(code) = c.get(4).map(|m| m.as_str()).filter(|s| !s.is_empty()) {
            bump(&mut codes, code);
        }
    }
    if errors + warnings < 5 {
        return None;
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    codes.sort_by(|a, b| b.1.cmp(&a.1));
    let list = |v: &[(String, usize)], n: usize| {
        let mut s = v.iter().take(n).map(|(k, c)| format!("{k} ({c})")).collect::<Vec<_>>().join(", ");
        if v.len() > n {
            s.push_str(&format!(", +{} more", v.len() - n));
        }
        s
    };
    let mut out = format!("Diagnostics: {errors} errors, {warnings} warnings in {} files: {}", files.len(), list(&files, 12));
    if !codes.is_empty() {
        out.push_str(&format!("\nMost common: {}", list(&codes, 8)));
    }
    out.push_str("\nFix them file by file; re-run the check for ONE file or grep the log instead of dumping everything again.");
    Some(out)
}

/// The whole output of a long command, for the model to grep later.
fn save_full_output(raw: &str) -> Option<PathBuf> {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = std::env::temp_dir().join("singularity-output");
    std::fs::create_dir_all(&dir).ok()?;
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = dir.join(format!("out-{}-{n}.log", std::process::id()));
    std::fs::write(&path, raw).ok()?;
    Some(path)
}

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
    let mut text = condense_output(text);
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
        .take(100)
        .collect();
    if hits.is_empty() {
        return ToolResult::ok(format!("no files match {pattern:?} under {}", base.display()));
    }
    let more = if hits.len() == 100 { "\n… (first 100 shown — narrow the pattern)" } else { "" };
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

/// `cp -r`: copies `from` to `to`, merging into existing folders and
/// overwriting existing files (collected in `overwritten`). Returns the
/// number of files copied.
fn copy_merge(from: &Path, to: &Path, overwritten: &mut Vec<PathBuf>) -> std::io::Result<u64> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        let mut n = 0;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            n += copy_merge(&e.path(), &to.join(e.file_name()), overwritten)?;
        }
        Ok(n)
    } else {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if to.is_dir() {
            return Err(std::io::Error::other(format!("{} is a folder, cannot overwrite it with a file", to.display())));
        }
        if to.exists() {
            overwritten.push(to.to_path_buf());
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
            let (from, into) = (lexical(&src), lexical(&target));
            if from == into {
                return ToolResult::err(format!("{op}: source and destination are the same ({shown})"));
            }
            if src.is_dir() && into.starts_with(&format!("{from}/")) {
                return ToolResult::err(format!("cannot {op} {shown} into itself ({})", target.display()));
            }
            if op == "copy" {
                // `cp -r` semantics (what Goose / Roo Code agents get from
                // the shell): copying onto an existing folder merges into it
                // and same-named files are overwritten; the result names them.
                if src.is_dir() && target.is_file() {
                    return ToolResult::err(format!("cannot copy folder {shown} onto file {}", target.display()));
                }
                let merged = target.is_dir();
                let mut overwritten = Vec::new();
                return match copy_merge(&src, &target, &mut overwritten) {
                    Ok(n) => {
                        let mut msg = format!("copied {shown} → {} ({n} files", target.display());
                        if merged {
                            msg.push_str(", merged into the existing folder");
                        }
                        if overwritten.is_empty() {
                            msg.push(')');
                        } else {
                            msg.push_str(&format!(", {} overwritten):", overwritten.len()));
                            for p in overwritten.iter().take(20) {
                                msg.push_str(&format!("\n  {}", p.display()));
                            }
                            if overwritten.len() > 20 {
                                msg.push_str(&format!("\n  … and {} more", overwritten.len() - 20));
                            }
                        }
                        ToolResult::ok(msg)
                    }
                    Err(e) => ToolResult::err(format!("copy failed: {e}")),
                };
            }
            if target.exists() {
                // Like `mv` onto a non-empty folder: never merge on a move.
                return ToolResult::err(format!(
                    "{} already exists — move does not overwrite; delete it first, pick another name, or copy instead (copy merges)",
                    target.display()
                ));
            }
            if let Some(parent) = target.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let res = {
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
    // Models often repeat the subcommand (or "git") at the head of `args`.
    let skip = args.iter().take(2).take_while(|a| a.as_str() == "git" || a.as_str() == sub).count();
    let args = &args[skip..];
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
    let text = condense_output(text);
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

    if matches!(name, "read_file" | "list_dir" | "grep" | "find_files") {
        if let Some((fixed, note)) = autocorrect(root, s("path"), name) {
            let mut args = args.clone();
            args["path"] = serde_json::Value::String(fixed);
            let mut res = dispatch(root, name, &args);
            res.output = format!("{note}{}", res.output);
            return res;
        }
    }

    match name {
        "read_file" => read_file(
            root,
            s("path"),
            args.get("start_line").and_then(|v| v.as_u64()).map(|v| v as usize),
            args.get("end_line").and_then(|v| v.as_u64()).map(|v| v as usize),
        ),
        // Writes or creates a file, its folders included (like Claude Code's
        // Write / Goose's text_editor write). The one refusal: a folder
        // name one typo away from a folder that has this very file — a
        // wrong guess at an existing file's path, not a new file. (A
        // same-named file ELSEWHERE — index.html — says nothing: refusing
        // then threw away a whole file the model had just written.)
        "write_file" => match resolve(root, s("path")) {
            Ok(full) if full.is_dir() => ToolResult::err(format!("{} is a directory", s("path"))),
            Ok(full) if !full.exists() => match mistyped_folder(&full) {
                Some(meant) => ToolResult::err(format!(
                    "refusing to create {}: its folder does not exist, but {} does — a typo in the folder name? \
                     Write to that file instead, or create the folder first with file_op mkdir if a new file is really intended.",
                    s("path"),
                    rel_to(root, &meant)
                )),
                None => write_file(root, s("path"), s("content")),
            },
            Ok(_) => write_file(root, s("path"), s("content")),
            Err(e) => ToolResult::err(e),
        },
        "background" => crate::bg::tool(args),
        "edit_file" => edit_file(root, s("path"), s("old_text"), s("new_text")),
        "apply_patch" => apply_patch(
            root,
            s("path"),
            s("diff"),
            args.get("create").and_then(|v| v.as_bool()).unwrap_or(false),
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
mod tests {
    use super::*;

    /// A fresh temp folder, removed on drop.
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(name: &str) -> Self {
            let p = std::env::temp_dir().join(format!("sing-tools-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
        fn write(&self, rel: &str, text: &str) {
            let f = self.0.join(rel);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, text).unwrap();
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn name_similarity_matches_difflib_cutoff() {
        assert!(name_similarity("compoents", "components") >= CLOSE_MATCH);
        assert!(name_similarity("Components", "components") == 1.0);
        assert!(name_similarity("src", "components") < CLOSE_MATCH);
    }

    #[test]
    fn misspelled_absolute_path_is_corrected_not_blamed_on_the_workspace() {
        let other = Tmp::new("nf-other");
        other.write("src/components/ui/button.tsx", "x");
        let ws = Tmp::new("nf-ws");
        let typo = other.0.join("src").join("compoents");
        let msg = not_found(&ws.0, &typo.to_string_lossy());
        assert!(!msg.contains("relative paths start at"), "{msg}");
        assert!(msg.contains("Did you mean") && msg.contains("components"), "{msg}");
        // Several wrong components down the path are fixed too (case, typo).
        let deep = other.0.join("SRC").join("componets").join("ui");
        assert!(not_found(&ws.0, &deep.to_string_lossy()).contains("Did you mean"));
        // Nothing close: shows what the folder holds instead of the workspace list.
        let far = other.0.join("src").join("zzzzzz");
        let msg = not_found(&ws.0, &far.to_string_lossy());
        assert!(!msg.contains("Did you mean") && msg.contains("contains: components/"), "{msg}");
    }

    #[test]
    fn missing_file_outside_the_workspace_is_searched_in_its_project() {
        let other = Tmp::new("nf-proj");
        other.write("package.json", "{}");
        other.write("src/styles.css", "body{}");
        other.write("src/theme/global.css", "x");
        let ws = Tmp::new("nf-proj-ws");
        let guess = other.0.join("src").join("styles").join("global.css");
        let msg = not_found(&ws.0, &guess.to_string_lossy());
        assert!(msg.contains("src/theme/global.css"), "{msg}");
    }

    #[test]
    fn read_only_tools_follow_an_obvious_typo() {
        let ws = Tmp::new("auto");
        ws.write("src/components/Button.tsx", "export const Button = 1;");
        let typo = ws.0.join("src").join("compoents");
        let res = dispatch(&ws.0, "list_dir", &serde_json::json!({ "path": typo.to_string_lossy() }));
        assert!(res.ok && res.output.contains("showing") && res.output.contains("Button.tsx"), "{}", res.output);
        let res = dispatch(&ws.0, "read_file", &serde_json::json!({ "path": "src/compoents/button.tsx" }));
        assert!(res.ok && res.output.contains("export const Button"), "{}", res.output);
        // A different file name is never guessed for a read.
        let res = dispatch(&ws.0, "read_file", &serde_json::json!({ "path": "src/components/Buton.tsx" }));
        assert!(!res.ok && res.output.contains("Did you mean"), "{}", res.output);
    }

    #[test]
    fn ambiguous_typos_are_not_followed() {
        let ws = Tmp::new("auto-amb");
        ws.write("test1/a.txt", "1");
        ws.write("test2/a.txt", "2");
        let res = dispatch(&ws.0, "list_dir", &serde_json::json!({ "path": "test3" }));
        assert!(!res.ok, "{}", res.output);
    }

    #[test]
    fn git_drops_a_repeated_subcommand() {
        let ws = Tmp::new("git-dup");
        let res = git(&ws.0, "status", &["status".into()], None);
        assert!(res.output.starts_with("git status  [in"), "{}", res.output);
    }

    #[test]
    fn relative_path_keeps_the_workspace_hint() {
        let ws = Tmp::new("nf-rel");
        ws.write("src/components/a.ts", "x");
        let msg = not_found(&ws.0, "src/compnents/a.ts");
        assert!(msg.contains("relative paths start at") && msg.contains("Did you mean"), "{msg}");
    }

    #[test]
    fn copy_into_existing_folder_merges_like_cp_r() {
        let src = Tmp::new("cp-src");
        src.write("ui/button.tsx", "new button");
        src.write("ui/input.tsx", "input");
        let ws = Tmp::new("cp-ws");
        ws.write("src/components/ui/button.tsx", "old button");
        ws.write("src/components/ui/keep.tsx", "keep");
        let res = file_op(&ws.0, "copy", &src.0.join("ui").to_string_lossy(), "src/components");
        assert!(res.ok, "{}", res.output);
        assert!(res.output.contains("merged") && res.output.contains("1 overwritten"), "{}", res.output);
        let ui = ws.0.join("src/components/ui");
        assert_eq!(std::fs::read_to_string(ui.join("button.tsx")).unwrap(), "new button");
        assert_eq!(std::fs::read_to_string(ui.join("input.tsx")).unwrap(), "input");
        assert_eq!(std::fs::read_to_string(ui.join("keep.tsx")).unwrap(), "keep");
    }

    #[test]
    fn copy_and_move_refuse_nonsense() {
        let ws = Tmp::new("cp-guard");
        ws.write("a/f.txt", "x");
        ws.write("b/a/f.txt", "y");
        assert!(!file_op(&ws.0, "copy", "a", "a/sub").ok, "into itself");
        assert!(!file_op(&ws.0, "copy", "a/f.txt", "a/f.txt").ok, "onto itself");
        let mv = file_op(&ws.0, "move", "a", "b");
        assert!(!mv.ok && mv.output.contains("move does not overwrite"), "{}", mv.output);
        assert_eq!(std::fs::read_to_string(ws.0.join("b/a/f.txt")).unwrap(), "y");
    }

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
        // The same diff again: REPLACE is already there — done, not an error.
        let res = apply_patch(&dir, "Hero.tsx", near, false);
        assert!(res.ok && res.output.contains("already contains"), "{}", res.output);
        assert_eq!(std::fs::read_to_string(dir.join("Hero.tsx")).unwrap(), now);
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
    fn big_files_read_as_preview_with_outline_and_paths_without_extension_resolve() {
        let dir = std::env::temp_dir().join(format!("sg_big_{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let mut ts = String::new();
        for i in 0..60 {
            ts.push_str(&format!("export function handler{i}(x: number) {{\n"));
            for j in 0..10 {
                ts.push_str(&format!("  const v{j} = x + {j};\n"));
            }
            ts.push_str("  return x;\n}\n\n");
        }
        std::fs::write(dir.join("src/big.ts"), &ts).unwrap();
        let res = dispatch(&dir, "read_file", &serde_json::json!({ "path": "src/big.ts" }));
        assert!(res.ok, "{}", res.output);
        assert!(res.output.starts_with("src/big.ts (lines 1-150 of 840)"), "{}", &res.output[..80]);
        assert!(res.output.contains("Large file") && res.output.contains("export function handler59(x: number) {"), "outline missing");
        assert!(res.output.contains("827-839"), "outline has line ranges");
        // An explicit range reads just that.
        let res = dispatch(&dir, "read_file", &serde_json::json!({ "path": "src/big.ts", "start_line": 827, "end_line": 830 }));
        assert!(res.output.contains("(lines 827-830 of 840)") && !res.output.contains("Large file"));
        // The extension left off: the one `big.*` file is meant.
        let res = dispatch(&dir, "read_file", &serde_json::json!({ "path": "src/big", "start_line": 1, "end_line": 1 }));
        assert!(res.ok && res.output.contains("does not exist — showing the file"), "{}", res.output);
        let res = dispatch(&dir, "list_dir", &serde_json::json!({ "path": "src/big" }));
        assert!(res.ok && res.output.contains("listing its folder"), "{}", res.output);
        // grep: grouped, relative, works on one file.
        let res = dispatch(&dir, "grep", &serde_json::json!({ "pattern": "return x", "path": "src/big.ts" }));
        assert!(res.output.starts_with("60 matches in 1 files\nsrc/big.ts:"), "{}", res.output);
        assert!(res.output.contains("… 48 more in this file"), "{}", res.output);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn long_command_output_is_condensed_with_a_diagnostics_summary() {
        // A tsc dump: 400 errors over 4 files, plus a progress bar and spam.
        let mut raw = String::from("Progress 1%\rProgress 50%\rProgress 100%\n");
        for i in 0..400 {
            raw.push_str(&format!("src/f{}.tsx({},5): error TS{}: Type 'x' is not assignable to type 'y'.\n", i % 4, i + 1, if i % 3 == 0 { 2322 } else { 2339 }));
        }
        raw.push_str(&"warning: same line\n".repeat(50));
        let out = condense_output(raw.clone());
        assert!(out.len() <= OUT_MAX_CHARS + 100, "{} chars", out.len());
        assert!(out.starts_with("Diagnostics: 400 errors"), "{out}");
        assert!(out.contains("src/f0.tsx (100)") && out.contains("TS2339 (266)"), "{out}");
        assert!(out.contains("Progress 100%") && !out.contains("Progress 50%"));
        assert!(out.contains("warning: same line  (×50)"), "{out}");
        // The middle is not lost: it is in the log the message points to.
        let log = out.split("the full output is in ").nth(1).unwrap().split(" (grep").next().unwrap();
        assert_eq!(std::fs::read_to_string(log).unwrap(), raw);
        let _ = std::fs::remove_file(log);
        // Short output passes untouched.
        assert_eq!(condense_output("ok\ndone".into()), "ok\ndone");
    }

    #[test]
    fn write_file_creates_new_files_but_not_wrong_paths() {
        let dir = std::env::temp_dir().join(format!("sg_write_{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src/layout")).unwrap();
        std::fs::write(dir.join("src/layout/Nav.tsx"), "x").unwrap();
        let w = |p: &str| dispatch(&dir, "write_file", &serde_json::json!({ "path": p, "content": "new\n" }));
        // A new file next to existing ones, and one in a brand-new folder.
        assert!(w("src/layout/AppLayout.tsx").ok);
        assert!(w("src/pages/Home.tsx").ok);
        assert_eq!(std::fs::read_to_string(dir.join("src/pages/Home.tsx")).unwrap(), "new\n");
        // A folder one typo away from the folder that has this file = a mistyped path.
        let res = w("src/layuot/Nav.tsx");
        assert!(!res.ok && res.output.contains("refusing") && res.output.contains("src/layout/Nav.tsx"), "{}", res.output);
        // A brand-new folder for a common name that exists elsewhere is just new.
        std::fs::write(dir.join("index.html"), "old").unwrap();
        assert!(w("bmw-service/index.html").ok);
        assert_eq!(std::fs::read_to_string(dir.join("bmw-service/index.html")).unwrap(), "new\n");
        assert!(typo_of("layout", "layuot") && typo_of("src", "scr") && !typo_of("bmw-service", "src") && !typo_of("public", "pages"));
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

        // A typo in a folder that has this file: refused.
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/a.txt"), "x").unwrap();
        let guess = apply_patch(&dir, "sbu/a.txt", create, true);
        assert!(!guess.ok && guess.output.contains("refusing"), "{}", guess.output);
        assert!(!dir.join("sbu").exists());
        // A new folder is just new.
        assert!(apply_patch(&dir, "fresh/a.txt", create, true).ok);

        let _ = std::fs::remove_dir_all(&dir);
    }
}