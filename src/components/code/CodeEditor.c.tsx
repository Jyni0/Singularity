/**
 * CodeMirror 6 editor themed with the app's CSS variables. Uncontrolled:
 * `initial` seeds the document once per `docKey`; every edit is reported
 * through onChange, and Mod-S calls onSave.
 */
import { useEffect, useRef } from "react";
import { shortcutKey } from "../../utils/keys.u";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  highlightSpecialChars,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
  StreamLanguage,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12.5px",
    color: "var(--text-main)",
    backgroundColor: "transparent",
  },
  ".cm-scroller": { fontFamily: "'JetBrains Mono', ui-monospace, monospace", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--accent)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent) !important",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--text-dim)",
    border: "none",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-main)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--hover-bg) 60%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 14%, transparent)" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)", outline: "none" },
  ".cm-panels": { backgroundColor: "var(--bg-surface)", color: "var(--text-main)", borderColor: "var(--border)" },
  ".cm-panels input, .cm-panels button": { fontSize: "12px" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-search": { padding: "6px 8px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px" },
  ".cm-search label": { display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "11.5px", color: "var(--text-muted)" },
  ".cm-search [name=close]": { color: "var(--text-dim)", fontSize: "16px", cursor: "pointer" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, #e5c07b 30%, transparent)", outline: "1px solid color-mix(in srgb, #e5c07b 60%, transparent)" },
  ".cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 45%, transparent)" },
  ".cm-textfield": {
    backgroundColor: "var(--bg-input)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    color: "var(--text-main)",
  },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--hover-bg)", border: "1px solid var(--border)", borderRadius: "4px", color: "var(--text-main)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--hover-bg)", border: "none", color: "var(--text-muted)" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "#c678dd" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#98c379" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#d19a66" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#7f848e", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#61afef" },
  { tag: [t.typeName, t.className, t.namespace], color: "#e5c07b" },
  { tag: [t.propertyName, t.attributeName], color: "#e06c75" },
  { tag: [t.tagName, t.heading], color: "#e06c75", fontWeight: "600" },
  { tag: [t.definition(t.variableName)], color: "#e5c07b" },
  { tag: [t.operator, t.punctuation], color: "#abb2bf" },
  { tag: [t.meta, t.processingInstruction], color: "#56b6c2" },
  { tag: t.link, color: "#61afef", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.invalid, color: "#f44747" },
]);

/** Language support by file name; null = plain text. Loaded lazily. */
async function languageFor(fileName: string): Promise<Extension | null> {
  const name = fileName.toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  // Before the extension switch: "nginx.conf" is nginx, not a generic .conf.
  if (name.startsWith("nginx") || name.endsWith(".nginx") || (ext === "conf" && /sites-|nginx/.test(name)))
    return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/nginx")).nginx);
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "ts":
    case "tsx":
    case "mts":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: ext === "tsx", typescript: true });
    case "py":
      return (await import("@codemirror/lang-python")).python();
    case "json":
    case "jsonc":
      return (await import("@codemirror/lang-json")).json();
    case "html":
    case "htm":
    case "vue":
      return (await import("@codemirror/lang-html")).html();
    case "css":
    case "scss":
    case "less":
      return (await import("@codemirror/lang-css")).css();
    case "md":
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "yml":
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "rs":
      return (await import("@codemirror/lang-rust")).rust();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "xml":
    case "svg":
      return (await import("@codemirror/lang-xml")).xml();
    case "php":
      return (await import("@codemirror/lang-php")).php();
    case "go":
      return (await import("@codemirror/lang-go")).go();
    case "sh":
    case "bash":
    case "zsh":
    case "env":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
    case "toml":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml);
    case "ini":
    case "conf":
    case "cfg":
    case "properties":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/properties")).properties);
    case "lua":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/lua")).lua);
  }
  if (name === "dockerfile" || name.startsWith("dockerfile."))
    return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile);
  if ([".bashrc", ".profile", ".zshrc", ".bash_profile", ".bash_aliases"].includes(name))
    return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
  return null;
}

export function CodeEditor({
  docKey,
  initial,
  fileName,
  onChange,
  onSave,
}: {
  /** A new key replaces the document (and resets undo history). */
  docKey: string;
  initial: string;
  /** Picks the syntax highlighting. */
  fileName: string;
  onChange: (text: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  // Latest callbacks without rebuilding the editor on every render.
  const cbs = useRef({ onChange, onSave });
  cbs.current = { onChange, onSave };

  useEffect(() => {
    if (!host.current) return;
    let cancelled = false;
    const language = new Compartment();
    const base: Extension[] = [
      language.of([]),
      lineNumbers(),
      foldGutter(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      syntaxHighlighting(highlight),
      theme,
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (cbs.current.onSave(), true) },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) cbs.current.onChange(u.state.doc.toString());
      }),
    ];
    const view = new EditorView({ state: EditorState.create({ doc: initial, extensions: base }), parent: host.current });
    view.focus();
    // Ctrl+F anywhere on the page opens this editor's search, even when the
    // focus is on the toolbar; inside the editor its own keymap handles it.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || shortcutKey(e) !== "F") return;
      if (view.dom.contains(document.activeElement)) return;
      e.preventDefault();
      view.focus();
      openSearchPanel(view);
    };
    window.addEventListener("keydown", onKey);
    // Highlighting arrives a moment later; the text is editable right away.
    void languageFor(fileName).then((lang) => {
      if (cancelled || !lang) return;
      view.dispatch({ effects: language.reconfigure(lang) });
    });
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
      view.destroy();
    };
    // Only a new document rebuilds the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
