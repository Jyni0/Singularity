---
name: debug
description: "Systematically find the root cause of a bug, crash, failing test or wrong behaviour before changing code."
---
# Rules
- Do not guess-and-patch. A fix without a confirmed cause is a new bug.
- Change one thing at a time.

# Steps
1. Reproduce: get the exact error, stack trace, command and input. Run it yourself. If it does not reproduce, find out what differs (env, data, versions, OS).
2. Read the error fully: the first frame in project code, the exact message. Search the codebase for the message text.
3. Narrow down: find the last point where the state is correct and the first where it is wrong. Use logs/prints, a minimal test case, or `git bisect` / `git log -p` on the suspicious file for regressions.
4. Form one hypothesis that explains ALL symptoms. Confirm it with a check (a log line, a test) before fixing.
5. Fix the cause, not the symptom (no blanket try/catch, no `?.` sprinkled to hide nulls).
6. Verify: the original reproduction now passes; run the related tests; think about the same bug elsewhere (same pattern in other files).
7. Remove temporary debug output.

# Report
Cause (one or two sentences), the fix, and how it was verified.
