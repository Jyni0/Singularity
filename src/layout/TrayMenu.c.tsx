/**
 * The custom tray menu — rendered inside its own popup window.
 *
 * Compact by design: the window hugs the content, and its height follows the
 * number of running agents (measured here, applied in Rust via `tray_resize`,
 * which keeps the popup anchored to the tray icon).
 *
 * Shows the app version, the agents running right now (live, pushed by Rust)
 * and the two real actions: bring the window back, or quit the process.
 * Styled standalone: this popup has no parent document to inherit tokens from,
 * so it carries its own little dark theme.
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Monitor, Power, CircleDot } from "lucide-react";

interface RunRow {
  run_id: string;
  label: string;
}

interface TrayState {
  version: string;
  runs: RunRow[];
}

const action = (name: "show" | "quit" | "close") => void invoke("tray_action", { action: name });

export function TrayMenu() {
  const [state, setState] = useState<TrayState>({ version: "", runs: [] });
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let off: (() => void) | undefined;
    void invoke<TrayState>("tray_state").then(setState).catch(() => {});
    void listen<TrayState>("tray://state", (e) => setState(e.payload)).then((fn) => {
      off = fn;
    });
    // A popup that lost focus is a popup the user clicked away from.
    const onBlur = () => action("close");
    // Escape closes it too, like any context menu.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") action("close");
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKey);
    return () => {
      off?.();
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Fit the window to the card after every state change (an agent starting or
  // finishing while the menu is open re-shrinks/grows it on the spot).
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const fit = () => {
      void invoke("tray_resize", { height: Math.ceil(el.getBoundingClientRect().height) }).catch(() => {});
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [state]);

  const row =
    "flex w-full items-center gap-1.5 rounded-md px-2 py-[5px] text-left text-[12px] text-[#E4E4E7] transition-colors hover:bg-white/[0.08]";

  return (
    <div ref={cardRef} className="m-[6px] flex w-auto flex-col overflow-hidden rounded-lg border border-white/10 bg-[#1b1b1f]/95 p-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-xl">
      {/* Header: name + version on one tight line */}
      <div className="flex items-baseline justify-between px-2 pb-1 pt-0.5">
        <span className="text-[12px] font-semibold text-[#F4F4F5]">Singularity</span>
        <span className="font-mono text-[10px] text-[#71717A]">v{state.version || "—"}</span>
      </div>

      <div className="mx-1.5 border-t border-white/[0.07]" />

      {/* Live agents — one compact row each; scrolls past four. */}
      <div className="max-h-[124px] overflow-y-auto py-1">
        {state.runs.length === 0 ? (
          <div className="px-2 text-[11px] leading-[22px] text-[#71717A]">No agents running</div>
        ) : (
          <>
            <div className="px-2 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-[#71717A]">
              Running · {state.runs.length}
            </div>
            {state.runs.map((r) => (
              <div key={r.run_id} className="flex items-center gap-1.5 px-2 py-[3px]">
                <CircleDot size={11} className="shrink-0 text-[#34D399]" />
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-[#A1A1AA]" title={r.label}>
                  {r.label}
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="mx-1.5 border-t border-white/[0.07]" />

      {/* Actions */}
      <div className="flex flex-col py-1">
        <button className={row} onClick={() => action("show")}>
          <Monitor size={13} className="shrink-0 text-[#A1A1AA]" />
          Show window
        </button>
        <button className={`${row} hover:bg-[#E81123]/20 hover:text-[#FF8A80]`} onClick={() => action("quit")}>
          <Power size={13} className="shrink-0" />
          Quit Singularity
        </button>
      </div>
    </div>
  );
}
