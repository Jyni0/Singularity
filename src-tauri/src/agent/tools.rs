//! Everything the model can call, behind one `ToolRegistry`:
//!   registry - the `AgentTool` trait + registry (rig-core ToolDefinitions)
//!   builtin  - filesystem / shell / git / web / SSH / image tools, `skill`
//!   mcp      - MCP server tools, inline or through mcp_find / mcp_call
//!   specs    - built-in schemas + human-readable call summaries for the UI
//! The `delegate` tool lives with the subagent runner (runtime.rs).

mod builtin;
mod mcp;
mod registry;
mod specs;

pub(in crate::agent) use builtin::{builtin_tools, SkillTool};
pub(in crate::agent) use mcp::{load_mcp, mcp_catalog, mcp_deferred, mcp_mode, McpBinding, McpCall, McpFind, McpToolAdapter};
pub(in crate::agent) use registry::{norm_args, AgentTool, CallInfo, ToolRegistry, ToolSource};
pub(in crate::agent) use specs::{live_summary, summarize, tool_specs};
