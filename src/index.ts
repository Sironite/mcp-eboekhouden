#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileAuditLogger } from "./audit.js";
import { EBoekhoudenClient } from "./client.js";
import {
  auditLogPath,
  mutationMarker,
  readApiToken,
  readTokenExpiry,
  sessionSource,
} from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const client = new EBoekhoudenClient({
    apiToken: readApiToken(),
    source: sessionSource(),
  });
  const server = createServer(client, new FileAuditLogger(auditLogPath()), {
    tokenExpiresAt: readTokenExpiry(),
    marker: mutationMarker(),
  });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error(
    `[mcp-eboekhouden] failed to start: ${err instanceof Error ? err.message : "unknown error"}`,
  );
  process.exit(1);
});
