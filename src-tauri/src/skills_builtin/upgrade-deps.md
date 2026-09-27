---
name: upgrade-deps
description: "Upgrade project dependencies or a framework version safely — read changelogs, apply breaking-change migrations, and verify the build and tests."
---
# Steps
1. Inventory: current versions (manifest + lockfile), what is outdated (`npm outdated`, `pip list --outdated`, `cargo outdated`, `dotnet list package --outdated`). If the Package versions plugin is installed, use it to get the real latest versions.
2. Plan: patch/minor upgrades together; major upgrades one at a time. Read the release notes / migration guide of every major bump (web_fetch or docs plugins).
3. Upgrade with the project's package manager so the lockfile updates. Never hand-edit lockfiles.
4. Apply migrations: renamed APIs, config changes, removed options. Prefer official codemods when they exist.
5. Verify after each step: install, build, typecheck, tests, and start the app briefly.
6. Report: what changed (old → new), migrations applied, anything left for the user to check.
