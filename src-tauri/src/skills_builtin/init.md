---
name: init
description: "Analyse a codebase and write an AGENTS.md guide (build/test commands, architecture, conventions) so future agent runs start with the right context."
---
# Steps
1. Explore: README, package manifests (package.json, Cargo.toml, pyproject.toml, *.csproj, go.mod), CI config, scripts, top-level folders, a few representative source files, existing lint/format config, and any existing AGENTS.md / CLAUDE.md / .cursorrules / copilot-instructions.
2. Write AGENTS.md at the project root (update it if it exists — keep what is still true). Sections:
   - Overview: what the project is, in 2–3 sentences.
   - Commands: install, dev, build, test (incl. running a single test), lint, format — exact commands that work.
   - Architecture: main folders and what lives where; how the parts talk; key entry points.
   - Conventions: naming, code style, patterns to follow, patterns to avoid, error handling, where tests go.
   - Gotchas: non-obvious things that break (env vars, generated files, platform quirks).
3. Keep it short and specific (under ~150 lines). No generic advice ("write clean code"). Only facts you verified in the repo.
