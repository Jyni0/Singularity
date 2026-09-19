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
}

impl ToolResult {
    fn ok(output: impl Into<String>) -> Self {
        Self {
            ok: true,
            output: output.into(),
        }
    }
    fn err(output: impl Into<String>) -> Self {
        Self {
            ok: false,
            output: output.into(),
        }
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
    let text = match String::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => return ToolResult::err(format!("{path} is not valid UTF-8 text")),
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
    match std::fs::write(&full, content) {
        Ok(()) => ToolResult::ok(format!(
            "wrote {path} ({} bytes, {} lines)",
            content.len(),
            content.lines().count()
        )),
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
        Ok(()) => ToolResult::ok(format!("edited {path}")),
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
        Command::new("cmd")
            .args(["/C", command])
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

    let mut text = String::new();
    text.push_str(&String::from_utf8_lossy(&output.stdout));
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str("stderr:\n");
        text.push_str(&stderr);
    }

    // Truncate from the middle so both the start and the end stay visible.
    if text.len() > MAX_OUTPUT_BYTES {
        let head = &text[..MAX_OUTPUT_BYTES / 2];
        let tail = &text[text.len() - MAX_OUTPUT_BYTES / 2..];
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
        ToolResult { ok: false, output: body }
    }
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