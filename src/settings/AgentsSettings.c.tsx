/**
 * Settings → Agent: user-defined helper agents (subagents) and how many may
 * work at once. Helpers are optional — the main agent decides on its own
 * which part of a prompt (if any) to hand to which helper, through its
 * `delegate` tool. Everything here is persisted in the settings table.
 */
import { useState } from "react";
import { Bot, Plus, Trash2 } from "lucide-react";
import * as db from "../core/db.r";
import { Switch, SettingRow, SettingsCard, Sep, Button, Input, TextArea, IconButton } from "../components";

export function AgentsSettings({
  subagents,
  onChange,
  maxRetries,
  onMaxRetries,
}: {
  subagents: db.Subagent[];
  onChange: (next: db.Subagent[]) => void;
  maxRetries: number;
  onMaxRetries: (n: number) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  const update = (id: string, patch: Partial<db.Subagent>) =>
    onChange(subagents.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const add = () => {
    const id = "sa-" + Date.now().toString(36);
    onChange([
      ...subagents,
      { id, name: `Helper ${subagents.length + 1}`, description: "", prompt: "", enabled: true },
    ]);
    setOpenId(id);
  };

  return (
    <div className="flex flex-col gap-3">
      <SettingsCard>
        <SettingRow
          title="Max retry attempts"
          hint="When the API fails (502, 429, broken JSON, cut connection) the request is sent again every 5s, up to this many times. 0 = never retry."
        >
          <Input
            type="number"
            min={0}
            max={20} className="w-[90px]"
            value={maxRetries}
            onChange={(e) => {
              const n = Math.min(20, Math.max(0, Math.floor(Number(e.target.value) || 0)));
              onMaxRetries(n);
            }}
          />
        </SettingRow>
        <Sep />
        <div className="text-[12px] text-[var(--text-dim)]">
          How many agents may work at once is set per provider (Settings → Models → the provider → Max agents), and a model can override it. The default is 1:
          the agent works alone and opens no extra sessions. Subscription CLIs always use one agent and one session per chat.
        </div>
      </SettingsCard>

      <SettingsCard>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-[var(--text-main)]">Subagents</div>
            <div className="mt-0.5 text-[12px] text-[var(--text-dim)]">
              Optional helpers. The agent reads each description and decides which task, if any, to give them.
            </div>
          </div>
          <Button onClick={add}>
            <Plus size={13} className="mr-1" /> Add subagent
          </Button>
        </div>

        {subagents.length === 0 && (
          <div className="rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-center text-[12px] text-[var(--text-dim)]">
            No subagents yet — the agent works alone.
          </div>
        )}

        {subagents.map((s, i) => {
          const open = openId === s.id;
          return (
            <div key={s.id} className="flex flex-col">
              {i > 0 && <Sep />}
              <div
                className="group flex cursor-pointer items-center gap-2 rounded-xl px-1.5 py-2 transition-colors hover:bg-[var(--hover-bg)]"
                onClick={() => setOpenId(open ? null : s.id)}
              >
                <Bot size={14} className={s.enabled ? "text-[var(--accent)]" : "text-[var(--text-dim)]"} />
                <span className="min-w-0 shrink-0 text-[13px] font-medium text-[var(--text-main)]">{s.name || "Unnamed"}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-dim)]">
                  {s.description || "No description"}
                </span>
                <span onClick={(e) => e.stopPropagation()}>
                  <Switch on={s.enabled} onChange={(on) => update(s.id, { enabled: on })} ariaLabel="enable subagent" />
                </span>
                <IconButton
                  label="Delete subagent" size="xs" tone="danger" reveal
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(subagents.filter((x) => x.id !== s.id));
                  }}
                >
                  <Trash2 size={12} />
                </IconButton>
              </div>
              {open && (
                <div className="flex flex-col gap-2.5 px-1.5 pb-2 pt-1">
                  <label className="flex flex-col gap-1 text-[11px] text-[var(--text-dim)]">
                    Name
                    <Input
                      value={s.name}
                      placeholder="e.g. Tester"
                      onChange={(e) => update(s.id, { name: e.target.value.replace(/[^\p{L}\p{N} _-]/gu, "") })}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-[var(--text-dim)]">
                    When to use it (shown to the main agent)
                    <Input
                      value={s.description}
                      placeholder="e.g. Writes and runs unit tests for changed code"
                      onChange={(e) => update(s.id, { description: e.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-[var(--text-dim)]">
                    Prompt (the subagent's own instructions)
                    <TextArea
                      rows={6}
                      value={s.prompt}
                      placeholder="You are a testing specialist. Prefer small focused tests…"
                      onChange={(e) => update(s.id, { prompt: e.target.value })}
                    />
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </SettingsCard>
    </div>
  );
}
