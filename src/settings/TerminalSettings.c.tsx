import { useEffect, useState } from "react";
import * as db from "../core/db.r";
import { Switch } from "../ui/Switch.c";
import { Segmented, SettingRow, SettingsCard, Sep } from "./SettingsParts.c";
import {
  TERMINAL_THEMES,
  TERMINAL_THEME_NAMES,
  DEFAULT_TERMINAL_THEME,
  terminalTheme,
} from "../ui/TerminalTheme.s";

/**
 * Settings → Terminal (SSH Client mode): the appearance and behaviour of
 * the PTY console. Every value is persisted to SQLite (ssh_* settings) and
 * applied live — an already-open terminal picks the theme up on remount,
 * new pages immediately. Same SettingRow/SettingsCard anatomy as the rest
 * of the modal, and the same shared Switch component.
 */
export function TerminalSettings() {
  const [themeName, setThemeName] = useState(DEFAULT_TERMINAL_THEME);
  const [fontSize, setFontSize] = useState(13);
  const [fontFamily, setFontFamily] = useState(
    "Cascadia Mono, Consolas, 'Courier New', monospace"
  );
  const [scrollback, setScrollback] = useState(5000);
  const [cursorBlink, setCursorBlink] = useState(true);
  const [termType, setTermType] = useState("xterm-256color");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [th, fs, ff, sb, cb, tt] = await Promise.all([
        db.getSetting("ssh_theme"),
        db.getSetting("ssh_font_size"),
        db.getSetting("ssh_font_family"),
        db.getSetting("ssh_scrollback"),
        db.getSetting("ssh_cursor_blink"),
        db.getSetting("ssh_term"),
      ]);
      if (cancelled) return;
      if (th && TERMINAL_THEMES[th]) setThemeName(th);
      if (fs) setFontSize(Number(fs) || 13);
      if (ff) setFontFamily(ff);
      if (sb) setScrollback(Number(sb) || 5000);
      if (cb !== null) setCursorBlink(cb === "1");
      if (tt) setTermType(tt);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = (key: string, value: string) => {
    void db.setSetting(key, value);
  };

  const theme = terminalTheme(themeName);

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard>
        <SettingRow title="Theme" hint="Color palette of the SSH console">
          <select
            className="h-[30px] rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 text-[12px] text-[var(--text-main)] outline-none focus:border-[var(--accent)]"
            value={themeName}
            onChange={(e) => {
              setThemeName(e.target.value);
              persist("ssh_theme", e.target.value);
            }}
          >
            {TERMINAL_THEME_NAMES.map((n) => (
              <option key={n} value={n}>
                {n.charAt(0).toUpperCase() + n.slice(1)}
              </option>
            ))}
          </select>
        </SettingRow>
        <Sep />
        {/* Live palette preview — 8 swatches of the picked theme */}
        <div
          className="flex items-center gap-1 rounded-lg px-3 py-2.5"
          style={{ background: theme.background }}
        >
          {([
            theme.red,
            theme.green,
            theme.yellow,
            theme.blue,
            theme.magenta,
            theme.cyan,
            theme.white,
            theme.foreground,
          ] as (string | undefined)[]).map((c, i) => (
            <span
              key={i}
              className="h-4 w-4 rounded-full"
              style={{ background: c ?? "transparent" }}
            />
          ))}
          <span
            className="ml-2 font-mono text-[11px]"
            style={{ color: theme.foreground }}
          >
            user@host: ~$
          </span>
        </div>
      </SettingsCard>

      <SettingsCard>
        <SettingRow title="Font size" hint="Console text size in px">
          <Segmented
            options={["11", "12", "13", "14", "16"]}
            value={String(fontSize)}
            onChange={(v) => {
              setFontSize(Number(v));
              persist("ssh_font_size", v);
            }}
          />
        </SettingRow>
        <Sep />
        <SettingRow title="Font family" hint="Monospace font of the console">
          <select
            className="h-[30px] rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 text-[12px] text-[var(--text-main)] outline-none focus:border-[var(--accent)]"
            value={fontFamily}
            onChange={(e) => {
              setFontFamily(e.target.value);
              persist("ssh_font_family", e.target.value);
            }}
          >
            {[
              "Cascadia Mono, Consolas, 'Courier New', monospace",
              "Consolas, 'Courier New', monospace",
              "'JetBrains Mono', 'Fira Code', monospace",
              "'Courier New', monospace",
            ].map((f) => (
              <option key={f} value={f}>
                {f.split(",")[0].replace(/'/g, "")}
              </option>
            ))}
          </select>
        </SettingRow>
        <Sep />
        <SettingRow title="Cursor blink" hint="Animate the terminal cursor">
          <Switch
            on={cursorBlink}
            onChange={(v) => {
              setCursorBlink(v);
              persist("ssh_cursor_blink", v ? "1" : "0");
            }}
          />
        </SettingRow>
        <Sep />
        <SettingRow title="Scrollback" hint="Lines kept in history">
          <select
            className="h-[30px] rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 text-[12px] text-[var(--text-main)] outline-none focus:border-[var(--accent)]"
            value={String(scrollback)}
            onChange={(e) => {
              setScrollback(Number(e.target.value));
              persist("ssh_scrollback", e.target.value);
            }}
          >
            {[1000, 5000, 10000, 50000].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()} lines
              </option>
            ))}
          </select>
        </SettingRow>
        <Sep />
        <SettingRow title="Terminal type" hint="$TERM sent to the server">
          <select
            className="h-[30px] rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 text-[12px] text-[var(--text-main)] outline-none focus:border-[var(--accent)]"
            value={termType}
            onChange={(e) => {
              setTermType(e.target.value);
              persist("ssh_term", e.target.value);
            }}
          >
            {["xterm-256color", "xterm", "screen-256color", "vt100"].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingsCard>
    </div>
  );
}
