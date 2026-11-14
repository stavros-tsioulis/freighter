#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.ts";

// stdout belongs to the protocol: anything for a person goes to stderr.
serveStdio(createServer);
console.error("freighter-mcp-server running on stdio");
