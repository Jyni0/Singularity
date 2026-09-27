/**
 * Prompt-box shorthands — pure helpers behind the `/` and `@` menus.
 *
 *  /command  — typed at the start of the prompt: actions (/new, /model…),
 *              prompt templates (/plan, /review…) and skills (/code-review).
 *              Templates and skills are expanded in Rust (agent/expand.rs),
 *              so the chat shows exactly what the user typed.
 *  @mention  — anywhere after a space: a file or folder of the workspace
 *              (`@src/app.ts`, `@"my dir/notes.md"`) or `@git`. The agent
 *              receives their contents with the prompt.
 */

export interface Trigger {
  kind: "slash" | "mention";
  /** Text typed after the `/` or `@` (without an opening quote). */
  query: string;
  /** Range of the whole token in the prompt, `/` or `@` included. */
  start: number;
  end: number;
}

/** The `/` or `@` token the caret is in, if any. */
export function detectTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const slash = /^\s*\/([\w-]*)$/.exec(before);
  if (slash) {
    const tail = /^[\w-]*/.exec(text.slice(caret))?.[0] ?? "";
    return { kind: "slash", query: slash[1], start: caret - slash[1].length - 1, end: caret + tail.length };
  }
  const at = /(^|[\s(])@("[^"]*|[^\s"]*)$/.exec(before);
  if (at) {
    const raw = at[2];
    const quoted = raw.startsWith('"');
    const tail = (quoted ? /^[^"]*"?/ : /^[^\s]*/).exec(text.slice(caret))?.[0] ?? "";
    return {
      kind: "mention",
      query: quoted ? raw.slice(1) : raw,
      start: caret - raw.length - 1,
      end: caret + tail.length,
    };
  }
  return null;
}

/** Replaces the trigger token; returns the new text and caret position. */
export function replaceToken(text: string, t: Trigger, insert: string): { text: string; caret: number } {
  // A space already follows the token — reuse it instead of doubling it.
  let ins = insert;
  let skip = 0;
  if (ins.endsWith(" ") && /^\s/.test(text.slice(t.end))) {
    ins = ins.slice(0, -1);
    skip = 1;
  }
  const next = text.slice(0, t.start) + ins + text.slice(t.end);
  return { text: next, caret: t.start + ins.length + skip };
}

/** `@path` as typed into the prompt; paths with spaces are quoted. `open`
 *  leaves a folder unterminated so the menu keeps listing its children. */
export function mentionText(path: string, open = false): string {
  const quoted = /\s/.test(path);
  if (open) return quoted ? `@"${path}` : `@${path}`;
  return quoted ? `@"${path}" ` : `@${path} `;
}

const baseName = (p: string) => {
  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
};
const depth = (p: string) => (p.endsWith("/") ? p.slice(0, -1) : p).split("/").length - 1;
const dirsFirst = (a: string, b: string) =>
  Number(!a.endsWith("/")) - Number(!b.endsWith("/")) || a.localeCompare(b);

function subsequence(hay: string, needle: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length;
}

/**
 * Workspace entries matching what was typed after `@`, best first.
 *  - nothing typed        → the top level;
 *  - "src/"               → that folder's children;
 *  - anything else        → fuzzy: name prefix, name part, path part, subsequence.
 */
export function rankFiles(files: string[], query: string, limit = 50): string[] {
  const q = query.replace(/\\/g, "/").toLowerCase();
  if (!q) return files.filter((f) => depth(f) === 0).sort(dirsFirst).slice(0, limit);
  if (q.endsWith("/")) {
    const kids = files.filter((f) => f.toLowerCase().startsWith(q) && f.length > q.length && depth(f) === depth(q) + 1);
    if (kids.length > 0) return kids.sort(dirsFirst).slice(0, limit);
  }
  const scored: Array<[number, string]> = [];
  for (const f of files) {
    const lf = f.toLowerCase();
    const base = baseName(lf);
    let score: number;
    if (lf.startsWith(q)) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (base.includes(q)) score = 2;
    else if (lf.includes(q)) score = 3;
    else if (subsequence(lf, q)) score = 4;
    else continue;
    scored.push([score, f]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]));
  return scored.slice(0, limit).map(([, f]) => f);
}

/** Splits a path for display: name + the folder it is in. */
export function splitPath(p: string): { name: string; dir: string } {
  const isDir = p.endsWith("/");
  const trimmed = isDir ? p.slice(0, -1) : p;
  const at = trimmed.lastIndexOf("/");
  return { name: trimmed.slice(at + 1) + (isDir ? "/" : ""), dir: at >= 0 ? trimmed.slice(0, at) : "" };
}
