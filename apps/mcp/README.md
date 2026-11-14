# freighter-mcp-server

An MCP server (stdio) for [Freighter](../../README.md): 30 `freighter_*` tools to inspect apps, read logs, deploy, change variables, manage domains and run commands in services.

```sh
pnpm --filter freighter-mcp-server build
claude mcp add freighter -e FREIGHTER_URL=https://freighter.example.com -e FREIGHTER_TOKEN=fr_… -- node "$PWD/apps/mcp/dist/index.js"
```

Without `FREIGHTER_URL`/`FREIGHTER_TOKEN` it uses the current context of the `freighter` CLI (`freighter login`).

By design there is no tool for setting secrets, changing a firewall, deleting apps or managing tokens. Roles apply as everywhere: a viewer token can read, a deployer can deploy, an admin can change variables, domains and run commands.

See `.agents/skills/freighter-mcp/` for how an agent should use it.
