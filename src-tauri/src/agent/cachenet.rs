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
//! * Breakpoints ask for the 1-hour cache (as Claude Code does): with the
//!   5-minute default everything was gone after a pause between messages
//!   or a long Allow/Deny wait, and the next step paid the whole prompt
//!   again. A gateway that refuses `ttl` gets plain 5-minute marks.
//! * Responses streams from gateways often leave out fields Rig requires
//!   (`sequence_number`, `output_index`, the item's `status`/`id`…) — one
//!   such frame failed the whole request with "data did not match any
//!   variant of untagged enum StreamingCompletionChunk". Frames are
//!   repaired on the way in (see [`FrameFixer`]).

use bytes::Bytes;
use rig_agent::core::http_client::{self, HttpClientExt, LazyBody, MultipartForm, ReqwestClient, Request, Response, StreamingResponse};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

/// The request extras a gateway (by host) accepts.
#[derive(Clone, Copy, Debug)]
struct Accepted {
    /// `prompt_cache_key`.
    key: bool,
    /// The 1-hour `ttl` on breakpoints.
    ttl: bool,
    /// Anthropic breakpoints at all.
    marks: bool,
}

/// Gateways that refused some extra — they never get it again.
static ACCEPTED: Mutex<Option<HashMap<String, Accepted>>> = Mutex::new(None);

fn accepted(host: &str) -> Accepted {
    ACCEPTED
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.get(host).copied())
        .unwrap_or(Accepted { key: true, ttl: true, marks: true })
}

/// A 400 that complains about a request field (not, say, a too long
/// prompt): only then is an extra dropped and the request sent again.
fn refuses_extra(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("400")
        && ["prompt_cache_key", "cache_control", "ttl", "unrecognized", "unknown", "extra", "not permitted", "not allowed", "additional propert"]
            .iter()
            .any(|w| e.contains(w))
}

/// The body with the extras added; None = nothing to add (send it as is).
fn compose(body: &[u8], marks: bool, ttl: bool, key: Option<&str>) -> Option<Vec<u8>> {
    let marked = marks.then(|| add_breakpoints(body, ttl)).flatten();
    let Some(key) = key else { return marked };
    let mut v: Value = serde_json::from_slice(marked.as_deref().unwrap_or(body)).ok()?;
    let obj = v.as_object_mut()?;
    if !(obj.contains_key("input") || obj.contains_key("messages")) || obj.contains_key("prompt_cache_key") {
        return marked;
    }
    obj.insert("prompt_cache_key".into(), json!(key));
    serde_json::to_vec(&v).ok()
}

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
    /// `prompt_cache_key`: OpenAI routes requests with the same key to the
    /// same cache — without it a repeated prefix often lands on a machine
    /// that has never seen it, and a new message started at 0% cache.
    cache_key: Option<String>,
}

impl CacheClient {
    pub fn new(model: &str) -> Self {
        let inner = ReqwestClient::new();
        Self { inner, mark: model.to_lowercase().contains("claude"), seen: Arc::default(), cache_key: None }
    }

    /// Requests of one workspace + model share their cache routing key.
    pub fn with_cache_key(mut self, key: String) -> Self {
        self.cache_key = Some(key);
        self
    }
}

/// The breakpoint itself: 1-hour or the 5-minute default.
fn cache_control(long: bool) -> Value {
    if long {
        json!({ "type": "ephemeral", "ttl": "1h" })
    } else {
        json!({ "type": "ephemeral" })
    }
}

/// Puts a cache breakpoint on a message: string content becomes one text
/// part carrying `cache_control`; for part lists the last text part gets it.
fn mark_message(msg: &mut Value, long: bool) -> bool {
    let cc = cache_control(long);
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
pub fn add_breakpoints(body: &[u8], long: bool) -> Option<Vec<u8>> {
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
            last["output"] = json!([{ "type": "input_text", "text": text, "cache_control": cache_control(long) }]);
        } else if !mark_message(last, long) {
            return None;
        }
        return serde_json::to_vec(&v).ok();
    }
    let msgs = v.get_mut("messages")?.as_array_mut()?;
    let mut changed = false;
    if let Some(sys) = msgs.iter_mut().find(|m| matches!(m["role"].as_str(), Some("system") | Some("developer"))) {
        changed |= mark_message(sys, long);
    }
    if let Some(last) = msgs.iter_mut().rev().find(|m| matches!(m["role"].as_str(), Some("user") | Some("tool"))) {
        changed |= mark_message(last, long);
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
        let responses = parts.uri.path().trim_end_matches('/').ends_with("/responses");
        let (mark, key) = (self.mark, self.cache_key.clone());
        let inner = self.inner.clone();
        let seen = self.seen.clone();
        async move {
            *seen.lock().unwrap() = None;
            let send = |b: Bytes| inner.send_streaming(Request::from_parts(parts.clone(), b));
            // What this gateway accepts; each refusal (a 400) drops one
            // extra — the one it names, else the key, then the 1-hour ttl,
            // then the marks — and is remembered, never sent again.
            let mut ok = accepted(&host);
            let resp = loop {
                let out = compose(&body, mark && ok.marks, ok.ttl, key.as_deref().filter(|_| ok.key));
                let extra = out.is_some();
                match send(out.map(Bytes::from).unwrap_or_else(|| body.clone())).await {
                    Ok(r) => break r,
                    Err(e) if extra && refuses_extra(&e.to_string()) => {
                        let msg = e.to_string().to_lowercase();
                        let has_key = key.is_some() && ok.key;
                        if has_key && (msg.contains("prompt_cache_key") || !msg.contains("ttl")) {
                            ok.key = false;
                        } else if mark && ok.marks && ok.ttl {
                            ok.ttl = false;
                        } else {
                            ok.marks = false;
                        }
                        ACCEPTED.lock().unwrap().get_or_insert_with(HashMap::new).insert(host.clone(), ok);
                    }
                    Err(e) => return Err(e),
                }
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
            if responses {
                return Ok(Response::from_parts(parts, Box::pin(fix_frames(sniffed)) as _));
            }
            Ok(Response::from_parts(parts, Box::pin(sniffed) as _))
        }
    }
}

/* ---------- Responses stream repair ---------- */

/// Rewrites the `data:` lines of a Responses SSE stream through
/// [`repair_frame`]; everything else passes unchanged. Works on bytes, so a
/// UTF-8 character split across chunks is never mangled.
#[derive(Default)]
pub struct FrameFixer {
    buf: Vec<u8>,
    seq: u64,
}

impl FrameFixer {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            self.line(&line, &mut out);
        }
        out
    }

    /// End of stream: a last line without a newline.
    pub fn finish(&mut self) -> Vec<u8> {
        let rest = std::mem::take(&mut self.buf);
        let mut out = Vec::new();
        if !rest.is_empty() {
            self.line(&rest, &mut out);
        }
        out
    }

    fn line(&mut self, line: &[u8], out: &mut Vec<u8>) {
        let text = String::from_utf8_lossy(line);
        let Some(data) = text.trim_end_matches(['\r', '\n']).strip_prefix("data:") else {
            out.extend_from_slice(line);
            return;
        };
        if let Some(fixed) = repair_frame(data.trim(), &mut self.seq) {
            out.extend_from_slice(b"data: ");
            out.extend_from_slice(fixed.as_bytes());
            out.push(b'\n');
        }
    }
}

fn fix_frames<S, E>(inner: S) -> impl futures_util::Stream<Item = Result<Bytes, E>>
where
    S: futures_util::Stream<Item = Result<Bytes, E>> + Unpin,
{
    use futures_util::StreamExt;
    futures_util::stream::unfold((inner, FrameFixer::default(), false), |(mut inner, mut fixer, done)| async move {
        if done {
            return None;
        }
        match inner.next().await {
            Some(Ok(bytes)) => Some((Ok(Bytes::from(fixer.push(&bytes))), (inner, fixer, false))),
            Some(Err(e)) => Some((Err(e), (inner, fixer, false))),
            None => Some((Ok(Bytes::from(fixer.finish())), (inner, fixer, true))),
        }
    })
    // Chunks that held only part of a line.
    .filter(|r| futures_util::future::ready(!matches!(r, Ok(b) if b.is_empty())))
}

/// Events whose payload is a whole `response` object.
const RESPONSE_EVENTS: [&str; 5] =
    ["response.created", "response.in_progress", "response.completed", "response.failed", "response.incomplete"];

/// The one `data:` payload, with the fields Rig requires filled in. None =
/// drop the frame (it cannot be a Responses event at all).
pub fn repair_frame(data: &str, seq: &mut u64) -> Option<String> {
    use rig_agent::core::providers::openai::responses_api::streaming::StreamingCompletionChunk;
    let Ok(Value::Object(mut v)) = serde_json::from_str::<Value>(data) else {
        // `[DONE]`, keep-alives, non-objects: Rig skips them itself.
        return Some(data.to_string());
    };
    let Some(kind) = v.get("type").and_then(Value::as_str).map(str::to_string) else {
        // No event type: an error object becomes an error event (Rig then
        // shows its message); anything else (a chat/completions chunk from
        // a confused gateway) is not something this stream can use.
        return v.get("error").map(|e| json!({ "type": "error", "error": e }).to_string());
    };
    if !kind.starts_with("response.") {
        return Some(data.to_string());
    }
    match v.get("sequence_number").and_then(Value::as_u64) {
        Some(n) => *seq = n + 1,
        None => {
            v.insert("sequence_number".into(), json!(*seq));
            *seq += 1;
        }
    }
    let mut v = Value::Object(v);
    if RESPONSE_EVENTS.contains(&kind.as_str()) {
        let status = match kind.as_str() {
            "response.completed" => "completed",
            "response.failed" => "failed",
            "response.incomplete" => "incomplete",
            _ => "in_progress",
        };
        if !v["response"].is_object() {
            v["response"] = json!({});
        }
        repair_response(&mut v["response"], status);
    } else {
        let default = |v: &mut Value, key: &str, val: Value| {
            if v.get(key).is_none_or(Value::is_null) {
                v[key] = val;
            }
        };
        default(&mut v, "output_index", json!(0));
        if kind.contains("output_text") || kind.contains("refusal") || kind.contains("content_part") {
            default(&mut v, "content_index", json!(0));
        }
        if kind.contains("reasoning_summary") {
            default(&mut v, "summary_index", json!(0));
        }
        // Part events without their part (some gateways send only indexes).
        if kind.starts_with("response.reasoning_summary_part.") {
            default(&mut v, "part", json!({ "type": "summary_text", "text": "" }));
        }
        if kind.starts_with("response.content_part.") {
            default(&mut v, "part", json!({ "type": "output_text", "text": "" }));
        }
        if kind.ends_with(".delta") {
            default(&mut v, "delta", json!(""));
        }
        if kind == "response.output_text.done" || kind == "response.reasoning_text.done" {
            default(&mut v, "text", json!(""));
        }
        if kind == "response.function_call_arguments.done" {
            default(&mut v, "arguments", json!(""));
        }
        if kind.starts_with("response.output_item.") {
            if !v["item"].is_object() {
                return None;
            }
            let status = if kind.ends_with(".done") { "completed" } else { "in_progress" };
            repair_item(&mut v["item"], status);
        }
    }
    if let Err(e) = serde_json::from_value::<StreamingCompletionChunk>(v.clone()) {
        // Still not decodable: frames Rig can do without are dropped; the
        // text, tool-call and final ones go on and fail with the reason.
        let optional = matches!(
            kind.as_str(),
            "response.created" | "response.in_progress" | "response.output_item.added"
        ) || kind.starts_with("response.content_part.")
            || kind.starts_with("response.reasoning_summary_part.");
        if optional {
            return None;
        }
        eprintln!("[responses] frame {kind} does not decode ({e}): {}", super::context::one_line(data, 300));
    }
    Some(v.to_string())
}

/// A `response` object with Rig's required fields.
fn repair_response(r: &mut Value, status: &str) {
    let set = |r: &mut Value, key: &str, val: Value| {
        if r.get(key).is_none_or(Value::is_null) {
            r[key] = val;
        }
    };
    set(r, "id", json!(""));
    set(r, "object", json!("response"));
    set(r, "created_at", json!(0));
    set(r, "status", json!(status));
    set(r, "model", json!(""));
    if r.get("instructions").is_some_and(|i| !i.is_string() && !i.is_null()) {
        r["instructions"] = Value::Null;
    }
    let item_status = if status == "in_progress" { "in_progress" } else { "completed" };
    let items: Vec<Value> = match r.get_mut("output").map(Value::take) {
        Some(Value::Array(items)) => items
            .into_iter()
            .filter_map(|mut item| {
                if !item.is_object() {
                    return None;
                }
                repair_item(&mut item, item_status);
                Some(item)
            })
            .collect(),
        _ => Vec::new(),
    };
    r["output"] = Value::Array(items);
    if let Some(u) = r.get_mut("usage").filter(|u| u.is_object()) {
        let n = |u: &Value, k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
        let (input, output) = (n(u, "input_tokens").max(n(u, "prompt_tokens")), n(u, "output_tokens").max(n(u, "completion_tokens")));
        u["input_tokens"] = json!(input);
        u["output_tokens"] = json!(output);
        if u.get("total_tokens").and_then(Value::as_u64).is_none() {
            u["total_tokens"] = json!(input + output);
        }
        let cached = u.pointer("/input_tokens_details/cached_tokens").and_then(Value::as_u64).unwrap_or(0);
        u["input_tokens_details"] = json!({ "cached_tokens": cached });
        let reasoning = u.pointer("/output_tokens_details/reasoning_tokens").and_then(Value::as_u64).unwrap_or(0);
        u["output_tokens_details"] = json!({ "reasoning_tokens": reasoning });
    } else if r.get("usage").is_some() {
        r["usage"] = Value::Null;
    }
}

/// An output item (message / function call / reasoning) with Rig's
/// required fields.
fn repair_item(item: &mut Value, status: &str) {
    let set = |v: &mut Value, key: &str, val: Value| {
        if v.get(key).is_none_or(Value::is_null) {
            v[key] = val;
        }
    };
    match item.get("type").and_then(Value::as_str).unwrap_or("") {
        "message" => {
            set(item, "id", json!(""));
            set(item, "role", json!("assistant"));
            set(item, "status", json!(status));
            let parts: Vec<Value> = match item.get_mut("content").map(Value::take) {
                Some(Value::Array(parts)) => parts
                    .into_iter()
                    .filter_map(|mut p| {
                        let kind = p.get("type").and_then(Value::as_str).unwrap_or("text").to_string();
                        match kind.as_str() {
                            "output_text" | "text" => {
                                p["type"] = json!("output_text");
                                set(&mut p, "text", json!(""));
                                Some(p)
                            }
                            "refusal" => {
                                set(&mut p, "refusal", json!(""));
                                Some(p)
                            }
                            _ => None,
                        }
                    })
                    .collect(),
                Some(Value::String(text)) => vec![json!({ "type": "output_text", "text": text })],
                _ => Vec::new(),
            };
            item["content"] = Value::Array(parts);
        }
        "function_call" => {
            let id = item.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            set(item, "call_id", json!(id));
            set(item, "name", json!(""));
            set(item, "arguments", json!(""));
            set(item, "status", json!(status));
        }
        "reasoning" => {
            set(item, "id", json!(""));
            set(item, "summary", json!([]));
        }
        _ => {}
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
        let out: Value = serde_json::from_slice(&add_breakpoints(body.to_string().as_bytes(), true).unwrap()).unwrap();
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
        let out: Value = serde_json::from_slice(&add_breakpoints(body.to_string().as_bytes(), true).unwrap()).unwrap();
        assert_eq!(out["input"][2]["content"][0]["cache_control"]["type"], "ephemeral");
        assert!(out["input"][0]["content"][0].get("cache_control").is_none());
        assert_eq!(out["instructions"], "SYSTEM PROMPT");

        // Inside the tool loop the newest item is a tool result.
        let mut looped = body.clone();
        looped["input"].as_array_mut().unwrap().push(json!({ "call_id": "c1", "output": "listing", "type": "function_call_output" }));
        let out: Value = serde_json::from_slice(&add_breakpoints(looped.to_string().as_bytes(), true).unwrap()).unwrap();
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

    #[test]
    fn marks_ask_for_one_hour_unless_refused() {
        let body = json!({ "messages": [{ "role": "user", "content": "hi" }] }).to_string();
        let long: Value = serde_json::from_slice(&add_breakpoints(body.as_bytes(), true).unwrap()).unwrap();
        assert_eq!(long["messages"][0]["content"][0]["cache_control"]["ttl"], "1h");
        let short: Value = serde_json::from_slice(&add_breakpoints(body.as_bytes(), false).unwrap()).unwrap();
        assert!(short["messages"][0]["content"][0]["cache_control"].get("ttl").is_none());
    }

    #[test]
    fn only_field_complaints_drop_extras() {
        assert!(refuses_extra("HTTP 400: Unrecognized request argument supplied: prompt_cache_key"));
        assert!(refuses_extra("400 Bad Request: cache_control.ttl: Extra inputs are not permitted"));
        assert!(!refuses_extra("400 Bad Request: prompt is too long: 250000 tokens > 200000 maximum"));
        assert!(!refuses_extra("429 Too Many Requests"));
    }

    #[test]
    fn cache_key_is_added_once_and_only_to_conversations() {
        let chat = json!({ "model": "gpt-5", "messages": [{ "role": "user", "content": "hi" }] }).to_string();
        let out: Value = serde_json::from_slice(&compose(chat.as_bytes(), false, true, Some("k1")).unwrap()).unwrap();
        assert_eq!(out["prompt_cache_key"], "k1");
        let resp = json!({ "input": [], "prompt_cache_key": "mine" }).to_string();
        assert!(compose(resp.as_bytes(), false, true, Some("k1")).is_none());
        assert!(compose(b"{\"x\":1}", false, true, Some("k1")).is_none());
        // Marks and key together.
        let claude = json!({ "messages": [{ "role": "user", "content": "hi" }] }).to_string();
        let out: Value = serde_json::from_slice(&compose(claude.as_bytes(), true, false, Some("k")).unwrap()).unwrap();
        assert_eq!(out["prompt_cache_key"], "k");
        assert!(out["messages"][0]["content"][0]["cache_control"].get("ttl").is_none());
    }

    /// Frames as sparse gateways send them decode after the repair.
    #[test]
    fn sparse_responses_frames_are_repaired() {
        use rig_agent::core::providers::openai::responses_api::streaming::StreamingCompletionChunk;
        let mut seq = 0;
        let frames = [
            r#"{"type":"response.created","response":{"id":"r1","model":"claude"}}"#,
            r#"{"type":"response.output_item.added","item":{"type":"message","content":[]}}"#,
            r#"{"type":"response.output_text.delta","delta":"При"}"#,
            r#"{"type":"response.reasoning_summary_part.added","sequence_number":3,"item_id":"rs_1","output_index":0,"summary_index":0,"part_index":0}"#,
            r#"{"type":"response.content_part.added","item_id":"msg_1","output_index":0,"content_index":0}"#,
            r#"{"type":"response.output_text.done","text":"Привет"}"#,
            r#"{"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_1","name":"read_file","arguments":"{}"}}"#,
            r#"{"type":"response.completed","response":{"id":"r1","output":[{"type":"message","content":[{"type":"text","text":"Привет"}]}],"usage":{"input_tokens":10,"output_tokens":2}}}"#,
        ];
        for f in frames {
            let fixed = repair_frame(f, &mut seq).expect("kept");
            serde_json::from_str::<StreamingCompletionChunk>(&fixed).unwrap_or_else(|e| panic!("{f}\n→ {fixed}\n{e}"));
        }
        assert_eq!(seq, 8); // numbering continues after the gateway's own 3
    }

    #[test]
    fn untyped_frames_become_errors_or_are_dropped() {
        let mut seq = 0;
        let err = repair_frame(r#"{"error":{"message":"quota exceeded"}}"#, &mut seq).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&err).unwrap()["type"], "error");
        assert!(repair_frame(r#"{"choices":[{"delta":{"content":"x"}}]}"#, &mut seq).is_none());
        assert_eq!(repair_frame("[DONE]", &mut seq).as_deref(), Some("[DONE]"));
    }

    /// A Cyrillic character split between two chunks survives intact.
    #[test]
    fn fixer_keeps_split_utf8() {
        let line = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Ж\"}\n\n".as_bytes();
        let cut = line.iter().position(|b| *b >= 0x80).unwrap() + 1;
        let mut fx = FrameFixer::default();
        let mut out = fx.push(&line[..cut]);
        out.extend(fx.push(&line[cut..]));
        out.extend(fx.finish());
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("\"delta\":\"Ж\""), "{text}");
        assert!(text.contains("sequence_number"));
    }

}
