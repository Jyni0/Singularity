//! Built-in tool schemas exposed to the model, and the human-readable
//! rendering of tool arguments for the UI cards.

use crate::agent::context::one_line;
use crate::agent::AgentRequest;
use crate::tools;
use serde_json::{json, Value};

/* ---------- Tool schema exposed to the model ---------- */

/// Tool definitions in a neutral shape, converted per protocol when sent.
pub(in crate::agent) fn tool_specs(req: &AgentRequest) -> Value {
    let shell_names: Vec<&str> = if cfg!(windows) { vec!["bash", "powershell", "cmd"] } else { vec!["bash"] };
    let mut specs = json!([
        {
            "name": "read_file",
            "description": "Read a text file with line numbers. A file up to 400 lines comes whole; a bigger one read without a range gives its first 150 lines plus an OUTLINE of its definitions with line ranges — then read just the range you need with start_line/end_line. Lines you already read and that have not changed are not returned again: use the earlier output.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path — absolute or relative to the workspace." },
                    "start_line": { "type": "integer", "description": "First line to return (1-based)." },
                    "end_line": { "type": "integer", "description": "Last line to return." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "apply_patch",
            "description": "The main way to change files. The diff is one or more SEARCH/REPLACE blocks: <<<<<<< SEARCH / exact existing lines / ======= / new lines / >>>>>>> REPLACE (each marker on its own line). Only edit files you have read with read_file in this task — never invent paths or contents. Keep SEARCH short (a few lines) and copy it verbatim from the read, without line numbers. If a patch fails, the error shows the real lines — fix SEARCH from them instead of resending. Every edit is syntax-checked: when the result lists SYNTAX ERRORS (unclosed tags / brackets…), fix them in your very next step. New files: use write_file (or create:true with ONE block whose SEARCH side is EMPTY).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path — absolute or relative to the workspace." },
                    "diff": { "type": "string", "description": "SEARCH/REPLACE blocks exactly as specified." },
                    "create": { "type": "boolean", "description": "true ONLY to create a new file that does not exist yet." }
                },
                "required": ["path", "diff"]
            }
        },
        {
            "name": "write_file",
            "description": "Create a new file, or replace the WHOLE content of an existing file you have read. Use it for new files, when most of a file changes, or when apply_patch keeps failing — write the complete file, nothing omitted.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path — absolute or relative to the workspace; missing folders are created." },
                    "content": { "type": "string", "description": "The complete new file content." }
                },
                "required": ["path", "content"]
            }
        },
        {
            "name": "background",
            "description": "Manage background tasks started with run_command background:true (dev servers, watchers, long builds): list them, read a task's latest output, or stop it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "output", "stop"] },
                    "id": { "type": "integer", "description": "Task id (from run_command or list) — for output / stop." },
                    "max_chars": { "type": "integer", "description": "Output tail length, default 6000." }
                },
                "required": ["action"]
            }
        },
        {
            "name": "list_dir",
            "description": "List the entries of a directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory path — absolute or relative, or \"\" for the workspace root." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "grep",
            "description": "Search for a literal string in a folder or one file. Returns matches grouped by file (paths relative to the workspace) with line numbers; capped, so make the pattern specific. Then read_file just the lines around a match.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Text to find." },
                    "path": { "type": "string", "description": "Optional directory to search in — absolute or relative." }
                },
                "required": ["pattern"]
            }
        },
        {
            "name": "find_files",
            "description": "Find files and folders by name with a glob: \"*.tsx\", \"package.json\", \"src/**/*.test.ts\", \"*config*\", \"*.{ts,tsx}\". A pattern without / matches the name anywhere below. Skips node_modules, .git, build output. Use this instead of guessing paths.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Glob pattern (case-insensitive)." },
                    "path": { "type": "string", "description": "Optional folder to search in; defaults to the working directory." }
                },
                "required": ["pattern"]
            }
        },
        {
            "name": "change_dir",
            "description": "Change the working directory (like cd) for all following tools and commands, and list it. \"..\" goes up, \"\" returns to the workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Folder — absolute or relative to the current working directory." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "file_op",
            "description": "File and folder operations without a shell: mkdir (with parents), move / rename (never overwrites), copy (folders recursively, like cp -r: into an existing folder it merges and overwrites same-named files — the result lists them), delete (folders recursively), info (exists? size?).",
            "parameters": {
                "type": "object",
                "properties": {
                    "op": { "type": "string", "enum": ["mkdir", "move", "copy", "delete", "info"] },
                    "path": { "type": "string", "description": "The file or folder to act on." },
                    "to": { "type": "string", "description": "Destination for move / copy; an existing folder keeps the name." }
                },
                "required": ["op", "path"]
            }
        },
        {
            "name": "git",
            "description": "Run git without shell quoting problems: ONE subcommand plus its arguments as a list. status/diff/log/show/blame never need approval; log defaults to the last 20 commits. No pager, no editor — always pass -m for commit.",
            "parameters": {
                "type": "object",
                "properties": {
                    "subcommand": { "type": "string", "description": "status, diff, log, show, add, commit, checkout, switch, branch, restore, stash, pull, push, fetch, merge, rebase…" },
                    "args": { "type": "array", "items": { "type": "string" }, "description": "Arguments, one per item, e.g. [\"-m\", \"Fix login\"] or [\"--stat\"]." },
                    "cwd": { "type": "string", "description": "Optional repository folder; defaults to the working directory." }
                },
                "required": ["subcommand"]
            }
        },
        {
            "name": "web_search",
            "description": "Search the internet. Returns titles, URLs and snippets; open a result with web_fetch. Use for docs, error messages, library versions, anything current.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query." },
                    "max_results": { "type": "integer", "description": "1-20, default 8." }
                },
                "required": ["query"]
            }
        },
        {
            "name": "web_fetch",
            "description": "Download a web page (or JSON / text URL) and return it as readable text with links kept. Long pages come in parts: call again with the `start` it gives.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "http(s) URL." },
                    "start": { "type": "integer", "description": "Character offset for the next part of a long page." }
                },
                "required": ["url"]
            }
        },
        {
            "name": "run_command",
            "description": format!(
                "Run a shell command; returns its output, exit code, the shell and the folder it ran in. \
                 For builds, tests, package managers and project scripts — for files, folders, git and the web use the dedicated tools. \
                 {} Commands get no input: pass --yes / -y style flags. \
                 Anything that runs long or never exits (dev servers, watchers, long builds): set background:true — it returns a task id \
                 right away with the first output; check it later with the background tool and stop it there when done.",
                crate::tools::shell_summary()
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Command line to execute." },
                    "cwd": { "type": "string", "description": "Optional working directory — absolute or relative. Defaults to the current working directory." },
                    "shell": { "type": "string", "enum": shell_names, "description": "Optional; the default is described above." },
                    "background": { "type": "boolean", "description": "Keep running after the tool returns (dev servers, watchers)." },
                    "timeout_secs": { "type": "integer", "description": "Optional timeout, default 120, max 600." }
                },
                "required": ["command"]
            }
        }
    ]);
    if req.image_gen.is_some() {
        specs.as_array_mut().unwrap().push(json!({
            "name": "generate_image",
            "description": "Generate a picture (photo, illustration, logo, icon…) from a text description. \
                 The picture appears in the chat for the user by itself; you get its file path back. \
                 Write the prompt in English with the subject, style, composition, lighting and colours.",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "Detailed description of the picture." },
                    "size": {
                        "type": "string",
                        "enum": ["auto", "1024x1024", "1536x1024", "1024x1536"],
                        "description": "Square, landscape or portrait; default auto."
                    }
                },
                "required": ["prompt"]
            }
        }));
    }
    if !req.disabled_tools.is_empty() {
        if let Some(list) = specs.as_array_mut() {
            list.retain(|t| !req.disabled_tools.iter().any(|d| t["name"].as_str() == Some(d.as_str())));
        }
    }
    specs
}

/// Short, human-readable rendering of a tool's arguments for the UI.
pub(in crate::agent) fn summarize(name: &str, args: &Value) -> String {
    let get = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("");
    match name {
        "run_command" => {
            let cmd = get("command");
            let cwd = get("cwd");
            let bg = if args.get("background").and_then(|v| v.as_bool()).unwrap_or(false) { "  [background]" } else { "" };
            if cwd.is_empty() {
                format!("{cmd}{bg}")
            } else {
                // Show WHERE the command runs — "launches commands somewhere
                // on my PC" was a real complaint; the card must name the place.
                format!("{cmd}  [in {cwd}]")
            }
        }
        "read_file" => {
            let s = get("start_line");
            let e = get("end_line");
            if s.is_empty() && e.is_empty() {
                get("path").to_string()
            } else {
                format!("{} ({}–{})", get("path"), s, e)
            }
        }
        "grep" => format!("\"{}\" in {}", get("pattern"), if get("path").is_empty() { "." } else { get("path") }),
        "write_file" => format!("{} ({} bytes)", get("path"), get("content").len()),
        "apply_patch" => {
            let hunks = tools::parse_patch(get("diff")).len();
            format!("{} ({} hunks)", get("path"), hunks)
        }
        "list_dir" | "change_dir" => get("path").to_string(),
        "find_files" => {
            if get("path").is_empty() {
                get("pattern").to_string()
            } else {
                format!("{} in {}", get("pattern"), get("path"))
            }
        }
        "file_op" => {
            if get("to").is_empty() {
                format!("{} {}", get("op"), get("path"))
            } else {
                format!("{} {} → {}", get("op"), get("path"), get("to"))
            }
        }
        "git" => {
            let rest = match args.get("args") {
                Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(" "),
                Some(Value::String(t)) => t.clone(),
                _ => String::new(),
            };
            one_line(&format!("git {} {rest}", get("subcommand")), 100)
        }
        "web_search" => get("query").to_string(),
        "background" => match args.get("id").and_then(|v| v.as_u64()) {
            Some(id) => format!("{} #{id}", get("action")),
            None => get("action").to_string(),
        },
        "web_fetch" => get("url").to_string(),
        "generate_image" => one_line(get("prompt"), 100),
        "delegate" => format!("{}: {}", get("agent"), one_line(get("task"), 80)),
        "skill" => {
            if get("file").is_empty() {
                get("name").to_string()
            } else {
                format!("{}: {}", get("name"), get("file"))
            }
        }
        "mcp_find" => get("query").to_string(),
        "mcp_call" => format!("{} {}", get("tool"), one_line(&args.get("arguments").map(|a| a.to_string()).unwrap_or_default(), 90)),
        // MCP tools have arbitrary arguments — show them compactly.
        n if n.starts_with("mcp__") => one_line(&args.to_string(), 100),
        _ => get("path").to_string(),
    }
}

/// Card input for a call whose JSON arguments may still be incomplete.
pub(in crate::agent) fn live_summary(name: &str, args: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(args) {
        return summarize(name, &v);
    }
    let key = match name {
        "run_command" => "command",
        "grep" | "find_files" => "pattern",
        "web_search" => "query",
        "web_fetch" => "url",
        "generate_image" => "prompt",
        "git" => "subcommand",
        "delegate" => "agent",
        "skill" => "name",
        "mcp_find" => "query",
        "mcp_call" => "tool",
        _ => "path",
    };
    let head = partial_field(args, key).unwrap_or_default();
    if args.len() < 64 {
        format!("{head}…")
    } else {
        format!("{head} … ({} chars)", args.len())
    }
}

/// Reads a string field out of a possibly truncated JSON object.
fn partial_field(json: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\"");
    let at = json.find(&pat)? + pat.len();
    let rest = json[at..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    let mut out = String::new();
    let mut esc = false;
    for ch in rest.chars() {
        if esc {
            out.push(if ch == 'n' || ch == 't' { ' ' } else { ch });
            esc = false;
            continue;
        }
        match ch {
            '\\' => esc = true,
            '"' => break,
            c => out.push(c),
        }
    }
    Some(one_line(&out, 80))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_field_reads_truncated_json() {
        assert_eq!(partial_field(r#"{"path":"src/ma"#, "path").as_deref(), Some("src/ma"));
        assert_eq!(partial_field(r#"{"path": "a\"b", "diff":"x"#, "path").as_deref(), Some("a\"b"));
        assert_eq!(partial_field(r#"{"diff":"x"#, "path"), None);
    }

    #[test]
    fn live_summary_uses_full_json_when_complete() {
        assert_eq!(live_summary("list_dir", r#"{"path":"src"}"#), "src");
        assert!(live_summary("apply_patch", r#"{"path":"a.rs","diff":"<<<"#).starts_with("a.rs"));
    }
}
