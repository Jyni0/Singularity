//! Built-in Rust tools (filesystem, shell, git, web, SSH, image generation)
//! and the `skill` tool, as registry entries.

use super::registry::{AgentTool, CallInfo, ToolSource};
use super::specs::tool_specs;
use crate::agent::permissions::full_path;
use crate::agent::run_ctx::RunCtx;
use crate::tools::{self, ToolResult};
use futures_util::future::BoxFuture;
use rig_agent::core::completion::ToolDefinition;
use serde_json::{json, Value};
use std::sync::Arc;

/// One built-in tool: its schema from `tool_specs`, its work in Rust.
pub(in crate::agent) struct BuiltinTool {
    def: ToolDefinition,
    ctx: RunCtx,
}

/// Every built-in tool this run offers (Settings → Plugins may switch some
/// off; ssh_exec / generate_image only exist when configured).
pub(in crate::agent) fn builtin_tools(ctx: &RunCtx) -> Vec<BuiltinTool> {
    tool_specs(&ctx.req)
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|spec| BuiltinTool {
            def: ToolDefinition {
                name: spec["name"].as_str().unwrap_or("").to_string(),
                description: spec["description"].as_str().unwrap_or("").to_string(),
                parameters: spec["parameters"].clone(),
            },
            ctx: ctx.clone(),
        })
        .collect()
}

impl AgentTool for BuiltinTool {
    fn definition(&self) -> ToolDefinition {
        self.def.clone()
    }

    fn call<'a>(&'a self, args: Value, _info: CallInfo) -> BoxFuture<'a, ToolResult> {
        Box::pin(async move {
            let c = &self.ctx;
            let name = self.def.name.clone();
            let get = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let no_app = || ToolResult::err(format!("{name} is not available here"));
            match name.as_str() {
                "ssh_exec" => match &c.app {
                    Some(app) => crate::agent::run_ssh_tool(app, &c.req, &args).await,
                    None => no_app(),
                },
                "web_search" => {
                    let max = args.get("max_results").and_then(|v| v.as_u64()).unwrap_or(8) as usize;
                    crate::web::search(&get("query"), max).await
                }
                "web_fetch" => {
                    let start = args.get("start").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    crate::web::fetch(&get("url"), start).await
                }
                "change_dir" => change_dir(c, &get("path")),
                "generate_image" => match &c.app {
                    Some(app) => crate::imagegen::tool(app, c.req.image_gen.as_ref(), &args).await,
                    None => no_app(),
                },
                _ => {
                    // Tools block (file IO, processes): keep the async
                    // workers free so events keep flowing.
                    let root = c.cwd();
                    tokio::task::spawn_blocking(move || tools::dispatch(&root, &name, &args))
                        .await
                        .unwrap_or_else(|e| ToolResult::err(format!("tool task failed: {e}")))
                }
            }
        })
    }
}

/// `change_dir`: moves the run's working directory (relative paths of every
/// later file tool and command start there) and lists the new place.
fn change_dir(ctx: &RunCtx, path: &str) -> ToolResult {
    let current = ctx.cwd();
    let target = if path.trim().is_empty() {
        ctx.root.clone()
    } else {
        match tools::resolve(&current, path) {
            Ok(p) => p,
            Err(e) => return ToolResult::err(e),
        }
    };
    if !target.is_dir() {
        return ToolResult::err(tools::not_found(&current, path));
    }
    let target = full_path(&target.to_string_lossy(), "");
    *ctx.cwd.lock().unwrap() = target.clone();
    let listing = tools::list_dir(&target, "");
    ToolResult::ok(format!("now in {}\n{}", target.display(), listing.output))
}

/// The `skill` tool: loads a skill's instructions (or one of its files).
pub(in crate::agent) struct SkillTool(pub Arc<Vec<crate::skills::Skill>>);

impl AgentTool for SkillTool {
    fn definition(&self) -> ToolDefinition {
        let names: Vec<&str> = self.0.iter().map(|s| s.name.as_str()).collect();
        ToolDefinition {
            name: "skill".into(),
            description: "Load the instructions of a skill listed in the system prompt. Call it before starting a task that matches the skill's description, then follow the instructions. Pass `file` to read one of the skill's supporting files.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "enum": names, "description": "Skill to load." },
                    "file": { "type": "string", "description": "Optional: a file inside the skill folder, as listed by the skill." }
                },
                "required": ["name"]
            }),
        }
    }

    fn source(&self) -> ToolSource {
        ToolSource::Skill
    }

    fn call<'a>(&'a self, args: Value, _info: CallInfo) -> BoxFuture<'a, ToolResult> {
        Box::pin(async move {
            let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let file = args.get("file").and_then(|v| v.as_str());
            match self.0.iter().find(|s| s.name == name) {
                None => ToolResult::err(format!("unknown skill {name:?}")),
                Some(s) => match crate::skills::load_for_model(s, file) {
                    Ok(text) => ToolResult::ok(text),
                    Err(e) => ToolResult::err(e),
                },
            }
        })
    }
}
