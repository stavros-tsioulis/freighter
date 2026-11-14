import { McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION } from "./constants.ts";
import { registerAppTools } from "./tools/apps.ts";
import { registerConfigTools } from "./tools/config.ts";
import { registerDeployTools } from "./tools/deploy.ts";
import { registerExecTools } from "./tools/exec.ts";
import { registerServerTools } from "./tools/servers.ts";

/** A new server per connection: the tools hold no state, the connection to Freighter is made per call. */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerAppTools(server);
  registerDeployTools(server);
  registerConfigTools(server);
  registerServerTools(server);
  registerExecTools(server);
  return server;
}
