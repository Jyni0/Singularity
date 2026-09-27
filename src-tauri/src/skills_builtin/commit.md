---
name: commit
description: "Stage changes and write a clear git commit message (or a PR description) that follows the repository's conventions."
---
# Steps
1. Look: `git status`, `git diff` and `git diff --staged`, and `git log --oneline -15` to learn the message style (Conventional Commits? prefixes? language? issue refs?).
2. Check for things that must not be committed: secrets, .env files, large binaries, build output, debug code. Mention them instead of committing.
3. If the changes are unrelated to each other, propose separate commits.
4. Message: a subject line under ~72 chars in the repo's style, imperative mood ("Add…", "Fix…"); a blank line; a body that says WHY and anything non-obvious — not a list of every file.
5. Commit only when the user asked to commit. Never push, amend, rebase or force unless asked.

# PR description
Title like a good subject line. Body: what and why, how it was tested, risks / follow-ups, screenshots for UI changes.
