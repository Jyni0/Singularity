import { useMemo, useState } from "react";
import { CalendarClock, Save } from "lucide-react";
import type { Model, Project, Provider, ScheduledTask } from "../core/types.i";
import { NO_PROJECT } from "../core/types.i";
import type { ScheduleKind } from "../utils/cron.u";
import { WEEKDAYS, cronError, describeSchedule, nextRun, presetCron, presetFields } from "../utils/cron.u";
import { Modal, Combobox, FIELD_LABEL, Input, TextArea, Button, Alert, Segmented, cx, input } from "../components";

const KINDS: Array<{ id: ScheduleKind; label: string }> = [
  { id: "hourly", label: "Every hour" },
  { id: "daily", label: "Every day" },
  { id: "weekly", label: "Every week" },
  { id: "cron", label: "Custom (cron)" },
];

/** Monday-first order for the weekday picker; values stay cron numbers (0 = Sunday). */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/**
 * Create / edit a scheduled task: name, model, project (required),
 * schedule (hourly / daily at a time / weekly on a day at a time / cron)
 * and the prompt the agent receives on every run.
 */
export function ScheduleModal({
  task,
  projects,
  providers,
  models,
  defaultModel,
  onSave,
  onClose,
}: {
  /** Undefined = create. */
  task?: ScheduledTask;
  projects: Project[];
  providers: Provider[];
  models: Model[];
  /** Pre-selected model for a new task (the prompt box's current pick). */
  defaultModel: { gatewayId: string; modelId: string } | null;
  onSave: (task: ScheduledTask) => Promise<void>;
  onClose: () => void;
}) {
  const preset = task && task.kind !== "cron" ? presetFields(task.schedule) : { time: "09:00", weekday: 1 };
  const [name, setName] = useState(task?.name ?? "");
  const [modelKey, setModelKey] = useState(
    task ? `${task.provider_id}::${task.model_id}` : defaultModel ? `${defaultModel.gatewayId}::${defaultModel.modelId}` : ""
  );
  const realProjects = projects.filter((p) => p.name !== NO_PROJECT);
  const [project, setProject] = useState(task?.project ?? (realProjects.length === 1 ? realProjects[0].name : ""));
  const [kind, setKind] = useState<ScheduleKind>(task?.kind ?? "daily");
  const [time, setTime] = useState(preset.time);
  const [weekday, setWeekday] = useState(preset.weekday);
  const [cron, setCron] = useState(task?.kind === "cron" ? task.schedule : "0 9 * * 1-5");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const modelOptions = useMemo(
    () =>
      models
        .filter((m) => m.enabled && providers.some((p) => p.id === m.provider_id && p.enabled))
        .map((m) => ({
          value: `${m.provider_id}::${m.model_id}`,
          label: m.name || m.model_id,
          hint: providers.find((p) => p.id === m.provider_id)?.name,
        })),
    [models, providers]
  );

  const schedule = kind === "cron" ? cron.trim() : presetCron(kind, time, weekday);
  const scheduleError = kind === "cron" ? cronError(schedule) : null;
  const upcoming = (() => {
    if (scheduleError) return null;
    try {
      return nextRun(schedule, new Date());
    } catch {
      return null;
    }
  })();

  const save = async () => {
    setError(null);
    if (!name.trim()) return setError("Give the task a name.");
    if (!modelKey) return setError("Pick the model that runs the task.");
    if (!project) return setError("Pick a project — scheduled chats are created inside it.");
    if (scheduleError) return setError(scheduleError);
    if (!upcoming) return setError("This schedule never fires.");
    if (!prompt.trim()) return setError("Write the prompt the agent should run.");
    const [provider_id, model_id] = modelKey.split("::");
    setBusy(true);
    try {
      await onSave({
        id: task?.id ?? `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: name.trim(),
        project,
        provider_id,
        model_id,
        kind,
        schedule,
        prompt: prompt.trim(),
        enabled: task?.enabled ?? true,
        last_run_at: task?.last_run_at ?? null,
        armed_at: task?.armed_at ?? 0,
        last_conv: task?.last_conv ?? "",
        created_at: task?.created_at ?? Math.floor(Date.now() / 1000),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={task ? "Edit Scheduled Task" : "Schedule Task"} onClose={onClose} width={560} overflowVisible>
      <div>
        <label className={FIELD_LABEL}>Name</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly code review" autoFocus />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={FIELD_LABEL}>Model</label>
          {modelOptions.length === 0 ? (
            <div className="flex h-9 items-center rounded-lg border border-dashed border-[var(--border)] px-2.5 text-[11.5px] text-[var(--text-muted)]">
              No models — add one in Settings → Models
            </div>
          ) : (
            <Combobox value={modelKey} onChange={setModelKey} placeholder="Pick a model" emptyText="No model matches" options={modelOptions} />
          )}
        </div>
        <div>
          <label className={FIELD_LABEL}>Project (required)</label>
          {realProjects.length === 0 ? (
            <div className="flex h-9 items-center rounded-lg border border-dashed border-[var(--border)] px-2.5 text-[11.5px] text-[var(--text-muted)]">
              No projects — create one first (File → New Project)
            </div>
          ) : (
            <Combobox
              value={project}
              onChange={setProject}
              placeholder="Pick a project"
              emptyText="No project matches"
              options={realProjects.map((p) => ({ value: p.name, label: p.name, hint: p.path || undefined }))}
            />
          )}
        </div>
      </div>

      <div>
        <label className={FIELD_LABEL}>Runs</label>
        <Segmented fill options={KINDS.map((k) => ({ value: k.id, label: k.label }))} value={kind} onChange={setKind} />
        <div className="mt-2 flex items-center gap-2">
          {kind === "weekly" && (
            <select
              className={cx(input(), "w-[150px]")}
              value={weekday}
              onChange={(e) => setWeekday(Number(e.target.value))}
            >
              {WEEK_ORDER.map((d) => (
                <option key={d} value={d}>
                  {WEEKDAYS[d]}
                </option>
              ))}
            </select>
          )}
          {(kind === "daily" || kind === "weekly") && (
            <Input type="time" className="w-[120px]" value={time} onChange={(e) => setTime(e.target.value || "09:00")} />
          )}
          {kind === "cron" && (
            <Input
              className="font-mono"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="minute hour day month weekday — e.g. 0 9 * * 1-5"
              spellCheck={false}
            />
          )}
          {kind === "hourly" && <span className="text-[12px] text-[var(--text-muted)]">At the start of every hour</span>}
        </div>
        <div className="mt-1.5 text-[11px] text-[var(--text-dim)]">
          {scheduleError
            ? <span className="text-[var(--diff-del)]">{scheduleError}</span>
            : upcoming
              ? `${describeSchedule(kind, schedule)} · next run ${upcoming.toLocaleString()}`
              : "This schedule never fires"}
        </div>
      </div>

      <div>
        <label className={FIELD_LABEL}>Prompt</label>
        <TextArea
          className="h-32 resize-none text-[12.5px]"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Review yesterday's commits on main and list anything risky."
        />
      </div>

      {error && (
        <Alert>{error}</Alert>
      )}

      <div className="mt-2 flex justify-end gap-2">
        <Button
          variant="secondary"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={busy}
        >
          {task ? <Save size={14} /> : <CalendarClock size={14} />}
          {task ? "Save" : "Schedule"}
        </Button>
      </div>
    </Modal>
  );
}
