#!/usr/bin/env node

import { AuditLogger } from './audit/logger.js';
import { loadRuntimeConfig } from './config/runtime.js';
import { closeAllSharedPostgresPools } from './dynamic/postgres-pool.js';
import { createMcpServer } from './server/create-server.js';
import { startHttpTransport } from './transports/http.js';
import { startStdioTransport } from './transports/stdio.js';

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const auditLogger = new AuditLogger({
    enabled: config.audit.enabled,
    filePath: config.audit.filePath,
    maxEventBytes: config.audit.maxEventBytes,
    maxFileBytes: config.audit.maxFileBytes,
    maxFiles: config.audit.maxFiles,
    service: 'dynamic-mcp',
    serviceVersion: '0.3.0'
  });

  if (config.transport === 'stdio') {
    const server = await createMcpServer({
      dynamic: config.dynamic,
      sandbox: config.sandbox,
      security: config.security,
      auth: config.auth,
      auditLogger
    });
    installShutdownHandlers(async () => {
      await server.close();
    }, auditLogger);
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

  installShutdownHandlers(async () => {
    await serverHandle.stop();
  }, auditLogger);
}

function installShutdownHandlers(
  stopTransport: () => Promise<void>,
  auditLogger: AuditLogger
): void {
  let shuttingDown = false;
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    try {
      await stopTransport();
      await closeAllSharedPostgresPools();
      await auditLogger.flush();
    } catch (error) {
      console.error(`[dynamic-mcp] ${signal} shutdown error:`, error);
      process.exit(1);
      return;
    }

    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((error: unknown) => {
  console.error('[dynamic-mcp] fatal error:', error);
  process.exit(1);
});
