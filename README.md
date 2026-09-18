# Singularity

**Next-Gen Agentic Desktop** — кроссплатформенное приложение (Tauri v2 + React/TS) для запуска, оркестрации и визуализации работы автономных ИИ-агентов.

## Статус

Ранний каркас (scaffold):

- **Frontend:** Vite + React + TypeScript, дизайн-система на CSS-переменных (`data-theme="dark | light | slate | amoled"`), компоненты: Sidebar, Prompt Box (auto-grow, селектор модели, Turbo/Safe), Diff Viewer (Accept/Reject), Walkthrough-карточки, терминал-блоки.
- **Backend (Tauri v2):** `src-tauri` — Rust-каркас с командами `greet` / `probe_ollama` (заглушки для Agent Harness Layer).

## Запуск (веб-прототип)

```bash
npm install
npm run dev        # http://localhost:1420
npm run build      # tsc + vite build
```

## Запуск (десктоп)

Требуется Rust toolchain ([rustup.rs](https://rustup.rs)):

```bash
npm install
npm run tauri:dev
npm run tauri:build   # .msi/.exe для Windows
```

## Структура

```
src/            # React UI (дизайн-система в src/styles.css)
src-tauri/      # Rust backend (Agent Harness Layer)
```

## Roadmap

- [ ] Agent Harness Layer: PTY-терминал, файловые операции, browser verification
- [ ] Gateways: Antigravity, DSH (RPC/WebSocket), Ollama, OpenAI-compatible, BYOK
- [ ] Model Router & fallback (429 / network errors)
- [ ] Security presets: Turbo / Safe + Tool Permissions Control
- [ ] Multi-agent orchestration & quota monitoring
