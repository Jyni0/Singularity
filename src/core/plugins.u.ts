/**
 * Plugins: what the agent can do, in one place.
 *
 *  * Built-in plugins are groups of the agent's own tools (terminal, git,
 *    web, images) that can be switched off — the tools then leave the request
 *    (and stop costing context).
 *  * Add-ons (ready-made MCP servers) live in addons.u.ts.
 */

export interface BuiltinPlugin {
  id: string;
  title: string;
  description: string;
  /** Tool names this plugin adds to the agent. */
  tools: string[];
  /** Cannot be switched off. */
  core?: boolean;
}

export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  {
    id: "files",
    title: "Files",
    description: "Read, search, edit and create files in the project. Every edit is syntax-checked.",
    tools: ["read_file", "apply_patch", "write_file", "list_dir", "grep", "find_files", "file_op", "change_dir"],
    core: true,
  },
  {
    id: "terminal",
    title: "Terminal & background tasks",
    description: "Run builds, tests and package managers; dev servers and watchers keep running in the background.",
    tools: ["run_command", "background"],
  },
  {
    id: "git",
    title: "Git",
    description: "Status, diffs, history, commits and branches through git.",
    tools: ["git"],
  },
  {
    id: "web",
    title: "Web",
    description: "Search the internet and read pages as clean text — docs, changelogs, error messages.",
    tools: ["web_search", "web_fetch"],
  },
  {
    id: "images",
    title: "Image generation",
    description: "Draw pictures on request — Google (Antigravity / Gemini), OpenAI API image models, Imagen, Flux… Claude and Codex chats borrow a provider that can draw. Shown right in the chat.",
    tools: ["generate_image"],
  },
];

const DISABLED_KEY = "disabled_tools";

/** Tool names switched off in Settings → Plugins. */
export function loadDisabledTools(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISABLED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveDisabledTools(tools: string[]) {
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify([...new Set(tools)]));
  } catch {
    /* storage unavailable — the default (everything on) stays */
  }
}
