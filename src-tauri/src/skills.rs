//! Skills — reusable instruction packs the agent loads on demand.
//!
//! The format is the Agent Skills one: a folder with a `SKILL.md` whose YAML
//! front matter carries `name` and `description`, and whose body holds the
//! instructions. Extra files in the folder (scripts, references, templates)
//! are read by the agent through the `skill` tool when the body points at
//! them.
//!
//! Where skills live:
//!   * user skills:    <app data>/skills/<name>/SKILL.md   (editable in Settings)
//!   * project skills: <workspace>/.singularity/skills/*/SKILL.md and
//!                     <workspace>/.claude/skills/*/SKILL.md (read-only here)
//!
//! Only name + description go into the system prompt; the body is loaded when
//! the model calls `skill` (or when the user invokes `/name`), so a long
//! library costs a line per skill, not its full text.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Largest SKILL.md / supporting file handed to the model.
const MAX_SKILL_BYTES: u64 = 200_000;
/// Largest folder copied by an import.
const MAX_IMPORT_BYTES: u64 = 20_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// Folder that holds SKILL.md.
    pub dir: String,
    /// "user" (app data, editable) or "project" (inside the workspace).
    pub source: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SkillDraft {
    /// Name before an edit; empty for a new skill.
    #[serde(default)]
    pub original: String,
    pub name: String,
    pub description: String,
    pub body: String,
}

/* ---------- Paths + state ---------- */

fn user_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no data directory: {e}"))?
        .join("skills");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create skills folder: {e}"))?;
    Ok(dir)
}

fn project_roots(workspace: &str) -> Vec<PathBuf> {
    if workspace.trim().is_empty() {
        return Vec::new();
    }
    let ws = Path::new(workspace);
    vec![ws.join(".singularity").join("skills"), ws.join(".claude").join("skills")]
}

#[derive(Default, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    disabled: Vec<String>,
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(user_root(app)?.join(".state.json"))
}

fn load_state(app: &AppHandle) -> State {
    state_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_state(app: &AppHandle, st: &State) -> Result<(), String> {
    let text = serde_json::to_string_pretty(st).map_err(|e| e.to_string())?;
    std::fs::write(state_path(app)?, text).map_err(|e| format!("cannot save skill state: {e}"))
}

/* ---------- SKILL.md parsing ---------- */

/// Front matter fields + body of a SKILL.md. Handles `key: value`, quoted
/// values and `>` / `|` block scalars — what skill files use in practice.
pub fn parse_skill_md(text: &str) -> (Option<String>, Option<String>, String) {
    let text = text.trim_start_matches('\u{feff}');
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None, text.to_string());
    }
    let mut name = None;
    let mut description = None;
    let mut consumed = 1usize;
    let mut block: Option<(String, Vec<String>, bool)> = None; // key, lines, folded
    let flush = |block: &mut Option<(String, Vec<String>, bool)>, name: &mut Option<String>, desc: &mut Option<String>| {
        if let Some((key, parts, folded)) = block.take() {
            let v = if folded { parts.join(" ") } else { parts.join("\n") };
            let v = v.trim().to_string();
            match key.as_str() {
                "name" => *name = Some(v),
                "description" => *desc = Some(v),
                _ => {}
            }
        }
    };
    let mut closed = false;
    for line in lines {
        consumed += 1;
        if line.trim() == "---" {
            closed = true;
            break;
        }
        if let Some((_, parts, _)) = block.as_mut() {
            if line.starts_with(' ') || line.starts_with('\t') || line.trim().is_empty() {
                parts.push(line.trim().to_string());
                continue;
            }
            flush(&mut block, &mut name, &mut description);
        }
        let Some((k, v)) = line.split_once(':') else { continue };
        let key = k.trim().to_string();
        let v = v.trim();
        if v == ">" || v == ">-" || v == "|" || v == "|-" {
            block = Some((key, Vec::new(), v.starts_with('>')));
            continue;
        }
        let v = unquote(v);
        match key.as_str() {
            "name" => name = Some(v),
            "description" => description = Some(v),
            _ => {}
        }
    }
    flush(&mut block, &mut name, &mut description);
    if !closed {
        return (None, None, text.to_string());
    }
    let body: String = text.lines().skip(consumed).collect::<Vec<_>>().join("\n");
    (name, description, body.trim().to_string())
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    if v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\''))) {
        let inner = &v[1..v.len() - 1];
        if v.starts_with('"') {
            return inner.replace("\\\"", "\"").replace("\\n", "\n");
        }
        return inner.replace("''", "'");
    }
    v.to_string()
}

/// Quotes a front matter value when YAML would misread it.
fn yaml_value(v: &str) -> String {
    let flat = v.replace(['\r', '\n'], " ");
    let needs = flat.contains(": ")
        || flat.contains(" #")
        || flat.starts_with(['"', '\'', '[', '{', '>', '|', '*', '&', '!', '%', '@', '`', '-', '?'])
        || flat.trim() != flat;
    if needs {
        format!("\"{}\"", flat.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        flat
    }
}

pub fn validate_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
    if ok {
        Ok(())
    } else {
        Err("Skill name: 1–64 characters, letters, digits, - and _ (e.g. code-review).".into())
    }
}

/// Reads one skill folder; None when it has no usable SKILL.md.
fn read_skill(dir: &Path, source: &str) -> Option<Skill> {
    let md = dir.join("SKILL.md");
    let meta = std::fs::metadata(&md).ok()?;
    if meta.len() > MAX_SKILL_BYTES {
        return None;
    }
    let text = std::fs::read_to_string(&md).ok()?;
    let (name, description, _) = parse_skill_md(&text);
    let folder = dir.file_name()?.to_string_lossy().to_string();
    let name = name.filter(|n| validate_name(n).is_ok()).unwrap_or(folder);
    Some(Skill {
        name,
        description: description.unwrap_or_default(),
        dir: dir.to_string_lossy().to_string(),
        source: source.to_string(),
        enabled: true,
    })
}

fn scan(root: &Path, source: &str) -> Vec<Skill> {
    let Ok(rd) = std::fs::read_dir(root) else { return Vec::new() };
    let mut out: Vec<Skill> = rd
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| read_skill(&e.path(), source))
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Every skill visible for this workspace. A project skill shadows a user
/// skill of the same name.
pub fn list(app: &AppHandle, workspace: &str) -> Result<Vec<Skill>, String> {
    let st = load_state(app);
    let mut out = scan(&user_root(app)?, "user");
    for root in project_roots(workspace) {
        for s in scan(&root, "project") {
            out.retain(|x| x.name != s.name);
            out.push(s);
        }
    }
    for s in &mut out {
        s.enabled = !st.disabled.contains(&s.name);
    }
    Ok(out)
}

/// Enabled skills for an agent run.
pub fn for_run(app: &AppHandle, workspace: &str) -> Vec<Skill> {
    list(app, workspace)
        .unwrap_or_default()
        .into_iter()
        .filter(|s| s.enabled)
        .collect()
}

/// The instructions of a skill (SKILL.md without its front matter).
pub fn body(skill: &Skill) -> Result<String, String> {
    let text = std::fs::read_to_string(Path::new(&skill.dir).join("SKILL.md"))
        .map_err(|e| format!("cannot read skill {}: {e}", skill.name))?;
    Ok(parse_skill_md(&text).2)
}

/// Supporting files of a skill, relative to its folder (SKILL.md excluded).
pub fn files(skill: &Skill) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            if out.len() >= 100 {
                return;
            }
            let p = e.path();
            if p.is_dir() {
                walk(root, &p, out);
            } else if let Ok(rel) = p.strip_prefix(root) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                if rel != "SKILL.md" {
                    out.push(rel);
                }
            }
        }
    }
    let root = Path::new(&skill.dir);
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

/// A supporting file inside the skill folder (never outside it).
pub fn read_file(skill: &Skill, rel: &str) -> Result<String, String> {
    let root = std::fs::canonicalize(&skill.dir).map_err(|e| e.to_string())?;
    let path = std::fs::canonicalize(root.join(rel.trim_start_matches(['/', '\\'])))
        .map_err(|_| format!("no file {rel:?} in skill {}", skill.name))?;
    if !path.starts_with(&root) {
        return Err("the path leaves the skill folder".into());
    }
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_SKILL_BYTES {
        return Err(format!("{rel} is too large ({} bytes)", meta.len()));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| format!("{rel} is not a text file"))
}

/// What the `skill` tool returns.
pub fn load_for_model(skill: &Skill, file: Option<&str>) -> Result<String, String> {
    if let Some(f) = file.filter(|f| !f.trim().is_empty()) {
        return read_file(skill, f.trim());
    }
    let mut out = format!("# Skill: {}\n\n{}", skill.name, body(skill)?);
    let extra = files(skill);
    if !extra.is_empty() {
        out.push_str(&format!(
            "\n\n---\nFiles in this skill (read them with the skill tool's `file` argument): {}",
            extra.join(", ")
        ));
    }
    Ok(out)
}

/* ---------- Editing ---------- */

fn compose(name: &str, description: &str, body: &str) -> String {
    format!(
        "---\nname: {}\ndescription: {}\n---\n\n{}\n",
        yaml_value(name),
        yaml_value(description.trim()),
        body.trim()
    )
}

pub fn save(app: &AppHandle, d: &SkillDraft) -> Result<Skill, String> {
    let name = d.name.trim();
    validate_name(name)?;
    if d.description.trim().is_empty() {
        return Err("Describe when the agent should use this skill.".into());
    }
    if d.body.trim().is_empty() {
        return Err("Write the skill's instructions.".into());
    }
    let root = user_root(app)?;
    let dir = root.join(name);
    let original = d.original.trim();
    if original != name && dir.exists() {
        return Err(format!("A skill named {name} already exists."));
    }
    if !original.is_empty() && original != name {
        validate_name(original)?;
        let old = root.join(original);
        if old.is_dir() {
            std::fs::rename(&old, &dir).map_err(|e| format!("cannot rename skill: {e}"))?;
        }
        let mut st = load_state(app);
        if let Some(n) = st.disabled.iter_mut().find(|n| *n == original) {
            *n = name.to_string();
            save_state(app, &st)?;
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create skill folder: {e}"))?;
    std::fs::write(dir.join("SKILL.md"), compose(name, &d.description, &d.body))
        .map_err(|e| format!("cannot write SKILL.md: {e}"))?;
    let mut s = read_skill(&dir, "user").ok_or("the skill could not be read back")?;
    s.enabled = !load_state(app).disabled.contains(&s.name);
    Ok(s)
}

pub fn delete(app: &AppHandle, name: &str) -> Result<(), String> {
    validate_name(name)?;
    let dir = user_root(app)?.join(name);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("cannot delete skill: {e}"))?;
    }
    let mut st = load_state(app);
    st.disabled.retain(|n| n != name);
    save_state(app, &st)
}

pub fn set_enabled(app: &AppHandle, name: &str, enabled: bool) -> Result<(), String> {
    let mut st = load_state(app);
    st.disabled.retain(|n| n != name);
    if !enabled {
        st.disabled.push(name.to_string());
    }
    save_state(app, &st)
}

fn dir_size(p: &Path) -> u64 {
    if p.is_file() {
        return std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    }
    std::fs::read_dir(p)
        .map(|rd| rd.flatten().map(|e| dir_size(&e.path())).sum())
        .unwrap_or(0)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)?.flatten() {
        let name = e.file_name();
        if name == ".git" || name == "node_modules" {
            continue;
        }
        let src = e.path();
        let dst = to.join(&name);
        if src.is_dir() {
            copy_dir(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Imports a skill folder (with SKILL.md) or a single .md file into the user
/// skills. Returns the imported skill.
pub fn import(app: &AppHandle, path: &str) -> Result<Skill, String> {
    let src = PathBuf::from(path.trim());
    let (folder, md) = if src.is_dir() {
        (Some(src.clone()), src.join("SKILL.md"))
    } else {
        (None, src.clone())
    };
    let text = std::fs::read_to_string(&md)
        .map_err(|_| format!("{} has no SKILL.md", src.display()))?;
    let (name, description, body) = parse_skill_md(&text);
    let fallback = folder
        .as_ref()
        .and_then(|f| f.file_name())
        .or_else(|| md.file_stem())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = name.unwrap_or(fallback);
    let name: String = name
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let name = name.trim_matches('-').to_string();
    validate_name(&name)?;
    let dest = user_root(app)?.join(&name);
    if dest.exists() {
        return Err(format!("A skill named {name} already exists — delete or rename it first."));
    }
    match folder {
        Some(f) => {
            if dir_size(&f) > MAX_IMPORT_BYTES {
                return Err("That folder is too large for a skill (over 20 MB).".into());
            }
            copy_dir(&f, &dest).map_err(|e| format!("cannot copy skill: {e}"))?;
        }
        None => {
            std::fs::create_dir_all(&dest).map_err(|e| format!("cannot create skill folder: {e}"))?;
            let desc = description.unwrap_or_default();
            std::fs::write(dest.join("SKILL.md"), compose(&name, &desc, &body))
                .map_err(|e| format!("cannot write SKILL.md: {e}"))?;
        }
    }
    read_skill(&dest, "user").ok_or_else(|| "the imported skill could not be read".into())
}

/* ---------- Commands ---------- */

#[derive(Debug, Clone, Serialize)]
pub struct SkillFull {
    #[serde(flatten)]
    pub skill: Skill,
    pub body: String,
    pub files: Vec<String>,
}

#[tauri::command]
pub fn skills_list(app: AppHandle, workspace: Option<String>) -> Result<Vec<Skill>, String> {
    list(&app, workspace.as_deref().unwrap_or(""))
}

#[tauri::command]
pub fn skills_get(app: AppHandle, name: String, workspace: Option<String>) -> Result<SkillFull, String> {
    let skill = list(&app, workspace.as_deref().unwrap_or(""))?
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("no skill named {name}"))?;
    Ok(SkillFull { body: body(&skill)?, files: files(&skill), skill })
}

#[tauri::command]
pub fn skills_save(app: AppHandle, draft: SkillDraft) -> Result<Skill, String> {
    save(&app, &draft)
}

#[tauri::command]
pub fn skills_delete(app: AppHandle, name: String) -> Result<(), String> {
    delete(&app, &name)
}

#[tauri::command]
pub fn skills_set_enabled(app: AppHandle, name: String, enabled: bool) -> Result<(), String> {
    set_enabled(&app, &name, enabled)
}

#[tauri::command]
pub fn skills_import(app: AppHandle, path: String) -> Result<Skill, String> {
    import(&app, &path)
}

#[tauri::command]
pub fn skills_folder(app: AppHandle) -> Result<String, String> {
    Ok(user_root(&app)?.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_front_matter_and_body() {
        let (n, d, b) = parse_skill_md("---\nname: code-review\ndescription: \"Review: diffs\"\n---\n\n# Steps\n1. read");
        assert_eq!(n.as_deref(), Some("code-review"));
        assert_eq!(d.as_deref(), Some("Review: diffs"));
        assert_eq!(b, "# Steps\n1. read");
    }

    #[test]
    fn parses_folded_description() {
        let (_, d, b) = parse_skill_md("---\nname: x\ndescription: >\n  line one\n  line two\nlicense: MIT\n---\nbody");
        assert_eq!(d.as_deref(), Some("line one line two"));
        assert_eq!(b, "body");
    }

    #[test]
    fn no_front_matter_is_all_body() {
        let (n, d, b) = parse_skill_md("just text");
        assert!(n.is_none() && d.is_none());
        assert_eq!(b, "just text");
    }

    #[test]
    fn compose_round_trips() {
        let text = compose("my-skill", "Use when: x # y", "Do it.");
        let (n, d, b) = parse_skill_md(&text);
        assert_eq!(n.as_deref(), Some("my-skill"));
        assert_eq!(d.as_deref(), Some("Use when: x # y"));
        assert_eq!(b, "Do it.");
    }

    #[test]
    fn names_are_validated() {
        assert!(validate_name("code-review_2").is_ok());
        assert!(validate_name("../etc").is_err());
        assert!(validate_name("-x").is_err());
        assert!(validate_name("").is_err());
    }
}
