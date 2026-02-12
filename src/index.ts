#!/usr/bin/env node

import { AuditLogger } from './audit/logger.js';
import { loadRuntimeConfig } from './config/runtime.js';
import { createMcpServer } from './server/create-server.js';
import { startHttpTransport } from './transports/http.js';
import { startStdioTransport } from './transports/stdio.js';

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const auditLogger = new AuditLogger({
    enabled: config.audit.enabled,
    filePath: config.audit.filePath,
    maxEventBytes: config.audit.maxEventBytes,
    service: 'dynamic-mcp',
    serviceVersion: '0.3.0'
  });

  if (config.transport === 'stdio') {
    const server = await createMcpServer({
      dynamic: config.dynamic,
      sandbox: config.sandbox,
      security: config.security,
      auditLogger
    });
    await startStdioTransport(server);
    console.error('[dynamic-mcp] running in stdio mode');
    return;
  }

  const serverHandle = await startHttpTransport(config.http, {
    dynamic: config.dynamic,
    sandbox: config.sandbox,
    security: config.security,
    auth: config.auth,
    auditLogger
  });
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
