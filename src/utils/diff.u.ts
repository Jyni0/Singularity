/**
 * Minimal line diff for the Changes panel.
 *
 * LCS over lines is O(n·m), which is fine for source files; the inputs are
 * capped upstream (tool snapshots stop at 200KB). Context lines are collapsed
 * into hunks so a 3000-line file with a two-line edit renders compactly.
 */

export type DiffLine =
  | { kind: "add"; text: string; newNo: number }
  | { kind: "del"; text: string; oldNo: number }
  | { kind: "ctx"; text: string; oldNo: number; newNo: number }
  | { kind: "hunk"; text: string };

/** Lines added / removed between two texts (the common head and tail are
 *  skipped first, so a small edit of a big file stays cheap). */
export function diffStat(oldText: string, newText: string): { added: number; removed: number } {
  if (oldText === newText) return { added: 0, removed: 0 };
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  if (x.length === 0 || y.length === 0 || x.length * y.length > 4_000_000) return { added: y.length, removed: x.length };
  // LCS length, two rows.
  let prev = new Uint32Array(y.length + 1);
  let cur = new Uint32Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  const same = prev[y.length];
  return { added: y.length - same, removed: x.length - same };
}

export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");

  // LCS length table.
  const n = a.length;
  const m = b.length;
  // Guard against pathological inputs (the byte cap upstream keeps this rare).
  if (n * m > 40_000_000) {
    const fallback: DiffLine[] = [
      { kind: "hunk", text: "@@ file too large to diff — showing raw content @@" },
    ];
    b.forEach((text, i) => fallback.push({ kind: "add", text, newNo: i + 1 }));
    return fallback;
  }

  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Walk the table to produce the change list.
  const raw: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ kind: "ctx", text: a[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ kind: "del", text: a[i], oldNo: i + 1 });
      i++;
    } else {
      raw.push({ kind: "add", text: b[j], newNo: j + 1 });
      j++;
    }
  }
  while (i < n) {
    raw.push({ kind: "del", text: a[i], oldNo: i + 1 });
    i++;
  }
  while (j < m) {
    raw.push({ kind: "add", text: b[j], newNo: j + 1 });
    j++;
  }

  // Collapse unchanged runs longer than CONTEXT*2 into hunk headers.
  const CONTEXT = 3;
  const out: DiffLine[] = [];
  let k = 0;
  while (k < raw.length) {
    const line = raw[k];
    if (line.kind !== "ctx") {
      out.push(line);
      k++;
      continue;
    }
    // Find the length of this unchanged run.
    let runEnd = k;
    while (runEnd < raw.length && raw[runEnd].kind === "ctx") runEnd++;
    const runLen = runEnd - k;
    const atStart = k === 0;
    const atEnd = runEnd === raw.length;
    if (runLen > CONTEXT * 2 || (atStart && runLen > CONTEXT) || (atEnd && runLen > CONTEXT)) {
      // Keep CONTEXT lines around the change, collapse the middle.
      const head = atStart ? 0 : CONTEXT;
      const tail = atEnd ? 0 : CONTEXT;
      for (let x = 0; x < head; x++) out.push(raw[k + x]);
      const skip = runLen - head - tail;
      if (skip > 0) {
        const first = raw[k + head];
        const oldNo = first.kind === "ctx" ? first.oldNo : 0;
        const newNo = first.kind === "ctx" ? first.newNo : 0;
        out.push({ kind: "hunk", text: `@@ -${oldNo} +${newNo} — ${skip} unchanged lines @@` });
      }
      for (let x = runLen - tail; x < runLen; x++) out.push(raw[k + x]);
    } else {
      for (let x = 0; x < runLen; x++) out.push(raw[k + x]);
    }
    k = runEnd;
  }
  return out;
}
