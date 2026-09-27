---
name: mcp-builder
description: "Build an MCP (Model Context Protocol) server that gives agents tools for an API or service — TypeScript or Python."
---
# Steps
1. Design the tools around what an agent needs to accomplish, not a 1:1 mirror of every API endpoint. Few, well-named tools (`search_issues`, `create_issue`) with clear descriptions and typed input schemas.
2. Pick the SDK: TypeScript `@modelcontextprotocol/sdk` (with zod schemas) or Python `mcp` (FastMCP). Check the current SDK docs/version first (docs plugin or web_fetch).
3. Transport: stdio for local tools; Streamable HTTP for hosted ones. Never write logs to stdout on stdio servers — use stderr.
4. Tool results: concise, structured text; paginate large lists; include ids the agent needs for follow-up calls; actionable error messages ("repo not found — check owner/name").
5. Mark read-only tools with annotations (readOnlyHint) and destructive ones (destructiveHint).
6. Secrets come from env vars, never from tool arguments or code.
7. Test: run it with the MCP Inspector (`npx @modelcontextprotocol/inspector`) or add it in Settings → MCP Servers and call each tool.
