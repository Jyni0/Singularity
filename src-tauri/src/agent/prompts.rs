//! System prompt generation.

mod builder;

pub(in crate::agent) use builder::{default_system, McpMode, SystemPromptBuilder};
