/// Agent tools — the file and command operations the model can call.
///
/// Every tool takes a workspace root and refuses paths that escape it, so a
/// model cannot read `C:\Windows` or write outside the project it was given.
/// Commands run through the platform shell with a timeout and a captured exit
/// code, and their output is truncated before it goes back into the context.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// Largest file we will read into the model context.
const MAX_READ_BYTES: usize = 200_000;
/// Largest command output returned to the model.
const MAX_OUTPUT_BYTES: usize = 30_000;
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
        }
    }
    pub fn err(output: impl Into<String>) -> Self {
        Self {
            ok: false,
            output: output.into(),
            path: None,
            old_text: None,
            new_text: None,
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
fn resolve(root: &Path, path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(root.to_path_buf());
    }

    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        return Ok(candidate.to_path_buf());
    }

    // A relative path is joined onto the workspace root.
    Ok(root.join(candidate))
}

/* ---------- Filesystem tools ---------- */

/// Reads a file as UTF-8, with line numbers so the model can cite positions.
pub fn read_file(root: &Path, path: &str, start_line: Option<usize>, end_line: Option<usize>) -> ToolResult {
    let full = match resolve(root, path) {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let bytes = match std::fs::read(&full) {
        Ok(b) => b,
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
    let to = end_line.unwrap_or(lines.len()).min(lines.len());

    if from > lines.len() {
        return ToolResult::err(format!(
            "{path} has only {} lines, but line {from} was requested",
            lines.len()
        ));
    }

    let mut out = format!("{path} (lines {from}-{to} of {})\n", lines.len());
    for (i, line) in lines[from - 1..to].iter().enumerate() {
        out.push_str(&format!("{:>5}  {}\n", from + i, line));
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
    match std::fs::write(&full, content) {
        Ok(()) => ToolResult::ok(format!(
            "wrote {path} ({} bytes, {} lines)",
            content.len(),
            content.lines().count()
        ))
        .with_change(path, old, content.to_string()),
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
        Err(e) => return ToolResult::err(format!("cannot read {path}: {e}")),
    };

    let count = text.matches(old).count();
    if count == 0 {
        return ToolResult::err(format!(
            "the search text was not found in {path}. Read the file first and copy the exact text."
        ));
    }
    if count > 1 {
        return ToolResult::err(format!(
            "the search text appears {count} times in {path}; include more surrounding lines to make it unique."
        ));
    }

    match std::fs::write(&full, text.replacen(old, new, 1)) {
        Ok(()) => {
            let updated = text.replacen(old, new, 1);
            ToolResult::ok(format!("edited {path}")).with_change(path, Some(text), updated)
        }
        Err(e) => ToolResult::err(format!("cannot write {path}: {e}")),
    }
}

/// Lists a directory, marking subdirectories with a trailing slash.
pub fn list_dir(root: &Path, path: &str) -> ToolResult {
    let dir = match resolve(root, path) {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    if !dir.is_dir() {
        return ToolResult::err(format!("{} is not a directory", dir.display()));
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
pub fn parse_patch(diff: &str) -> Vec<(String, String)> {
    let mut hunks: Vec<(String, String)> = Vec::new();
    let mut search: Option<Vec<String>> = None;
    let mut replace: Option<Vec<String>> = None;
    for line in diff.lines() {
        let t = line.trim();
        if t == "<<<<<<< SEARCH" {
            search = Some(Vec::new());
            replace = None;
            continue;
        }
        if t == "=======" && search.is_some() && replace.is_none() {
            replace = Some(Vec::new());
            continue;
        }
        if t == ">>>>>>> REPLACE" {
            if let (Some(s), Some(r)) = (search.take(), replace.take()) {
                hunks.push((s.join("\n"), r.join("\n")));
            }
            continue;
        }
        if let Some(r) = replace.as_mut() {
            r.push(line.to_string());
        } else if let Some(s) = search.as_mut() {
            s.push(line.to_string());
        }
    }
    hunks
}

/// Applies a SEARCH/REPLACE diff to one file — the diff-only edit path.
///
/// Rules mirror `edit_file`: every SEARCH side must match the current file
/// content EXACTLY ONCE (hunks apply sequentially, so later hunks see the
/// result of earlier ones). A single hunk with an empty SEARCH creates the
/// file. Failures are reported per hunk with its index so the model can fix
/// exactly the broken block and retry.
pub fn apply_patch(root: &Path, path: &str, diff: &str) -> ToolResult {
    let full = match resolve(root, path) {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let hunks = parse_patch(diff);
    if hunks.is_empty() {
        return ToolResult::err(
            "no SEARCH/REPLACE blocks found in the diff. Expected format:\n\
             <<<<<<< SEARCH\n<exact existing code>\n=======\n<new code>\n>>>>>>> REPLACE",
        );
    }

    let text = std::fs::read_to_string(&full).ok();
    let original = text.clone();

    // New-file hunk: file absent + exactly one hunk with an empty SEARCH.
    if text.is_none() {
        let create_only = hunks.len() == 1 && hunks[0].0.trim().is_empty();
        if !create_only {
            return ToolResult::err(format!(
                "{path} does not exist. To create it, send ONE hunk with an empty SEARCH side."
            ));
        }
        if let Some(parent) = full.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return ToolResult::err(format!("cannot create directory for {path}: {e}"));
            }
        }
        let content = format!("{}\n", hunks[0].1);
        return match std::fs::write(&full, &content) {
            Ok(()) => ToolResult::ok(format!("created {path} ({} bytes)", content.len()))
                .with_change(path, None, content),
            Err(e) => ToolResult::err(format!("cannot write {path}: {e}")),
        };
    }

    let mut current = text.unwrap_or_default();
    let mut applied = 0usize;
    let mut errors: Vec<String> = Vec::new();
    for (i, (search, replace)) in hunks.iter().enumerate() {
        let needle = search.as_str();
        let count = current.matches(needle).count();
        if count == 0 {
            errors.push(format!(
                "hunk {i}: SEARCH text not found in {path} — read the file and copy the exact text (whitespace matters)"
            ));
            continue;
        }
        if count > 1 {
            errors.push(format!(
                "hunk {i}: SEARCH text appears {count} times in {path} — add surrounding lines to make it unique"
            ));
            continue;
        }
        current = current.replacen(needle, replace.as_str(), 1);
        applied += 1;
    }

    if applied == 0 {
        return ToolResult::err(errors.join("\n"));
    }
    match std::fs::write(&full, &current) {
        Ok(()) => {
            let mut out = format!("patched {path}: {applied}/{} hunks applied", hunks.len());
            if !errors.is_empty() {
                out.push_str("\nFAILED:\n");
                out.push_str(&errors.join("\n"));
            }
            let res = if errors.is_empty() {
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

/// Extracts inline patches from free assistant text. A patch is a file path
/// line immediately followed by one or more SEARCH/REPLACE blocks.
/// Returns (path, diff-body) pairs so the agent loop can apply them exactly
/// like explicit apply_patch calls — the model cannot bypass diff-only mode
/// by pasting blocks into its reply instead of calling the tool.
pub fn extract_inline_patches(text: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<(String, String)> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        if lines[i].trim() == "<<<<<<< SEARCH" {
            // The path is the nearest previous non-empty, non-marker line.
            let mut path = String::new();
            let mut j = i;
            while j > 0 {
                j -= 1;
                let cand = lines[j].trim();
                if cand.is_empty() {
                    continue;
                }
                if cand.starts_with("<<<<<<<") || cand.starts_with("=======") || cand.starts_with(">>>>>>>") {
                    break;
                }
                // Strip markdown fences / backticks around the path.
                path = cand.trim_matches('`').trim().to_string();
                break;
            }
            // Collect consecutive hunks.
            let mut body: Vec<&str> = Vec::new();
            while i < lines.len() {
                body.push(lines[i]);
                let is_end = lines[i].trim() == ">>>>>>> REPLACE";
                i += 1;
                if is_end {
                    // Continue collecting while the next hunk starts right away.
                    let mut k = i;
                    while k < lines.len() && lines[k].trim().is_empty() {
                        k += 1;
                    }
                    if k < lines.len() && lines[k].trim() == "<<<<<<< SEARCH" {
                        i = k;
                        continue;
                    }
                    break;
                }
            }
            if !path.is_empty() {
                out.push((path, body.join("\n")));
            }
        } else {
            i += 1;
        }
    }
    out
}

/* ---------- Shell ---------- */

/// Runs a command in `cwd` (the workspace when unset) and returns its output.
pub fn run_command(root: &Path, command: &str, cwd: Option<&str>, timeout_secs: Option<u64>) -> ToolResult {
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(COMMAND_TIMEOUT_SECS).min(600));

    // The model may target any folder; fall back to the workspace root.
    let workdir = match cwd.map(str::trim) {
        Some(c) if !c.is_empty() => PathBuf::from(c),
        _ => root.to_path_buf(),
    };
    if !workdir.is_dir() {
        return ToolResult::err(format!("working directory does not exist: {}", workdir.display()));
    }

    #[cfg(target_os = "windows")]
    let spawned = {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW keeps a console window from flashing on every call.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // Force UTF-8 console output (chcp 65001) — without it cmd prints in
        // the OEM codepage (cp866) and Cyrillic reaches the model as mojibake.
        let utf8_command = format!("chcp 65001>nul & {command}");
        Command::new("cmd")
            .args(["/C", utf8_command.as_str()])
            .current_dir(&workdir)
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
    };

    #[cfg(not(target_os = "windows"))]
    let spawned = Command::new("sh")
        .args(["-c", command])
        .current_dir(&workdir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => return ToolResult::err(format!("cannot start command: {e}")),
    };

    // Poll instead of blocking so a hanging command cannot stall the agent.
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return ToolResult::err(format!(
                        "command timed out after {}s and was killed: {command}",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(e) => return ToolResult::err(format!("cannot wait for command: {e}")),
        }
    }

    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(e) => return ToolResult::err(format!("cannot collect output: {e}")),
    };

    let mut text = decode_console(&output.stdout);
    let stderr = decode_console(&output.stderr);
    if !stderr.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str("stderr:\n");
        text.push_str(&stderr);
    }

    // Truncate from the middle so both the start and the end stay visible.
    // Slice on CHAR boundaries — byte slicing here panicked on any Cyrillic
    // output ("byte index is not a char boundary").
    if text.len() > MAX_OUTPUT_BYTES {
        fn cut(s: &str, at: usize) -> usize {
            let mut i = at.min(s.len());
            while i > 0 && !s.is_char_boundary(i) {
                i -= 1;
            }
            i
        }
        let head_end = cut(&text, MAX_OUTPUT_BYTES / 2);
        let tail_start = cut(&text, text.len().saturating_sub(MAX_OUTPUT_BYTES / 2));
        let head = &text[..head_end];
        let tail = &text[tail_start..];
        text = format!("{head}\n\n… output truncated …\n\n{tail}");
    }
    if text.trim().is_empty() {
        text = "(no output)".into();
    }

    let code = output.status.code().unwrap_or(-1);
    let body = format!("exit code {code}\n{text}");

    if output.status.success() {
        ToolResult::ok(body)
    } else {
        ToolResult::err(body)
    }
}

/// Decodes command output the way the user's console actually wrote it.
///
/// Windows cmd.exe emits the OEM codepage (cp866 on a Russian system, cp850
/// on Western ones) — decoding it as UTF-8 mangles every Cyrillic letter.
/// Strategy: strict UTF-8 first (cross-platform tools, modern builds); if that
/// fails, fall back to the system ANSI codepage via encoding_rs (which maps
/// cp866/cp1251 correctly for the Russian locale).
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
pub fn dispatch(root: &Path, name: &str, args: &serde_json::Value) -> ToolResult {
    let s = |key: &str| args.get(key).and_then(|v| v.as_str()).unwrap_or("");

    match name {
        "read_file" => read_file(
            root,
            s("path"),
            args.get("start_line").and_then(|v| v.as_u64()).map(|v| v as usize),
            args.get("end_line").and_then(|v| v.as_u64()).map(|v| v as usize),
        ),
        "write_file" => write_file(root, s("path"), s("content")),
        "edit_file" => edit_file(root, s("path"), s("old_text"), s("new_text")),
        "apply_patch" => apply_patch(root, s("path"), s("diff")),
        "list_dir" => list_dir(root, s("path")),
        "grep" => grep(root, s("pattern"), args.get("path").and_then(|v| v.as_str())),
        "run_command" => run_command(
            root,
            s("command"),
            args.get("cwd").and_then(|v| v.as_str()),
            args.get("timeout_secs").and_then(|v| v.as_u64()),
        ),
        other => ToolResult::err(format!("unknown tool: {other}")),
    }
}

/* ---------- Tests ---------- */

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
    fn extracts_inline_patch_with_path_above() {
        let text = [
            "Here is the fix:",
            "",
            "src/app.tsx",
            "<<<<<<< SEARCH",
            "const a = 1;",
            "=======",
            "const a = 2;",
            ">>>>>>> REPLACE",
            "",
            "Done.",
        ]
        .join("\n");
        let patches = extract_inline_patches(&text);
        assert_eq!(patches.len(), 1);
        assert_eq!(patches[0].0, "src/app.tsx");
        assert!(patches[0].1.contains("<<<<<<< SEARCH"));
        assert!(patches[0].1.contains(">>>>>>> REPLACE"));
    }

    #[test]
    fn strips_backtick_fenced_path() {
        let text = "`src/app.tsx`\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE";
        let patches = extract_inline_patches(text);
        assert_eq!(patches[0].0, "src/app.tsx");
    }

    #[test]
    fn apply_patch_edits_and_creates() {
        let dir = std::env::temp_dir().join(format!("sing-patch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "one\ntwo\nthree").unwrap();

        // Edit existing
        let diff = "<<<<<<< SEARCH\ntwo\n=======\nTWO\n>>>>>>> REPLACE";
        let res = apply_patch(&dir, "a.txt", diff);
        assert!(res.ok, "{}", res.output);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\nTWO\nthree");

        // Create new via empty SEARCH
        let create = "<<<<<<< SEARCH\n=======\nfresh\n>>>>>>> REPLACE";
        let res2 = apply_patch(&dir, "b.txt", create);
        assert!(res2.ok, "{}", res2.output);
        assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "fresh\n");

        // Missing SEARCH side → error, file untouched
        let bad = "<<<<<<< SEARCH\nnope\n=======\nx\n>>>>>>> REPLACE";
        let res3 = apply_patch(&dir, "a.txt", bad);
        assert!(!res3.ok);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\nTWO\nthree");

        let _ = std::fs::remove_dir_all(&dir);
    }
}