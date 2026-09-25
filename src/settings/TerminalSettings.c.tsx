import { useEffect, useState } from "react";
import * as db from "../core/db.r";
import { Switch } from "../ui/Switch.c";
import { Combobox } from "../ui/Combobox.c";
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
          <div className="w-[240px]">
            <Combobox
              searchable={false}
              value={themeName}
              onChange={(v) => {
                setThemeName(v);
                persist("ssh_theme", v);
              }}
              options={TERMINAL_THEME_NAMES.map((n) => ({
                value: n,
                label: n.charAt(0).toUpperCase() + n.slice(1),
                swatch: [terminalTheme(n).background ?? "#000", terminalTheme(n).blue ?? "#38f", terminalTheme(n).foreground ?? "#fff"],
              }))}
            />
          </div>
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
          <div className="w-[240px]">
            <Combobox
              searchable={false}
              value={fontFamily}
              onChange={(v) => {
                setFontFamily(v);
                persist("ssh_font_family", v);
              }}
              options={[
                "Cascadia Mono, Consolas, 'Courier New', monospace",
                "Consolas, 'Courier New', monospace",
                "'JetBrains Mono', 'Fira Code', monospace",
                "'Courier New', monospace",
              ].map((f) => ({ value: f, label: f.split(",")[0].replace(/'/g, "") }))}
            />
          </div>
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
          <div className="w-[240px]">
            <Combobox
              searchable={false}
              value={String(scrollback)}
              onChange={(v) => {
                setScrollback(Number(v));
                persist("ssh_scrollback", v);
              }}
              options={[1000, 5000, 10000, 50000].map((n) => ({
                value: String(n),
                label: n.toLocaleString() + " lines",
              }))}
            />
          </div>
        </SettingRow>
        <Sep />
        <SettingRow title="Terminal type" hint="$TERM sent to the server">
          <div className="w-[240px]">
            <Combobox
              searchable={false}
              value={termType}
              onChange={(v) => {
                setTermType(v);
                persist("ssh_term", v);
              }}
              options={["xterm-256color", "xterm", "screen-256color", "vt100"].map((t) => ({
                value: t,
                label: t,
              }))}
            />
          </div>
        </SettingRow>
      </SettingsCard>
    </div>
  );
}
