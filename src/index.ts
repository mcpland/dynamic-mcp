#!/usr/bin/env node

import { AuditLogger } from './audit/logger.js';
import { loadRuntimeConfig } from './config/runtime.js';
import { shutdownPostgresRegistryChangeListeners } from './dynamic/postgres-change-sync.js';
import { closeAllSharedPostgresPools } from './dynamic/postgres-pool.js';
import { shutdownSandboxRuntime } from './sandbox/register-session-tools.js';
import { createMcpServer } from './server/create-server.js';
import { startHttpTransport } from './transports/http.js';
import { startStdioTransport } from './transports/stdio.js';
import { serviceVersion } from './version.js';

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const auditLogger = new AuditLogger({
    enabled: config.audit.enabled,
    filePath: config.audit.filePath,
    maxEventBytes: config.audit.maxEventBytes,
    maxFileBytes: config.audit.maxFileBytes,
    maxFiles: config.audit.maxFiles,
    service: 'dynamic-mcp',
    serviceVersion
  });

  if (config.transport === 'stdio') {
    const server = await createMcpServer({
      profile: config.profile,
      dynamic: config.dynamic,
      sandbox: config.sandbox,
      security: config.security,
      auth: config.auth,
      auditLogger
    });
    installShutdownHandlers(async () => {
      await server.close();
    }, auditLogger, config.sandbox.dockerBinary);
    await startStdioTransport(server);
    console.error('[dynamic-mcp] running in stdio mode');
    return;
  }

  const serverHandle = await startHttpTransport(config.http, {
    profile: config.profile,
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
  }, auditLogger, config.sandbox.dockerBinary);
}

function installShutdownHandlers(
  stopTransport: () => Promise<void>,
  auditLogger: AuditLogger,
  dockerBinary: string
): void {
  let shuttingDown = false;
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    try {
      await stopTransport();
      await shutdownSandboxRuntime(dockerBinary);
      await shutdownPostgresRegistryChangeListeners();
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
