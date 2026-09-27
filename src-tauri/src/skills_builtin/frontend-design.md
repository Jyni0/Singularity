---
name: frontend-design
description: "Build distinctive, production-grade web UI (pages, components, dashboards, landing pages) instead of generic-looking layouts. Use for any frontend / UI / styling work."
---
# Goal
Interfaces that look deliberately designed, work on every screen size and are accessible — not the default "AI template" look.

# Before writing code
1. Read what exists: the framework, styling system (Tailwind, CSS modules, styled-components…), design tokens, existing components. Reuse them; never introduce a second styling system.
2. Pick a clear direction in one sentence (e.g. "dense, calm dashboard with one accent colour", "editorial landing page with large type"). Every choice below follows it.

# Design rules
- Typography: at most two families; a real scale (e.g. 12/14/16/20/28/40); line-height 1.4–1.6 for text, tighter for headings; limit line length to ~70ch.
- Colour: define tokens (background, surface, text, muted text, border, accent, danger). One accent colour, used sparingly. Check contrast (4.5:1 for text). Support dark mode if the app has it.
- Spacing: one spacing scale (4px steps). Group related things tightly, separate groups generously. Align to a grid.
- Hierarchy: one primary action per view. Size, weight and colour — not boxes everywhere — show importance.
- Avoid clichés: purple-to-blue gradients on white, emoji as icons, every element in a rounded card with a shadow, centered everything.
- Details: hover / focus / active / disabled states for every control; visible keyboard focus; empty, loading and error states; smooth but short transitions (150–250ms).

# Responsiveness and accessibility
- Mobile first; test at 360px, 768px, 1280px. No horizontal scroll.
- Semantic HTML (button, nav, main, label for inputs), alt text, aria only where semantics are not enough.

# Finish
Run the dev server (in the background) and, if the Browser plugin is installed, open the page and look at it at a narrow and a wide size. Fix what looks off before reporting.
