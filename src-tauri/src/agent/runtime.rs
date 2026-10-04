//! One agent run, end to end: loads skills and MCP servers, builds the
//! system prompt and the tool registry, hands the conversation to the
//! `AgentLoop` and returns its answer. Also the subagents (`delegate`) and
//! the context view (what the next request would carry).
//!
//! * Subagents: user-defined helpers reachable through ONE `delegate` tool;
//!   the model decides which task goes to which helper. A semaphore bounds
//!   how many work at once, and the main loop runs the tool calls of a turn
//!   side by side, so several delegations really run in parallel.
//! * Skills: a `skill` tool loads a skill's instructions on demand; the
//!   system prompt lists only names + descriptions.
//! * MCP: every tool of every enabled MCP server is in the registry — inline,
//!   or through mcp_find / mcp_call when the schemas are big.

use super::agent_loop::AgentLoop;
use super::context::{est_tokens, one_line, project_context, ProjectContext};
use super::prompts::{default_system, McpMode, SystemPromptBuilder};
use super::run_ctx::{RunCtx, DEFAULT_WINDOW};
use super::tools::{
    builtin_tools, load_mcp, mcp_catalog, mcp_deferred, mcp_mode, tool_specs, AgentTool, CallInfo, McpBinding, McpCall, McpFind,
    McpToolAdapter, SkillTool, ToolRegistry, ToolSource,
};
use super::{cancelled_result, is_cancelled, AgentRequest, SubagentDef};
use crate::tools::ToolResult;
use futures_util::future::BoxFuture;
use rig_agent::core::completion::message::{ImageMediaType, Message, UserContent};
use rig_agent::core::completion::ToolDefinition;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;
use tauri::AppHandle;

/// Upper bound of "Max agents at once".
pub(super) const MAX_AGENTS: usize = 52;
/// Name of the built-in general-purpose helper.
const WORKER: &str = "worker";
/// How long the run waits for the model's context window lookup.
const WINDOW_LOOKUP: std::time::Duration = std::time::Duration::from_secs(4);

/* ---------- Subagents ---------- */

/// The single `delegate` tool that hands a task to a user-defined helper.
struct DelegateTool {
    ctx: RunCtx,
    /// The workspace's instructions + repo map — helpers start informed too.
    project: Arc<ProjectContext>,
}

impl AgentTool for DelegateTool {
    fn definition(&self) -> ToolDefinition {
        let subagents = &self.ctx.req.subagents;
        let names: Vec<&str> = subagents.iter().map(|s| s.name.as_str()).collect();
        let roster = subagents.iter().map(|s| format!("- {}: {}", s.name, s.description)).collect::<Vec<_>>().join("\n");
        ToolDefinition {
            name: "delegate".into(),
            description: format!(
                "Hand a self-contained task to a helper agent and get its result back. Helpers have the same file/command tools. Use one only when the task matches its specialty; call delegate several times in one turn to run helpers in parallel.\nHelpers:\n{roster}"
            ),
            parameters: json!({
                "type": "object",
                "properties": {
                    "agent": { "type": "string", "enum": names, "description": "Which helper to use." },
                    "task": { "type": "string", "description": "Complete, self-contained instruction for the helper." }
                },
                "required": ["agent", "task"]
            }),
        }
    }

    fn source(&self) -> ToolSource {
        ToolSource::Agent
    }

    fn call<'a>(&'a self, args: Value, info: CallInfo) -> BoxFuture<'a, ToolResult> {
        Box::pin(async move {
            let name = args.get("agent").and_then(|v| v.as_str()).unwrap_or("");
            let task = args.get("task").and_then(|v| v.as_str()).unwrap_or("");
            let Some(def) = self.ctx.req.subagents.iter().find(|s| s.name == name) else {
                return ToolResult::err(format!("unknown helper {name:?}"));
            };
            // Bounded parallelism: extra delegations queue here.
            let _slot = self.ctx.agent_slots.acquire().await;
            match run_subagent(&self.ctx, &self.project, def, task, info.card).await {
                Ok(text) => ToolResult::ok(text),
                Err(e) => ToolResult::err(e),
            }
        })
    }
}

/// Runs one helper agent to completion. Its tool cards join the run's
/// transcript (prefixed with its name); its prose streams into the delegate
/// card and comes back to the main agent as the tool result.
async fn run_subagent(ctx: &RunCtx, project: &ProjectContext, def: &SubagentDef, task: &str, card: usize) -> Result<String, String> {
    let base = default_system();
    let prompt = SystemPromptBuilder {
        system: &base,
        req: &ctx.req,
        root: &ctx.root,
        skills: &[],
        mcp: McpMode::Off,
        helpers: false,
        parallel: 1,
        project,
    }
    .build();
    let preamble = format!(
        "{prompt}\n\n# Your assignment\nYou are the helper agent \"{}\". {}\nDo ONLY the task you are given, then answer with a short factual summary of what you did or found.",
        def.name,
        def.prompt.trim()
    );
    let mut tools = ToolRegistry::new(Arc::default());
    tools.extend(builtin_tools(ctx));
    let agent = AgentLoop {
        ctx,
        preamble,
        tools: &tools,
        label: format!("[{}] ", def.name),
        to_ui: false,
        // Helpers batch their own independent tool calls too.
        parallel: ctx.req.max_agents.clamp(1, 8),
    };
    let summary = format!("{}: {}", def.name, one_line(task, 80));
    let mut partial = String::new();
    let mut shown = 0usize;
    let mut progress = |t: &str| {
        partial.push_str(t);
        // Live progress in the delegate card, throttled.
        if partial.len() >= shown + 200 {
            shown = partial.len();
            ctx.step("", card, "delegate", &summary, false, &ToolResult::ok(partial.clone()));
        }
    };
    match agent.run(vec![Message::user(task)], &mut progress).await {
        Ok(text) if text.trim().is_empty() => Err("the helper returned no answer".into()),
        other => other,
    }
}

/// The request with the built-in helper added: with room for more than one
/// agent, a general-purpose helper is always there — parallel work no
/// longer depends on the user defining subagents.
fn with_worker(req: &AgentRequest) -> AgentRequest {
    let mut req = req.clone();
    let cli = crate::cli::Cli::from_kind(&req.kind).is_some();
    if !cli && req.max_agents.clamp(1, MAX_AGENTS) > 1 && !req.subagents.iter().any(|s| s.name == WORKER) {
        req.subagents.push(SubagentDef {
            name: WORKER.into(),
            description: "General-purpose helper for ANY self-contained part of the task: exploring or reading an area of the codebase, researching on the web, implementing a change confined to its own files, running and fixing tests. Give it everything it needs in `task`.".into(),
            prompt: "Work fast: batch independent tool calls into one turn.".into(),
        });
    }
    req
}

/* ---------- Main run ---------- */

/// The system prompt of a main run; the context view measures the same.
fn prompt_builder<'a>(
    system: &'a str,
    req: &'a AgentRequest,
    root: &'a Path,
    skills: &'a [crate::skills::Skill],
    mcp: &[McpBinding],
    project: &'a ProjectContext,
) -> SystemPromptBuilder<'a> {
    SystemPromptBuilder {
        system,
        req,
        root,
        skills,
        mcp: mcp_mode(req, mcp),
        helpers: req.has_helpers(),
        parallel: req.max_agents.clamp(1, MAX_AGENTS),
        project,
    }
}

/// Instructions + repo map of the workspace, built off the async workers.
async fn load_project(root: &Path) -> Arc<ProjectContext> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || project_context(&root)).await.unwrap_or_default()
}

/// Every tool of the main agent, in a fixed order (the tool definitions
/// are part of the cached request prefix).
fn main_tools(ctx: &RunCtx, skills: &Arc<Vec<crate::skills::Skill>>, mcp: &[McpBinding], project: &Arc<ProjectContext>) -> ToolRegistry {
    let mcp_all = Arc::new(mcp.to_vec());
    let mut r = ToolRegistry::new(mcp_all.clone());
    r.extend(builtin_tools(ctx));
    if ctx.req.has_helpers() {
        r.add(DelegateTool { ctx: ctx.clone(), project: project.clone() });
    }
    if !skills.is_empty() {
        r.add(SkillTool(skills.clone()));
    }
    if mcp_deferred(&ctx.req, mcp) {
        r.add(McpFind(mcp_all.clone()));
        r.add(McpCall(mcp_all));
    } else {
        r.extend(mcp.iter().cloned().map(McpToolAdapter));
    }
    r
}

/// The model's context window (provider catalog / Ollama), or
/// DEFAULT_WINDOW when unknown or slow to find out.
async fn context_window(req: &AgentRequest) -> u64 {
    if crate::cli::Cli::from_kind(&req.kind).is_some() {
        return DEFAULT_WINDOW;
    }
    let info = crate::pricing::model_info(req.kind.clone(), req.base_url.clone(), req.model.clone());
    let window = tokio::time::timeout(WINDOW_LOOKUP, info).await.ok().and_then(|i| i.context).filter(|c| *c >= 4_096);
    if window.is_none() {
        tracing::debug!(model = %req.model, "context window unknown; assuming {DEFAULT_WINDOW}");
    }
    window.unwrap_or(DEFAULT_WINDOW)
}

/// Chat history → messages; the LAST user turn (with the attached images)
/// is the prompt and ends the list.
fn to_messages(req: &AgentRequest, turns: &[crate::chat::ChatTurn]) -> Vec<Message> {
    let last_user = turns.iter().rposition(|t| t.role != "agent" && t.role != "assistant");
    let mut history = Vec::new();
    let mut prompt = Message::user("");
    for (i, t) in turns.iter().enumerate() {
        let agent = t.role == "agent" || t.role == "assistant";
        if Some(i) == last_user {
            let mut content = vec![UserContent::text(t.text.clone())];
            for img in &req.images {
                let mt = match img.mime.as_str() {
                    "image/png" => Some(ImageMediaType::PNG),
                    "image/jpeg" | "image/jpg" => Some(ImageMediaType::JPEG),
                    "image/gif" => Some(ImageMediaType::GIF),
                    "image/webp" => Some(ImageMediaType::WEBP),
                    _ => None,
                };
                content.push(UserContent::image_base64(crate::chat::base64_body(&img.data_url).to_string(), mt, None));
            }
            prompt = Message::User { content };
        } else if agent {
            if !t.text.trim().is_empty() {
                history.push(Message::assistant(t.text.clone()));
            }
        } else {
            history.push(Message::user(t.text.clone()));
        }
    }
    history.push(prompt);
    history
}

/// /commands, invoked skills and @mentions → what the model reads. File IO
/// and git run off the async workers.
async fn expand_turns(
    skills: Arc<Vec<crate::skills::Skill>>,
    root: &Path,
    turns: Vec<crate::chat::ChatTurn>,
) -> Result<Vec<crate::chat::ChatTurn>, String> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let is_user = |r: &str| r != "agent" && r != "assistant";
        let last_user = turns.iter().rposition(|t| is_user(&t.role));
        turns
            .into_iter()
            .enumerate()
            .map(|(i, mut t)| {
                if is_user(&t.role) {
                    t.text = super::expand::user_turn(&t.text, &skills, &root, Some(i) == last_user);
                }
                t
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| format!("prompt expansion failed: {e}"))
}

/// The main run.
pub(super) async fn run(
    app: &AppHandle,
    run_id: &str,
    req: &AgentRequest,
    system: &str,
    root: &Path,
    turns: Vec<crate::chat::ChatTurn>,
) -> Result<String, String> {
    let parallel = req.max_agents.clamp(1, MAX_AGENTS);
    let req = &with_worker(req);
    let window = context_window(req).await;
    let ctx = RunCtx::new(Some(app), run_id, req, root.to_path_buf(), parallel, window);
    let skills = Arc::new(crate::skills::for_run(app, &req.workspace));
    let (mcp, project) = tokio::join!(load_mcp(app, run_id, &ctx.counter), load_project(root));
    if is_cancelled(run_id) {
        return cancelled_result(String::new());
    }

    let preamble = prompt_builder(system, req, root, &skills, &mcp, &project).build();
    let tools = main_tools(&ctx, &skills, &mcp, &project);
    let turns = expand_turns(skills.clone(), root, turns).await?;
    ctx.usage.lock().unwrap().first_est =
        measure(req, system, root, &skills, &mcp, &project, &turns, None).iter().map(|p| p.tokens as u64).sum();
    let agent = AgentLoop {
        ctx: &ctx,
        preamble,
        tools: &tools,
        label: String::new(),
        to_ui: true,
        // The main agent may run many tool calls of one turn at once
        // (parallel reads, several delegations); at least a handful even
        // with one helper.
        parallel: parallel.max(8),
    };
    let text = agent.run(to_messages(req, &turns), &mut |_| {}).await?;
    if text.trim().is_empty() && ctx.steps() == 0 {
        return Err(
            "the model returned an empty answer — its output may have been reasoning-only; retry, or try another model/effort level".into(),
        );
    }
    Ok(text)
}

/* ---------- Context view ---------- */

/// One line inside a context category (a tool, a skill, a kind of message).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ContextItem {
    pub name: String,
    pub tokens: usize,
}

/// One category of what the next request carries.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ContextPart {
    pub label: String,
    /// "messages" | "tools" | "mcp" | "skills" | "system" — picks the color.
    pub group: &'static str,
    pub tokens: usize,
    pub items: Vec<ContextItem>,
}

fn item(name: impl Into<String>, text: &str) -> ContextItem {
    ContextItem { name: name.into(), tokens: est_tokens(text) }
}

/// The first words of a message, on one line.
fn snippet(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= 48 {
        return if flat.is_empty() { "(empty)".into() } else { flat };
    }
    format!("{}…", flat.chars().take(47).collect::<String>())
}

fn category(label: &str, group: &'static str, mut items: Vec<ContextItem>) -> ContextPart {
    items.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    ContextPart { label: label.into(), group, tokens: items.iter().map(|i| i.tokens).sum(), items }
}

/// What the NEXT agent request of this conversation would send, measured
/// category by category — the same system prompt, tool list and trimmed,
/// expanded history the run builds. (Inside a run the history then grows
/// with tool calls and results; the context manager trims those.)
pub(super) async fn context_info(
    app: &AppHandle,
    req: &AgentRequest,
    system: &str,
    root: &Path,
    turns: Vec<crate::chat::ChatTurn>,
) -> Result<Vec<ContextPart>, String> {
    let req = &with_worker(req);
    let counter = AtomicUsize::new(0);
    let skills = Arc::new(crate::skills::for_run(app, &req.workspace));
    let (mcp, project) = tokio::join!(load_mcp(app, "context-info", &counter), load_project(root));
    // The latest prompt as typed: the rest of its expanded text is @files.
    let raw_last = turns.iter().rev().find(|t| t.role != "agent" && t.role != "assistant").map(|t| t.text.clone());
    let turns = expand_turns(skills.clone(), root, turns).await?;
    Ok(measure(req, system, root, &skills, &mcp, &project, &turns, raw_last.as_deref()))
}

/// Estimated tokens per category of one request (see context_info). The
/// run measures its first request the same way, which calibrates this.
#[allow(clippy::too_many_arguments)]
fn measure(
    req: &AgentRequest,
    system: &str,
    root: &Path,
    skills: &[crate::skills::Skill],
    mcp: &[McpBinding],
    project: &ProjectContext,
    turns: &[crate::chat::ChatTurn],
    raw_last: Option<&str>,
) -> Vec<ContextPart> {
    let mut parts = Vec::new();

    // Messages: one line per message ("You · first words…"), the latest
    // prompt split from the @files expanded into it.
    let is_user = |r: &str| r != "agent" && r != "assistant";
    let last_user = turns.iter().rposition(|t| is_user(&t.role));
    let mut msgs = Vec::new();
    for (i, t) in turns.iter().enumerate() {
        let who = if !is_user(&t.role) {
            "Agent"
        } else if Some(i) == last_user {
            "Latest"
        } else {
            "You"
        };
        match raw_last.filter(|_| Some(i) == last_user) {
            Some(raw) => {
                let typed = item(format!("{who} · {}", snippet(raw)), raw);
                let files = est_tokens(&t.text).saturating_sub(typed.tokens);
                msgs.push(typed);
                if files > 0 {
                    msgs.push(ContextItem { name: "Latest · attached @files".into(), tokens: files });
                }
            }
            None => msgs.push(item(format!("{who} · {}", snippet(&t.text)), &t.text)),
        }
    }
    parts.push(category("Messages", "messages", msgs));

    // System tools: each built-in schema as sent (name + description + params).
    let mut tools_items: Vec<ContextItem> = tool_specs(req)
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|spec| item(spec["name"].as_str().unwrap_or("tool"), &spec.to_string()))
        .collect();
    if req.has_helpers() {
        let roster: String = req.subagents.iter().map(|s| format!("- {}: {}\n", s.name, s.description)).collect();
        tools_items.push(item("delegate", &format!("{roster}{}", " ".repeat(420))));
    }
    if !skills.is_empty() {
        let names = skills.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(",");
        tools_items.push(item("skill", &format!("{names}{}", " ".repeat(450))));
    }
    parts.push(category("System tools", "tools", tools_items));

    if mcp_deferred(req, mcp) {
        // Only the catalog and the two lookup tools ride along.
        let items = vec![
            item("catalog (names only)", &mcp_catalog(mcp)),
            item("mcp_find + mcp_call", &" ".repeat(1_400)),
        ];
        parts.push(category("MCP tools", "mcp", items));
    } else if !mcp.is_empty() {
        let items = mcp
            .iter()
            .map(|b| item(format!("{} · {}", b.server.name, b.tool.name), &format!("{}{}{}", b.name, b.tool.description, b.tool.input_schema)))
            .collect();
        parts.push(category("MCP tools", "mcp", items));
    }

    let sections = prompt_builder(system, req, root, skills, mcp, project).sections();
    if !skills.is_empty() {
        // Only name + description ride along; a skill's body loads on use.
        let items = skills
            .iter()
            .map(|sk| item(sk.name.clone(), &format!("\n- {}: {}", sk.name, one_line(&sk.description, 300))))
            .collect();
        parts.push(category("Skills", "skills", items));
    }
    let sys_items = sections
        .iter()
        .filter(|(label, _)| *label != "Skills list" && *label != "MCP catalog")
        .map(|(label, text)| item(*label, text))
        .collect();
    parts.push(category("System prompt", "system", sys_items));
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(max_agents: usize) -> AgentRequest {
        serde_json::from_value(json!({
            "kind": "openai", "base_url": "http://x", "model": "m", "workspace": "/w", "max_agents": max_agents
        }))
        .unwrap()
    }

    #[test]
    fn worker_joins_only_with_room_for_helpers() {
        assert!(!with_worker(&req(1)).has_helpers());
        let r = with_worker(&req(4));
        assert_eq!(r.subagents.iter().filter(|s| s.name == WORKER).count(), 1);
        assert_eq!(with_worker(&r).subagents.len(), r.subagents.len(), "added once");
    }

    #[test]
    fn last_user_turn_is_the_prompt() {
        let turn = |role: &str, text: &str| crate::chat::ChatTurn { role: role.into(), text: text.into(), ..Default::default() };
        let msgs = to_messages(&req(1), &[turn("user", "a"), turn("agent", "b"), turn("agent", " "), turn("user", "c")]);
        assert_eq!(msgs.len(), 3);
        assert!(matches!(msgs[1], Message::Assistant { .. }));
        assert!(serde_json::to_string(msgs.last().unwrap()).unwrap().contains("\"c\""));
    }
}
