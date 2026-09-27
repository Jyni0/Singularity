---
name: simplify
description: "Refactor code for clarity and simplicity without changing behaviour — remove duplication, dead code and needless complexity."
---
# Rules
- Behaviour stays identical: same outputs, errors, side effects and public API — unless the user asked otherwise.
- Work in small steps; run tests (or build/typecheck) after each step.
- Only touch the code in scope.

# What to improve
- Duplicated logic → one well-named function.
- Deep nesting → early returns / guard clauses.
- Long functions → extract meaningful pieces (not one-line wrappers).
- Unclear names → names that say what the thing is.
- Dead code, unused imports/params/variables, commented-out code → remove.
- Over-abstraction (interfaces with one implementation, factories for one type, needless generics) → inline.
- Hand-written utilities that the standard library or an existing dependency already provides → use those.

# Report
What changed and why, in a short list; confirm tests/build still pass.
