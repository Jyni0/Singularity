/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week), local
 * time — enough for Scheduled Tasks. Supports `*`, lists `1,5`, ranges
 * `1-5`, steps `*\/15` / `0-30/10`, and `7` as Sunday in day-of-week.
 */

export type ScheduleKind = "hourly" | "daily" | "weekly" | "cron";

interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Both day fields restricted → a day matches when EITHER does (POSIX). */
  domStar: boolean;
  dowStar: boolean;
}

const FIELDS: Array<[string, number, number]> = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day of month", 1, 31],
  ["month", 1, 12],
  ["day of week", 0, 7],
];

function parseField(src: string, [label, min, max]: [string, number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`Bad ${label} "${part}"`);
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      lo = a;
      hi = b ?? (m[2] ? max : a);
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`${label} out of range in "${part}" (${min}-${max})`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron needs 5 fields: minute hour day month weekday");
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domStar: parts[2] === "*", dowStar: parts[4] === "*" };
}

/** Error text for an invalid expression, or null when it parses. */
export function cronError(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dow;
  if (c.dowStar) return dom;
  return dom || dow;
}

/** First matching minute strictly after `after` (within ~4 years), or null. */
export function nextRun(expr: string, after: Date): Date | null {
  const c = parseCron(expr);
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after.getTime() + 4 * 366 * 24 * 3600 * 1000;
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  return null;
}

/* ---------- Presets <-> cron ---------- */

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "HH:MM" → [h, m]; falls back to 09:00. */
function hm(time: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return [9, 0];
  return [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))];
}

export function presetCron(kind: Exclude<ScheduleKind, "cron">, time: string, weekday: number): string {
  if (kind === "hourly") return "0 * * * *";
  const [h, m] = hm(time);
  return kind === "daily" ? `${m} ${h} * * *` : `${m} ${h} * * ${weekday}`;
}

/** Reads the editor fields back out of a stored preset expression. */
export function presetFields(expr: string): { time: string; weekday: number } {
  const [m, h, , , dow] = expr.trim().split(/\s+/);
  const num = (x: string | undefined, d: number) => (x && /^\d+$/.test(x) ? Number(x) : d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { time: `${pad(num(h, 9))}:${pad(num(m, 0))}`, weekday: num(dow, 1) % 7 };
}

/** Human summary for the task list. */
export function describeSchedule(kind: ScheduleKind, expr: string): string {
  if (kind === "hourly") return "Every hour";
  const { time, weekday } = presetFields(expr);
  if (kind === "daily") return `Every day at ${time}`;
  if (kind === "weekly") return `Every ${WEEKDAYS[weekday]} at ${time}`;
  return `Cron: ${expr}`;
}
