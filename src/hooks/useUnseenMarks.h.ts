/**
 * Which subscription CLI sessions of a chat have not read which messages.
 *
 * A chat keeps one CLI session per provider. When the chat moves on with
 * another provider's model, the earlier session falls behind; on its next
 * turn it is told what it missed. This hook asks the backend how far each
 * live session has read and returns, per message index, the sessions whose
 * unread part starts there — the chat draws a divider at that spot.
 */
import { useEffect, useMemo, useState } from "react";
import * as db from "../core/db.r";
import type { Msg } from "../chat/message.i";
import { modelTurnsOf } from "./useChat.h";

/** A session that has not read the chat from some message on. */
export interface UnseenMark {
  kind: string;
  model: string;
}

/** Provider names as the model picker shows them. */
export const CLI_LABEL: Record<string, string> = {
  "anthropic-cli": "Claude Code",
  "openai-cli": "Codex",
  "google-cli": "Antigravity",
};

export function useUnseenMarks(convId: string | undefined, msgs: Msg[], busy: boolean): Map<number, UnseenMark[]> {
  const [sessions, setSessions] = useState<db.CliChatSession[]>([]);
  // Re-read when the chat changes and whenever a run of it ends (a run moves
  // its session's mark; the backend leaves a busy session out).
  useEffect(() => {
    if (!convId || busy) return;
    let alive = true;
    void db.cliChatSessions(convId).then((s) => alive && setSessions(s));
    return () => {
      alive = false;
    };
  }, [convId, busy, msgs.length]);
  useEffect(() => setSessions([]), [convId]);

  return useMemo(() => {
    const marks = new Map<number, UnseenMark[]>();
    if (!sessions.length) return marks;
    const { turns, source } = modelTurnsOf(msgs);
    for (const s of sessions) {
      // Its own answers right after its mark are not news to it.
      let k = s.read;
      while (k < turns.length && turns[k].role === "agent" && turns[k].by?.startsWith(`${s.kind}:`)) k++;
      if (k >= turns.length) continue;
      const at = source[k];
      marks.set(at, [...(marks.get(at) ?? []), { kind: s.kind, model: s.model }]);
    }
    return marks;
  }, [sessions, msgs]);
}
