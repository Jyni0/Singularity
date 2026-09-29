import { useEffect, useState } from "react";
import { Check, Copy, Download, ImageOff } from "lucide-react";
import * as db from "../core/db.r";
import { IconButton, Spinner } from "../components";

/** Data URLs of generated pictures already read, by file path. */
const CACHE = new Map<string, string>();

/**
 * A picture the agent drew (generate_image), shown in the answer itself —
 * never folded into the collapsed action log. Click opens it in the side panel.
 */
export function GeneratedImage({
  path,
  prompt,
  onOpen,
}: {
  path: string;
  prompt: string;
  onOpen?: (image: db.StoredImage) => void;
}) {
  const [src, setSrc] = useState<string | null>(CACHE.get(path) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"copied" | "saved" | null>(null);
  useEffect(() => {
    if (CACHE.has(path)) return;
    let alive = true;
    db.readGeneratedImage(path)
      .then((url) => {
        CACHE.set(path, url);
        if (alive) setSrc(url);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [path]);

  const name = path.split(/[\\/]/).pop() ?? "image.png";
  const flash = (what: "copied" | "saved") => {
    setDone(what);
    setTimeout(() => setDone(null), 1400);
  };
  const copyPath = () =>
    void navigator.clipboard
      .writeText(path)
      .then(() => flash("copied"))
      .catch(() => {});
  const download = async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const ext = name.split(".").pop() ?? "png";
    const dest = await save({ defaultPath: name, filters: [{ name: "Image", extensions: [ext] }] });
    if (!dest) return;
    try {
      await db.saveGeneratedImage(path, dest);
      flash("saved");
    } catch (e) {
      setError(String(e));
    }
  };
  if (error) {
    return (
      <div className="flex w-fit items-center gap-2 rounded-2xl border border-[var(--border)] px-3 py-2 text-[12px] text-[var(--text-dim)]" title={error}>
        <ImageOff size={14} /> The picture is no longer on disk
      </div>
    );
  }
  if (!src) {
    return (
      <div className="flex h-48 w-72 items-center justify-center rounded-2xl bg-[var(--bg-input)]">
        <Spinner size={16} className="text-[var(--text-dim)]" />
      </div>
    );
  }
  return (
    <div className="group relative w-fit">
      <button
        className="block overflow-hidden rounded-2xl border border-[var(--border)] transition-transform hover:scale-[1.01]"
        onClick={() => onOpen?.({ name, mime: src.slice(5, src.indexOf(";")), data_url: src })}
        title={prompt}
      >
        <img src={src} alt={prompt} className="block max-h-[420px] w-auto max-w-full object-contain" />
      </button>
      <div className="absolute right-2 top-2 flex gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <IconButton label={done === "copied" ? "Copied" : "Copy path"} onClick={copyPath}>
          {done === "copied" ? <Check size={14} /> : <Copy size={14} />}
        </IconButton>
        <IconButton label={done === "saved" ? "Saved" : "Download"} onClick={() => void download()}>
          {done === "saved" ? <Check size={14} /> : <Download size={14} />}
        </IconButton>
      </div>
    </div>
  );
}
