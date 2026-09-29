/**
 * Markdown renderer for agent replies.
 *
 * Written by hand rather than pulled from a library: it needs to handle exactly
 * what models emit — fenced code with a language tag, inline code, headings,
 * lists, tables, quotes, links — and nothing else. Keeping it local means no
 * dependency on a markdown parser plus a syntax highlighter, and full control
 * over how a shell command is presented (with its own copy button).
 */
import { useState, type ReactNode } from "react";
import { Bot, Brain, Check, Copy, Eye, FileDiff, FilePlus2, FolderOpen, Pencil, Search, Server, Terminal, Wrench, ChevronRight, Sparkles, Plug, FileSearch, CornerDownRight, FolderCog, GitBranch, Globe, Link2, Activity } from "lucide-react";
import { ScrollBox, FileIcon, baseName, dirName, Spinner } from "../components";

/* ---------- Inline formatting ---------- */

/** Splits on `code`, **bold**, *italic* and [links](url). */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // One pass, alternation ordered so `code` wins over emphasis.
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;

  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${i++}`;

    if (token.startsWith("`")) {
      out.push(
        <code
          key={key}
          className="rounded-md bg-[var(--bg-input)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--text-main)]"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**")) {
      out.push(
        <strong key={key} className="font-semibold text-[var(--text-main)]">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("*")) {
      out.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>
      );
    } else {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (m) {
        out.push(
          <a
            key={key}
            className="text-[var(--accent)] underline decoration-dotted hover:no-underline"
            href={m[2]}
            target="_blank"
            rel="noreferrer"
          >
            {m[1]}
          </a>
        );
      }
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* ---------- Code block ---------- */

/** Languages that read as a shell command rather than source to copy verbatim. */
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "powershell", "ps1", "cmd"]);

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const isShell = SHELL_LANGS.has(lang.toLowerCase());

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard can be unavailable; ignore */
    }
  };

  return (
    <div className="group relative my-2 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-input)]">
      <div className="flex items-center gap-2 border-b border-[var(--border-soft)] px-3 py-1.5">
        {isShell ? (
          <Terminal size={11} className="shrink-0 text-[var(--text-dim)]" />
        ) : (
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
            {lang || "code"}
          </span>
        )}
        {isShell && (
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
            command
          </span>
        )}
        <button
          className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-[var(--text-dim)] opacity-0 transition-opacity hover:text-[var(--text-main)] group-hover:opacity-100"
          onClick={copy}
          title="Copy"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <ScrollBox className="overflow-x-auto px-3 py-2.5">
        <pre>
          <code className="whitespace-pre font-mono text-[12px] leading-[1.6] text-[var(--text-main)]">
            {code}
          </code>
        </pre>
      </ScrollBox>
    </div>
  );
}

/* ---------- Block parsing ---------- */

export interface Block {
  kind: "p" | "h" | "ul" | "ol" | "quote" | "code" | "table" | "hr";
  lines: string[];
  lang?: string;
}

/** Groups raw lines into markdown blocks, keeping fenced code intact. */
function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code — ``` optionally followed by a language.
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume the closing fence
      blocks.push({ kind: "code", lines: body, lang });
      continue;
    }

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: "hr", lines: [] });
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "h", lines: [heading[1].length + ":" + heading[2]] });
      i++;
      continue;
    }

    // Table: a header row followed by a separator of dashes.
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])
    ) {
      const body: string[] = [line];
      i += 2; // skip header and separator
      while (i < lines.length && lines[i].includes("|")) {
        body.push(lines[i]);
        i++;
      }
      blocks.push({ kind: "table", lines: body });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", lines: body });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", lines: body });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", lines: body });
      continue;
    }

    // Plain paragraph: consume until a blank line or another block starts.
    const body: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i])
    ) {
      body.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "p", lines: body });
  }

  return blocks;
}

/* ---------- Table ---------- */

function Table({ rows, keyPrefix }: { rows: string[]; keyPrefix: string }) {
  const cells = (row: string) =>
    row
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());

  const [header, ...body] = rows;

  return (
    <ScrollBox className="my-2 overflow-x-auto rounded-xl border border-[var(--border)]">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-[var(--bg-input)]">
            {cells(header).map((c, i) => (
              <th
                key={i}
                className="border-b border-[var(--border)] px-3 py-1.5 text-left font-medium text-[var(--text-main)]"
              >
                {renderInline(c, `${keyPrefix}-th${i}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {cells(row).map((c, i) => (
                <td
                  key={i}
                  className="border-b border-[var(--border-soft)] px-3 py-1.5 align-top text-[var(--text-muted)]"
                >
                  {renderInline(c, `${keyPrefix}-td${r}-${i}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollBox>
  );
}

/* ---------- Entry point ---------- */

export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-2 leading-relaxed text-[var(--text-main)]">
      {blocks.map((b, idx) => {
        const key = `b${idx}`;

        if (b.kind === "code") {
          return <CodeBlock key={key} code={b.lines.join("\n")} lang={b.lang ?? ""} />;
        }

        if (b.kind === "hr") {
          return <div key={key} className="my-1 h-px bg-[var(--border-soft)]" />;
        }

        if (b.kind === "h") {
          const [level, ...rest] = b.lines[0].split(":");
          const size =
            level === "1" ? "text-[18px]" : level === "2" ? "text-[16px]" : "text-[14px]";
          return (
            <div key={key} className={`mt-1 font-semibold text-[var(--text-main)] ${size}`}>
              {renderInline(rest.join(":"), key)}
            </div>
          );
        }

        if (b.kind === "ul") {
          return (
            <ul key={key} className="flex flex-col gap-1 pl-1">
              {b.lines.map((li, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--text-dim)]" />
                  <span className="min-w-0 flex-1">
                    {renderInline(li, `${key}-${i}`)}
                  </span>
                </li>
              ))}
            </ul>
          );
        }

        if (b.kind === "ol") {
          return (
            <ol key={key} className="flex flex-col gap-1">
              {b.lines.map((li, i) => (
                <li key={i} className="flex gap-2">
                  <span className="shrink-0 font-mono text-[12px] text-[var(--text-dim)]">
                    {i + 1}.
                  </span>
                  <span className="min-w-0 flex-1">{renderInline(li, `${key}-${i}`)}</span>
                </li>
              ))}
            </ol>
          );
        }

        if (b.kind === "quote") {
          return (
            <blockquote
              key={key}
              className="border-l-2 border-[var(--border)] pl-3 text-[var(--text-muted)]"
            >
              {b.lines.map((l, i) => (
                <div key={i}>{renderInline(l, `${key}-${i}`)}</div>
              ))}
            </blockquote>
          );
        }

        if (b.kind === "table") {
          return <Table key={key} rows={b.lines} keyPrefix={key} />;
        }

        return (
          <p key={key} className="whitespace-pre-wrap break-words">
            {renderInline(b.lines.join("\n"), key)}
          </p>
        );
      })}
    </div>
  );
}

/* ---------- Agent tool call row ---------- */

export interface ToolCallView {
  name: string;
  input: string;
  result?: string;
  ok?: boolean;
  running?: boolean;
  /** Opens this call in the side panel as its own tab. */
  onInspect?: () => void;
}

/** Each tool gets its own icon and verb, so the transcript reads at a glance. */
const TOOL_META: Record<string, { icon: typeof Terminal; label: string }> = {
  read_file: { icon: Eye, label: "Read" },
  write_file: { icon: FilePlus2, label: "Write" },
  edit_file: { icon: Pencil, label: "Edit" },
  apply_patch: { icon: FileDiff, label: "Edit" },
  list_dir: { icon: FolderOpen, label: "List" },
  grep: { icon: Search, label: "Search" },
  run_command: { icon: Terminal, label: "Run" },
  ssh_exec: { icon: Server, label: "SSH" },
  delegate: { icon: Bot, label: "Agent" },
  skill: { icon: Sparkles, label: "Skill" },
  mcp: { icon: Plug, label: "MCP" },
  find_files: { icon: FileSearch, label: "Find" },
  change_dir: { icon: CornerDownRight, label: "cd" },
  file_op: { icon: FolderCog, label: "Files" },
  git: { icon: GitBranch, label: "Git" },
  web_search: { icon: Globe, label: "Web search" },
  web_fetch: { icon: Link2, label: "Fetch" },
  background: { icon: Activity, label: "Task" },
};

/** `mcp__github__create_issue` → "github · create_issue". */
export function mcpLabel(name: string): string | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : null;
}

/** Tools whose input starts with a file path. */
const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file", "apply_patch"]);

/**
 * Splits a tool row's input into the file it touches and the rest:
 * "src/a.ts (12–40)" → path "src/a.ts", extra "(12–40)". Subagent rows carry
 * a "[Helper] " prefix, kept apart as the owner tag.
 */
function parseInput(name: string, input: string): { owner: string; path: string | null; extra: string } {
  let rest = input;
  let owner = "";
  const m = /^\[([^\]]+)\] /.exec(rest);
  if (m) {
    owner = m[1];
    rest = rest.slice(m[0].length);
  }
  if (FILE_TOOLS.has(name) || name === "list_dir") {
    const sp = rest.search(/ [(…]/);
    const path = (sp >= 0 ? rest.slice(0, sp) : rest).trim();
    return { owner, path: path || (name === "list_dir" ? "." : null), extra: sp >= 0 ? rest.slice(sp).trim() : "" };
  }
  return { owner, path: null, extra: rest };
}

/** Reasoning the model streamed before or between its actions. */
export function ThinkBlock({ text, live }: { text: string; live?: boolean }) {
  // Open while streaming (progress must be visible), folded once done.
  const [open, setOpen] = useState(!!live);
  return (
    <div className="flex flex-col">
      <button
        className="flex w-fit items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-[12px] text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-muted)]"
        onClick={() => setOpen(!open)}
      >
        <Brain size={12} className={live ? "animate-pulse text-[var(--accent)]" : ""} />
        <span>{live ? "Thinking…" : "Thought"}</span>
        <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <ScrollBox className="ml-2 mt-1 max-h-[260px] overflow-auto border-l border-[var(--border-soft)] pl-3">
          {/* Reasoning is prose, not markdown the model meant for the user. */}
          <p className="whitespace-pre-wrap text-[12px] leading-[1.6] text-[var(--text-dim)]">{text}</p>
        </ScrollBox>
      )}
    </div>
  );
}

/**
 * One tool invocation as a flat row — no box; the background shows on hover.
 * File tools show the language badge + file name, the folder dimmed after
 * it. A click opens the full diff / output in the side panel.
 */
export function ToolCall({ call }: { call: ToolCallView }) {
  const running = call.running ?? false;
  const ok = call.ok ?? true;
  const mcp = mcpLabel(call.name);
  const meta = TOOL_META[call.name] ?? (mcp ? { icon: Plug, label: mcp } : { icon: Wrench, label: call.name });
  const Icon = meta.icon;
  const clickable = !!call.onInspect;
  const { owner, path, extra } = parseInput(call.name, call.input);

  return (
    <div
      className={`group/tool flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-[12.5px] transition-colors ${
        clickable ? "cursor-pointer hover:bg-[var(--hover-bg)]" : ""
      }`}
      onClick={clickable ? call.onInspect : undefined}
      title={clickable ? "Open in the side panel" : undefined}
      role={clickable ? "button" : undefined}
    >
      {running ? (
        <Spinner size={13} className="text-[var(--accent)]" />
      ) : (
        <Icon size={13} strokeWidth={1.6} className={`shrink-0 ${ok ? "text-[var(--text-dim)]" : "text-[var(--diff-del)]"}`} />
      )}
      <span className="shrink-0 text-[var(--text-muted)]">{meta.label}</span>
      {owner && (
        <span className="shrink-0 rounded-md bg-[var(--accent)]/12 px-1.5 text-[10.5px] text-[var(--accent)]">{owner}</span>
      )}
      {path !== null ? (
        <>
          <FileIcon path={path} folder={call.name === "list_dir"} />
          <span className="min-w-0 shrink truncate font-medium text-[var(--text-main)]">{baseName(path)}</span>
          {dirName(path) && (
            <span className="hidden min-w-0 shrink-[2] truncate text-[11px] text-[var(--text-dim)] group-hover/tool:inline">
              {dirName(path)}
            </span>
          )}
          {extra && <span className="shrink-0 font-mono text-[11px] text-[var(--text-dim)]">{extra}</span>}
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--text-dim)]">{extra}</span>
      )}
      <span className="flex-1" />
      {!running && !ok && (
        <span className="shrink-0 text-[10.5px] text-[var(--diff-del)]">failed</span>
      )}
      {clickable && (
        <ChevronRight size={12} className="shrink-0 text-[var(--text-dim)] opacity-0 transition-opacity group-hover/tool:opacity-100" />
      )}
    </div>
  );
}
