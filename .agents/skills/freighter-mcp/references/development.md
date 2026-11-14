# Developing freighter-mcp-server

TypeScript, MCP SDK **v2** (`@modelcontextprotocol/server`), zod 4 (`import * as z from "zod/v4"`), stdio transport. Package: `apps/mcp`.

```
src/index.ts       serveStdio(createServer) — nothing else; stdout is the protocol, log to stderr
src/server.ts      createServer(): a NEW McpServer each call, registers every tool group
src/config.ts      resolveConnection(): FREIGHTER_URL+FREIGHTER_TOKEN, else the CLI's current context
src/api.ts         api()/apiGet/apiPost/apiPut/apiDelete, ApiError, recovery-oriented messages for 401/403/404/409
src/format.ts      ResponseFormat, Pagination, listResult (keeps under CHARACTER_LIMIT by returning fewer items), respond, tail
src/deployments.ts WaitArgs, waitFor, finish() — wait for a deployment, failed => isError
src/tools/*.ts     apps, deploy, config (variables/domains), servers, exec
test/server.test.ts built server over stdio + mock Freighter HTTP server + real MCP client
```

Commands: `pnpm --filter freighter-mcp-server typecheck | build | test` (tests run `dist/index.js`, so build first).

## Adding a tool

1. Pick the group file (or add one and call it from `server.ts`). Name it `freighter_<verb>_<noun>`.
2. `server.registerTool(name, { title, description, inputSchema: z.strictObject({...}), annotations }, async (args, ctx) => …)`. Use `ctx.mcpReq.signal` for every API call.
3. Annotations: reads → readOnly + idempotent; mutations → set `destructiveHint` honestly.
4. Descriptions say what it does, what role it needs, an example, and when *not* to use it.
5. Lists use `listResult` (pagination + size cap); anything that starts a deployment ends with `finish()`.
6. Never add a tool that accepts a secret value or can lock someone out (firewall writes), see SKILL.md.
7. Add a case to `test/server.test.ts` with a mock route.

Mind the API: `/api/v1/*`, bearer `fr_…`. `freighter_exec` uses the console WebSocket `/_console` (binary frames: data 0, exit 2, error 3, ready 4, eof 6, stderr 7).
