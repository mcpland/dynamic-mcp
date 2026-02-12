#!/usr/bin/env node

import { loadRuntimeConfig } from './config/runtime.js';
import { createMcpServer } from './server/create-server.js';
import { startHttpTransport } from './transports/http.js';
import { startStdioTransport } from './transports/stdio.js';

async function main(): Promise<void> {
  const config = loadRuntimeConfig();

  if (config.transport === 'stdio') {
    const server = await createMcpServer({ dynamic: config.dynamic });
    await startStdioTransport(server);
    console.error('[dynamic-mcp] running in stdio mode');
    return;
  }

  const serverHandle = await startHttpTransport(config.http, { dynamic: config.dynamic });
  console.error(
    `[dynamic-mcp] running in http mode at http://${config.http.host}:${config.http.port}${config.http.path}`
  );

  const shutdown = async (): Promise<void> => {
    await serverHandle.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });

  process.on('SIGTERM', () => {
    void shutdown();
  });
}

main().catch((error: unknown) => {
  console.error('[dynamic-mcp] fatal error:', error);
  process.exit(1);
});
