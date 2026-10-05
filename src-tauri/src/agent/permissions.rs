//! The permission gate: which tool calls wait for the user's Allow/Deny.
//! Commands need a yes unless the project runs them automatically; risky
//! commands, secrets and writes to system / outside-project paths ALWAYS do.

use crate::tools;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// What the Allow/Deny banner shows for a call that needs a yes.
pub(in crate::agent) struct Gate {
    pub what: String,
    pub place: String,
    pub reason: String,
}

/// The gate of any registry call. MCP tools act outside the app — they ask
/// like commands do, unless the server marks the tool read-only or the
/// project auto-runs; mcp_call is gated as the MCP tool it runs.
pub(in crate::agent) fn gate(
    registry: &crate::agent::tools::ToolRegistry,
    tool: &str,
    args: &Value,
    workspace: &str,
    cwd: &str,
    auto_run: bool,
) -> Option<Gate> {
    match registry.mcp_target(tool, args) {
        Some(t) => (!auto_run && !t.read_only).then(|| Gate {
            what: format!("{} {}", t.tool, crate::agent::context::one_line(&t.args.to_string(), 200)),
            place: format!("MCP server {}", t.server),
            reason: String::new(),
        }),
        // An unknown mcp_call target runs nothing.
        None if tool == "mcp_call" => None,
        None => permission_gate(tool, args, workspace, cwd, auto_run),
    }
}

/// Decides whether a built-in tool call must wait for the user. `reason` is empty
/// for the plain "commands need approval" case and names the danger
/// otherwise.
pub(in crate::agent) fn permission_gate(tool: &str, args: &Value, workspace: &str, cwd: &str, auto_run: bool) -> Option<Gate> {
    let get = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("");
    // A file the call writes / reads: sensitive paths always ask, writes
    // outside the project ask unless the project auto-runs.
    let path_gate = |path: &str, write: bool, verb: &str| -> Option<Gate> {
        let full = full_path(cwd, path);
        let reason = if let Some(why) = crate::safety::sensitive_path(&full.to_string_lossy(), write) {
            format!("{} {}", if write { "Writes a file that" } else { "Reads a file that" }, why)
        } else if write && !auto_run && !is_inside(&full, Path::new(workspace)) {
            "Writes outside the project folder".to_string()
        } else {
            return None;
        };
        Some(Gate {
            what: format!("{verb} {}", full.display()),
            place: workspace.to_string(),
            reason,
        })
    };
    match tool {
        "run_command" => {
            let cmd = get("command");
            let risky = crate::safety::risky_command(cmd);
            if auto_run && risky.is_none() {
                return None;
            }
            let place = if get("cwd").is_empty() {
                cwd.to_string()
            } else {
                full_path(cwd, get("cwd")).display().to_string()
            };
            Some(Gate {
                what: cmd.to_string(),
                place,
                reason: risky.map(|r| format!("Risky command: {r}")).unwrap_or_default(),
            })
        }
        "git" => {
            let sub = get("subcommand").trim().to_string();
            let rest = match args.get("args") {
                Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(" "),
                Some(Value::String(t)) => t.clone(),
                _ => String::new(),
            };
            let line = format!("git {sub} {rest}").trim().to_string();
            let risky = crate::safety::risky_command(&line);
            // Read-only subcommands never ask (a `branch`/`tag`/`remote`
            // with arguments may change things, so those do).
            let read_only = tools::GIT_READ_ONLY.contains(&sub.as_str())
                && (rest.is_empty() || !matches!(sub.as_str(), "branch" | "tag" | "remote"));
            if risky.is_none() && (read_only || auto_run) {
                return None;
            }
            Some(Gate {
                what: line,
                place: if get("cwd").is_empty() { cwd.to_string() } else { full_path(cwd, get("cwd")).display().to_string() },
                reason: risky.map(|r| format!("Risky command: {r}")).unwrap_or_default(),
            })
        }
        "file_op" => match get("op") {
            "info" | "exists" => None,
            "delete" => {
                let full = full_path(cwd, get("path"));
                let inside = is_inside(&full, Path::new(workspace));
                if auto_run && inside && crate::safety::sensitive_path(&full.to_string_lossy(), true).is_none() {
                    return None;
                }
                Some(Gate {
                    what: format!("delete {}", full.display()),
                    place: workspace.to_string(),
                    reason: if inside { String::new() } else { "Deletes outside the project folder".into() },
                })
            }
            "move" | "rename" => path_gate(get("path"), true, "move").or_else(|| path_gate(get("to"), true, "move to")),
            "copy" => path_gate(get("to"), true, "copy to"),
            _ => path_gate(get("path"), true, "create"),
        },
        "read_file" | "list_dir" | "grep" | "find_files" | "apply_patch" | "write_file" | "edit_file" => {
            let write = matches!(tool, "apply_patch" | "write_file" | "edit_file");
            path_gate(get("path"), write, if write { "edit" } else { "read" })
        }
        _ => None,
    }
}

/// The path a tool will touch, relative paths joined onto the workspace and
/// `.`/`..` folded lexically (the file may not exist yet).
pub(in crate::agent) fn full_path(workspace: &str, path: &str) -> PathBuf {
    let p = Path::new(path.trim());
    let joined = if p.is_absolute() { p.to_path_buf() } else { Path::new(workspace).join(p) };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

fn is_inside(path: &Path, root: &Path) -> bool {
    if root.as_os_str().is_empty() {
        return true;
    }
    // Windows paths compare case-insensitively.
    let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase();
    let (p, r) = (norm(path), norm(root));
    p == r || p.starts_with(&(r + "/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn gates_follow_the_tool() {
        let ws = if cfg!(windows) { "C:/proj" } else { "/proj" };
        assert!(permission_gate("git", &json!({"subcommand": "status"}), ws, ws, false).is_none());
        assert!(permission_gate("git", &json!({"subcommand": "commit", "args": ["-m", "x"]}), ws, ws, false).is_some());
        assert!(permission_gate("git", &json!({"subcommand": "commit", "args": ["-m", "x"]}), ws, ws, true).is_none());
        assert!(permission_gate("git", &json!({"subcommand": "reset", "args": ["--hard"]}), ws, ws, true).is_some());
        assert!(permission_gate("file_op", &json!({"op": "delete", "path": "a"}), ws, ws, false).is_some());
        assert!(permission_gate("file_op", &json!({"op": "delete", "path": "a"}), ws, ws, true).is_none());
        assert!(permission_gate("file_op", &json!({"op": "mkdir", "path": "a/b"}), ws, ws, false).is_none());
        assert!(permission_gate("web_fetch", &json!({"url": "https://x"}), ws, ws, false).is_none());
    }
}
