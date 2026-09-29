
import { Spinner } from "../components";/**
 * A /compact summary in the transcript: a divider that says the history
 * above was compacted, with the summary itself folded underneath. The model
 * sees this summary instead of everything above it.
 */
import { useState } from "react";
import { ChevronRight, Minimize2 } from "lucide-react";
import { Markdown } from "./Markdown.c";

export function CompactNote({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-[11.5px] text-[var(--text-dim)]">
        <span className="h-px flex-1 bg-[var(--border)]" />
        <button
          className="flex items-center gap-1.5 rounded-lg px-2 py-0.5 transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-muted)]"
          onClick={() => setOpen(!open)}
          title="The model sees this summary instead of the messages above"
        >
          {live ? <Spinner size={12} className="text-[var(--accent)]" /> : <Minimize2 size={12} />}
          <span>{live ? "Compacting the conversation…" : "Conversation compacted — the summary replaces the messages above"}</span>
          <ChevronRight size={12} className={`transition-transform ${open || live ? "rotate-90" : ""}`} />
        </button>
        <span className="h-px flex-1 bg-[var(--border)]" />
      </div>
      {(open || live) && text && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2 text-[12.5px]">
          <Markdown text={text} />
        </div>
      )}
    </div>
  );
}
