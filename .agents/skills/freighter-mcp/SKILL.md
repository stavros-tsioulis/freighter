---
name: freighter-mcp
description: How to use (and set up) the Freighter MCP server, `freighter-mcp-server`, whose tools are all named `freighter_*` — list apps, read logs and metrics, deploy images, redeploy, roll back, change variables, manage domains, inspect servers and firewalls, and run commands in services. Use whenever freighter_* tools are available and the user asks about their deployed apps, services, deployments, logs, domains, or servers, and whenever the user wants to connect an MCP client (Claude Code, Claude Desktop) to their Freighter, or asks what the Freighter MCP server can or cannot do.
---

# Freighter MCP server

`freighter-mcp-server` (in `apps/mcp`) gives an agent the same API the dashboard and CLI use, as 30 `freighter_*` tools over stdio. It is deliberately a *subset*: no tool takes a secret value, changes a firewall, deletes an app or manages tokens. Those stay with the human, in the CLI/dashboard — if the user wants one, say so and give them the `freighter` command (see the `freighter-cli` skill) instead of looking for a workaround.

## Connecting it

Build once (`pnpm --filter freighter-mcp-server build`), then register it. Either pass the connection explicitly or let it reuse the CLI's sign-in (current context in `~/.config/freighter/config.json`):

```json
{ "mcpServers": { "freighter": {
  "command": "node",
  "args": ["/path/to/freighter/apps/mcp/dist/index.js"],
  "env": { "FREIGHTER_URL": "https://freighter.example.com", "FREIGHTER_TOKEN": "fr_…" }
} } }
```
Claude Code: `claude mcp add freighter -e FREIGHTER_URL=… -e FREIGHTER_TOKEN=… -- node /path/to/apps/mcp/dist/index.js`. Prefer a token with the lowest role the work needs; with a **viewer** token every read tool works and every change is refused with a message saying so. Never paste a token into chat or commit it.

If a tool says "Not connected", neither the env vars nor a CLI context exist: tell the user how to set one, don't guess.

## Tools by purpose

| Want to… | Tool (role) |
| --- | --- |
| see identity/role | `freighter_whoami` |
| find apps, projects | `freighter_list_apps`, `freighter_get_app`, `freighter_list_projects` |
| diagnose | `freighter_get_logs`, `freighter_get_stats`, `freighter_list_releases`, `freighter_list_deployments`, `freighter_get_deployment`, `freighter_get_deployment_log` |
| deploy | `freighter_deploy_image`, `freighter_redeploy`, `freighter_rollback`, `freighter_cancel_deployment` (deployer) |
| start/stop/restart | `freighter_control_service` (deployer) |
| configuration | `freighter_get_config`, `freighter_list_variables`, `freighter_set_variables`, `freighter_unset_variables` (admin to change), `freighter_list_secret_names` |
| domains | `freighter_list_domains`, `freighter_add_domain`, `freighter_verify_domain`, `freighter_remove_domain` (admin to change) |
| infrastructure | `freighter_list_servers`, `freighter_get_server`, `freighter_get_firewall` (read-only), `freighter_list_storages`, `freighter_get_audit_log` |
| run a command | `freighter_exec` (admin, audited) |

List tools take `limit`/`offset` and `response_format` (`markdown` default, `json` when you will process the data). Follow `next_offset` rather than asking for huge pages.

## How to work with it

- **Start from the symptom.** "Why is shop down?" → `freighter_get_app` (states; `retrying` = crash loop) → `freighter_get_logs` → `freighter_list_secret_names` (an unset declared secret is the common cause) → `freighter_list_variables resolved=true` (a connection that cannot resolve shows the reason) → `freighter_list_deployments`.
- **Deploy-type tools wait** (`wait=true`, default 120 s) and report how it ended. A failed deployment comes back as an error containing the reason; the old release keeps running. Read it, fix the cause, don't blindly retry. For long work pass `wait=false` and follow with `freighter_get_deployment`.
- **Changing variables restarts the service**, and `freighter_set_variables` without `service` is app-wide. Say what you're about to change on production apps before doing it, unless the user already asked precisely for it.
- **Secrets are write-only.** `freighter_list_secret_names` shows whether a name is set, never its value; to set one, tell the user to run `freighter secret set <app/service> KEY` (it reads the value without echo). After a secret changes, `freighter_redeploy` picks it up.
- **`freighter_exec` takes an argument list, not a shell line**: `["ls","-la"]`, or `["sh","-c","a | b"]` for pipes. No stdin, no terminal. Prefer read-only commands; it runs as the service's user (inside the container for container services) and changes live data if the command does. Output keeps its tail beyond 25 000 characters.
- **Domains start pending.** `freighter_add_domain` returns the DNS records the user must create; call `freighter_verify_domain` after they exist (DNS can take minutes — report "not ready yet" instead of looping).
- Errors are written to say what to do next (role too low, unknown app → list apps). Relay them; don't retry a 403.

## Developing the server

Source layout, tests and how to add a tool: `references/development.md`.
