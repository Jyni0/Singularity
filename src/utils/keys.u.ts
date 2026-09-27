/**
 * Layout-independent key of a shortcut press.
 *
 * `e.key` is the character of the ACTIVE keyboard layout — with Russian
 * active Ctrl+N arrives as "т" and no binding matched. `e.code` names the
 * physical key ("KeyN", "Digit1", "Comma"), the same on every layout, so
 * shortcuts are matched on it and mapped back to the US label.
 * Returns an uppercase letter / digit / punctuation, or `e.key` for
 * everything else (F11, Escape, Enter…).
 */
export function shortcutKey(e: KeyboardEvent | { key: string; code: string }): string {
  const code = e.code ?? "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  const punct = PUNCT[code];
  if (punct) return punct;
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

const PUNCT: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
};
