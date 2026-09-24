/**
 * The custom tray menu — rendered inside its own popup window.
 *
 * Shows the app version, the agents running right now (live, pushed by Rust)
 * and the two real actions: bring the window back, or quit the process.
 * Styled standalone: this popup has no parent document to inherit tokens from,
 * so it carries its own little dark theme.
 */
import { useEffect, useState } from "react";
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

  const row =
    "flex w-full items-center gap-2 rounded-lg px-2.5 py-[7px] text-left text-[12.5px] text-[#E4E4E7] transition-colors hover:bg-white/[0.08]";

  return (
    <div className="flex h-screen select-none flex-col overflow-hidden rounded-xl border border-white/10 bg-[#1b1b1f]/95 p-1.5 shadow-[0_14px_40px_rgba(0,0,0,0.55)] backdrop-blur-xl">
      {/* Header: name + version */}
      <div className="flex items-baseline justify-between px-2.5 pb-1.5 pt-1">
        <span className="text-[13px] font-semibold text-[#F4F4F5]">Singularity</span>
        <span className="font-mono text-[11px] text-[#71717A]">v{state.version || "—"}</span>
      </div>

      <div className="mx-2 border-t border-white/[0.07]" />

      {/* Live agents — the honest answer to "is it still working?" */}
      <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
        {state.runs.length === 0 ? (
          <div className="px-2.5 py-1 text-[12px] text-[#71717A]">No agents running</div>
        ) : (
          <>
            <div className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-[#71717A]">
              Running · {state.runs.length}
            </div>
            {state.runs.map((r) => (
              <div key={r.run_id} className="flex items-center gap-2 rounded-lg px-2.5 py-[6px]">
                <CircleDot size={12} className="shrink-0 text-[#34D399]" />
                <span className="min-w-0 flex-1 truncate text-[12px] text-[#A1A1AA]" title={r.label}>
                  {r.label}
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="mx-2 border-t border-white/[0.07]" />

      {/* Actions */}
      <div className="flex flex-col py-1.5">
        <button className={row} onClick={() => action("show")}>
          <Monitor size={14} className="shrink-0 text-[#A1A1AA]" />
          Show window
        </button>
        <button className={`${row} hover:bg-[#E81123]/20 hover:text-[#FF8A80]`} onClick={() => action("quit")}>
          <Power size={14} className="shrink-0" />
          Quit Singularity
        </button>
      </div>
    </div>
  );
}
