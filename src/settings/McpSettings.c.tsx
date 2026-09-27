/**
 * Settings → MCP Servers: external tool servers (Model Context Protocol).
 * Every tool of an enabled server is offered to the agent as
 * `mcp__<server>__<tool>`; calls that are not marked read-only ask for
 * approval like commands do (unless the project runs commands without asking).
 *
 * Two transports: stdio (a local command — npx / uvx / a binary) and
 * Streamable HTTP (a URL). Configs copied from other apps' `mcpServers` JSON
 * can be pasted in as-is.
 */
import { useCallback, useEffect, useState } from "react";
import { Plug, Plus, Trash2, Save, X, PlayCircle, LoaderCircle, ClipboardPaste, Eye, EyeOff, Check } from "lucide-react";
import * as db from "../core/db.r";
import { SBUTTON, SINPUT } from "../ui/tokens.s";
import { Switch } from "../ui/Switch.c";
import { SettingsCard, Sep, Segmented } from "./SettingsParts.c";

const TEXTAREA =
  "w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2.5 py-2 font-mono text-[12px] leading-relaxed text-[var(--text-main)] outline-none focus:border-[var(--accent)]";
const LABEL = "flex flex-col gap-1 text-[11px] text-[var(--text-dim)]";

/** Editor state: lists edited as plain text, one entry per line. */
interface Draft {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
  enabled: boolean;
}

const toDraft = (s: db.McpServer): Draft => ({
  id: s.id,
  name: s.name,
  transport: s.transport,
  command: s.command,
  args: s.args.join("\n"),
  env: Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join("\n"),
  url: s.url,
  headers: Object.entries(s.headers).map(([k, v]) => `${k}: ${v}`).join("\n"),
  enabled: s.enabled,
});

function pairs(text: string, sep: "=" | ":"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(sep);
    if (!line.trim() || at < 1) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

const fromDraft = (d: Draft): db.McpServer => ({
  id: d.id,
  name: d.name.trim(),
  transport: d.transport,
  command: d.command.trim(),
  args: d.args.split(/\r?\n/).map((a) => a.trim()).filter(Boolean),
  env: pairs(d.env, "="),
  url: d.url.trim(),
  headers: pairs(d.headers, ":"),
  enabled: d.enabled,
});

const EMPTY: Draft = { id: "", name: "", transport: "stdio", command: "npx", args: "-y\n", env: "", url: "", headers: "", enabled: true };

/** `{"mcpServers": {...}}` (Claude Desktop / Cursor / VS Code style) → servers. */
export function parseMcpJson(text: string): db.McpServer[] {
  const root = JSON.parse(text) as Record<string, unknown>;
  const map = (root.mcpServers ?? root.servers ?? root) as Record<string, Record<string, unknown>>;
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("Expected an object of servers");
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const dict = (v: unknown) =>
    Object.fromEntries(Object.entries((v && typeof v === "object" ? v : {}) as Record<string, unknown>).map(([k, x]) => [k, String(x)]));
  return Object.entries(map).map(([name, cfg]) => {
    if (!cfg || typeof cfg !== "object") throw new Error(`Server “${name}” is not an object`);
    const url = str(cfg.url) || str(cfg.serverUrl);
    return {
      id: "",
      name,
      transport: url ? "http" : "stdio",
      command: str(cfg.command),
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: dict(cfg.env),
      url,
      headers: dict(cfg.headers),
      enabled: cfg.disabled !== true,
    } as db.McpServer;
  });
}

type TestState = { busy: boolean; tools?: db.McpTool[]; error?: string };

export function McpSettings() {
  const [servers, setServers] = useState<db.McpServer[]>([]);
  /** Row being edited ("" = new server). */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState | undefined>>({});
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);

  const reload = useCallback(() => {
    void db.listMcpServers().then(setServers).catch((e) => setError(String(e)));
  }, []);
  useEffect(reload, [reload]);

  const close = () => {
    setEditing(null);
    setDraft(null);
    setError(null);
    setShowSecrets(false);
  };

  const test = async (key: string, server: db.McpServer) => {
    setTests((t) => ({ ...t, [key]: { busy: true } }));
    try {
      const tools = await db.testMcpServer(server);
      setTests((t) => ({ ...t, [key]: { busy: false, tools } }));
    } catch (e) {
      setTests((t) => ({ ...t, [key]: { busy: false, error: String(e) } }));
    }
  };

  const save = async () => {
    if (!draft) return;
    setError(null);
    try {
      await db.saveMcpServer(fromDraft(draft));
      close();
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const importPasted = async () => {
    setError(null);
    try {
      const list = parseMcpJson(paste);
      for (const s of list) await db.saveMcpServer(s);
      setPasting(false);
      setPaste("");
      reload();
    } catch (e) {
      setError(`Could not import: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const toggle = async (s: db.McpServer, on: boolean) => {
    setServers((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled: on } : x)));
    try {
      await db.saveMcpServer({ ...s, enabled: on });
    } catch (e) {
      setError(String(e));
      reload();
    }
  };

  const testView = (key: string) => {
    const t = tests[key];
    if (!t) return null;
    if (t.busy)
      return (
        <div className="flex items-center gap-2 px-1.5 pb-2 text-[12px] text-[var(--text-dim)]">
          <LoaderCircle size={12} className="animate-spin" /> Starting the server and listing its tools… (the first start of an npx/uvx
          server can take a minute)
        </div>
      );
    if (t.error)
      return (
        <div className="mx-1.5 mb-2 whitespace-pre-wrap rounded-md border border-[var(--diff-del)]/40 bg-[var(--diff-del)]/10 px-3 py-2 font-mono text-[11.5px] text-[var(--diff-del)]">
          {t.error}
        </div>
      );
    return (
      <div className="mx-1.5 mb-2 rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-[12px] text-[var(--diff-add)]">
          <Check size={12} /> Connected — {t.tools?.length ?? 0} tools
        </div>
        <div className="flex max-h-[180px] flex-col gap-0.5 overflow-auto">
          {t.tools?.map((tool) => (
            <div key={tool.name} className="flex gap-2 text-[11.5px]">
              <span className="shrink-0 font-mono text-[var(--text-main)]">{tool.name}</span>
              {tool.readOnly && <span className="shrink-0 text-[10px] text-[var(--text-dim)]">read-only</span>}
              <span className="min-w-0 truncate text-[var(--text-dim)]">{tool.description}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const secretInput = (value: string, onChange: (v: string) => void, placeholder: string) => (
    <div className="relative">
      <textarea
        className={TEXTAREA + (showSecrets ? "" : " [-webkit-text-security:disc]")}
        rows={3}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="absolute right-2 top-2 text-[var(--text-dim)] hover:text-[var(--text-main)]"
        title={showSecrets ? "Hide values" : "Show values"}
        onClick={() => setShowSecrets((v) => !v)}
      >
        {showSecrets ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
    </div>
  );

  const editor = draft && (
    <div className="flex flex-col gap-2.5 px-1.5 pb-2 pt-1">
      <div className="grid grid-cols-[1fr_auto] items-end gap-2.5">
        <label className={LABEL}>
          Name (tools appear as mcp__name__tool)
          <input
            className={`${SINPUT} w-full`}
            value={draft.name}
            placeholder="github"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            autoFocus={draft.id === ""}
          />
        </label>
        <Segmented
          options={["stdio", "http"]}
          value={draft.transport}
          onChange={(v) => setDraft({ ...draft, transport: v as Draft["transport"] })}
        />
      </div>
      {draft.transport === "stdio" ? (
        <>
          <div className="grid grid-cols-[200px_1fr] gap-2.5">
            <label className={LABEL}>
              Command
              <input className={`${SINPUT} w-full font-mono`} value={draft.command} placeholder="npx" onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
            </label>
            <label className={LABEL}>
              Arguments — one per line
              <textarea
                className={TEXTAREA}
                rows={3}
                value={draft.args}
                placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\me\\notes"}
                spellCheck={false}
                onChange={(e) => setDraft({ ...draft, args: e.target.value })}
              />
            </label>
          </div>
          <label className={LABEL}>
            Environment — KEY=value per line (stored encrypted)
            {secretInput(draft.env, (env) => setDraft({ ...draft, env }), "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_…")}
          </label>
        </>
      ) : (
        <>
          <label className={LABEL}>
            URL (Streamable HTTP endpoint)
            <input className={`${SINPUT} w-full font-mono`} value={draft.url} placeholder="https://example.com/mcp" onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
          </label>
          <label className={LABEL}>
            Headers — Name: value per line (stored encrypted)
            {secretInput(draft.headers, (headers) => setDraft({ ...draft, headers }), "Authorization: Bearer …")}
          </label>
        </>
      )}
      {testView("draft")}
      <div className="flex items-center gap-2">
        <button className={SBUTTON} onClick={() => void test("draft", { ...fromDraft(draft), id: "" })}>
          <PlayCircle size={13} className="mr-1" /> Test
        </button>
        <span className="flex-1" />
        <button className={SBUTTON} onClick={close}>
          <X size={13} className="mr-1" /> Cancel
        </button>
        <button
          className="flex h-9 items-center rounded-md bg-[var(--accent)] px-3 text-[12px] text-white transition-colors hover:bg-[var(--accent-hover)]"
          onClick={() => void save()}
        >
          <Save size={13} className="mr-1.5" /> Save server
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <SettingsCard>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-[var(--text-main)]">MCP servers</div>
            <div className="mt-0.5 text-[12px] text-[var(--text-dim)]">
              Their tools join the agent's own. Tools that change things ask for approval unless the project runs commands without
              asking.
            </div>
          </div>
          <button className={SBUTTON} onClick={() => setPasting((v) => !v)} title="Paste an mcpServers JSON config">
            <ClipboardPaste size={13} className="mr-1" /> Paste JSON
          </button>
          <button
            className={SBUTTON}
            onClick={() => {
              setEditing("");
              setError(null);
              setDraft({ ...EMPTY });
              setTests((t) => ({ ...t, draft: undefined }));
            }}
          >
            <Plus size={13} className="mr-1" /> Add server
          </button>
        </div>

        {pasting && (
          <div className="flex flex-col gap-2">
            <textarea
              className={TEXTAREA}
              rows={8}
              value={paste}
              spellCheck={false}
              autoFocus
              placeholder={`{\n  "mcpServers": {\n    "github": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-github"],\n      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "…" }\n    }\n  }\n}`}
              onChange={(e) => setPaste(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button className={SBUTTON} onClick={() => setPasting(false)}>
                Cancel
              </button>
              <button
                className="flex h-9 items-center rounded-md bg-[var(--accent)] px-3 text-[12px] text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
                disabled={!paste.trim()}
                onClick={() => void importPasted()}
              >
                Import
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-[var(--diff-del)]/40 bg-[var(--diff-del)]/10 px-3 py-2 text-[12px] text-[var(--diff-del)]">
            {error}
          </div>
        )}

        {editing === "" && editor}

        {servers.length === 0 && editing !== "" && (
          <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-center text-[12px] text-[var(--text-dim)]">
            No MCP servers yet — add one or paste a config.
          </div>
        )}

        {servers.map((s, i) => (
          <div key={s.id} className="flex flex-col">
            {i > 0 && <Sep />}
            {confirmDel === s.id ? (
              <div className="flex items-center gap-2 rounded-lg border border-[var(--diff-del)]/40 bg-[var(--diff-del)]/10 px-2.5 py-1.5 text-[12.5px] text-[var(--text-main)]">
                <span className="min-w-0 flex-1 truncate">Remove the MCP server “{s.name}”?</span>
                <button
                  className="shrink-0 rounded-md bg-[var(--diff-del)] px-2.5 py-1 text-[11px] font-medium text-white"
                  onClick={async () => {
                    await db.deleteMcpServer(s.id).catch((e) => setError(String(e)));
                    setConfirmDel(null);
                    if (editing === s.id) close();
                    reload();
                  }}
                >
                  Remove
                </button>
                <button className="shrink-0 rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--hover-bg)]" onClick={() => setConfirmDel(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div
                className="group flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-2 transition-colors hover:bg-[var(--hover-bg)]"
                onClick={() => {
                  if (editing === s.id) return close();
                  setError(null);
                  setEditing(s.id);
                  setDraft(toDraft(s));
                  setTests((t) => ({ ...t, draft: undefined }));
                }}
              >
                <Plug size={14} className={s.enabled ? "shrink-0 text-[var(--accent)]" : "shrink-0 text-[var(--text-dim)]"} />
                <span className="shrink-0 text-[13px] font-medium text-[var(--text-main)]">{s.name}</span>
                <span className="shrink-0 rounded border border-[var(--border)] px-1.5 text-[10px] uppercase text-[var(--text-dim)]">{s.transport}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--text-dim)]">
                  {s.transport === "http" ? s.url : [s.command, ...s.args].join(" ")}
                </span>
                <button
                  className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-[var(--text-dim)] opacity-0 transition-all hover:bg-[var(--bg-input)] hover:text-[var(--text-main)] group-hover:opacity-100"
                  title="Start the server and list its tools"
                  onClick={(e) => {
                    e.stopPropagation();
                    void test(s.id, s);
                  }}
                >
                  <PlayCircle size={12} /> Test
                </button>
                <span onClick={(e) => e.stopPropagation()}>
                  <Switch on={s.enabled} onChange={(on) => void toggle(s, on)} ariaLabel="enable MCP server" />
                </span>
                <button
                  className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-dim)] opacity-0 transition-all hover:bg-[var(--diff-del)]/15 hover:text-[var(--diff-del)] group-hover:opacity-100"
                  title="Remove server"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDel(s.id);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            )}
            {testView(s.id)}
            {editing === s.id && editor}
          </div>
        ))}
      </SettingsCard>
    </div>
  );
}
