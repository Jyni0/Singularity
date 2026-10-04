//! Context management: history bounding, collapsing of old tool output,
//! read dedupe, auto-compaction, token accounting, and the project context
//! (instructions + repo map) the model starts with.

mod compact;
mod manager;
mod project;

pub(in crate::agent) use compact::{rebuild, split_point, summarize};
pub(in crate::agent) use manager::{est_tokens, one_line, read_fingerprint, trim_history, ContextManager};
pub(in crate::agent) use project::{project_context, ProjectContext};
