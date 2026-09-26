//! Tool schema exposed to the model, the default system prompt, and the
//! human-readable rendering of tool arguments for the UI.

use super::context::one_line;
use super::AgentRequest;
use crate::tools;
use serde_json::{json, Value};

/* ---------- Tool schema exposed to the model ---------- */

/// Tool definitions in a neutral shape, converted per protocol when sent.
/// The ssh_exec tool is appended only when the project has saved SSH units,
/// so the model never sees a tool it cannot use.
pub(super) fn tool_specs(req: &AgentRequest) -> Value {
    let mut specs = json!([
        {
            "name": "read_file",
            "description": "Read a text file. Returns the contents with line numbers. Use start_line/end_line for large files.",
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
            "description": "THE ONLY way to change files (diff-only mode). The diff is one or more SEARCH/REPLACE blocks: <<<<<<< SEARCH / exact existing code / ======= / new code / >>>>>>> REPLACE. To create a new file send ONE block with an EMPTY SEARCH side. Every SEARCH side must match the file exactly once — read the file first and copy the text verbatim.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path — absolute or relative to the workspace." },
                    "diff": { "type": "string", "description": "SEARCH/REPLACE blocks exactly as specified." }
                },
                "required": ["path", "diff"]
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
            "description": "Search for a literal string across files. Returns matching lines with file paths and line numbers.",
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
            "name": "run_command",
            "description": "Run a shell command and return its combined output and exit code. Use for builds, tests and git. On Windows this runs through cmd, elsewhere through sh.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Command line to execute." },
                    "cwd": { "type": "string", "description": "Optional working directory as an absolute path. Defaults to the workspace." },
                    "timeout_secs": { "type": "integer", "description": "Optional timeout, default 120." }
                },
                "required": ["command"]
            }
        }
    ]);
    if !req.ssh_units.is_empty() {
        let names: Vec<String> = req.ssh_units.iter().map(|u| u.name.clone()).collect();
        let hint = req
            .ssh_units
            .iter()
            .map(|u| format!("{} = {}", u.name, u.host))
            .collect::<Vec<_>>()
            .join(", ");
        specs.as_array_mut().unwrap().push(json!({
            "name": "ssh_exec",
            "description": format!(
                "Run a command on a remote server over SSH and return its output. \
                 Available units (server → host): {hint}. Connections are pooled \
                 and authenticated automatically from saved credentials."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "server": {
                        "type": "string",
                        "enum": names,
                        "description": "Which saved SSH unit to run on."
                    },
                    "command": { "type": "string", "description": "Command line to execute on the remote server." }
                },
                "required": ["server", "command"]
            }
        }));
    }
    specs
}

/// Default system prompt — tells the model it can act, not just answer.
pub(super) fn default_system() -> String {
    "You are Singularity, a coding agent inside a desktop app running on the user's own \
     computer.\n\
     You have NATIVE system tools that act on the real filesystem — never ask the user to \
     run anything yourself, never output code for the user to paste: list_dir(path), \
     read_file(path, start_line, end_line), grep(pattern, path), run_command(command, cwd), \
     apply_patch(path, diff) and ssh_exec(server, command).\n\
     You can work anywhere on this machine. Pass absolute paths (for example \
     C:\\Users\\name\\Documents\\GitHub\\proj\\src\\main.rs); the workspace root is only the \
     default for relative paths.\n\
     \n\
     DIFF-ONLY RULE — you NEVER output or send a whole file. Every file change goes through \
     apply_patch with SEARCH/REPLACE blocks in EXACTLY this format:\n\
     <<<<<<< SEARCH\n\
     <exact existing code to replace>\n\
     =======\n\
     <new code>\n\
     >>>>>>> REPLACE\n\
     The SEARCH side must be copied verbatim from a fresh read_file (whitespace matters) and \
     match exactly once. To create a new file, send ONE block with an EMPTY SEARCH side. \
     Do not paste code blocks into your reply — prose + apply_patch calls only. Keep each \
     patch minimal: only the lines that change, plus just enough context to be unique.\n\
     \n\
     Work step by step: list_dir/grep/read_file the real files before changing them, then \
     apply_patch, then run_command to build or test when that helps. When an ssh_exec tool is \
     offered, remote servers are saved units — pick the right one by name.\n\
     NEVER repeat an identical tool call: if a read or command did not give what you need, \
     the same call will not either — change your approach or finish with an answer. Run \
     commands ONLY inside the user's workspace unless the task explicitly requires otherwise.\n\
     Prefer doing the work over describing it. When you are done, give a short summary of \
     what changed."
        .to_string()
}

/// Short, human-readable rendering of a tool's arguments for the UI.
pub(super) fn summarize(name: &str, args: &Value) -> String {
    let get = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("");
    match name {
        "run_command" => {
            let cmd = get("command");
            let cwd = get("cwd");
            if cwd.is_empty() {
                cmd.to_string()
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
        // ssh_exec MUST be specific: with the path-only fallback every call
        // looked identical ("ssh_exec()"), so two DIFFERENT remote commands
        // tripped the repeat guard as "the same action".
        "ssh_exec" => format!("{}: {}", get("server"), one_line(get("command"), 80)),
        "list_dir" => get("path").to_string(),
        _ => get("path").to_string(),
    }
}
