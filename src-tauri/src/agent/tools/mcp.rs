//! MCP tools: every tool of every enabled MCP server, offered either one by
//! one (`mcp__server__tool`, schemas inline) or — when the schemas are big —
//! through `mcp_find` / `mcp_call` over a names-only catalog.

use super::registry::{AgentTool, CallInfo, ToolSource};
use crate::agent::context::{est_tokens, one_line};
use crate::agent::prompts::McpMode;
use crate::agent::AgentRequest;
use crate::tools::ToolResult;
use futures_util::future::BoxFuture;
use rig_agent::core::completion::ToolDefinition;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::AppHandle;

/// One MCP tool offered to the model.
#[derive(Clone)]
pub(in crate::agent) struct McpBinding {
    pub server: Arc<crate::mcp::McpServer>,
    pub tool: crate::mcp::McpTool,
    /// Name the model sees (`mcp__server__tool`, unique within the run).
    pub name: String,
}

/// Connects every enabled MCP server (pooled — usually instant) and lists
/// their tools. A server that fails gets a red card and is left out; the run
/// goes on with the rest.
pub(in crate::agent) async fn load_mcp(app: &AppHandle, run_id: &str, counter: &AtomicUsize) -> Vec<McpBinding> {
    let servers: Vec<_> = crate::mcp::list(app)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|s| s.enabled)
        .collect();
    if servers.is_empty() {
        return Vec::new();
    }
    let results = futures_util::future::join_all(servers.into_iter().map(|s| async move {
        let r = tokio::select! {
            r = crate::mcp::connect(&s) => r,
            _ = crate::cancel::cancel_signal(run_id) => Err(crate::cancel::STOPPED.to_string()),
        };
        (s, r)
    }))
    .await;
    let mut out: Vec<McpBinding> = Vec::new();
    for (server, res) in results {
        match res {
            Ok(conn) => {
                let server = Arc::new(server);
                for tool in &conn.tools {
                    let mut name = crate::mcp::tool_name(&server.name, &tool.name);
                    let mut n = 2;
                    while out.iter().any(|b| b.name == name) {
                        let suffix = format!("_{n}");
                        name = format!("{}{suffix}", name.chars().take(64 - suffix.len()).collect::<String>());
                        n += 1;
                    }
                    out.push(McpBinding { server: server.clone(), tool: tool.clone(), name });
                }
            }
            Err(e) if e == crate::cancel::STOPPED => {}
            Err(e) => {
                tracing::warn!(server = %server.name, error = %e, "MCP server failed to connect");
                let idx = counter.fetch_add(1, Ordering::SeqCst) + 1;
                crate::agent::emit_step(app, run_id, idx, "mcp", format!("connect {}", server.name), true, &ToolResult::err(e));
            }
        }
    }
    out
}

/// Runs one MCP tool; an MCP-level error result reads as a failed call.
async fn call_mcp(b: &McpBinding, args: Value) -> ToolResult {
    match crate::mcp::call(&b.server, &b.tool.name, args).await {
        Ok((text, false)) => ToolResult::ok(text),
        Ok((text, true)) => ToolResult::err(text),
        Err(e) => ToolResult::err(e),
    }
}

/// One MCP tool as its own model tool.
pub(in crate::agent) struct McpToolAdapter(pub McpBinding);

impl AgentTool for McpToolAdapter {
    fn definition(&self) -> ToolDefinition {
        let b = &self.0;
        let description = if b.tool.description.trim().is_empty() {
            format!("{} (MCP server {})", b.tool.name, b.server.name)
        } else {
            format!("{} (MCP server {})", b.tool.description.trim(), b.server.name)
        };
        ToolDefinition { name: b.name.clone(), description, parameters: b.tool.input_schema.clone() }
    }

    fn source(&self) -> ToolSource {
        ToolSource::Mcp { server: self.0.server.name.clone(), read_only: self.0.tool.read_only }
    }

    fn call<'a>(&'a self, args: Value, _info: CallInfo) -> BoxFuture<'a, ToolResult> {
        Box::pin(call_mcp(&self.0, args))
    }
}

/// MCP schemas above this many tokens are not sent inline (see mcp_deferred).
const MCP_INLINE_TOKENS: usize = 6_000;

pub(in crate::agent) fn mcp_schema_tokens(mcp: &[McpBinding]) -> usize {
    mcp.iter()
        .map(|b| est_tokens(&format!("{}{}{}", b.name, b.tool.description, b.tool.input_schema)))
        .sum()
}

/// Whether MCP tools are offered through mcp_find / mcp_call instead of one
/// tool each. A dozen servers (Playwright, DevTools…) carry 20k+ tokens of
/// schemas into EVERY request: on a local model reading ~40 tokens/s that
/// was minutes before the first word and more than its whole window (Ollama
/// then silently cuts the prompt's start — the model lost its instructions
/// and never finished). Local models always defer; others once it is big.
pub(in crate::agent) fn mcp_deferred(req: &AgentRequest, mcp: &[McpBinding]) -> bool {
    !mcp.is_empty() && (req.kind == "ollama" || mcp_schema_tokens(mcp) > MCP_INLINE_TOKENS)
}

/// How this run offers its MCP tools to the model.
pub(in crate::agent) fn mcp_mode(req: &AgentRequest, mcp: &[McpBinding]) -> McpMode {
    if mcp.is_empty() {
        McpMode::Off
    } else if mcp_deferred(req, mcp) {
        McpMode::Deferred(mcp_catalog(mcp))
    } else {
        McpMode::Inline(server_names(mcp))
    }
}

/// Connected servers, in first-seen order.
fn server_names(mcp: &[McpBinding]) -> Vec<String> {
    let mut servers: Vec<String> = Vec::new();
    for b in mcp {
        if !servers.contains(&b.server.name) {
            servers.push(b.server.name.clone());
        }
    }
    servers
}

/// The MCP binding a model-given name points at: the full
/// `mcp__server__tool` name, or the bare tool name when that is unique.
pub(in crate::agent) fn find_mcp<'a>(mcp: &'a [McpBinding], name: &str) -> Option<&'a McpBinding> {
    let name = name.trim();
    mcp.iter().find(|b| b.name == name).or_else(|| {
        let mut hits = mcp.iter().filter(|b| b.tool.name == name);
        let first = hits.next()?;
        hits.next().is_none().then_some(first)
    })
}

/// Catalog for the system prompt: server → tool names, no schemas.
pub(in crate::agent) fn mcp_catalog(mcp: &[McpBinding]) -> String {
    let mut out = String::from(
        "\n\nMCP tools — extra tools from servers the user connected. Their parameters are NOT loaded: \
         call mcp_find with what you need (or an exact tool name) to get its name and parameters, \
         then run it with mcp_call {tool, arguments}. Use them when they fit better than the built-in tools.",
    );
    for server in server_names(mcp) {
        let names: Vec<&str> = mcp.iter().filter(|b| b.server.name == server).map(|b| b.name.as_str()).collect();
        out.push_str(&format!("\n- {server}: {}", names.join(", ")));
    }
    out
}

/// `mcp_find`: full name, description and parameters of matching MCP tools.
pub(in crate::agent) struct McpFind(pub Arc<Vec<McpBinding>>);

impl AgentTool for McpFind {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "mcp_find".into(),
            description: "Look up MCP tools listed in the system prompt: returns their exact names, descriptions and parameter schemas. Pass keywords (\"screenshot\", \"navigate page\") or an exact tool name.".into(),
            parameters: json!({
                "type": "object",
                "properties": { "query": { "type": "string", "description": "Keywords or an exact tool name." } },
                "required": ["query"]
            }),
        }
    }

    fn source(&self) -> ToolSource {
        ToolSource::McpGateway
    }

    fn call<'a>(&'a self, args: Value, _info: CallInfo) -> BoxFuture<'a, ToolResult> {
        Box::pin(async move {
            let mcp = &self.0;
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            let words: Vec<&str> = query.split(|c: char| !c.is_alphanumeric() && c != '_').filter(|w| w.len() > 1).collect();
            let mut scored: Vec<(usize, &McpBinding)> = match find_mcp(mcp, &query) {
                Some(b) => vec![(usize::MAX, b)],
                None => mcp
                    .iter()
                    .map(|b| {
                        let hay = format!("{} {} {}", b.name, b.server.name, b.tool.description).to_lowercase();
                        (words.iter().filter(|w| hay.contains(*w)).count(), b)
                    })
                    .filter(|(n, _)| *n > 0)
                    .collect(),
            };
            scored.sort_by(|a, b| b.0.cmp(&a.0));
            if scored.is_empty() {
                return ToolResult::err(format!("no MCP tool matches {query:?} — pick a name from the list in the system prompt"));
            }
            ToolResult::ok(
                scored
                    .iter()
                    .take(6)
                    .map(|(_, b)| format!("{}\n{}\nparameters: {}", b.name, one_line(&b.tool.description, 600), b.tool.input_schema))
                    .collect::<Vec<_>>()
                    .join("\n\n"),
            )
        })
    }
}

/// `mcp_call`: runs one MCP tool by name.
pub(in crate::agent) struct McpCall(pub Arc<Vec<McpBinding>>);

impl AgentTool for McpCall {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "mcp_call".into(),
            description: "Run an MCP tool. Get its exact name and parameters with mcp_find first.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "tool": { "type": "string", "description": "Exact MCP tool name (mcp__server__tool)." },
                    "arguments": { "type": "object", "description": "The tool's parameters, as mcp_find showed them." }
                },
                "required": ["tool"]
            }),
        }
    }

    fn source(&self) -> ToolSource {
        ToolSource::McpGateway
    }

    fn call<'a>(&'a self, args: Value, _info: CallInfo) -> BoxFuture<'a, ToolResult> {
        Box::pin(async move {
            let name = args.get("tool").and_then(|v| v.as_str()).unwrap_or("");
            let call_args = match args.get("arguments") {
                Some(Value::String(s)) => serde_json::from_str(s).unwrap_or_else(|_| json!({})),
                Some(v) if v.is_object() => v.clone(),
                _ => json!({}),
            };
            match find_mcp(&self.0, name) {
                None => ToolResult::err(format!("unknown MCP tool {name:?} — use mcp_find to get the exact name")),
                Some(b) => call_mcp(b, call_args).await,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(server: &str, tool: &str) -> McpBinding {
        let tool = crate::mcp::McpTool {
            name: tool.into(),
            description: format!("{tool} does things"),
            input_schema: json!({ "type": "object" }),
            read_only: false,
        };
        let server: crate::mcp::McpServer = serde_json::from_value(json!({
            "id": "s", "name": server, "transport": "http", "url": "http://x", "enabled": true
        }))
        .unwrap_or_else(|_| panic!("McpServer shape"));
        McpBinding { name: crate::mcp::tool_name(&server.name, &tool.name), server: Arc::new(server), tool }
    }

    #[test]
    fn deferred_lookup_by_full_or_bare_name() {
        let mcp = vec![binding("Browser", "navigate"), binding("Browser", "click"), binding("DevTools", "click")];
        assert_eq!(find_mcp(&mcp, "navigate").map(|b| b.tool.name.as_str()), Some("navigate"));
        assert!(find_mcp(&mcp, "click").is_none(), "ambiguous bare name");
        let full = mcp[2].name.clone();
        assert_eq!(find_mcp(&mcp, &full).map(|b| b.server.name.as_str()), Some("DevTools"));
        let cat = mcp_catalog(&mcp);
        assert!(cat.contains("- Browser: ") && cat.contains("- DevTools: "));
        assert_eq!(server_names(&mcp), ["Browser", "DevTools"]);
    }

    #[test]
    fn registry_resolves_mcp_call_targets() {
        let mcp = Arc::new(vec![binding("Browser", "navigate")]);
        let mut reg = super::super::registry::ToolRegistry::new(mcp.clone());
        reg.add(McpToolAdapter(mcp[0].clone()));
        reg.add(McpCall(mcp.clone()));
        let direct = reg.mcp_target(&mcp[0].name, &json!({"url": "x"})).expect("inline tool");
        assert_eq!(direct.server, "Browser");
        let via = reg.mcp_target("mcp_call", &json!({"tool": "navigate", "arguments": {"url": "y"}})).expect("mcp_call");
        assert_eq!(via.tool, mcp[0].name);
        assert_eq!(via.args, json!({"url": "y"}));
        assert!(reg.mcp_target("mcp_call", &json!({"tool": "nope"})).is_none());
    }
}
