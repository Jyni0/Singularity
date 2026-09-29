import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowDownToLine, ExternalLink } from "lucide-react";
import * as db from "../core/db.r";
import type { UpdateInfo } from "../core/db.r";
import { Button, Spinner } from "../components";

/** Re-check GitHub this often while the app stays open. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

const CHECK_EVENT = "singularity:check-update";

/** Help → Check for Updates: re-checks now and shows the result in the title bar. */
export function requestUpdateCheck() {
  window.dispatchEvent(new Event(CHECK_EVENT));
}

/**
 * Title-bar pill that appears only when GitHub Releases has a newer version.
 * Click → details popover → "Install" downloads the installer for this OS,
 * starts it and closes the app.
 */
export function UpdateButton() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  /** Result of a manual check, shown briefly when there is nothing to install. */
  const [status, setStatus] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const check = () =>
      db
        .checkForUpdate()
        .then(setUpdate)
        .catch(() => {
          /* offline / rate-limited — try again next round */
        });
    void check();
    const id = setInterval(check, CHECK_EVERY_MS);
    let hide: ReturnType<typeof setTimeout> | undefined;
    const manual = async () => {
      clearTimeout(hide);
      setStatus("Checking for updates…");
      try {
        const found = await db.checkForUpdate();
        setUpdate(found);
        if (found) {
          setStatus(null);
          setOpen(true);
          return;
        }
        setStatus("You're on the latest version");
      } catch (e) {
        setStatus("Update check failed: " + (e instanceof Error ? e.message : String(e)));
      }
      hide = setTimeout(() => setStatus(null), 4000);
    };
    window.addEventListener(CHECK_EVENT, manual);
    return () => {
      clearInterval(id);
      clearTimeout(hide);
      window.removeEventListener(CHECK_EVENT, manual);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!update) {
    return status ? (
      <div className="flex h-full items-center pr-2 text-[12px] text-[var(--text-muted)]">{status}</div>
    ) : null;
  }
  const installing = progress !== null;

  const install = async () => {
    setError("");
    setProgress(0);
    try {
      await db.installUpdate((done, total) => setProgress(total ? done / total : 0));
    } catch (e) {
      setProgress(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div ref={boxRef} className="relative flex h-full items-center pr-1.5">
      <button
        className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)]/15 px-2.5 py-1 text-[12px] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/25"
        onClick={() => setOpen((o) => !o)}
        title={`Singularity ${update.version} is available`}
      >
        {installing ? (
          <>
            <Spinner size={13} />
            {Math.round((progress ?? 0) * 100)}%
          </>
        ) : (
          <>
            <ArrowDownToLine size={13} />
            Update
          </>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute right-0 top-[calc(100%+4px)] z-[300] flex w-[320px] flex-col gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-3 shadow-[var(--shadow-popup)]"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
          >
            <div>
              <div className="text-[13px] font-semibold text-[var(--text-main)]">{update.title}</div>
              <div className="text-[11px] text-[var(--text-dim)]">
                {update.current} → {update.version} · {update.asset} · {mb(update.size)}
              </div>
            </div>
            {update.notes.trim() && (
              <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--bg-input)] p-2 text-[12px] text-[var(--text-muted)]">
                {update.notes.trim()}
              </div>
            )}
            {installing && (
              <div className="h-1 overflow-hidden rounded-md bg-[var(--bg-input)]">
                <div
                  className="h-full bg-[var(--accent)] transition-[width]"
                  style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
                />
              </div>
            )}
            {error && <div className="text-[12px] text-[var(--diff-del)]">{error}</div>}
            <div className="flex items-center justify-between gap-2">
              <a
                className="flex items-center gap-1 text-[12px] text-[var(--text-dim)] transition-colors hover:text-[var(--text-main)]"
                href={update.page}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={12} /> Release page
              </a>
              <Button
                variant="primary" size="sm"
                disabled={installing}
                onClick={() => void install()}
              >
                {installing ? "Downloading…" : "Install update"}
              </Button>
            </div>
            <div className="text-[11px] text-[var(--text-dim)]">
              The app closes while the installer runs.
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
