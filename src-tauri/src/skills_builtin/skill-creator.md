---
name: skill-creator
description: "Create a new skill (a SKILL.md instruction pack) for a repeatable task, or improve an existing one."
---
# What a skill is
A folder with SKILL.md: YAML front matter with `name` (lowercase, digits, dashes) and `description`, then markdown instructions. Extra files next to it (scripts, templates, reference docs) can be read when the instructions point to them.
- User skills: the skills folder shown in Settings → Skills.
- Project skills: `<project>/.singularity/skills/<name>/SKILL.md`.

# Steps
1. Clarify the task: what triggers it, inputs, the expected result, and 2–3 concrete examples of requests it should handle.
2. Write the description first — it decides when the skill is used. Say what it does AND when to use it, with the words a user would type ("Use when … / for …"). One or two sentences.
3. Write the body: the goal, numbered steps, rules / don'ts, the output format. Imperative, specific, no filler. Put long reference material in separate files and link them.
4. Keep SKILL.md under ~300 lines; put scripts that must run exactly in files instead of prose.
5. Test it mentally against the example requests; tighten anything ambiguous.
