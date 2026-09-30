//! HTTP transport for OpenAI-compatible providers that makes prompt caching
//! work and visible.
//!
//! * Claude behind an OpenAI-compatible gateway (OpenRouter, resellers…)
//!   caches nothing unless the request carries Anthropic `cache_control`
//!   breakpoints — plain /chat/completions has no such field, so every step
//!   re-billed the whole prompt ("0% cache"). The request body gets
//!   breakpoints on the system prompt (caches tools + system) and on the
//!   last user/tool message (caches the history), in the content-part form
//!   gateways forward to Anthropic. A gateway that rejects them is retried
//!   once without, and not marked again.
//! * Gateways report cache hits in different fields (`prompt_tokens_details.
//!   cached_tokens`, Anthropic's `cache_read_input_tokens`, DeepSeek's
//!   `prompt_cache_hit_tokens`); Rig reads only the first. The streamed
//!   usage is sniffed so the HUD shows real hits.

use bytes::Bytes;
use rig_agent::core::http_client::{self, HttpClientExt, LazyBody, MultipartForm, ReqwestClient, Request, Response, StreamingResponse};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::future::Future;
use std::sync::{Arc, Mutex};

/// Gateways (by host) that refused the breakpoints — never marked again.
static REFUSED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Cache numbers read from the provider's own usage report.
#[derive(Debug, Clone, Copy, Default)]
pub struct CacheSeen {
    pub prompt: u64,
    pub cached: u64,
    pub created: u64,
}

#[derive(Clone, Debug, Default)]
pub struct CacheClient {
    inner: ReqwestClient,
    /// Add Anthropic cache breakpoints (Claude models only).
    mark: bool,
    /// Usage of the latest streamed response.
    pub seen: Arc<Mutex<Option<CacheSeen>>>,
}

impl CacheClient {
    pub fn new(model: &str) -> Self {
        let inner = ReqwestClient::new();
        Self { inner, mark: model.to_lowercase().contains("claude"), seen: Arc::default() }
    }

    fn refused(host: &str) -> bool {
        REFUSED.lock().unwrap().as_ref().is_some_and(|s| s.contains(host))
    }
}

/// Puts a cache breakpoint on a message: string content becomes one text
/// part carrying `cache_control`; for part lists the last text part gets it.
fn mark_message(msg: &mut Value) -> bool {
    let cc = json!({ "type": "ephemeral" });
    match msg.get_mut("content") {
        Some(Value::String(s)) if !s.is_empty() => {
            let text = std::mem::take(s);
            msg["content"] = json!([{ "type": "text", "text": text, "cache_control": cc }]);
            true
        }
        Some(Value::Array(parts)) => match parts
            .iter_mut()
            .rev()
            .find(|p| matches!(p.get("type").and_then(Value::as_str), Some("text" | "input_text")))
        {
            Some(p) => {
                p["cache_control"] = cc;
                true
            }
            None => false,
        },
        _ => false,
    }
}

/// Adds breakpoints to a chat/completions or /responses body; None = nothing
/// to change.
pub fn add_breakpoints(body: &[u8]) -> Option<Vec<u8>> {
    let mut v: Value = serde_json::from_slice(body).ok()?;
    // Responses: `instructions` is a plain string (no place for a mark), the
    // conversation is `input`. One mark on the newest user text or tool
    // result caches everything before it — tools, instructions, history.
    if let Some(items) = v.get_mut("input").and_then(Value::as_array_mut) {
        let last = items.iter_mut().rev().find(|m| {
            (m["role"] == "user" && m["content"].is_array()) || (m["type"] == "function_call_output" && m["output"].is_string())
        })?;
        if last["type"] == "function_call_output" {
            let text = last["output"].as_str().unwrap_or("").to_string();
            last["output"] = json!([{ "type": "input_text", "text": text, "cache_control": { "type": "ephemeral" } }]);
        } else if !mark_message(last) {
            return None;
        }
        return serde_json::to_vec(&v).ok();
    }
    let msgs = v.get_mut("messages")?.as_array_mut()?;
    let mut changed = false;
    if let Some(sys) = msgs.iter_mut().find(|m| matches!(m["role"].as_str(), Some("system") | Some("developer"))) {
        changed |= mark_message(sys);
    }
    if let Some(last) = msgs.iter_mut().rev().find(|m| matches!(m["role"].as_str(), Some("user") | Some("tool"))) {
        changed |= mark_message(last);
    }
    if !changed {
        return None;
    }
    serde_json::to_vec(&v).ok()
}

/// Cache fields of one usage object, whatever the provider calls them.
pub fn read_usage(v: &Value) -> Option<CacheSeen> {
    let u = v.get("usage").filter(|u| u.is_object())?;
    let n = |p: &str| u.pointer(p).and_then(Value::as_u64).unwrap_or(0);
    let cached = n("/prompt_tokens_details/cached_tokens")
        .max(n("/cache_read_input_tokens"))
        .max(n("/prompt_cache_hit_tokens"))
        .max(n("/input_tokens_details/cached_tokens"));
    let created = n("/cache_creation_input_tokens");
    let prompt = n("/prompt_tokens").max(n("/input_tokens"));
    (prompt > 0 || cached > 0).then_some(CacheSeen { prompt, cached, created })
}

/// Feeds SSE text and records every usage object in complete `data:` lines.
fn sniff(buf: &mut String, chunk: &[u8], seen: &Mutex<Option<CacheSeen>>) {
    buf.push_str(&String::from_utf8_lossy(chunk));
    while let Some(nl) = buf.find('\n') {
        let line: String = buf.drain(..=nl).collect();
        let Some(data) = line.trim().strip_prefix("data:") else { continue };
        if !data.contains("usage") {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(data.trim()) {
            if let Some(u) = read_usage(&v) {
                *seen.lock().unwrap() = Some(u);
            }
        }
    }
    // A runaway line without newlines must not grow forever.
    if buf.len() > 1_000_000 {
        buf.clear();
    }
}

impl HttpClientExt for CacheClient {
    fn send<T, U>(&self, req: Request<T>) -> impl Future<Output = http_client::Result<Response<LazyBody<U>>>> + Send + 'static
    where
        T: Into<Bytes> + Send,
        U: From<Bytes> + Send + 'static,
    {
        self.inner.send(req)
    }

    fn send_multipart<U>(&self, req: Request<MultipartForm>) -> impl Future<Output = http_client::Result<Response<LazyBody<U>>>> + Send + 'static
    where
        U: From<Bytes> + Send + 'static,
    {
        self.inner.send_multipart(req)
    }

    fn send_streaming<T>(&self, req: Request<T>) -> impl Future<Output = http_client::Result<StreamingResponse>> + Send
    where
        T: Into<Bytes> + Send,
    {
        let (parts, body) = req.into_parts();
        let body: Bytes = body.into();
        let host = parts.uri.host().unwrap_or("").to_string();
        let marked = (self.mark && !Self::refused(&host)).then(|| add_breakpoints(&body)).flatten();
        let inner = self.inner.clone();
        let seen = self.seen.clone();
        async move {
            *seen.lock().unwrap() = None;
            let first = Request::from_parts(parts.clone(), marked.clone().map(Bytes::from).unwrap_or_else(|| body.clone()));
            let resp = match inner.send_streaming(first).await {
                Ok(r) => r,
                Err(e) if marked.is_some() && e.to_string().contains("400") => {
                    // The gateway did not take the breakpoints: plain request, and never again.
                    REFUSED.lock().unwrap().get_or_insert_with(HashSet::new).insert(host);
                    inner.send_streaming(Request::from_parts(parts, body)).await?
                }
                Err(e) => return Err(e),
            };
            use futures_util::StreamExt;
            let (parts, stream) = resp.into_parts();
            let mut buf = String::new();
            let sniffed = stream.map(move |chunk| {
                if let Ok(bytes) = &chunk {
                    sniff(&mut buf, bytes, &seen);
                }
                chunk
            });
            Ok(Response::from_parts(parts, Box::pin(sniffed) as _))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn breakpoints_go_on_system_and_last_turn() {
        let body = json!({
            "model": "claude-opus-5",
            "messages": [
                { "role": "system", "content": "You are an agent." },
                { "role": "user", "content": "hi" },
                { "role": "assistant", "content": null, "tool_calls": [] },
                { "role": "tool", "tool_call_id": "1", "content": "result" }
            ]
        });
        let out: Value = serde_json::from_slice(&add_breakpoints(body.to_string().as_bytes()).unwrap()).unwrap();
        assert_eq!(out["messages"][0]["content"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(out["messages"][0]["content"][0]["text"], "You are an agent.");
        assert!(out["messages"][1]["content"].is_string(), "only the last user/tool turn is marked");
        assert_eq!(out["messages"][3]["content"][0]["cache_control"]["type"], "ephemeral");
    }

    /// The body Rig's Responses client really sends (captured).
    #[test]
    fn responses_body_is_marked_on_the_newest_user_text() {
        let body = json!({
            "input": [
                { "content": [{ "text": "first", "type": "input_text" }], "role": "user", "type": "message" },
                { "content": "answer", "role": "assistant", "type": "message" },
                { "content": [{ "text": "latest", "type": "input_text" }], "role": "user", "type": "message" }
            ],
            "instructions": "SYSTEM PROMPT",
            "model": "claude-opus-4-6",
            "stream": true
        });
        let out: Value = serde_json::from_slice(&add_breakpoints(body.to_string().as_bytes()).unwrap()).unwrap();
        assert_eq!(out["input"][2]["content"][0]["cache_control"]["type"], "ephemeral");
        assert!(out["input"][0]["content"][0].get("cache_control").is_none());
        assert_eq!(out["instructions"], "SYSTEM PROMPT");

        // Inside the tool loop the newest item is a tool result.
        let mut looped = body.clone();
        looped["input"].as_array_mut().unwrap().push(json!({ "call_id": "c1", "output": "listing", "type": "function_call_output" }));
        let out: Value = serde_json::from_slice(&add_breakpoints(looped.to_string().as_bytes()).unwrap()).unwrap();
        assert_eq!(out["input"][3]["output"][0]["text"], "listing");
        assert_eq!(out["input"][3]["output"][0]["cache_control"]["type"], "ephemeral");
        assert!(out["input"][2]["content"][0].get("cache_control").is_none());
    }

    #[test]
    fn usage_fields_of_every_flavour() {
        let openai = json!({ "usage": { "prompt_tokens": 1000, "prompt_tokens_details": { "cached_tokens": 800 } } });
        assert_eq!(read_usage(&openai).unwrap().cached, 800);
        let anthropic = json!({ "usage": { "prompt_tokens": 50, "cache_read_input_tokens": 900, "cache_creation_input_tokens": 10 } });
        let a = read_usage(&anthropic).unwrap();
        assert_eq!((a.prompt, a.cached, a.created), (50, 900, 10));
        let deepseek = json!({ "usage": { "prompt_tokens": 500, "prompt_cache_hit_tokens": 300 } });
        assert_eq!(read_usage(&deepseek).unwrap().cached, 300);
        assert!(read_usage(&json!({ "choices": [] })).is_none());

        let seen = Mutex::new(None);
        let mut buf = String::new();
        sniff(&mut buf, b"data: {\"choices\":[]}\n\ndata: {\"usage\":{\"prompt_tok", &seen);
        assert!(seen.lock().unwrap().is_none());
        sniff(&mut buf, b"ens\":10,\"prompt_tokens_details\":{\"cached_tokens\":7}}}\n\n", &seen);
        assert_eq!(seen.lock().unwrap().unwrap().cached, 7);
    }
}
