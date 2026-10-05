# AI_WORKING_PROCESS — как Singularity говорит с нейронками

Документ — только разбор, без изменений кода. Ссылки вида `file:line` указывают на текущее состояние `main`.

Что сказано по коду — проверено чтением исходников. Утверждения о поведении официальных CLI (Claude Code, Codex, Antigravity/Gemini CLI) — из их известного устройства, в этой сессии не перепроверялись; такие места помечены **(проверить)**. Ссылки из задачи не открывались: официальный репозиторий Codex CLI — `github.com/openai/codex` (не `openai-cli`), `deepseek-ai/deepseek-harness` не проверен.

---

## 0. Коротко

1. **Главная причина «в 10 раз больше лимитов» — CLI-сессия чата пересоздаётся почти на каждом сообщении**, начиная с 7-го сообщения в чате. Причина — конфликт `HISTORY_TURNS = 12` и проверки `user_turns == turns + 1` (см. §2.1). Каждое пересоздание = новый процесс CLI + вся история одним сообщением **без кэша**.
2. Codex и Antigravity получают **два набора инструментов и два системных промпта**: свой встроенный (его не выключить, только запретить/песочница) + наш текстом. Claude Code — чистый (`--tools ""`, `--system-prompt-file`).
3. Antigravity запускается **в новой случайной папке на каждую сессию** — его системный промпт (в который входит путь папки и правила GEMINI.md) каждый раз другой → первый запрос сессии никогда не попадает в кэш.
4. Инструменты через **текстовый протокол** `<tool_call>` вместо нативного tool calling: схемы JSON-текстом в промпте, напоминание в каждом сообщении, ошибки парсинга, отказы/«подталкивания» agy — лишние полные запросы.
5. Контекст показывается меньше, потому что гейдж считает **оценку того, что мы бы отправили заново** (обрезанная история, ~4 символа/токен), а не то, что реально лежит в живой CLI-сессии, и не видит скрытые промпты CLI. Официальные UI считают всё, включая резерв под автокомпакт.
6. Структура: несколько файлов-«комбайнов» (`tools.rs` 3020 строк, `ssh.rs` 2003, `core/db.r.ts` 2439, `App.p.tsx` 1521, `useChat.h.ts` 1093). Строки-«kind» (`"anthropic-messages"`, `"openai-cli"`…) сравниваются по всему коду вместо одного enum/адаптера.

---

## 1. Как сейчас проходит запрос

### 1.1 Общая схема

```text
UI (React)                                   Rust (Tauri)
───────────                                  ─────────────
PromptBox → useChat.h.ts                     lib.rs  #[tauri::command]
  runTurn()                                    ├─ chat_stream  → chat.rs::stream_chat      (агент выключен)
   ├─ agentRequest(provider, cred, model…)     │     ├─ kind "google" → stream_google (нативный Gemini)
   ├─ modelTurns(history)  ← work_log/detail   │     └─ иначе        → agent/plain.rs (Rig AgentBuilder, без tools)
   └─ invoke("agent_run" | "chat_stream")      └─ agent_run    → agent.rs::run_agent        (агент включён)
                                                     ├─ context::trim_history(turns)   12 последних реплик
события обратно:                                     └─ runtime::run
  agent://text | think | step | usage                   ├─ skills, MCP, project_context (AGENTS.md + repo map)
  agent://confirm | retry | done | error                ├─ SystemPromptBuilder → preamble
  chat://delta | usage | done                           ├─ main_tools → ToolRegistry
                                                        └─ AgentLoop::run
                                                              loop (≤128 шагов):
                                                                compact? → ContextManager.prepare
                                                                → model::build(req).handle.stream(request)
                                                                → tool calls? → guard/dedupe/approve/run
                                                                → tool results в историю → снова
```

Ключевые файлы:

| Слой | Файл |
|---|---|
| Сбор запроса во фронте | [useChat.h.ts](src/hooks/useChat.h.ts) (`agentRequest`, `modelTurns`, `workOf`, `contextFor`) |
| IPC-обёртки | [db.r.ts](src/core/db.r.ts) (секции «Inference», «Agent (tool-using) run») |
| Точка входа агента | [agent.rs:322](src-tauri/src/agent.rs:322) `run_agent` |
| Сборка прогона | [runtime.rs:281](src-tauri/src/agent/runtime.rs:281) `run` |
| Цикл модели | [agent_loop.rs:116](src-tauri/src/agent/agent_loop.rs:116) `run_with` |
| Провайдер → Rig-модель | [model.rs:70](src-tauri/src/agent/model.rs:70) `build_model` |
| CLI как Rig-модель | [cli/model.rs](src-tauri/src/cli/model.rs), [cli/protocol.rs](src-tauri/src/cli/protocol.rs) |
| Контекст | [context/manager.rs](src-tauri/src/agent/context/manager.rs), [context/compact.rs](src-tauri/src/agent/context/compact.rs), [context/project.rs](src-tauri/src/agent/context/project.rs) |
| Системный промпт | [prompts/builder.rs](src-tauri/src/agent/prompts/builder.rs) |

### 1.2 Что уходит в каждый запрос (одинаково для всех провайдеров)

`AgentLoop::request` ([agent_loop.rs:202](src-tauri/src/agent/agent_loop.rs:202)) собирает `CompletionRequest`:

1. **System** — `SystemPromptBuilder::build()`:
   - Role & operating mode (наш дефолт или промпт пользователя),
   - Tool protocol (план, параллельные вызовы, не повторять),
   - Execution constraints,
   - Environment (ОС, shell, workspace, дата, MCP, картинки),
   - Project instructions (AGENTS.md / CLAUDE.md / .goosehints…, до `HINTS_CHARS = 8000` символов),
   - Project map (Aider-style repo map, до `MAP_CHARS 8000` + `MAP_SYMBOL_CHARS 6000`),
   - MCP catalog (если MCP > `MCP_INLINE_TOKENS = 6000` — только имена + `mcp_find`/`mcp_call`),
   - Skills list (имена + описания).
2. **Tools** — схемы всех встроенных инструментов ([tools/specs.rs](src-tauri/src/agent/tools/specs.rs)) + MCP + `skill` (+ `delegate` только для API и `max_agents > 1`).
3. **History** — результат `trim_history` + сообщения текущего прогона (вызовы и результаты инструментов).

`trim_history` ([manager.rs:34](src-tauri/src/agent/context/manager.rs:34)):
- последние `HISTORY_TURNS = 12` реплик, начиная с реплики пользователя;
- ответы агента обрезаются до последних `1500` символов;
- к каждому ответу агента дописывается `[What I did in this turn]` (work_log, до 4000 символов);
- к последнему ответу — `[What those tools returned…]` (work_detail, до 24000 символов);
- саммари `/compact` переносится на первую оставшуюся реплику.

### 1.3 Путь «API-ключ» (anthropic-messages, openai-responses, OpenAI-совместимые, DeepSeek, Ollama, Gemini API)

[model.rs:98](src-tauri/src/agent/model.rs:98):

| kind | Клиент | Кэш | Effort |
|---|---|---|---|
| `anthropic-messages` | Rig `anthropic` | `with_automatic_caching().with_prompt_caching()` — брейкпоинты на tools + system, автоматический на историю | `thinking.budget_tokens`: low → выкл, medium → 2048, high → 8192 |
| `openai-responses` | Rig `openai` Responses API | префиксный кэш OpenAI | `reasoning.effort` (только low/high) |
| `ollama` | Rig `ollama` | — | `think` только на high, `keep_alive: 30m` |
| всё остальное (`openai`, DeepSeek, OpenRouter, Gemini OpenAI-endpoint…) | Rig `openai` `/chat/completions` через `cachenet::CacheClient` | префиксный (DeepSeek/OpenAI автоматически, Gemini — implicit) | `reasoning_effort` |

Свойства пути:
- **Без состояния на стороне провайдера**: каждый шаг цикла отправляет system + tools + всю историю прогона. Экономия — только prompt-кэш провайдера, поэтому префикс держится байт-в-байт стабильным.
- **Нативный tool calling** (tool_use / function calling), параллельные вызовы в одном ответе.
- **Управление контекстом — наше**: схлопывание старых результатов инструментов при > 160k символов истории (`clear_old_results`, [manager.rs:153](src-tauri/src/agent/context/manager.rs:153)); дедуп `read_file` ([manager.rs:367](src-tauri/src/agent/context/manager.rs:367)); автокомпакт на 70% окна (`COMPACT_AT`, [manager.rs:221](src-tauri/src/agent/context/manager.rs:221)) через модельное саммари.
- **Usage**: `account()` ([agent_loop.rs:388](src-tauri/src/agent/agent_loop.rs:388)) нормализует к «input = весь промпт, включая cache reads»; для OpenAI-совместимых дополнительно сырые цифры из `cachenet`.
- **Окно** — из каталога моделей (`pricing::model_info`) или ручные caps; иначе `DEFAULT_WINDOW = 128000`.
- **Помощники** (`delegate`, `worker`) — только здесь, и только при `max_agents > 1`.

### 1.4 Путь «подписка через CLI» (anthropic-cli, openai-cli, google-cli)

`Cli::from_kind` ([cli/mod.rs:38](src-tauri/src/cli/mod.rs:38)): `anthropic-cli` → Claude Code, `openai-cli` → Codex, `google-cli` → Antigravity (`agy`).

`CliModel` ([cli/model.rs:51](src-tauri/src/cli/model.rs:51)) притворяется обычной Rig-моделью, но «HTTP-запрос» — это headless-процесс CLI:

1. **Рендер запроса в текст** — `protocol::render` ([protocol.rs:33](src-tauri/src/cli/protocol.rs:33)):
   - system + system-сообщения + **описание наших инструментов текстом** (`# My app's tools`, схема каждого инструмента как JSON Schema, [protocol.rs:186](src-tauri/src/cli/protocol.rs:186));
   - история как транскрипт `<user>…</user>`, `<assistant>…<tool_call>…</tool_call></assistant>`, `<tool_result …>`;
   - в конец каждого сообщения — напоминание про `<tool_call>` ([protocol.rs:138](src-tauri/src/cli/protocol.rs:138)).
2. **Модель отвечает текстом**; `ToolTagFilter` вырезает `<tool_call>{json}</tool_call>` и превращает их в Rig ToolCall. Дальше `AgentLoop` выполняет инструменты как обычно.
3. **Командная строка на каждый CLI** — `Job::prepare` ([cli/model.rs:529](src-tauri/src/cli/model.rs:529)):

| CLI | Запуск | Свои инструменты | Системный промпт | Ввод |
|---|---|---|---|---|
| Claude Code | `-p --input-format stream-json --output-format stream-json --no-session-persistence --tools "" --strict-mcp-config --disallowedTools mcp__* --system-prompt-file <file> [--model] [--effort]` | **выключены** | **заменён нашим** | stream-json в stdin, процесс живёт |
| Codex | `exec --json --sandbox read-only …` / `exec resume … <thread> -` | **остаются** (shell и др. в read-only песочнице) | свой базовый промпт Codex + наш текст `My instructions for this conversation:` в сообщении | один промпт → EOF; процесс на каждый вызов, продолжение через `exec resume` |
| Antigravity | `--input-format stream-json --output-format stream-json --disable-slash-commands [--model/--effort] -p ""`, `cwd = jobs/run-<uid>` | **остаются**, но в headless запрещаются (denied) | свой промпт agy + наши GEMINI.md/AGENTS.md (≤ 23 КБ каждый) как `user_rules`; остаток — в первом сообщении | stream-json, процесс живёт |

4. **Сессии** ([cli/model.rs:288](src-tauri/src/cli/model.rs:288) `open`):
   - `CHAT_SESSIONS` — реестр «чат → слот сессии», ключ `chat|cli|model|effort`, держится до `KEEP_CHATS = 4` чатов;
   - внутри прогона: если новый запрос = старый + ответ CLI + новые tool results (`Session::followup`), в живой процесс пишется **только новое** (результаты + напоминание);
   - новый прогон того же чата: `Session::resume` — пишется только последнее сообщение пользователя, **если** набор инструментов тот же и число пользовательских реплик выросло ровно на 1;
   - иначе сессия убивается и запускается новая с **полным транскриптом одним сообщением**.
5. **Usage** — `Decoder` + `Proc::turn_usage` ([cli/model.rs:458](src-tauri/src/cli/model.rs:458)):
   - Claude: из `result.usage`; input = input + cache_read;
   - Codex `resume` и agy отдают **накопленные итоги** — берётся разница с прошлыми; у agy input без cache reads, поэтому они добавляются.
6. **Контекст внутри прогона**: для CLI `ContextManager::without_collapsing()`, без компакта (`own_context`, [agent_loop.rs:131](src-tauri/src/agent/agent_loop.rs:131)). Любая правка ранних сообщений сломала бы `followup` и пересоздала сессию, поэтому сжатие отдано самому CLI.
7. **Окно** для CLI всегда `DEFAULT_WINDOW = 128000` в рантайме ([runtime.rs:210](src-tauri/src/agent/runtime.rs:210)); гейдж во фронте берёт окно из каталога или `FALLBACK_WINDOW = 128000`.

### 1.5 Plain chat (агент выключен)

`agent/plain.rs`: тот же `model::build`, Rig `AgentBuilder` без инструментов, `preamble = p.system`, история — **все** реплики чата без `trim_history` (для API-провайдеров история не ограничивается). Для CLI используется тот же слот сессии чата. Но набор инструментов другой (пустой), поэтому переключение «агент ↔ чат» в одном чате всегда пересоздаёт CLI-сессию. `chat://usage` не несёт `last_input`.

---

## 2. Почему Singularity тратит в разы больше лимитов, чем официальные CLI

Отсортировано по ожидаемому вкладу.

### 2.1 🔴 Сессия CLI пересоздаётся на каждом сообщении после 6-го (баг)

- `trim_history` оставляет 12 последних реплик, начиная с пользовательской ([manager.rs:22](src-tauri/src/agent/context/manager.rs:22)). При чередовании user/agent в запросе остаётся **максимум 6 пользовательских реплик** — сколько бы их ни было в чате.
- `Session::resume` требует `user_turns(req) == self.turns + 1` ([cli/model.rs:180](src-tauri/src/cli/model.rs:180)).
- С 7-го сообщения `user_turns` всегда = 6, а `self.turns` = 6. Проверка `6 == 7` ложна, `resume` возвращает `None`, живая сессия убивается ([cli/model.rs:297](src-tauri/src/cli/model.rs:297)). Стартует новый процесс с полным транскриптом:
  - 12 реплик,
  - work_log каждого ответа (до 4000 символов),
  - work_detail последнего (до 24000 символов),
  - весь system + текстовые схемы инструментов.
- Цена для лимитов:
  - **Claude** — запись в кэш всего префикса (cache creation ≈ 1,25× цены input), затем ещё и новый процесс;
  - **Gemini** — implicit-кэш на новом префиксе почти всегда 0%;
  - **Codex** — новый thread, кэш по `prompt_cache_key` тоже с нуля **(проверить)**.
- Официальный CLI держит один разговор и только дописывает в конец — кэш накрывает всё сказанное ранее.

Именно это объясняет картину «первые сообщения ок, потом каждое сообщение съедает проценты».

### 2.2 🔴 Другие причины пересоздания сессии

Каждая из них = полный холодный запрос:

| Триггер | Где |
|---|---|
| Смена модели **или effort** в чате (ключ слота содержит effort) | [cli/model.rs:219](src-tauri/src/cli/model.rs:219) |
| Переключение агент ↔ plain chat (другой `tool_defs`) | [cli/model.rs:180](src-tauri/src/cli/model.rs:180) |
| Включили/выключили MCP-сервер, skill, инструмент в Plugins (меняются схемы) | там же |
| Картинка в сообщении (`render_followup` → `None`) | [protocol.rs:174](src-tauri/src/cli/protocol.rs:174) |
| **Ретрай после ошибки**: сессия забрана из слота, при ошибке не возвращается; повтор в `model_turn` стартует новую с полной историей | [cli/model.rs:297](src-tauri/src/cli/model.rs:297), [agent_loop.rs:262](src-tauri/src/agent/agent_loop.rs:262) |
| Stop посреди ответа (процесс убивается) | [cli/model.rs:364](src-tauri/src/cli/model.rs:364) |
| Больше 4 активных чатов (`KEEP_CHATS`) | [cli/model.rs:70](src-tauri/src/cli/model.rs:70) |
| Перезапуск приложения (`--no-session-persistence`, сессии только в памяти) | [cli/model.rs:554](src-tauri/src/cli/model.rs:554) |
| Редактирование/повторная отправка старого сообщения, `/compact` | `resume` по счётчику реплик |

### 2.3 🔴 Codex и Antigravity: двойные промпты и двойные наборы инструментов

- **Claude Code** — чисто: `--tools ""` и `--system-prompt-file` полностью заменяют его промпт и инструменты. Накладные расходы минимальны.
- **Codex** (`exec --sandbox read-only`):
  - базовые инструкции Codex и его инструменты (shell, apply_patch, plan…) остаются в каждом запросе — плюс наш системный промпт и схемы текстом внутри пользовательского сообщения (`with_system`, [cli/model.rs:695](src-tauri/src/cli/model.rs:695));
  - read-only песочница **разрешает** читающие команды: модель может сама запускать `ls`/`cat`/`rg` в пустой scratch-папке. Каждый такой шаг — отдельный внутренний запрос Codex, который мы не видим. Decoder слушает только `agent_message` и `reasoning`, `command_execution` игнорирует ([cli/model.rs:839](src-tauri/src/cli/model.rs:839)), но usage этих шагов приходит в `turn.completed` и в лимиты попадает;
  - **(проверить)**: прогнать с `CLI_TRACE=1` и посмотреть, есть ли `command_execution` items.
- **Antigravity**:
  - собственный системный промпт agy + декларации его инструментов отправляются всегда;
  - когда Gemini тянется к своему `run_command` — отказ, «пустой» ход, затем до `MAX_NUDGES = 2` подталкивающих сообщений ([cli/model.rs:951](src-tauri/src/cli/model.rs:951)). Каждое — полный запрос.
- Официальные CLI отправляют **один** системный промпт и **один** набор нативных инструментов.

### 2.4 🟠 Antigravity: новая случайная папка → промпт каждый раз другой

- `Job::prepare` создаёт `jobs()/run-<uid>` ([cli/model.rs:530](src-tauri/src/cli/model.rs:530)) и делает её `cwd` для agy ([cli/model.rs:637](src-tauri/src/cli/model.rs:637)).
- В [cli/mod.rs:130](src-tauri/src/cli/mod.rs:130) прямо сказано: CLI кладут рабочую папку в начало своего промпта, и смена папки ломает кэш. Для Claude и Codex папка стабильная (`scratch()`), а для agy — уникальная на каждую сессию.
- Поэтому первый запрос любой новой agy-сессии — 0% кэша (это совпадает с замерами 0%, 0%, 89%). Вместе с §2.1 почти каждое сообщение после шестого холодное.

### 2.5 🟠 Текстовый протокол инструментов вместо нативного

- Схемы всех инструментов — сырой JSON Schema текстом в системном промпте ([protocol.rs:201](src-tauri/src/cli/protocol.rs:201)). У нативного tool calling провайдер хранит их компактнее и кэширует отдельным слоем **(проверить для каждого)**.
- Каждое сообщение в живую сессию получает `Reminder` ([protocol.rs:143](src-tauri/src/cli/protocol.rs:143)) — мелочь, но на каждом шаге.
- Модель обучена на нативных вызовах. В текстовом протоколе она:
  - чаще делает один вызов за ход (больше раундов = больше полных запросов);
  - иногда пишет кривой JSON (ход впустую);
  - тратит reasoning на сомнения («это injection?» — отсюда фраза «This is my genuine setup…», [protocol.rs:193](src-tauri/src/cli/protocol.rs:193)).
- Каждый раунд инструментов = отдельный «ход» CLI = отдельный запрос со всем контекстом. У официальных CLI так же, но раундов меньше: они батчат параллельные вызовы нативно.

### 2.6 🟠 Большой статический префикс

Каждая новая сессия (а из-за §2.1 — почти каждое сообщение) отправляет заново:
- наш системный промпт: роль, протокол, ограничения, окружение, project instructions до 8000 символов, repo map до ~14000 символов;
- текстовые схемы инструментов (исходник `specs.rs` — ~20 КБ);
- MCP inline до 6000 токенов;
- skills list.

Реальный размер — в логе `system prompt built` (tokens) и `agent loop started` (`preamble_tokens`, `tools`).

Для agy промпт больше 23 КБ не влезает в GEMINI.md и **переезжает в первое пользовательское сообщение** ([cli/model.rs:638](src-tauri/src/cli/model.rs:638)). Оно уже не часть стабильного system-префикса.

### 2.7 🟡 Переинъекция «что я сделал» при пересоздании сессии

`work_log` (до 4000 символов на каждый из ~6 ответов) + `work_detail` (до 24000 символов) — до ~48 КБ текста.

В живой сессии это не нужно: CLI и так помнит всё. Но из-за §2.1 сессия почти всегда новая, и этот блок едет каждый раз.

Для `resume` он не отправляется (уходит только последнее сообщение), но `resume` почти не срабатывает.

### 2.8 🟡 Reasoning

- Claude: `--effort`. Codex: `model_reasoning_effort`. agy: `agy_model_args`.
- По умолчанию в UI сейчас `low`. Gemini 3.1 Pro думает много даже на low — это свойство модели. Инструкция «Think briefly» в промпте ([builder.rs:220](src-tauri/src/agent/prompts/builder.rs:220)) помогает лишь частично.

### 2.9 Что НЕ является причиной

- Helper-агенты: для CLI выключены (`has_helpers`, [agent.rs:267](src-tauri/src/agent.rs:267); `with_worker`, [runtime.rs:146](src-tauri/src/agent/runtime.rs:146)).
- Заголовок чата для CLI строится локально.
- Компакт внутри прогона для CLI отключён.
- Цифры HUD (input/output/cached) сверены с собственной статистикой agy (`gen_metadata`) и совпадают. Проблема в количестве и холодности запросов, а не в подсчёте.

### 2.10 Как подтвердить замером

1. Чат на 10+ сообщений с Claude CLI → в логе после 6-го сообщения на **каждом** сообщении ищите `CLI session starts` вместо `CLI session continues`.
2. `CLI_TRACE=1` для Codex → наличие `command_execution` items.
3. Сравнить `cache_hit_pct` в логе `model call usage` для первого вызова каждой сессии agy.

---

## 3. Как считается контекст и почему он меньше, чем в официальных клиентах

### 3.1 Как считается сейчас

1. Фронт (`contextFor`, [useChat.h.ts:509](src/hooks/useChat.h.ts:509)) вызывает `agent_context` с тем же запросом, что ушёл бы следующим.
2. Rust (`measure`, [runtime.rs:385](src-tauri/src/agent/runtime.rs:385)) считает категории через `est_tokens` ([manager.rs:411](src-tauri/src/agent/context/manager.rs:411)): **ASCII = 4 символа/токен, остальное = 2,5**.
   - Messages: `trim_history` + раскрытые @files;
   - System tools: каждая схема;
   - MCP;
   - Skills;
   - System prompt по секциям.
3. Калибровка (только **API**): `first_input / first_est` последнего прогона, зажата в 0,4…3 ([useChat.h.ts:542](src/hooks/useChat.h.ts:542)). Для CLI отключена.
4. `ContextMeter` ([ContextMeter.c.tsx:247](src/chat/ContextMeter.c.tsx:247)):
   - во время прогона — `live` (= `last_input` главного агента);
   - для CLI вне прогона — `lastRequest` из последнего сохранённого usage;
   - `fitTo` подгоняет категории под реальное число; излишек становится «Session history & tool results».
5. Окно — из каталога (`effectiveModelInfo`) или `FALLBACK_WINDOW = 128000`.

### 3.2 Почему показывает меньше

| # | Причина | Где |
|---|---|---|
| 1 | **Считается не та история.** Оценка — обрезанные 12 реплик, ответы по 1500 символов, детали только последнего хода. Живая CLI-сессия держит всё с момента старта: каждый tool result целиком, без схлопывания (`without_collapsing`). Официальный клиент показывает именно накопленный разговор — поэтому у Claude Desktop «Messages» в разы больше. | [manager.rs:34](src-tauri/src/agent/context/manager.rs:34), [agent_loop.rs:127](src-tauri/src/agent/agent_loop.rs:127) |
| 2 | **Эвристика 4 символа/токен** занижает код, JSON-схемы и пути: у реальных токенизаторов там ~3–3,5 символа/токен, т.е. недосчёт 15–30%. Для CLI калибровка выключена, поэтому ошибка остаётся. | [manager.rs:411](src-tauri/src/agent/context/manager.rs:411), [useChat.h.ts:542](src/hooks/useChat.h.ts:542) |
| 3 | **Скрытые промпты CLI не видны оценке**: системный промпт и встроенные инструменты agy и Codex, служебные вставки Claude Code. Они есть только в `lastRequest`. | — |
| 4 | **`lastRequest` есть не всегда**: в старых сообщениях нет `last_input`, plain chat (`chat://usage`) его не передаёт → гейдж падает на чистую оценку. | [chat.rs:127](src-tauri/src/chat.rs:127) |
| 5 | **`lastRequest` — это прошлый запрос**, а не следующий: следующее сообщение добавит ещё ответ + новое сообщение. Если сессию пересоздадут (§2.1), реальный запрос будет вообще другим (транскрипт заново). | [ContextMeter.c.tsx:247](src/chat/ContextMeter.c.tsx:247) |
| 6 | **Окно не совпадает**: CLI-модель «default» в каталоге не найдётся → 128k. У Claude Code окно 200k/1M, у Gemini 1M, у Codex своё — проценты несравнимы. | [ContextMeter.c.tsx:31](src/chat/ContextMeter.c.tsx:31) |
| 7 | **Официальные UI прибавляют резерв**: Claude Code `/context` показывает «Autocompact buffer» как занятое место **(проверить точную величину)**. | — |
| 8 | Обратный эффект: у agy и Codex `last_input` — **сумма** всех внутренних вызовов хода (подталкивания, свои инструменты Codex), а не размер одного запроса. Значение может скакать вверх. | [cli/model.rs:458](src-tauri/src/cli/model.rs:458) |

### 3.3 Что нужно, чтобы цифра совпадала с официальной (для решения позже)

- Для CLI показывать **размер последнего запроса живой сессии** + рост с тех пор, и отдельно помечать «сессия будет пересоздана → размер = транскрипт».
- Считать токены по реальному токенизатору провайдера или калибровать и для CLI (по `first_input` первого запроса новой сессии).
- Для agy/Codex брать размер **последнего** внутреннего вызова, а не сумму хода. У agy есть `gen_metadata` в его БД.
- Окно CLI-модели брать из самого CLI/подписки, а не из каталога OpenRouter.

---

## 4. Структура приложения и что улучшить

### 4.1 Как устроено сейчас

**Backend `src-tauri/src`** (крупнейшие файлы, строк):

```text
tools.rs 3020   ssh.rs 2003   cli/mod.rs 1076   cli/model.rs 1031   agent/agent_loop.rs 831
mcp.rs 826   skills.rs 550   agent/context/manager.rs 536   db.rs 530   agent.rs 470
agent/runtime.rs 468   agent/context/project.rs 436   lib.rs 434   imagegen.rs 424   chat.rs 381
```

Модуль `agent/` уже разбит хорошо: `agent_loop`, `context/`, `prompts/`, `tools/`, `model`, `runtime`, `guardrails`, `permissions`. Остальное — плоские «файлы-сервисы».

**Frontend `src`** (91 файл, крупнейшие):

```text
core/db.r.ts 2439 (131 экспорт, ~30 секций)   app/App.p.tsx 1521 (42 useState)
settings/ModelsSettings.c.tsx 1224   hooks/useChat.h.ts 1093   layout/SshPanel.c.tsx 1052
views/FilesView.p.tsx 868   chat/PromptBox.c.tsx 764   chat/ChatMessage.c.tsx 615   core/types.i.ts 548
```

Суффиксы: `.p` — страница, `.c` — компонент, `.h` — хук, `.u` — утилита, `.r` — ресурс/IPC, `.i` — типы, `.s` — стили/токены. UI-кит — `src/components`.

### 4.2 Проблемы

1. **«Строковый» kind провайдера** проверяется в десятках мест: `== "anthropic-messages"` в `agent_loop::account`, `plain.rs`, `model.rs`; `Cli::from_kind` в runtime, agent, agent_loop; `isCliKind` во фронте. Новое поведение провайдера = правки в 5–8 файлах. Ровно так появились расхождения в usage (кто считает cache reads внутри input, а кто отдельно).
2. **Нормализация usage размазана**: CLI `Decoder` + `turn_usage`, `agent_loop::account`, `plain.rs`, `cachenet`. Четыре реализации одного правила «input = весь промпт».
3. **`cli/model.rs` смешивает четыре ответственности**:
   - реестр сессий,
   - сборку командной строки трёх CLI,
   - декодирование трёх протоколов событий,
   - эмиттер в Rig.
   Специфика каждого CLI разбросана по `match self.cli` в 8+ местах.
4. **`tools.rs` (3020)** — пути, ФС, патчи, shell + `condense_output`, grep, «готовые операции», диспетчер и тесты в одном файле.
5. **`ssh.rs` (2003)** — типы, пул, БД, креды, exec, PTY, SFTP, CRUD и Tauri-команды вместе.
6. **`db.r.ts` (2439)** — «всё про IPC»: БД, OAuth, CLI, инференс, агент, SSH, SFTP, апдейтер, расписание, skills, MCP… Любой импорт тянет весь файл, навигация тяжёлая.
7. **`App.p.tsx` (1521, 42 `useState`)** — состояние всего приложения в одном компоненте. Выбор модели дублируется в `App.pickedModel` и в локальном state `PromptBox`. Из-за двух источников правды и появился баг «модель не меняется при смене чата».
8. **`useChat.h.ts` (1093)** — отправка, подписка на события агента, сборка истории (`modelTurns`/`workOf`), отчёт контекста, `/compact`, заголовки.
9. **`lib.rs`** — регистрация всех команд + 17 команд прямо в нём.
10. **`agent.rs`** — тип запроса, события UI, approval-гейт, ssh-инструмент и точка входа вместе.

### 4.3 Предлагаемая раскладка (ориентиры — Goose, Roo Code, Aider)

**Провайдеры — один адаптер вместо строк (как `Provider` trait у Goose):**

```text
src-tauri/src/provider/
  kind.rs        enum ProviderKind { AnthropicMessages, OpenAiResponses, OpenAiCompat, Ollama, Google,
                                     ClaudeCli, CodexCli, AgyCli }  + parse/is_cli/reports_cache_apart
  usage.rs       normalize(kind, raw) -> NormalizedUsage  — единственное место правил input/cached
  api.rs         сегодняшний agent/model.rs::build_model (Rig-клиенты, effort, кэш)
  window.rs      окно модели (каталог, caps, CLI)
```

**CLI — стратегия на каждый CLI:**

```text
src-tauri/src/cli/
  mod.rs         Cli, resolve/ensure, Tauri-команды статуса/логина
  launch.rs      Launch, which, scratch/jobs
  session.rs     CHAT_SESSIONS, chat_slot, Session{followup,resume}, fingerprints
  model.rs       CliModel::open (тонкий: слот → backend → стрим)
  emitter.rs     Emitter + ToolTagFilter-связка
  protocol.rs    рендер транскрипта и <tool_call>
  backend/
    mod.rs       trait CliBackend { args(&Job), first_input(), user_line(), decode(line), turn_usage(), keeps_process() }
    claude.rs    codex.rs    agy.rs  (write_agy_rules, nudges)
  usage.rs       лимиты подписки (как сейчас)
```

**Инструменты (как разбиение Roo Code / Goose developer-extension):**

```text
src-tauri/src/tools/
  mod.rs (ToolResult, dispatch)  paths.rs (resolve, autocorrect)  read.rs (read_window, outline)
  write.rs  patch.rs (apply_patch)  search.rs (grep, find_files)  shell.rs (run_command, background)
  output.rs (condense_output, diagnostics_summary, save_full_output)  ops.rs  tests/
```

**Прочее backend:**
- `ssh/` — `types, pool, store, creds, exec, pty, sftp, units, commands`.
- `commands/` — все `#[tauri::command]`, сгруппированные по доменам; `lib.rs` — только сборка `Builder`.
- `agent/` — вынести из `agent.rs` `events.rs` (emit_*), `confirm.rs` (PENDING/ask_confirm), `request.rs` (AgentRequest, SubagentDef). Тесты `agent_loop.rs` (≈ 40% файла) — в `agent_loop/tests.rs`.

**Frontend:**

```text
src/core/api/            ← из db.r.ts, по домену: conversations, messages, providers, settings, oauth,
                            cli, inference, agent, ssh, units, credentials, proxies, scripts, audit,
                            terminal, sftp, updater, schedule, skills, mcp, modelCaps (+ connection.ts)
src/core/types/          ← из types.i.ts, по тем же доменам
src/state/               ← одно хранилище (Context + reducer или zustand):
  selection.ts           модель/effort per chat — единственный источник правды для App и PromptBox
  conversations.ts       активный чат, список, загрузка сообщений
src/hooks/chat/
  useSend.h.ts           runTurn / agentRequest
  useAgentEvents.h.ts    agent://* → сегменты
  useContextReport.h.ts  contextFor + калибровка
  useCompact.h.ts
src/chat/history.u.ts    modelTurns, workOf, diffStat-связка
src/settings/models/     ProviderCard, ProviderForm, CliProviderCard, ModelList, explainProviderError.u.ts
```

`App.p.tsx` после этого только компонует layout и роутинг, а состояние живёт в `state/` и хуках.

### 4.4 Порядок, если делать

1. `ProviderKind` + `usage::normalize` — меньше всего правок, убирает целый класс багов в подсчёте.
2. `cli/backend/*` — даёт место, где чинить §2.1–2.4 по одному CLI, не трогая остальные.
3. Хранилище выбора модели во фронте (`state/selection`).
4. Разрезка `db.r.ts` → `core/api/*`: механическая, можно по секциям, без изменения поведения.
5. `tools/`, `ssh/` — механическая разрезка, тесты переезжают вместе с кодом.

---

## 5. Сводка причин для починки (без решения)

| # | Проблема | Влияние | Файл |
|---|---|---|---|
| 1 | `resume` не срабатывает после 6 сообщений (`HISTORY_TURNS` vs `turns+1`) | 🔴 каждое сообщение — холодная новая сессия | manager.rs:22, cli/model.rs:180 |
| 2 | Ретрай/ошибка/Stop/смена effort/агент↔чат/картинка/>4 чатов/рестарт пересоздают сессию | 🔴 | cli/model.rs:219, 297; agent_loop.rs:262 |
| 3 | Codex/agy со своими промптами и инструментами + наши текстом; Codex может сам гонять shell | 🔴 | cli/model.rs:586–650, 839 |
| 4 | agy: случайный `cwd` на сессию → нет кэша на первом запросе | 🟠 | cli/model.rs:530, 637 |
| 5 | Текстовый `<tool_call>` протокол: больше раундов, ошибки, сомнения модели | 🟠 | cli/protocol.rs |
| 6 | Большой статический префикс, переезд остатка >23 КБ в сообщение у agy | 🟠 | builder.rs, cli/model.rs:638 |
| 7 | work_log/work_detail едут при каждом пересоздании | 🟡 | manager.rs:55–65 |
| 8 | Гейдж считает обрезанную историю, 4 символа/токен, без скрытых промптов CLI, с неверным окном | 🟠 (только отображение) | runtime.rs:385, manager.rs:411, ContextMeter.c.tsx |
