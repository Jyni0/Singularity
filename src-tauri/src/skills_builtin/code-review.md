---
name: code-review
description: "Review code changes (a diff, a branch, a PR or named files) for bugs, risks and maintainability, and report findings ranked by severity."
---
# Scope
Find what changed: `git diff` (staged + unstaged), `git diff <base>...HEAD` for a branch, or the files the user named. Read the surrounding code of every changed hunk — a diff alone hides most bugs.

# What to look for (in this order)
1. Correctness: wrong logic, off-by-one, null/undefined paths, unhandled errors, race conditions, wrong async/await, resource leaks, broken edge cases (empty, huge, unicode, concurrent).
2. Security: injection (SQL, shell, HTML), secrets in code, missing auth checks, unsafe deserialization, path traversal.
3. Behaviour changes callers do not expect: changed signatures, defaults, return shapes; missing migrations.
4. Tests: is the new behaviour covered? Are there tests that should now fail but don't?
5. Maintainability: duplication, unclear names, dead code, needless complexity. Only mention these when they matter.

# Rules
- Verify before reporting: trace the code path; if unsure, say "possible" and why.
- No style nitpicks that a formatter or linter would catch.
- Do not change code unless the user asked for fixes.

# Report
A list ranked most severe first. For each: file:line, what is wrong, a concrete failing scenario, and the suggested fix. End with a one-line verdict (ship / fix first).
