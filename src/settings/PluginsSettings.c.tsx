/**
 * Settings → Plugins: everything the agent can do. Built-in tool groups
 * switch on/off; add-ons (ready-made MCP servers) install with one click.
 */
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  FileCode2,
  GitBranch,
  Globe,
  Puzzle,
  RefreshCw,
  Search,
  Sparkles,
  Server,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import * as db from "../core/db.r";
import { BUILTIN_PLUGINS, loadDisabledTools, saveDisabledTools } from "../core/plugins.u";
import { ADDON_CATEGORIES, ADDON_PLUGINS, addonServer, addonServerId, addonValues, type AddonPlugin } from "../core/addons.u";
import { Switch, Segmented, SettingsCard, Button, IconButton, Input, SECTION_HEADING, Spinner } from "../components";

const ICONS: Record<string, React.ReactNode> = {
  files: <FileCode2 size={15} />,
  terminal: <SquareTerminal size={15} />,
  git: <GitBranch size={15} />,
  web: <Globe size={15} />,
  ssh: <Server size={15} />,
};

function PluginIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--bg-elevated)] text-[var(--text-muted)]">
      {children}
    </span>
  );
}

type AddonState = { kind: "idle" } | { kind: "busy"; text: string } | { kind: "ok"; text: string } | { kind: "err"; text: string };

/** Rows from before local installs started through npx / uvx — they fail on Windows. */
const isLegacy = (s: db.McpServer) => /^(npx|uvx)(\.cmd|\.exe)?$/i.test(s.command.trim());

function AddonCard({ plugin, server, onChanged }: { plugin: AddonPlugin; server: db.McpServer | undefined; onChanged: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [state, setState] = useState<AddonState>({ kind: "idle" });
  const busy = state.kind === "busy";
  const missing = (plugin.fields ?? []).some((f) => !(values[f.key] ?? "").trim());
  const legacy = server && isLegacy(server);

  /** Installs (or reinstalls with the values already saved), then starts it once to check. */
  const install = async (vals: Record<string, string>, enabled = true) => {
    try {
      let launch: { command: string; args: string[] } | undefined;
      if (plugin.install.type === "npm") {
        setState({ kind: "busy", text: `Installing ${plugin.install.package} — the first time takes a minute…` });
        launch = await db.pluginInstall(plugin.id, plugin.install.package);
      }
      const row = { ...addonServer(plugin, vals, launch), enabled };
      await db.saveMcpServer(row);
      onChanged();
      setState({ kind: "busy", text: "Starting it to check…" });
      const tools = await db.testMcpServer(row);
      setState({ kind: "ok", text: `Ready — ${tools.length} tools` });
    } catch (e) {
      setState({ kind: "err", text: String(e) });
    }
  };

  return (
    <SettingsCard>
      <div className="flex items-start gap-3">
        <PluginIcon>
          <Puzzle size={15} />
        </PluginIcon>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px] text-[var(--text-main)]">
            {plugin.title}
            {server && <span className="rounded-md bg-[var(--bg-elevated)] px-1.5 py-[1px] text-[10px] text-[var(--accent)]">installed</span>}
          </div>
          <div className="mt-0.5 text-[12px] text-[var(--text-dim)]">{plugin.description}</div>
          <div className="mt-1 text-[11px] text-[var(--text-dim)]">
            <span className="rounded-md bg-[var(--bg-elevated)] px-1.5 py-[1px]">{plugin.category}</span>
            <span className="ml-2">
              {plugin.install.type === "http" ? "Hosted — nothing to install" : `Needs Node.js${plugin.needs ? ` + ${plugin.needs}` : ""}`}
              {plugin.install.type === "http" && plugin.needs ? ` · needs ${plugin.needs}` : ""}
            </span>
          </div>
        </div>
        {server ? (
          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              label={plugin.install.type === "npm" ? "Reinstall / update" : "Check again"}
              disabled={busy}
              onClick={() => void install(addonValues(plugin, server), server.enabled)}
            >
              {busy ? <Spinner size={13} /> : <RefreshCw size={13} />}
            </IconButton>
            <IconButton
              className="hover:!text-[var(--diff-del)]"
              label="Remove"
              disabled={busy}
              onClick={() =>
                void db.deleteMcpServer(server.id).then(() => {
                  setState({ kind: "idle" });
                  onChanged();
                })
              }
            >
              <Trash2 size={13} />
            </IconButton>
            <span className="ml-1">
              <Switch
                on={server.enabled}
                onChange={(next) => void db.saveMcpServer({ ...server, enabled: next }).then(onChanged)}
                ariaLabel={`toggle ${plugin.title}`}
              />
            </span>
          </div>
        ) : (
          <Button className="h-8 gap-1.5" disabled={missing || busy} onClick={() => void install(values)}>
            {busy ? <Spinner size={13} /> : <Download size={13} />}
            Install
          </Button>
        )}
      </div>
      {!server &&
        (plugin.fields ?? []).map((f) => (
          <label key={f.key} className="ml-11 flex items-center gap-3 text-[12px] text-[var(--text-muted)]">
            <span className="w-[140px] shrink-0">{f.label}</span>
            <Input className="w-auto flex-1 font-mono"
              type={f.secret ? "password" : "text"}
              autoComplete="off"
              placeholder={f.placeholder}
              value={values[f.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          </label>
        ))}
      {legacy && state.kind === "idle" && (
        <div className="ml-11 flex items-center gap-2 text-[11.5px] text-[#f59e0b]">
          <AlertTriangle size={12} className="shrink-0" />
          <span className="flex-1">Installed the old way (npx), which fails on Windows.</span>
          <Button className="h-7 gap-1.5" onClick={() => void install(addonValues(plugin, server), server.enabled)}>
            <RefreshCw size={12} />
            Reinstall
          </Button>
        </div>
      )}
      {state.kind !== "idle" && (
        <div
          className={`ml-11 flex items-start gap-1.5 text-[11.5px] ${
            state.kind === "err" ? "text-[var(--diff-del)]" : state.kind === "ok" ? "text-[var(--text-main)]" : "text-[var(--text-dim)]"
          }`}
        >
          {state.kind === "ok" ? (
            <Check size={12} className="mt-[2px] shrink-0" />
          ) : state.kind === "err" ? (
            <AlertTriangle size={12} className="mt-[2px] shrink-0" />
          ) : (
            <Spinner size={12} className="mt-[2px]" />
          )}
          <span className="min-w-0 whitespace-pre-wrap break-words">{state.text}</span>
        </div>
      )}
    </SettingsCard>
  );
}

type Tab = "Discover" | "Installed" | "Built-in";

/** Installs an add-on without fields (the "recommended" set). */
async function setupAddon(plugin: AddonPlugin) {
  const launch = plugin.install.type === "npm" ? await db.pluginInstall(plugin.id, plugin.install.package) : undefined;
  await db.saveMcpServer(addonServer(plugin, {}, launch));
}

export function PluginsSettings() {
  const [tab, setTab] = useState<Tab>("Discover");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [disabled, setDisabled] = useState<string[]>(loadDisabledTools);
  const [servers, setServers] = useState<db.McpServer[]>([]);
  const [bulk, setBulk] = useState<string | null>(null);

  const reload = useCallback(() => {
    void db.listMcpServers().then(setServers).catch(() => {});
  }, []);
  useEffect(reload, [reload]);

  const toggle = (tools: string[], on: boolean) => {
    const next = on ? disabled.filter((t) => !tools.includes(t)) : [...disabled, ...tools];
    setDisabled(next);
    saveDisabledTools(next);
  };

  const serverOf = (p: AddonPlugin) => servers.find((s) => s.id === addonServerId(p.id));
  const installed = ADDON_PLUGINS.filter((p) => serverOf(p));
  const missingRecommended = ADDON_PLUGINS.filter((p) => p.recommended && !serverOf(p));

  const installRecommended = async () => {
    const failed: string[] = [];
    for (const p of missingRecommended) {
      setBulk(`Installing ${p.title}…`);
      try {
        await setupAddon(p);
      } catch {
        failed.push(p.title);
      }
      reload();
    }
    setBulk(failed.length ? `Could not install: ${failed.join(", ")} — open them below for the error.` : null);
  };

  const q = query.trim().toLowerCase();
  const matches = (p: AddonPlugin) =>
    (!category || p.category === category) &&
    (!q || `${p.title} ${p.description} ${p.category}`.toLowerCase().includes(q));
  const list = (tab === "Installed" ? installed : ADDON_PLUGINS).filter(matches);
  const groups = (category ? [category] : ADDON_CATEGORIES)
    .map((c) => [c, list.filter((p) => p.category === c)] as const)
    .filter(([, items]) => items.length > 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Segmented options={["Discover", `Installed`, "Built-in"]} value={tab} onChange={(v) => setTab(v as Tab)} />
        <span className="text-[11.5px] text-[var(--text-dim)]">
          {installed.length} installed · {ADDON_PLUGINS.length} available
        </span>
      </div>

      {tab === "Built-in" ? (
        BUILTIN_PLUGINS.map((p) => {
          const on = !p.tools.some((t) => disabled.includes(t));
          return (
            <SettingsCard key={p.id}>
              <div className="flex items-start gap-3">
                <PluginIcon>{ICONS[p.id]}</PluginIcon>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-[var(--text-main)]">{p.title}</div>
                  <div className="mt-0.5 text-[12px] text-[var(--text-dim)]">{p.description}</div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {p.tools.map((t) => (
                      <span key={t} className="rounded-md bg-[var(--bg-elevated)] px-1.5 py-[1px] font-mono text-[10.5px] text-[var(--text-dim)]">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
                {p.core ? (
                  <span className="shrink-0 text-[11px] text-[var(--text-dim)]">always on</span>
                ) : (
                  <Switch on={on} onChange={(next) => toggle(p.tools, next)} ariaLabel={`toggle ${p.title}`} />
                )}
              </div>
            </SettingsCard>
          );
        })
      ) : (
        <>
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-dim)]" />
            <Input className="pl-8"
              placeholder="Search plugins…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {[null, ...ADDON_CATEGORIES].map((c) => (
              <Button
                key={c ?? "all"}
                size="xs"
                variant={category === c ? "primary" : "secondary"}
                className="rounded-full font-normal"
                onClick={() => setCategory(c)}
              >
                {c ?? "All"}
              </Button>
            ))}
          </div>

          {tab === "Discover" && missingRecommended.length > 0 && !q && !category && (
            <SettingsCard>
              <div className="flex items-center gap-3">
                <PluginIcon>
                  <Sparkles size={15} />
                </PluginIcon>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-[var(--text-main)]">Recommended set</div>
                  <div className="mt-0.5 text-[12px] text-[var(--text-dim)]">
                    {missingRecommended.map((p) => p.title).join(", ")} — no keys needed.
                  </div>
                  {bulk && <div className="mt-1 text-[11.5px] text-[var(--text-muted)]">{bulk}</div>}
                </div>
                <Button className="h-8 gap-1.5" disabled={bulk !== null && bulk.endsWith("…")} onClick={() => void installRecommended()}>
                  {bulk?.endsWith("…") ? <Spinner size={13} /> : <Download size={13} />}
                  Install all
                </Button>
              </div>
            </SettingsCard>
          )}

          {groups.length === 0 && (
            <div className="rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-center text-[12px] text-[var(--text-dim)]">
              {tab === "Installed" && installed.length === 0 ? "Nothing installed yet — see Discover." : "No plugins match."}
            </div>
          )}
          {groups.map(([cat, items]) => (
            <div key={cat} className="flex flex-col gap-3">
              <div className={`${SECTION_HEADING} mt-2`}>{cat}</div>
              {items.map((p) => (
                <AddonCard key={p.id} plugin={p} server={serverOf(p)} onChanged={reload} />
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
