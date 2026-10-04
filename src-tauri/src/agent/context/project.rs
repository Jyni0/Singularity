//! What the model knows about the project before its first step — so it
//! does not spend the first turns listing folders and reading files just
//! to find its way:
//!
//! * Project instructions — AGENTS.md, .goosehints, CLAUDE.md… from the git
//!   root down to the workspace (Goose `hints/load_hints.rs`, Roo Code's
//!   custom instructions).
//! * Repo map — the project's source files ranked by how much of the rest
//!   of the project refers to them, each with its definitions parsed by
//!   tree-sitter (Aider's repomap, ~2k tokens), then the other files by
//!   path (Roo Code lists up to 200 workspace files).
//!
//! Built once per run: it is part of the static, cached system prompt.
//! Memoized per workspace until a file is added, removed or changed.

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

/// Files read as project instructions, in this order (Goose's defaults
/// plus the other agents' conventions).
const HINT_FILES: &[&str] = &["AGENTS.md", "AGENT.md", ".goosehints", "CLAUDE.md", "GEMINI.md", ".roorules", ".clinerules", ".cursorrules"];
/// Most instruction text carried, all files together.
const HINTS_CHARS: usize = 8_000;
/// Size of the repo map (≈ 2k tokens — Aider's map for a larger model).
const MAP_CHARS: usize = 8_000;
/// Part of the map for ranked source files; the rest lists other files.
const MAP_SYMBOL_CHARS: usize = 6_000;
/// Workspace entries considered (breadth-first: shallow ones first).
const MAX_FILES: usize = 3_000;
/// Source files larger than this are listed but not parsed.
const MAX_PARSE_BYTES: u64 = 400_000;
/// Definitions shown per file, members per class / impl.
const MAX_DEFS: usize = 10;
/// Not worth a line in the map: binaries, assets, lockfiles, build caches.
const NOISE_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "icns", "bmp", "svg", "woff", "woff2", "ttf", "otf", "eot",
    "mp3", "mp4", "wav", "zip", "gz", "tar", "exe", "dll", "so", "dylib", "pdb", "lock", "tsbuildinfo", "map",
];

/// Whether a workspace file is noise for the map (still counted as hidden).
fn noise(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    NOISE_EXT.contains(&ext.as_str()) || name.contains(".timestamp-") || name.ends_with("-lock.json")
}
const MAX_MEMBERS: usize = 6;

/// Project instructions + repo map, ready for the system prompt.
#[derive(Debug, Default, Clone, PartialEq)]
pub(in crate::agent) struct ProjectContext {
    pub instructions: String,
    pub map: String,
}

static CACHE: LazyLock<Mutex<HashMap<PathBuf, (u64, Arc<ProjectContext>)>>> = LazyLock::new(Default::default);

/// The project context of a workspace (memoized until the files change).
pub(in crate::agent) fn project_context(root: &Path) -> Arc<ProjectContext> {
    if too_broad(root) {
        return Arc::default();
    }
    let files: Vec<String> = crate::tools::workspace_files(root).into_iter().take(MAX_FILES).collect();
    let sig = signature(root, &files);
    if let Some((s, ctx)) = CACHE.lock().unwrap().get(root) {
        if *s == sig {
            return ctx.clone();
        }
    }
    let started = std::time::Instant::now();
    let ctx = Arc::new(ProjectContext { instructions: instructions(root), map: repo_map(root, &files) });
    tracing::info!(
        root = %root.display(),
        files = files.len(),
        map_chars = ctx.map.len(),
        instruction_chars = ctx.instructions.len(),
        ms = started.elapsed().as_millis() as u64,
        "project context built"
    );
    CACHE.lock().unwrap().insert(root.to_path_buf(), (sig, ctx.clone()));
    ctx
}

/// A home folder or a drive root is not a project: mapping it would read
/// half the disk (Roo Code skips the Desktop for the same reason).
fn too_broad(root: &Path) -> bool {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
    root.parent().is_none() || home.as_deref() == Some(root) || home.map(|h| h.join("Desktop")).as_deref() == Some(root)
}

/// Changes when a listed file is added, removed or modified.
fn signature(root: &Path, files: &[String]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for f in files {
        f.hash(&mut h);
        if let Ok(m) = std::fs::metadata(root.join(f)) {
            m.len().hash(&mut h);
            if let Ok(t) = m.modified() {
                t.hash(&mut h);
            }
        }
    }
    for name in HINT_FILES {
        if let Ok(t) = std::fs::metadata(root.join(name)).and_then(|m| m.modified()) {
            t.hash(&mut h);
        }
    }
    h.finish()
}

/* ---------- Project instructions ---------- */

/// The git root above `root` (inclusive), if any.
fn git_root(root: &Path) -> Option<&Path> {
    root.ancestors().find(|a| a.join(".git").exists())
}

/// Instruction files from the git root down to the workspace, Goose-style:
/// the outer (repository-wide) rules first, the workspace's own last.
fn instructions(root: &Path) -> String {
    let dirs: Vec<&Path> = match git_root(root) {
        Some(top) => {
            let mut d: Vec<&Path> = root.ancestors().take_while(|a| a.starts_with(top)).collect();
            d.reverse();
            d
        }
        None => vec![root],
    };
    let mut out = String::new();
    let mut seen: HashSet<String> = HashSet::new();
    for dir in dirs {
        for name in HINT_FILES {
            let path = dir.join(name);
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let text = text.trim();
            // The same rules under two names (AGENTS.md + CLAUDE.md copies).
            if text.is_empty() || !seen.insert(text.to_string()) {
                continue;
            }
            let rel = path.strip_prefix(root).map(|p| p.display().to_string()).unwrap_or_else(|_| path.display().to_string());
            let room = HINTS_CHARS.saturating_sub(out.len());
            if room < 200 {
                return out;
            }
            let body: String = if text.len() > room { format!("{}… [truncated]", clip_chars(text, room)) } else { text.to_string() };
            out.push_str(&format!("## {rel}\n{body}\n\n"));
        }
    }
    out.trim_end().to_string()
}

fn clip_chars(s: &str, max: usize) -> &str {
    let mut end = max.min(s.len());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/* ---------- Repo map ---------- */

struct Mapped {
    path: String,
    defs: Vec<String>,
    score: usize,
}

/// Ranked source files with their definitions, then the other files.
fn repo_map(root: &Path, files: &[String]) -> String {
    let mut sources: Vec<(String, String)> = Vec::new(); // (path, text)
    let mut others: Vec<&String> = Vec::new();
    let mut noisy = 0usize;
    for f in files.iter().filter(|f| !f.ends_with('/')) {
        if noise(f) {
            noisy += 1;
            continue;
        }
        let path = root.join(f);
        let parsable = crate::syntax::language(&path).is_some() && !f.ends_with(".json") && !f.ends_with(".css") && !f.ends_with(".html");
        let small = std::fs::metadata(&path).map(|m| m.len() <= MAX_PARSE_BYTES).unwrap_or(false);
        match (parsable && small).then(|| std::fs::read_to_string(&path).ok()).flatten() {
            Some(text) => sources.push((f.clone(), text)),
            None => others.push(f),
        }
    }

    // Aider ranks with PageRank over identifier references; the light
    // version: how many files mention the file's name or its definitions.
    let mut df: HashMap<&str, usize> = HashMap::new();
    for (_, text) in &sources {
        let words: HashSet<&str> = text.split(|c: char| !c.is_alphanumeric() && c != '_').filter(|w| w.len() >= 3).collect();
        for w in words {
            *df.entry(w).or_default() += 1;
        }
    }
    let mut mapped: Vec<Mapped> = sources
        .iter()
        .map(|(path, text)| {
            let defs = definitions(Path::new(path), text);
            let stem = Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let stem = stem.split('.').next().unwrap_or(stem);
            let refs = |w: &str| df.get(w).copied().unwrap_or(0).saturating_sub(1);
            let mut score = refs(stem) * 3;
            for d in &defs {
                let name = d.split(['{', '(']).next().unwrap_or(d);
                score += refs(name).min(5);
            }
            if matches!(stem.to_lowercase().as_str(), "main" | "index" | "app" | "lib" | "mod" | "server") {
                score += 5;
            }
            Mapped { path: path.clone(), defs, score }
        })
        .collect();
    mapped.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));

    let mut out = String::new();
    let mut shown = 0usize;
    for m in &mapped {
        let line = if m.defs.is_empty() { m.path.clone() } else { format!("{}: {}", m.path, m.defs.join(", ")) };
        if out.len() + line.len() + 1 > MAP_SYMBOL_CHARS {
            break;
        }
        out.push_str(&line);
        out.push('\n');
        shown += 1;
    }
    // The rest — unmapped sources, configs, styles, docs — by path.
    let mut rest: Vec<&str> = mapped[shown..].iter().map(|m| m.path.as_str()).chain(others.iter().map(|s| s.as_str())).collect();
    rest.sort_by_key(|p| (p.matches('/').count(), *p));
    let mut listed = 0usize;
    if !rest.is_empty() && out.len() < MAP_CHARS {
        out.push_str("Other files: ");
        for (i, p) in rest.iter().enumerate() {
            if out.len() + p.len() + 2 > MAP_CHARS {
                break;
            }
            if i > 0 {
                out.push_str(", ");
            }
            out.push_str(p);
            listed += 1;
        }
        out.push('\n');
    }
    let hidden = rest.len() - listed + noisy;
    if hidden > 0 {
        out.push_str(&format!("… {hidden} more files not shown — use find_files / grep to locate them.\n"));
    }
    out.trim_end().to_string()
}

/// Node kinds that define something worth naming, across the bundled
/// grammars (Rust, TS/JS, Python, Go, Java, C/C++, C#, PHP).
const DEF_KINDS: &[&str] = &[
    "function_declaration", "function_definition", "function_item", "generator_function_declaration",
    "class_declaration", "abstract_class_declaration", "class_definition", "class_specifier",
    "struct_item", "enum_item", "trait_item", "union_item", "type_item", "mod_item", "macro_definition",
    "interface_declaration", "type_alias_declaration", "enum_declaration", "struct_specifier",
    "method_declaration", "type_spec", "record_declaration", "struct_declaration", "trait_declaration",
    "impl_item",
];
/// Wrappers whose children are the definitions.
const CONTAINER_KINDS: &[&str] = &[
    "export_statement", "decorated_definition", "type_declaration", "namespace_declaration",
    "file_scoped_namespace_declaration", "internal_module", "declaration_list", "namespace_definition",
    "template_declaration", "ambient_declaration",
];
/// Members listed inside a class / impl / trait.
const MEMBER_KINDS: &[&str] = &[
    "method_definition", "function_definition", "function_item", "method_declaration",
    "function_signature_item", "constructor_declaration",
];

/// Top-level definitions of a source file: `name`, or `Type{member, …}`.
/// Like Aider's map it favours what the rest of the project can use: when
/// a file has public definitions (`pub`, `export`, no leading `_`), only
/// those are listed; private helpers would crowd them out.
fn definitions(path: &Path, text: &str) -> Vec<String> {
    let Some(lang) = crate::syntax::language(path) else { return Vec::new() };
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&lang).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(text, None) else { return Vec::new() };
    let mut defs: Vec<(String, bool)> = Vec::new();
    collect_defs(tree.root_node(), text, 0, false, &mut defs);
    let any_public = defs.iter().any(|(_, public)| *public);
    let mut seen = HashSet::new();
    let mut out: Vec<String> = defs
        .into_iter()
        .filter(|(_, public)| *public || !any_public)
        .map(|(d, _)| d)
        .filter(|d| seen.insert(d.clone()))
        .collect();
    if out.len() > MAX_DEFS {
        let more = out.len() - MAX_DEFS;
        out.truncate(MAX_DEFS);
        out.push(format!("+{more}"));
    }
    out
}

/// Whether a definition is visible outside its file.
fn is_public(node: tree_sitter::Node, name: &str, exported: bool) -> bool {
    if exported {
        return true;
    }
    let mut c = node.walk();
    if node.named_children(&mut c).any(|ch| ch.kind() == "visibility_modifier") {
        return true; // Rust `pub` / `pub(crate)`
    }
    match node.kind() {
        // Python: no leading underscore. Go: capitalized.
        "function_definition" | "class_definition" => !name.starts_with('_') && !node.parent().is_some_and(|p| p.kind() == "translation_unit"),
        "method_declaration" | "type_spec" | "function_declaration" if name.chars().next().is_some_and(char::is_uppercase) => true,
        _ => false,
    }
}

fn collect_defs(node: tree_sitter::Node, text: &str, depth: usize, exported: bool, out: &mut Vec<(String, bool)>) {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        let kind = child.kind();
        if CONTAINER_KINDS.contains(&kind) && depth < 3 {
            collect_defs(child, text, depth + 1, exported || kind == "export_statement", out);
        } else if kind == "lexical_declaration" || kind == "variable_declaration" {
            // `const Button = (…) => …` / `export const api = {…}`.
            let mut c = child.walk();
            for decl in child.named_children(&mut c).filter(|d| d.kind() == "variable_declarator") {
                let Some(name) = decl.child_by_field_name("name").map(|n| node_text(n, text)) else { continue };
                let value = decl.child_by_field_name("value").map(|v| v.kind()).unwrap_or("");
                let callable = matches!(value, "arrow_function" | "function_expression" | "function" | "class" | "call_expression");
                if callable || name.chars().next().is_some_and(char::is_uppercase) {
                    out.push((name.to_string(), exported));
                }
            }
        } else if kind == "mod_item" {
            // `mod x;` only declares a file the map lists anyway; `mod tests`
            // is not something to call.
        } else if DEF_KINDS.contains(&kind) {
            let Some(name) = def_name(child, text) else { continue };
            let (members, public_members) = members(child, text);
            let public = if kind == "impl_item" {
                child.child_by_field_name("trait").is_some() || public_members
            } else {
                is_public(child, &name, exported)
            };
            out.push((if members.is_empty() { name } else { format!("{name}{{{}}}", members.join(", ")) }, public));
        }
    }
}

/// The name of a definition: its `name` field, the `type` of a Rust impl,
/// or the identifier inside a C-style declarator.
fn def_name(node: tree_sitter::Node, text: &str) -> Option<String> {
    if let Some(n) = node.child_by_field_name("name") {
        return Some(node_text(n, text).to_string());
    }
    if node.kind() == "impl_item" {
        let ty = node.child_by_field_name("type").map(|t| node_text(t, text))?;
        return Some(match node.child_by_field_name("trait") {
            Some(tr) => format!("{ty}: {}", node_text(tr, text)),
            None => ty.to_string(),
        });
    }
    let mut d = node.child_by_field_name("declarator");
    for _ in 0..4 {
        let n = d?;
        if n.kind().ends_with("identifier") {
            return Some(node_text(n, text).to_string());
        }
        d = n.child_by_field_name("declarator").or_else(|| n.child_by_field_name("name"));
    }
    None
}

/// Method names of a class / impl / trait body — the public ones when
/// there are any — and whether there were public ones.
fn members(node: tree_sitter::Node, text: &str) -> (Vec<String>, bool) {
    let Some(body) = node.child_by_field_name("body") else { return (Vec::new(), false) };
    let mut all: Vec<(String, bool)> = Vec::new();
    let mut c = body.walk();
    for m in body.named_children(&mut c) {
        let m = if m.kind() == "decorated_definition" { m.child_by_field_name("definition").unwrap_or(m) } else { m };
        if MEMBER_KINDS.contains(&m.kind()) {
            if let Some(n) = def_name(m, text) {
                if n != "constructor" && n != "__init__" {
                    let mut mc = m.walk();
                    let public = m.named_children(&mut mc).any(|ch| ch.kind() == "visibility_modifier");
                    all.push((n, public));
                }
            }
        }
    }
    let any_public = all.iter().any(|(_, p)| *p);
    let mut out: Vec<String> = all.into_iter().filter(|(_, p)| *p || !any_public).map(|(n, _)| n).collect();
    if out.len() > MAX_MEMBERS {
        let more = out.len() - MAX_MEMBERS;
        out.truncate(MAX_MEMBERS);
        out.push(format!("+{more}"));
    }
    (out, any_public)
}

fn node_text<'a>(n: tree_sitter::Node, text: &'a str) -> &'a str {
    text.get(n.byte_range()).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definitions_of_common_languages() {
        let ts = "import x from './y';\nexport function Button(p: Props) { return 1 }\nexport const Input = () => null;\nconst helper = 3;\nfunction local() {}\nconst PANEL_W = 3;\nexport interface Props { a: string }\nexport class Store { load() {} save() {} }\n";
        let d = definitions(Path::new("a.tsx"), ts);
        assert_eq!(d, ["Button", "Input", "Props", "Store{load, save}"], "{d:?}");
        let rs = "mod sub;\npub struct Ctx { a: u8 }\nimpl Ctx { pub fn new() -> Self { todo!() } fn step(&self) {} }\nimpl Drop for Ctx { fn drop(&mut self) {} }\npub fn run() {}\nfn helper() {}\nmod tests {}\n";
        assert_eq!(definitions(Path::new("a.rs"), rs), ["Ctx", "Ctx{new}", "Ctx: Drop{drop}", "run"]);
        // A file without public items lists what it has.
        assert_eq!(definitions(Path::new("main.rs"), "fn main() {}\n"), ["main"]);
        let py = "class A:\n    def __init__(self): pass\n    def go(self): pass\n\ndef main():\n    pass\n\ndef _private():\n    pass\n";
        assert_eq!(definitions(Path::new("a.py"), py), ["A{go}", "main"]);
    }

    #[test]
    fn map_ranks_referenced_files_first_and_lists_the_rest() {
        let dir = std::env::temp_dir().join(format!("sing-map-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/components")).unwrap();
        std::fs::write(dir.join("src/components/Button.tsx"), "export function Button() { return null }").unwrap();
        std::fs::write(dir.join("src/a.tsx"), "import { Button } from './components/Button';\nexport function A() { return Button }").unwrap();
        std::fs::write(dir.join("src/b.tsx"), "import { Button } from './components/Button';\nexport function B() { return Button }").unwrap();
        std::fs::write(dir.join("styles.css"), "body {}").unwrap();
        std::fs::write(dir.join("logo.png"), "png").unwrap();
        std::fs::write(dir.join("AGENTS.md"), "Use pnpm.").unwrap();
        let ctx = project_context(&dir);
        let first = ctx.map.lines().next().unwrap();
        assert_eq!(first, "src/components/Button.tsx: Button", "{}", ctx.map);
        assert!(ctx.map.contains("Other files: ") && ctx.map.contains("styles.css"), "{}", ctx.map);
        assert!(!ctx.map.contains("logo.png"), "{}", ctx.map);
        assert!(ctx.instructions.contains("## AGENTS.md\nUse pnpm."), "{}", ctx.instructions);
        // Memoized until something changes.
        assert!(Arc::ptr_eq(&ctx, &project_context(&dir)));
        std::fs::write(dir.join("src/c.ts"), "export const C = 1").unwrap();
        assert!(project_context(&dir).map.contains("src/c.ts"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `SING_MAP_ROOT=<folder> cargo test --lib print_project_map -- --ignored --nocapture`
    #[test]
    #[ignore = "prints the map of a real project"]
    fn print_project_map() {
        let root = PathBuf::from(std::env::var("SING_MAP_ROOT").expect("set SING_MAP_ROOT"));
        let started = std::time::Instant::now();
        let ctx = project_context(&root);
        println!("--- instructions ---\n{}\n--- map ({} chars, {} ms) ---\n{}", ctx.instructions, ctx.map.len(), started.elapsed().as_millis(), ctx.map);
    }

    #[test]
    fn broad_roots_are_not_mapped() {
        assert!(too_broad(Path::new(if cfg!(windows) { "C:\\" } else { "/" })));
    }
}
