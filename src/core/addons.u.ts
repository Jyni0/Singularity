/**
 * Add-ons (Settings → Plugins): ready-made MCP servers installed with one
 * click — a browser the agent drives, library docs, GitHub, databases…
 *
 * npm packages are installed into the app's own folder and started with
 * node (plugins.rs) — `npx` kept failing on Windows after the download.
 * Hosted servers are plain HTTP, nothing to install. Either way the result
 * is an ordinary MCP server under a fixed id, so Settings → MCP Servers
 * lists it too.
 */
import type { McpServer } from "./db.r";

export interface AddonField {
  key: string;
  label: string;
  placeholder: string;
  /** Where the value goes: environment variable, extra argument, HTTP header. */
  kind: "env" | "arg" | "header";
  /** Prepended to the value ("Bearer "). */
  prefix?: string;
  secret?: boolean;
}

export type AddonInstall =
  /** npm package, installed locally and started as `node <bin> ...args`. */
  | { type: "npm"; package: string; args?: string[] }
  /** Hosted server — nothing to install. */
  | { type: "http"; url: string };

export interface AddonPlugin {
  id: string;
  title: string;
  description: string;
  category: string;
  /** What it needs besides the app (shown on the card). */
  needs?: string;
  install: AddonInstall;
  fields?: AddonField[];
  /** Part of the "Install recommended" set — no keys needed. */
  recommended?: boolean;
}

export const ADDON_CATEGORIES = [
  "Development",
  "Languages & frameworks",
  "Knowledge & docs",
  "Database",
  "Browser & web",
  "Security",
  "Deployment & DevOps",
  "Monitoring",
  "Design",
  "Productivity",
  "Thinking & memory",
];

const npm = (pkg: string, args?: string[]): AddonInstall => ({ type: "npm", package: pkg, args });
const http = (url: string): AddonInstall => ({ type: "http", url });
const key = (k: string, label: string, placeholder: string): AddonField => ({ key: k, label, placeholder, kind: "env", secret: true });

export const ADDON_PLUGINS: AddonPlugin[] = [
  /* ---------- Development ---------- */
  {
    id: "package-versions",
    title: "Package versions",
    description: "Latest versions from npm, PyPI, Maven, Go, Cargo, NuGet, Docker Hub… — no more outdated or made-up dependency versions.",
    category: "Development",
    recommended: true,
    install: npm("mcp-package-version"),
  },
  {
    id: "code-runner",
    title: "Code runner",
    description: "Run snippets in 30+ languages (JS, Python, Go, Rust, C#, PHP, Ruby, Bash…) to check an idea quickly.",
    category: "Development",
    install: npm("mcp-server-code-runner"),
  },
  {
    id: "grep-app",
    title: "grep.app code search",
    description: "Search code across a million public GitHub repositories — real usage examples of any API.",
    category: "Development",
    install: http("https://mcp.grep.app"),
  },
  {
    id: "github",
    title: "GitHub",
    description: "Issues, pull requests, reviews, Actions runs, code search and files across your repositories (official server).",
    category: "Development",
    needs: "A GitHub token",
    install: http("https://api.githubcopilot.com/mcp/"),
    fields: [{ key: "Authorization", label: "Personal access token", placeholder: "github_pat_…", kind: "header", prefix: "Bearer ", secret: true }],
  },
  {
    id: "jetbrains",
    title: "JetBrains IDE",
    description: "Work through a running IntelliJ / WebStorm / PyCharm / Rider: open files, run configurations, inspections.",
    category: "Development",
    needs: "Node.js + a JetBrains IDE with the MCP plugin",
    install: npm("@jetbrains/mcp-proxy"),
  },

  /* ---------- Languages & frameworks ---------- */
  {
    id: "nextjs",
    title: "Next.js DevTools",
    description: "Next.js docs, upgrade codemods, and live errors / routes of your running dev server.",
    category: "Languages & frameworks",
    install: npm("next-devtools-mcp"),
  },
  {
    id: "angular",
    title: "Angular CLI",
    description: "Angular best practices, docs search and examples from the official CLI.",
    category: "Languages & frameworks",
    install: npm("@angular/cli", ["mcp"]),
  },
  {
    id: "svelte",
    title: "Svelte",
    description: "Svelte 5 / SvelteKit docs and an autofixer that checks components.",
    category: "Languages & frameworks",
    install: http("https://mcp.svelte.dev/mcp"),
  },
  {
    id: "astro",
    title: "Astro docs",
    description: "Current Astro documentation, searched by the agent.",
    category: "Languages & frameworks",
    install: http("https://mcp.docs.astro.build/mcp"),
  },
  {
    id: "shadcn",
    title: "shadcn/ui",
    description: "Browse, search and add shadcn/ui components and blocks from registries.",
    category: "Languages & frameworks",
    install: npm("shadcn", ["mcp"]),
  },
  {
    id: "mui",
    title: "Material UI",
    description: "Official MUI docs and component APIs — correct props instead of guessed ones.",
    category: "Languages & frameworks",
    install: npm("@mui/mcp"),
  },
  {
    id: "mslearn",
    title: "Microsoft Learn (.NET, C#, Azure)",
    description: "Official Microsoft docs: .NET, C#, ASP.NET, Azure, Windows, PowerShell, TypeScript.",
    category: "Languages & frameworks",
    install: http("https://learn.microsoft.com/api/mcp"),
  },
  {
    id: "huggingface",
    title: "Hugging Face",
    description: "Find models, datasets, papers and Spaces for ML / Python work.",
    category: "Languages & frameworks",
    install: http("https://huggingface.co/mcp"),
  },

  /* ---------- Knowledge & docs ---------- */
  {
    id: "docs",
    title: "Library docs (Context7)",
    description: "Up-to-date docs and code examples for thousands of libraries, by version — fewer made-up APIs.",
    category: "Knowledge & docs",
    recommended: true,
    install: http("https://mcp.context7.com/mcp"),
  },
  {
    id: "deepwiki",
    title: "DeepWiki",
    description: "Ask about any public GitHub repository: architecture, how a feature works, where code lives.",
    category: "Knowledge & docs",
    recommended: true,
    install: http("https://mcp.deepwiki.com/mcp"),
  },
  {
    id: "gitmcp",
    title: "GitMCP",
    description: "Docs and README of any GitHub project, fetched straight from the repository.",
    category: "Knowledge & docs",
    install: http("https://gitmcp.io/docs"),
  },
  {
    id: "exa",
    title: "Exa code & web search",
    description: "Search tuned for code: API docs, examples and answers from across the web.",
    category: "Knowledge & docs",
    install: http("https://mcp.exa.ai/mcp"),
  },
  {
    id: "cloudflare-docs",
    title: "Cloudflare docs",
    description: "Workers, Pages, R2, D1, KV and the rest of the Cloudflare platform docs.",
    category: "Knowledge & docs",
    install: http("https://docs.mcp.cloudflare.com/mcp"),
  },
  {
    id: "aws-knowledge",
    title: "AWS knowledge",
    description: "AWS documentation, API references, architecture guidance and regional availability.",
    category: "Knowledge & docs",
    install: http("https://knowledge-mcp.global.api.aws"),
  },

  /* ---------- Database ---------- */
  {
    id: "postgres",
    title: "PostgreSQL",
    description: "Inspect schemas and run read-only SQL queries.",
    category: "Database",
    install: npm("@modelcontextprotocol/server-postgres"),
    fields: [{ key: "url", label: "Connection URL", placeholder: "postgresql://user:pass@localhost/db", kind: "arg", secret: true }],
  },
  {
    id: "mysql",
    title: "MySQL / MariaDB",
    description: "Schemas and SQL queries on a MySQL or MariaDB server (read-only by default).",
    category: "Database",
    install: npm("@benborla29/mcp-server-mysql"),
    fields: [
      { key: "MYSQL_HOST", label: "Host", placeholder: "127.0.0.1", kind: "env" },
      { key: "MYSQL_PORT", label: "Port", placeholder: "3306", kind: "env" },
      { key: "MYSQL_USER", label: "User", placeholder: "root", kind: "env" },
      { key: "MYSQL_PASS", label: "Password", placeholder: "••••", kind: "env", secret: true },
      { key: "MYSQL_DB", label: "Database", placeholder: "app", kind: "env" },
    ],
  },
  {
    id: "sqlite",
    title: "SQLite",
    description: "Query and change a local SQLite database file.",
    category: "Database",
    install: npm("@executeautomation/database-server"),
    fields: [{ key: "path", label: "Database file", placeholder: "C:\\data\\app.db", kind: "arg" }],
  },
  {
    id: "mongodb",
    title: "MongoDB",
    description: "Browse collections, run queries and aggregations, inspect indexes.",
    category: "Database",
    install: npm("mongodb-mcp-server"),
    fields: [key("MDB_MCP_CONNECTION_STRING", "Connection string", "mongodb://localhost:27017/db")],
  },
  {
    id: "prisma",
    title: "Prisma",
    description: "Migrations, schema status and Prisma Postgres databases through the Prisma CLI.",
    category: "Database",
    install: npm("prisma", ["mcp"]),
  },
  {
    id: "supabase",
    title: "Supabase",
    description: "Projects, tables, SQL, migrations, edge functions and logs of your Supabase account.",
    category: "Database",
    needs: "Supabase token",
    install: npm("@supabase/mcp-server-supabase"),
    fields: [key("SUPABASE_ACCESS_TOKEN", "Access token", "sbp_…")],
  },
  {
    id: "convex",
    title: "Convex",
    description: "Tables, functions, logs and data of your Convex deployments.",
    category: "Database",
    install: npm("convex", ["mcp", "start"]),
  },
  {
    id: "upstash",
    title: "Upstash (Redis / QStash)",
    description: "Create and manage Upstash Redis databases, run commands, read usage.",
    category: "Database",
    install: npm("@upstash/mcp-server", ["run"]),
    fields: [
      { key: "email", label: "Account email", placeholder: "you@example.com", kind: "arg" },
      { key: "api-key", label: "API key", placeholder: "…", kind: "arg", secret: true },
    ],
  },
  {
    id: "pinecone",
    title: "Pinecone",
    description: "Vector indexes: search docs, create indexes, upsert and query records.",
    category: "Database",
    install: npm("@pinecone-database/mcp"),
    fields: [key("PINECONE_API_KEY", "API key", "pcsk_…")],
  },

  /* ---------- Browser & web ---------- */
  {
    id: "browser",
    title: "Browser (Playwright)",
    description: "A real browser the agent drives: open sites and your dev server, click, fill forms, read the page, take screenshots.",
    category: "Browser & web",
    recommended: true,
    install: npm("@playwright/mcp@latest"),
  },
  {
    id: "chrome-devtools",
    title: "Chrome DevTools",
    description: "Debug web apps in Chrome: console errors, network requests, performance traces, DOM and styles.",
    category: "Browser & web",
    needs: "Chrome",
    install: npm("chrome-devtools-mcp@latest"),
  },
  {
    id: "firecrawl",
    title: "Firecrawl",
    description: "Scrape and crawl whole websites into clean markdown, extract structured data.",
    category: "Browser & web",
    needs: "API key (firecrawl.dev)",
    install: npm("firecrawl-mcp"),
    fields: [key("FIRECRAWL_API_KEY", "API key", "fc-…")],
  },
  {
    id: "tavily",
    title: "Tavily search",
    description: "Search built for AI agents: ranked, summarized results with sources; page extraction.",
    category: "Browser & web",
    needs: "API key (tavily.com, free tier)",
    install: npm("tavily-mcp"),
    fields: [key("TAVILY_API_KEY", "API key", "tvly-…")],
  },
  {
    id: "brave",
    title: "Brave Search",
    description: "Independent web, news, image and video search.",
    category: "Browser & web",
    needs: "API key (brave.com/search/api)",
    install: npm("@brave/brave-search-mcp-server"),
    fields: [key("BRAVE_API_KEY", "API key", "BSA…")],
  },
  {
    id: "perplexity",
    title: "Perplexity",
    description: "Answers with live web research and citations — for questions that need current info.",
    category: "Browser & web",
    needs: "API key (perplexity.ai)",
    install: npm("@perplexity-ai/mcp-server"),
    fields: [key("PERPLEXITY_API_KEY", "API key", "pplx-…")],
  },
  {
    id: "youtube",
    title: "YouTube transcripts",
    description: "Pull the transcript of a YouTube video — talks, tutorials, release streams.",
    category: "Browser & web",
    install: npm("@kimtaeyoon83/mcp-server-youtube-transcript"),
  },

  /* ---------- Security ---------- */
  {
    id: "snyk",
    title: "Snyk",
    description: "Scan code, dependencies, containers and IaC for vulnerabilities and get fixes.",
    category: "Security",
    needs: "Snyk account (run `snyk auth` once)",
    install: npm("snyk", ["mcp", "-t", "stdio"]),
  },

  /* ---------- Deployment & DevOps ---------- */
  {
    id: "docker",
    title: "Docker",
    description: "Containers, images, volumes and compose stacks: list, start, stop, logs.",
    category: "Deployment & DevOps",
    needs: "Docker",
    install: npm("mcp-server-docker"),
  },
  {
    id: "kubernetes",
    title: "Kubernetes",
    description: "Pods, deployments, logs, events and Helm on the clusters of your kubeconfig.",
    category: "Deployment & DevOps",
    needs: "kubectl config",
    install: npm("mcp-server-kubernetes"),
  },
  {
    id: "netlify",
    title: "Netlify",
    description: "Create, deploy and configure Netlify sites, env vars and forms.",
    category: "Deployment & DevOps",
    install: npm("@netlify/mcp"),
    fields: [key("NETLIFY_PERSONAL_ACCESS_TOKEN", "Access token", "nfp_…")],
  },
  {
    id: "heroku",
    title: "Heroku",
    description: "Apps, dynos, add-ons, logs and deploys on Heroku.",
    category: "Deployment & DevOps",
    install: npm("@heroku/mcp-server"),
    fields: [key("HEROKU_API_KEY", "API key", "HRKU-…")],
  },
  {
    id: "azure",
    title: "Azure",
    description: "Azure resources: storage, Cosmos DB, App Service, monitor logs, Key Vault and more.",
    category: "Deployment & DevOps",
    needs: "Azure CLI login",
    install: npm("@azure/mcp", ["server", "start"]),
  },

  /* ---------- Monitoring ---------- */
  {
    id: "sentry",
    title: "Sentry",
    description: "Production errors with stack traces, issues and releases — find and fix what users hit.",
    category: "Monitoring",
    install: npm("@sentry/mcp-server"),
    fields: [key("SENTRY_ACCESS_TOKEN", "Access token", "sntrys_…")],
  },

  /* ---------- Design ---------- */
  {
    id: "figma",
    title: "Figma",
    description: "Read Figma designs — layout, styles, components — to build UIs that match them.",
    category: "Design",
    install: npm("figma-developer-mcp", ["--stdio"]),
    fields: [key("FIGMA_API_KEY", "Access token", "figd_…")],
  },
  {
    id: "mermaid",
    title: "Mermaid diagrams",
    description: "Render flowcharts, sequence and ER diagrams to images from Mermaid code.",
    category: "Design",
    install: npm("mcp-mermaid"),
  },

  /* ---------- Productivity ---------- */
  {
    id: "notion",
    title: "Notion",
    description: "Search, read and update Notion pages and databases — specs, tasks, notes.",
    category: "Productivity",
    install: npm("@notionhq/notion-mcp-server"),
    fields: [key("NOTION_TOKEN", "Integration token", "ntn_…")],
  },
  {
    id: "jira",
    title: "Jira",
    description: "Search, read and comment on Jira issues and projects.",
    category: "Productivity",
    install: npm("@aashari/mcp-server-atlassian-jira"),
    fields: [
      { key: "ATLASSIAN_SITE_NAME", label: "Site name", placeholder: "mycompany (of mycompany.atlassian.net)", kind: "env" },
      { key: "ATLASSIAN_USER_EMAIL", label: "Email", placeholder: "you@example.com", kind: "env" },
      key("ATLASSIAN_API_TOKEN", "API token", "ATATT…"),
    ],
  },
  {
    id: "slack",
    title: "Slack",
    description: "Read channels and threads, post messages and replies.",
    category: "Productivity",
    install: npm("@zencoderai/slack-mcp-server"),
    fields: [key("SLACK_BOT_TOKEN", "Bot token", "xoxb-…"), { key: "SLACK_TEAM_ID", label: "Team ID", placeholder: "T01234567", kind: "env" }],
  },

  /* ---------- Thinking & memory ---------- */
  {
    id: "thinking",
    title: "Sequential thinking",
    description: "A scratchpad for step-by-step reasoning: break a hard problem down, revise steps, branch.",
    category: "Thinking & memory",
    recommended: true,
    install: npm("@modelcontextprotocol/server-sequential-thinking"),
  },
  {
    id: "memory",
    title: "Memory",
    description: "A knowledge graph the agent keeps between chats: facts about you, the project, decisions.",
    category: "Thinking & memory",
    install: npm("@modelcontextprotocol/server-memory"),
  },
];

export const addonServerId = (id: string) => `plugin-${id}`;

/** User-entered values of an installed add-on, read back from its row. */
export function addonValues(p: AddonPlugin, s: McpServer): Record<string, string> {
  const out: Record<string, string> = {};
  const argFields = (p.fields ?? []).filter((f) => f.kind === "arg");
  const tail = argFields.length ? s.args.slice(-argFields.length) : [];
  for (const f of p.fields ?? []) {
    const raw = (f.kind === "env" ? s.env[f.key] : f.kind === "header" ? s.headers[f.key] : tail[argFields.indexOf(f)]) ?? "";
    out[f.key] = f.prefix && raw.startsWith(f.prefix) ? raw.slice(f.prefix.length) : raw;
  }
  return out;
}

/**
 * The MCP server row an add-on installs as. `launch` = how plugins.rs said
 * to start an npm package (node + its bin script).
 */
export function addonServer(p: AddonPlugin, values: Record<string, string>, launch?: { command: string; args: string[] }): McpServer {
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const extra: string[] = [];
  for (const f of p.fields ?? []) {
    const v = (f.prefix ?? "") + (values[f.key] ?? "").trim();
    if (f.kind === "env") env[f.key] = v;
    else if (f.kind === "header") headers[f.key] = v;
    else extra.push(v);
  }
  const base = { id: addonServerId(p.id), name: p.title, env, headers, enabled: true };
  if (p.install.type === "http") {
    return { ...base, transport: "http", command: "", args: [], url: p.install.url };
  }
  return {
    ...base,
    transport: "stdio",
    command: launch?.command ?? "node",
    args: [...(launch?.args ?? []), ...(p.install.args ?? []), ...extra],
    url: "",
  };
}
