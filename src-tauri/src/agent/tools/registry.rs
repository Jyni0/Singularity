//! One registry for everything the model can call: built-in Rust tools,
//! MCP server tools (inline or through mcp_find / mcp_call), skills and the
//! `delegate` tool. The agent loop only ever talks to `ToolRegistry`.

use super::mcp::{find_mcp, McpBinding};
use crate::tools::ToolResult;
use futures_util::future::BoxFuture;
use rig_agent::core::completion::ToolDefinition;
use serde_json::Value;
use std::sync::Arc;

/// Arguments as an object: some providers send them as a JSON *string*
/// (`"{\"command\":…}"`), which tools and the loop guard must see alike.
pub(in crate::agent) fn norm_args(args: &Value) -> Value {
    match args {
        Value::String(s) => serde_json::from_str::<Value>(s)
            .ok()
            .filter(|v| v.is_object())
            .unwrap_or_else(|| args.clone()),
        _ => args.clone(),
    }
}

/// Where a tool comes from — the permission gate and logs care.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::agent) enum ToolSource {
    Builtin,
    Skill,
    /// A helper agent (`delegate`).
    Agent,
    /// One MCP tool; `read_only` from the server's annotations.
    Mcp { server: String, read_only: bool },
    /// mcp_find / mcp_call over the deferred MCP catalog.
    McpGateway,
}

/// What a tool knows about the call it serves.
#[derive(Debug, Clone, Copy)]
pub(in crate::agent) struct CallInfo {
    /// UI step index of this call's card (delegate streams progress into it).
    pub card: usize,
}

/// A tool the model can call.
pub(in crate::agent) trait AgentTool: Send + Sync {
    /// Name, description and JSON schema exactly as the model sees them.
    fn definition(&self) -> ToolDefinition;

    fn source(&self) -> ToolSource {
        ToolSource::Builtin
    }

    /// Runs the call. `args` are normalized (always a JSON object when the
    /// model sent one, even as a string).
    fn call<'a>(&'a self, args: Value, info: CallInfo) -> BoxFuture<'a, ToolResult>;
}

/// The tools of one agent, in a fixed order. Definitions are computed once:
/// they are part of the static, cacheable request prefix and must stay
/// byte-stable across the rounds of a run.
pub(in crate::agent) struct ToolRegistry {
    tools: Vec<Arc<dyn AgentTool>>,
    definitions: Vec<ToolDefinition>,
    /// Every MCP tool of the run, inline or not — mcp_call targets resolve here.
    mcp: Arc<Vec<McpBinding>>,
}

/// An MCP tool a call ends up running (directly or through mcp_call).
pub(in crate::agent) struct McpTarget {
    pub tool: String,
    pub server: String,
    pub read_only: bool,
    /// The arguments the MCP tool itself receives.
    pub args: Value,
}

impl ToolRegistry {
    pub fn new(mcp: Arc<Vec<McpBinding>>) -> Self {
        Self { tools: Vec::new(), definitions: Vec::new(), mcp }
    }

    /// Adds a tool; a later tool with the same name is ignored.
    pub fn add(&mut self, tool: impl AgentTool + 'static) {
        let def = tool.definition();
        if self.definitions.iter().any(|d| d.name == def.name) {
            tracing::warn!(tool = %def.name, "duplicate tool name ignored");
            return;
        }
        self.definitions.push(def);
        self.tools.push(Arc::new(tool));
    }

    pub fn extend<T: AgentTool + 'static>(&mut self, tools: impl IntoIterator<Item = T>) {
        for t in tools {
            self.add(t);
        }
    }

    /// rig-core function definitions, in registration order.
    pub fn definitions(&self) -> &[ToolDefinition] {
        &self.definitions
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn AgentTool>> {
        let i = self.definitions.iter().position(|d| d.name == name)?;
        Some(self.tools[i].clone())
    }

    pub fn names(&self) -> Vec<&str> {
        self.definitions.iter().map(|d| d.name.as_str()).collect()
    }

    /// The MCP tool a call runs, if any: an inline `mcp__server__tool`, or
    /// the target of an mcp_call (None for an unknown name — the tool itself
    /// reports it and nothing runs).
    pub fn mcp_target(&self, name: &str, args: &Value) -> Option<McpTarget> {
        if name == "mcp_call" {
            let wanted = args.get("tool").and_then(|v| v.as_str()).unwrap_or("");
            let b = find_mcp(&self.mcp, wanted)?;
            return Some(McpTarget {
                tool: b.name.clone(),
                server: b.server.name.clone(),
                read_only: b.tool.read_only,
                args: args.get("arguments").cloned().unwrap_or(Value::Null),
            });
        }
        match self.get(name)?.source() {
            ToolSource::Mcp { server, read_only } => Some(McpTarget { tool: name.to_string(), server, read_only, args: args.clone() }),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Echo(&'static str);

    impl AgentTool for Echo {
        fn definition(&self) -> ToolDefinition {
            ToolDefinition { name: self.0.into(), description: "echo".into(), parameters: json!({"type": "object"}) }
        }
        fn call<'a>(&'a self, args: Value, _info: CallInfo) -> BoxFuture<'a, ToolResult> {
            Box::pin(async move { ToolResult::ok(args.to_string()) })
        }
    }

    #[test]
    fn string_encoded_args_are_parsed() {
        let obj = json!({"command": "npm install", "cwd": "web"});
        assert_eq!(norm_args(&Value::String(obj.to_string())), obj);
        assert_eq!(norm_args(&obj), obj);
        assert_eq!(norm_args(&json!("not json")), json!("not json"));
    }

    #[tokio::test]
    async fn registry_keeps_order_and_dispatches() {
        let mut r = ToolRegistry::new(Arc::default());
        r.add(Echo("b"));
        r.add(Echo("a"));
        r.add(Echo("b"));
        assert_eq!(r.names(), ["b", "a"]);
        let out = r.get("a").unwrap().call(json!({"x": 1}), CallInfo { card: 1 }).await;
        assert!(out.ok && out.output.contains("\"x\":1"));
        assert!(r.get("zzz").is_none());
        assert!(r.mcp_target("a", &json!({})).is_none());
    }
}
