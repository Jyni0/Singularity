/**
 * Copying the path of a file the agent read or changed — from a tool row in
 * the chat and from the side panel's tab header. Relative paths (as the
 * model wrote them) are joined onto the chat's workspace, so what lands in
 * the clipboard opens anywhere.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** The workspace of the chat on screen (set by the App). */
export const WorkspaceContext = createContext("");

/** `src/a.ts` + `C:\proj` → `C:\proj\src\a.ts`; absolute paths stay. */
export function absolutePath(path: string, workspace: string): string {
  const p = path.trim();
  if (!workspace || /^([a-zA-Z]:[\\/]|[\\/]|~)/.test(p)) return p;
  const win = /^[a-zA-Z]:/.test(workspace) || workspace.includes("\\");
  const sep = win ? "\\" : "/";
  const rel = p.replace(/^\.[\\/]/, "").replace(/[\\/]/g, sep);
  return rel === "." || rel === "" ? workspace : workspace.replace(/[\\/]+$/, "") + sep + rel;
}

/** System clipboard through the Tauri plugin; the WebView API as fallback. */
export function copyText(text: string): Promise<void> {
  return writeText(text).catch(() => navigator.clipboard?.writeText(text));
}

/** Small copy button; shows a check for a moment after copying. */
export function CopyPathButton({ path, className = "" }: { path: string; className?: string }) {
  const workspace = useContext(WorkspaceContext);
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const full = absolutePath(path, workspace);
  return (
    <button
      type="button"
      className={`shrink-0 rounded-md p-0.5 text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)] ${className}`}
      title={`Copy path: ${full}`}
      aria-label="Copy path"
      onClick={(e) => {
        e.stopPropagation();
        void copyText(full).then(() => {
          setDone(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <Check size={12} className="text-[var(--accent)]" /> : <Copy size={12} />}
    </button>
  );
}
