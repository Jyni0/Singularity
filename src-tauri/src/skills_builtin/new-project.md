---
name: new-project
description: "Scaffold a new project or app with current, idiomatic tooling (Vite, Next.js, FastAPI, Tauri, .NET, Rust…) and a working dev setup."
---
# Steps
1. Confirm the stack from the request; if unspecified pick the mainstream modern default and say which.
2. Use the official generator non-interactively (pass flags like `--yes`, `--template`, `--typescript`): e.g. `npm create vite@latest app -- --template react-ts`, `npx create-next-app@latest app --ts --eslint --app --use-npm --yes`, `cargo new`, `dotnet new`, `uv init`. Check the generator's current flags first if unsure.
3. Never scaffold into a non-empty folder without asking — generators cancel or overwrite.
4. Install dependencies, then run build and the dev server (dev server in the background) to prove it works.
5. Add only what was asked (no extra libraries "for later"). Set up git (`git init`, a sensible .gitignore) if the folder is not a repo.
6. Report: the created structure in brief, how to run it, and the URL of the dev server.
