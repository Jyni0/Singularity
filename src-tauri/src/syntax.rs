//! Syntax check of files the agent writes — tree-sitter (the parser behind
//! GitHub's code navigation, Neovim, Zed) with bundled grammars.
//!
//! After every edit the new content is parsed; syntax errors the edit
//! INTRODUCED (unclosed tags / brackets, a stray brace, a half-pasted line)
//! go straight back to the model with line numbers, so it fixes them in the
//! next step instead of leaving broken code behind. Errors that were already
//! in the file are not blamed on the edit. HTML-like files additionally get
//! a tag-balance check: the HTML grammar itself tolerates unclosed tags.

use std::path::Path;
use tree_sitter::{Language, Node, Parser};

/// One syntax problem: 1-based line and column plus what is wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub line: usize,
    pub col: usize,
    pub what: String,
}

/// Most problems reported back in one message.
const MAX_REPORTED: usize = 8;
/// Files larger than this are not parsed (generated bundles, lockfiles).
const MAX_BYTES: usize = 1_500_000;

pub(crate) fn language(path: &Path) -> Option<Language> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "js" | "mjs" | "cjs" | "jsx" => tree_sitter_javascript::LANGUAGE.into(),
        "ts" | "mts" | "cts" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "py" | "pyw" => tree_sitter_python::LANGUAGE.into(),
        "rs" => tree_sitter_rust::LANGUAGE.into(),
        "json" => tree_sitter_json::LANGUAGE.into(),
        "css" => tree_sitter_css::LANGUAGE.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        "java" => tree_sitter_java::LANGUAGE.into(),
        "c" | "h" => tree_sitter_c::LANGUAGE.into(),
        "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" => tree_sitter_cpp::LANGUAGE.into(),
        "cs" => tree_sitter_c_sharp::LANGUAGE.into(),
        "php" => tree_sitter_php::LANGUAGE_PHP.into(),
        "sh" | "bash" => tree_sitter_bash::LANGUAGE.into(),
        "html" | "htm" => tree_sitter_html::LANGUAGE.into(),
        _ => return None,
    })
}

fn html_like(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("html" | "htm" | "vue" | "svelte")
    )
}

/// Whether the file type is checked at all.
pub fn supported(path: &Path) -> bool {
    language(path).is_some() || html_like(path)
}

/// Every syntax problem of `text` parsed as `path`'s language; None when the
/// language is not supported (or the file is too large to bother).
pub fn check(path: &Path, text: &str) -> Option<Vec<Problem>> {
    if text.len() > MAX_BYTES || !supported(path) {
        return None;
    }
    let mut problems = Vec::new();
    if let Some(lang) = language(path) {
        let mut parser = Parser::new();
        parser.set_language(&lang).ok()?;
        let tree = parser.parse(text, None)?;
        collect(tree.root_node(), text, &mut problems);
    }
    if html_like(path) {
        problems.extend(tag_balance(text));
    }
    problems.sort_by_key(|p| (p.line, p.col));
    problems.dedup_by(|a, b| a.line == b.line && a.what == b.what);
    Some(problems)
}

fn collect(node: Node, text: &str, out: &mut Vec<Problem>) {
    if !node.has_error() {
        return;
    }
    let pos = node.start_position();
    if node.is_missing() {
        out.push(Problem { line: pos.row + 1, col: pos.column + 1, what: format!("missing `{}`", node.kind()) });
        return;
    }
    if node.is_error() {
        // Innermost errors are the precise ones; report this node only when
        // nothing inside it is an error itself.
        let before = out.len();
        let mut c = node.walk();
        for child in node.children(&mut c) {
            collect(child, text, out);
        }
        if out.len() == before {
            let snippet: String = text[node.byte_range()].lines().next().unwrap_or("").trim().chars().take(60).collect();
            out.push(Problem {
                line: pos.row + 1,
                col: pos.column + 1,
                what: if snippet.is_empty() { "syntax error".into() } else { format!("syntax error near `{snippet}`") },
            });
        }
        return;
    }
    let mut c = node.walk();
    for child in node.children(&mut c) {
        collect(child, text, out);
    }
}

/// Unclosed / unmatched tags in HTML-like markup. Void elements, comments,
/// self-closing tags and the insides of script/style/pre are skipped.
fn tag_balance(text: &str) -> Vec<Problem> {
    const VOID: &[&str] = &[
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "!doctype",
    ];
    // Tags browsers close implicitly — not worth flagging.
    const OPTIONAL: &[&str] = &["p", "li", "dt", "dd", "tr", "td", "th", "option", "thead", "tbody", "tfoot", "html", "head", "body"];
    let line_of = |at: usize| text[..at].matches('\n').count() + 1;
    let mut stack: Vec<(String, usize)> = Vec::new();
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while let Some(off) = text[i..].find('<') {
        let at = i + off;
        if text[at..].starts_with("<!--") {
            i = text[at..].find("-->").map(|e| at + e + 3).unwrap_or(text.len());
            continue;
        }
        let Some(end) = text[at..].find('>').map(|e| at + e) else { break };
        let inner = &text[at + 1..end];
        i = end + 1;
        let closing = inner.starts_with('/');
        let name: String = inner
            .trim_start_matches('/')
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '!' || *c == ':' || *c == '.')
            .collect::<String>()
            .to_ascii_lowercase();
        if name.is_empty() || name.starts_with('!') && name != "!doctype" {
            continue;
        }
        if closing {
            match stack.iter().rposition(|(n, _)| *n == name) {
                Some(pos) => {
                    for (n, l) in stack.drain(pos..).skip(1) {
                        if !OPTIONAL.contains(&n.as_str()) {
                            out.push(Problem { line: l, col: 1, what: format!("<{n}> is never closed (</{name}> closes its parent first)") });
                        }
                    }
                }
                None => out.push(Problem { line: line_of(at), col: 1, what: format!("</{name}> has no matching <{name}>") }),
            }
            continue;
        }
        if inner.trim_end().ends_with('/') || VOID.contains(&name.as_str()) {
            continue;
        }
        // Raw-text elements: jump to their closing tag.
        if matches!(name.as_str(), "script" | "style" | "pre" | "textarea") {
            let close = format!("</{name}");
            match text[i..].to_ascii_lowercase().find(&close) {
                Some(e) => {
                    i += e;
                    stack.push((name, line_of(at)));
                }
                None => {
                    out.push(Problem { line: line_of(at), col: 1, what: format!("<{name}> is never closed") });
                    break;
                }
            }
            continue;
        }
        let _ = bytes;
        stack.push((name, line_of(at)));
    }
    for (n, l) in stack {
        if !OPTIONAL.contains(&n.as_str()) {
            out.push(Problem { line: l, col: 1, what: format!("<{n}> is never closed") });
        }
    }
    out
}

/// Problems in `after` that `before` did not have (matched by message, so a
/// pre-existing error that merely moved lines is not blamed on the edit).
/// None = language unsupported.
pub fn introduced(path: &Path, before: Option<&str>, after: &str) -> Option<Vec<Problem>> {
    let now = check(path, after)?;
    let old = before.and_then(|b| check(path, b)).unwrap_or_default();
    let mut budget: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for p in &old {
        *budget.entry(p.what.as_str()).or_default() += 1;
    }
    Some(
        now.into_iter()
            .filter(|p| match budget.get_mut(p.what.as_str()) {
                Some(n) if *n > 0 => {
                    *n -= 1;
                    false
                }
                _ => true,
            })
            .collect(),
    )
}

/// The model-facing report of introduced problems, with the offending lines.
pub fn report(path_label: &str, text: &str, problems: &[Problem]) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = format!(
        "SYNTAX ERRORS introduced by this edit in {path_label} ({} found) — fix them now, the file does not parse:",
        problems.len()
    );
    for p in problems.iter().take(MAX_REPORTED) {
        let src = lines.get(p.line.saturating_sub(1)).map(|l| l.trim()).unwrap_or("");
        let src: String = src.chars().take(120).collect();
        out.push_str(&format!("\n  line {}:{} — {}\n      {:>5}  {}", p.line, p.col, p.what, p.line, src));
    }
    if problems.len() > MAX_REPORTED {
        out.push_str(&format!("\n  … and {} more", problems.len() - MAX_REPORTED));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_unclosed_jsx_and_brackets() {
        let ok = "export function A() {\n  return <div><span>hi</span></div>;\n}\n";
        assert_eq!(check(Path::new("a.tsx"), ok).unwrap(), vec![]);
        let broken = "export function A() {\n  return <div><span>hi</div>;\n}\n";
        assert!(!check(Path::new("a.tsx"), broken).unwrap().is_empty());
        let py = "def f(:\n    return 1\n";
        assert!(!check(Path::new("x.py"), py).unwrap().is_empty());
        let rs = "fn main() { let x = (1 + 2; }\n";
        assert!(!check(Path::new("m.rs"), rs).unwrap().is_empty());
        assert!(check(Path::new("notes.txt"), "anything").is_none());
    }

    #[test]
    fn html_tags_must_balance() {
        let ok = "<!doctype html>\n<div class=\"a\">\n  <img src=x>\n  <p>one\n  <br/>\n</div>\n<script>if (a < b) {}</script>\n";
        assert_eq!(check(Path::new("i.html"), ok).unwrap(), vec![]);
        let broken = "<div>\n  <section>\n    text\n</div>\n";
        let p = check(Path::new("i.html"), broken).unwrap();
        assert!(p.iter().any(|p| p.what.contains("<section> is never closed") && p.line == 2), "{p:?}");
    }

    #[test]
    fn only_new_errors_are_blamed() {
        let path = Path::new("a.ts");
        let before = "const a = (1;\nconst b = 2;\n";
        let same = "const a = (1;\nconst b = 3;\n";
        assert_eq!(introduced(path, Some(before), same).unwrap(), vec![]);
        let worse = "const a = (1;\nconst b = {3;\n";
        assert!(!introduced(path, Some(before), worse).unwrap().is_empty());
    }
}

/* ---------- Outline (Roo Code's list_code_definition_names) ---------- */

/// Kinds that define something worth listing in an outline.
const OUTLINE_DEFS: &[&str] = &[
    "function_declaration", "function_definition", "function_item", "generator_function_declaration",
    "class_declaration", "abstract_class_declaration", "class_definition", "class_specifier",
    "struct_item", "enum_item", "trait_item", "union_item", "type_item", "macro_definition",
    "interface_declaration", "type_alias_declaration", "enum_declaration", "struct_specifier",
    "method_declaration", "type_spec", "record_declaration", "struct_declaration", "trait_declaration",
    "impl_item", "method_definition", "function_signature_item", "constructor_declaration", "mod_item",
];
/// Wrappers / bodies whose children are definitions too.
const OUTLINE_CONTAINERS: &[&str] = &[
    "export_statement", "decorated_definition", "type_declaration", "namespace_declaration",
    "file_scoped_namespace_declaration", "internal_module", "declaration_list", "namespace_definition",
    "template_declaration", "ambient_declaration", "class_body", "block", "field_declaration_list",
    "interface_body", "enum_body", "statement_block",
];
const OUTLINE_MAX: usize = 80;

/// The definitions of a file with their line ranges — `12-40  export function
/// Foo(props: Props) {` — so the model reads just the part it needs. Code
/// via tree-sitter; Markdown by its headings. Empty when nothing is known.
pub fn outline(path: &Path, text: &str) -> Vec<String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if matches!(ext.as_str(), "md" | "mdx" | "markdown") {
        return text
            .lines()
            .enumerate()
            .filter(|(_, l)| l.starts_with('#'))
            .take(OUTLINE_MAX)
            .map(|(i, l)| format!("{:>5}  {}", i + 1, clip(l)))
            .collect();
    }
    let Some(lang) = language(path) else { return Vec::new() };
    let mut parser = Parser::new();
    if parser.set_language(&lang).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(text, None) else { return Vec::new() };
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    walk_outline(tree.root_node(), &lines, 0, &mut out);
    if out.len() > OUTLINE_MAX {
        let more = out.len() - OUTLINE_MAX;
        out.truncate(OUTLINE_MAX);
        out.push(format!("       … {more} more"));
    }
    out
}

fn walk_outline(node: Node, lines: &[&str], depth: usize, out: &mut Vec<String>) {
    if depth > 4 {
        return;
    }
    let mut c = node.walk();
    for child in node.named_children(&mut c) {
        let kind = child.kind();
        let def = OUTLINE_DEFS.contains(&kind) || is_callable_const(child);
        if def {
            let (a, b) = (child.start_position().row, child.end_position().row);
            // One-liners (a `type X = …`) are not worth a line of their own.
            if b > a {
                let first = lines.get(a).copied().unwrap_or("");
                out.push(format!("{:>5}-{:<5} {}{}", a + 1, b + 1, "  ".repeat(depth.min(3)), clip(first.trim())));
            }
            // Members of a class / impl / trait.
            if let Some(body) = child.child_by_field_name("body") {
                walk_outline(body, lines, depth + 1, out);
            }
        } else if OUTLINE_CONTAINERS.contains(&kind) {
            walk_outline(child, lines, depth, out);
        }
    }
}

/// `const Foo = (…) => …` / `export const api = {…}` style definitions.
fn is_callable_const(n: Node) -> bool {
    if n.kind() != "lexical_declaration" && n.kind() != "variable_declaration" {
        return false;
    }
    let mut c = n.walk();
    let found = n.named_children(&mut c).any(|d| {
        d.kind() == "variable_declarator"
            && d.child_by_field_name("value").is_some_and(|v| {
                matches!(v.kind(), "arrow_function" | "function_expression" | "function" | "class" | "call_expression" | "object")
            })
    });
    found
}

fn clip(s: &str) -> String {
    match s.char_indices().nth(110) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}
