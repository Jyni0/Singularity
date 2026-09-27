---
name: write-tests
description: "Write or extend automated tests (unit, integration, e2e) that follow the project's existing test setup and actually catch regressions."
---
# Steps
1. Find the existing setup: framework (jest, vitest, pytest, cargo test, go test, xunit…), where tests live, naming, fixtures, how they are run (package.json scripts, Makefile, CI config). Follow it exactly.
2. List behaviours to cover: the happy path, edge cases (empty, zero, max, unicode, duplicates), error paths, and the specific bug if this is a regression test.
3. Write tests that assert behaviour, not implementation details. One reason to fail per test; descriptive names ("returns 404 when the user does not exist").
4. Keep them deterministic: no real network, clock or randomness — mock/fake at the boundary, fixed seeds and dates.
5. Run the tests. A new test for a bug must fail before the fix and pass after it. Run the whole related suite, not just the new file.

# Don'ts
- No snapshot tests of huge output unless the project already uses them.
- Do not weaken or delete existing assertions to make things pass.
- Do not add a new test framework.
