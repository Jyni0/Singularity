/**
 * "Not read yet" divider: the chat moved on with another provider's model,
 * and the named CLI sessions have not seen the messages below. Each gets a
 * summary of them (and of the files changed) on its next turn.
 */
import { EyeOff } from "lucide-react";
import { CLI_LABEL, type UnseenMark } from "../hooks/useUnseenMarks.h";

export function UnseenDivider({ marks }: { marks: UnseenMark[] }) {
  const names = marks.map((m) => `${CLI_LABEL[m.kind] ?? m.kind}${m.model && m.model !== "default" ? ` · ${m.model}` : ""}`);
  return (
    <div
      className="flex items-center gap-2 text-[11px] text-[var(--text-dim)]"
      title="These sessions get a summary of the messages below (and of the changed files) on their next turn"
    >
      <span className="h-px flex-1 bg-[var(--border)]" />
      <EyeOff size={11} className="shrink-0" />
      <span className="truncate">Not read yet by {names.join(", ")}</span>
      <span className="h-px flex-1 bg-[var(--border)]" />
    </div>
  );
}
