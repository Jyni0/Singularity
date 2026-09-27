//! Web access for the agent, as real tools instead of `curl` in a shell:
//!   web_search — results from DuckDuckGo's HTML endpoint (no API key), with
//!                DuckDuckGo Lite as the fallback when the first answers
//!                with a bot check;
//!   web_fetch  — one page as readable text (scripts, styles and markup
//!                dropped, links kept), paged by `start` for long pages.

use crate::tools::ToolResult;
use regex::Regex;
use std::sync::LazyLock;
use std::time::Duration;

const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
/// Largest response body read.
const MAX_BYTES: usize = 5_000_000;
/// Text returned per web_fetch call.
const PAGE_CHARS: usize = 30_000;

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(25))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .unwrap_or_default()
});

/* ---------- HTML → text ---------- */

static DROP_BLOCKS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    ["script", "style", "noscript", "svg", "template", "iframe", "nav", "footer", "form", "select"]
        .iter()
        .map(|t| Regex::new(&format!(r"(?is)<{t}\b.*?</{t}\s*>")).unwrap())
        .collect()
});
static COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<!--.*?-->").unwrap());
static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap());
static LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>"#).unwrap());
static HEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<h([1-6])\b[^>]*>").unwrap());
static LIST_ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<li\b[^>]*>").unwrap());
static BLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)</?(p|div|br|tr|table|section|article|header|main|aside|pre|blockquote|ul|ol|dl|dt|dd|h[1-6]|hr|figure|figcaption)\b[^>]*>")
        .unwrap()
});
static CELL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)</t[dh]\s*>").unwrap());
static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<[^>]*>").unwrap());
static ENTITY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t\u{a0}]+").unwrap());
static BLANKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n\s*\n(\s*\n)+").unwrap());

fn decode_entities(s: &str) -> String {
    ENTITY
        .replace_all(s, |c: &regex::Captures| {
            let e = &c[1];
            let ch = if let Some(hex) = e.strip_prefix("#x").or_else(|| e.strip_prefix("#X")) {
                u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
            } else if let Some(dec) = e.strip_prefix('#') {
                dec.parse::<u32>().ok().and_then(char::from_u32)
            } else {
                match e {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some(' '),
                    "mdash" => Some('—'),
                    "ndash" => Some('–'),
                    "hellip" => Some('…'),
                    "laquo" => Some('«'),
                    "raquo" => Some('»'),
                    "copy" => Some('©'),
                    _ => None,
                }
            };
            ch.map(String::from).unwrap_or_else(|| c[0].to_string())
        })
        .into_owned()
}

fn inline_text(html: &str) -> String {
    SPACES.replace_all(&decode_entities(&TAG.replace_all(html, " ")), " ").trim().to_string()
}

/// A page's title and its readable text.
pub fn html_to_text(html: &str) -> (String, String) {
    let title = TITLE.captures(html).map(|c| inline_text(&c[1])).unwrap_or_default();
    // Only the body — <head> is metadata.
    let lower = html.to_ascii_lowercase();
    let body = match lower.find("<body") {
        Some(i) => &html[i..],
        None => html,
    };
    let mut s = COMMENT.replace_all(body, "").into_owned();
    for re in DROP_BLOCKS.iter() {
        s = re.replace_all(&s, "").into_owned();
    }
    s = LINK
        .replace_all(&s, |c: &regex::Captures| {
            let text = inline_text(&c[2]);
            let href = decode_entities(&c[1]);
            if text.is_empty() {
                String::new()
            } else if href.starts_with("http") && !text.starts_with("http") {
                format!("[{text}]({href})")
            } else {
                text
            }
        })
        .into_owned();
    s = HEADING.replace_all(&s, |c: &regex::Captures| format!("\n\n{} ", "#".repeat(c[1].parse().unwrap_or(2)))).into_owned();
    s = LIST_ITEM.replace_all(&s, "\n- ").into_owned();
    s = CELL.replace_all(&s, " | ").into_owned();
    s = BLOCK.replace_all(&s, "\n").into_owned();
    s = TAG.replace_all(&s, "").into_owned();
    s = decode_entities(&s);
    let lines: Vec<String> = s.lines().map(|l| SPACES.replace_all(l, " ").trim().to_string()).collect();
    let text = BLANKS.replace_all(&lines.join("\n"), "\n\n").trim().to_string();
    (title, text)
}

/* ---------- Fetch ---------- */

/// Reads a body up to MAX_BYTES and decodes it with its declared charset.
async fn read_body(mut resp: reqwest::Response) -> Result<(String, String), String> {
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("download failed: {e}"))? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() >= MAX_BYTES {
            break;
        }
    }
    let label = ctype
        .split("charset=")
        .nth(1)
        .map(|c| c.trim_matches(['"', ' ', ';']).to_string())
        .or_else(|| {
            // <meta charset="windows-1251">
            let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_lowercase();
            head.split("charset=").nth(1).map(|r| {
                r.trim_start_matches(['"', '\''])
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                    .collect()
            })
        });
    let enc = label
        .and_then(|l| encoding_rs::Encoding::for_label(l.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let (text, _, _) = enc.decode(&bytes);
    Ok((ctype, text.into_owned()))
}

fn char_window(text: &str, start: usize, len: usize) -> (&str, usize) {
    let total = text.chars().count();
    let from = text.char_indices().nth(start).map(|(i, _)| i).unwrap_or(text.len());
    let to = text.char_indices().nth(start + len).map(|(i, _)| i).unwrap_or(text.len());
    (&text[from..to], total)
}

/// `web_fetch`: a URL as readable text.
pub async fn fetch(url: &str, start: usize) -> ToolResult {
    let url = url.trim();
    let url = if url.starts_with("http://") || url.starts_with("https://") {
        url.to_string()
    } else if url.contains("://") {
        return ToolResult::err("only http and https URLs can be fetched");
    } else {
        format!("https://{url}")
    };
    let resp = match CLIENT
        .get(&url)
        .header("Accept", "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5")
        .header("Accept-Language", "en-US,en;q=0.9,ru;q=0.8")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return ToolResult::err(format!("cannot fetch {url}: {e}")),
    };
    let status = resp.status();
    let final_url = resp.url().to_string();
    let (ctype, body) = match read_body(resp).await {
        Ok(b) => b,
        Err(e) => return ToolResult::err(e),
    };
    if ctype.starts_with("image/") || ctype.starts_with("video/") || ctype.starts_with("audio/") || ctype.contains("octet-stream") || ctype.contains("pdf") || ctype.contains("zip") {
        return ToolResult::err(format!("{final_url} is binary ({ctype}) — it cannot be read as text"));
    }
    let (title, text) = if ctype.contains("html") || (ctype.is_empty() && body.trim_start().starts_with('<')) {
        html_to_text(&body)
    } else {
        (String::new(), body)
    };
    let (window, total) = char_window(&text, start, PAGE_CHARS);
    let mut out = format!("{final_url} — HTTP {}", status.as_u16());
    if !title.is_empty() {
        out.push_str(&format!("\ntitle: {title}"));
    }
    if start > 0 || total > PAGE_CHARS {
        out.push_str(&format!("\n(chars {start}–{} of {total})", start + window.chars().count()));
    }
    out.push_str("\n\n");
    out.push_str(if window.trim().is_empty() { "(no readable text)" } else { window });
    if start + PAGE_CHARS < total {
        out.push_str(&format!("\n\n… more text: call web_fetch again with start={}", start + PAGE_CHARS));
    }
    if status.is_success() {
        ToolResult::ok(out)
    } else {
        ToolResult::err(out)
    }
}

/* ---------- Search ---------- */

pub struct Hit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

static DDG_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#).unwrap());
static DDG_SNIPPET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)class="result__snippet"[^>]*>(.*?)</(?:a|div|td)>"#).unwrap());
static LITE_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)<a[^>]*href="([^"]+)"[^>]*class='result-link'[^>]*>(.*?)</a>"#).unwrap());
static LITE_SNIPPET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)class='result-snippet'[^>]*>(.*?)</td>"#).unwrap());

/// DuckDuckGo wraps results as //duckduckgo.com/l/?uddg=<url>&rut=…
fn ddg_target(href: &str) -> String {
    let href = decode_entities(href);
    if let Some(i) = href.find("uddg=") {
        let enc = href[i + 5..].split('&').next().unwrap_or("");
        if let Ok(u) = urlencoding::decode(enc) {
            return u.into_owned();
        }
    }
    if href.starts_with("//") {
        format!("https:{href}")
    } else {
        href
    }
}

async fn ddg(query: &str) -> Result<Vec<Hit>, String> {
    let resp = CLIENT
        .post("https://html.duckduckgo.com/html/")
        .form(&[("q", query), ("kl", "wt-wt")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let (_, html) = read_body(resp).await?;
    let snippets: Vec<String> = DDG_SNIPPET.captures_iter(&html).map(|c| inline_text(&c[1])).collect();
    Ok(DDG_LINK
        .captures_iter(&html)
        .enumerate()
        .map(|(i, c)| Hit {
            title: inline_text(&c[2]),
            url: ddg_target(&c[1]),
            snippet: snippets.get(i).cloned().unwrap_or_default(),
        })
        // Ads go through duckduckgo.com/y.js
        .filter(|h| h.url.starts_with("http") && !h.url.contains("duckduckgo.com/y.js"))
        .collect())
}

/// DuckDuckGo Lite — a different page, usually still served when the HTML
/// endpoint asks for a captcha.
async fn ddg_lite(query: &str) -> Result<Vec<Hit>, String> {
    let resp = CLIENT
        .post("https://lite.duckduckgo.com/lite/")
        .form(&[("q", query), ("kl", "wt-wt")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let (_, html) = read_body(resp).await?;
    let snippets: Vec<String> = LITE_SNIPPET.captures_iter(&html).map(|c| inline_text(&c[1])).collect();
    Ok(LITE_LINK
        .captures_iter(&html)
        .enumerate()
        .map(|(i, c)| Hit {
            title: inline_text(&c[2]),
            url: ddg_target(&c[1]),
            snippet: snippets.get(i).cloned().unwrap_or_default(),
        })
        .filter(|h| h.url.starts_with("http") && !h.url.contains("duckduckgo.com/y.js"))
        .collect())
}

/// `web_search`: top results for a query.
pub async fn search(query: &str, max: usize) -> ToolResult {
    let query = query.trim();
    if query.is_empty() {
        return ToolResult::err("empty query");
    }
    let max = max.clamp(1, 20);
    let mut errors = Vec::new();
    let mut hits = match ddg(query).await {
        Ok(h) => h,
        Err(e) => {
            errors.push(format!("duckduckgo: {e}"));
            Vec::new()
        }
    };
    if hits.is_empty() {
        match ddg_lite(query).await {
            Ok(h) => hits = h,
            Err(e) => errors.push(format!("duckduckgo lite: {e}")),
        }
    }
    if hits.is_empty() {
        return ToolResult::err(if errors.is_empty() {
            format!("no results for {query:?}")
        } else {
            format!("search failed ({})", errors.join("; "))
        });
    }
    let mut out = format!("results for {query:?} (open one with web_fetch):");
    for (i, h) in hits.iter().take(max).enumerate() {
        out.push_str(&format!("\n\n{}. {}\n   {}", i + 1, h.title, h.url));
        if !h.snippet.is_empty() {
            out.push_str(&format!("\n   {}", h.snippet));
        }
    }
    ToolResult::ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_becomes_readable_text() {
        let html = r#"<html><head><title>T &amp; X</title><style>.a{}</style></head>
            <body><nav>menu</nav><h1>Hello</h1><p>One&nbsp;two <a href="https://x.dev/a">link</a></p>
            <script>alert(1)</script><ul><li>a</li><li>b</li></ul></body></html>"#;
        let (title, text) = html_to_text(html);
        assert_eq!(title, "T & X");
        assert!(text.contains("# Hello"), "{text}");
        assert!(text.contains("One two [link](https://x.dev/a)"), "{text}");
        assert!(text.contains("- a\n- b"), "{text}");
        assert!(!text.contains("alert") && !text.contains("menu"), "{text}");
    }

    #[test]
    fn unwraps_result_links() {
        assert_eq!(
            ddg_target("//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.rs%2Fregex&amp;rut=abc"),
            "https://docs.rs/regex"
        );
    }

    /// Live network — run with `cargo test web -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_search_and_fetch() {
        let r = search("tauri v2 single instance plugin", 5).await;
        println!("{}", r.output);
        assert!(r.ok, "{}", r.output);
        let b = ddg_lite("rust regex crate").await.unwrap();
        println!("lite: {:?}", b.iter().map(|h| (&h.url, &h.snippet)).take(2).collect::<Vec<_>>());
        assert!(!b.is_empty());
        let f = fetch("https://example.com", 0).await;
        println!("{}", f.output);
        assert!(f.ok && f.output.contains("Example Domain"), "{}", f.output);
    }
}
