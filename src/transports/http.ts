import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';

import { JwtAuthVerifier } from '../auth/jwt.js';
import type { AuditLogger } from '../audit/logger.js';
import { getSharedPostgresPool } from '../dynamic/postgres-pool.js';
import { createMcpServer } from '../server/create-server.js';

export interface HttpTransportConfig {
  host: string;
  port: number;
  path: string;
}

export interface HttpServerHandle {
  stop: () => Promise<void>;
}

interface HttpServerOptions {
  dynamic: {
    backend: 'file' | 'postgres';
    storeFilePath: string;
    maxTools: number;
    adminToken?: string;
    postgres?: {
      connectionString: string;
      schema: string;
    };
  };
  sandbox: {
    dockerBinary: string;
    memoryLimit: string;
    cpuLimit: string;
    maxDependencies: number;
    maxOutputBytes: number;
    maxTimeoutMs: number;
    allowedImages: string[];
    blockedPackages: string[];
    sessionTimeoutSeconds: number;
    maxSessions: number;
  };
  security: {
    toolMaxConcurrency: number;
    toolMaxCallsPerWindow: number;
    toolRateWindowMs: number;
  };
  auth: {
    mode: 'none' | 'jwt';
    jwt?: {
      jwksUrl: string;
      issuer: string;
      audience: string;
      requiredScopes: string[];
    };
  };
  auditLogger: AuditLogger;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export async function startHttpTransport(
  config: HttpTransportConfig,
  options: HttpServerOptions
): Promise<HttpServerHandle> {
  const app = createMcpExpressApp({ host: config.host });
  const readinessCheck = createReadinessCheck(options.dynamic);
  const jwtVerifier =
    options.auth.mode === 'jwt' && options.auth.jwt
      ? new JwtAuthVerifier({
          enabled: true,
          jwksUrl: options.auth.jwt.jwksUrl,
          issuer: options.auth.jwt.issuer,
          audience: options.auth.jwt.audience,
          requiredScopes: options.auth.jwt.requiredScopes
        })
      : null;
  const sessions = new Map<string, Session>();
  const closingSessions = new Set<string>();

  const closeSession = async (sessionId: string): Promise<void> => {
    if (closingSessions.has(sessionId)) {
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }

    closingSessions.add(sessionId);
    sessions.delete(sessionId);

    try {
      await session.transport.close();
    } catch {
      // Ignore transport close failures during shutdown.
    }

    try {
      await session.server.close();
    } catch {
      // Ignore server close failures during shutdown.
    }

    closingSessions.delete(sessionId);
  };

  const createSessionTransport = async (): Promise<StreamableHTTPServerTransport> => {
    const server = await createMcpServer({
      dynamic: options.dynamic,
      sandbox: options.sandbox,
      security: options.security,
      auditLogger: options.auditLogger
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { server, transport });
      },
      onsessionclosed: async (sessionId) => {
        await closeSession(sessionId);
      }
    });

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) {
        void closeSession(sessionId);
      }
    };

    await server.connect(transport);
    return transport;
  };

  const postHandler = async (req: Request, res: Response): Promise<void> => {
    if (!(await authenticate(req, res, jwtVerifier, options.auditLogger))) {
      return;
    }

    const sessionId = req.headers['mcp-session-id'];

    try {
      if (typeof sessionId === 'string') {
        const existing = sessions.get(sessionId);
        if (!existing) {
          sendJsonRpcError(res, 404, -32001, `Unknown MCP session id: ${sessionId}`);
          return;
        }

        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        sendJsonRpcError(res, 400, -32000, 'Missing mcp-session-id or initialize request body.');
        return;
      }

      const transport = await createSessionTransport();
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      sendJsonRpcError(res, 500, -32603, 'Internal MCP server error.', error);
    }
  };

  const getHandler = async (req: Request, res: Response): Promise<void> => {
    if (!(await authenticate(req, res, jwtVerifier, options.auditLogger))) {
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string') {
      sendJsonRpcError(res, 400, -32000, 'Missing mcp-session-id header.');
      return;
    }

    const existing = sessions.get(sessionId);
    if (!existing) {
      sendJsonRpcError(res, 404, -32001, `Unknown MCP session id: ${sessionId}`);
      return;
    }

    try {
      await existing.transport.handleRequest(req, res, req.body);
    } catch (error) {
      sendJsonRpcError(res, 500, -32603, 'Failed to process SSE request.', error);
    }
  };

  const deleteHandler = async (req: Request, res: Response): Promise<void> => {
    if (!(await authenticate(req, res, jwtVerifier, options.auditLogger))) {
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string') {
      sendJsonRpcError(res, 400, -32000, 'Missing mcp-session-id header.');
      return;
    }

    const existing = sessions.get(sessionId);
    if (!existing) {
      sendJsonRpcError(res, 404, -32001, `Unknown MCP session id: ${sessionId}`);
      return;
    }

    try {
      await existing.transport.handleRequest(req, res, req.body);
    } catch (error) {
      sendJsonRpcError(res, 500, -32603, 'Failed to close MCP session.', error);
    }
  };

  app.post(config.path, postHandler);
  app.get(config.path, getHandler);
  app.delete(config.path, deleteHandler);
  app.get('/livez', (_req, res) => {
    res.status(200).json({
      status: 'ok'
    });
  });
  app.get('/readyz', async (_req, res) => {
    try {
      await readinessCheck();
      res.status(200).json({
        status: 'ready'
      });
    } catch (error) {
      res.status(503).json({
        status: 'not_ready',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  const httpServer = await listen(app, config.host, config.port);

  return {
    stop: async () => {
      for (const sessionId of [...sessions.keys()]) {
        await closeSession(sessionId);
      }

      await closeServer(httpServer);
    }
  };
}

async function authenticate(
  req: Request,
  res: Response,
  verifier: JwtAuthVerifier | null,
  auditLogger: AuditLogger
): Promise<boolean> {
  if (!verifier) {
    return true;
  }

  const authorization = req.headers.authorization;
  if (!authorization || !authorization.startsWith('Bearer ')) {
    sendJsonRpcError(res, 401, -32001, 'Unauthorized: missing bearer token.');
    void auditLogger.log({
      action: 'http.auth',
      actor: req.ip,
      result: 'denied',
      details: { reason: 'missing_bearer' }
    });
    return false;
  }

  const token = authorization.slice('Bearer '.length).trim();
  if (token.length === 0) {
    sendJsonRpcError(res, 401, -32001, 'Unauthorized: empty bearer token.');
    void auditLogger.log({
      action: 'http.auth',
      actor: req.ip,
      result: 'denied',
      details: { reason: 'empty_bearer' }
    });
    return false;
  }

  try {
    const authInfo = await verifier.verifyAccessToken(token);
    (req as Request & { auth?: AuthInfo }).auth = authInfo;
    void auditLogger.log({
      action: 'http.auth',
      actor: authInfo.clientId,
      result: 'success',
      details: { scopes: authInfo.scopes }
    });
    return true;
  } catch (error) {
    sendJsonRpcError(
      res,
      403,
      -32002,
      error instanceof Error ? `Forbidden: ${error.message}` : 'Forbidden: invalid token.'
    );
    void auditLogger.log({
      action: 'http.auth',
      actor: req.ip,
      result: 'denied',
      details: { reason: error instanceof Error ? error.message : String(error) }
    });
    return false;
  }
}

function sendJsonRpcError(
  res: Response,
  statusCode: number,
  code: number,
  message: string,
  error?: unknown
): void {
  if (error) {
    console.error('[mcp-http] request failed:', error);
  }

  if (res.headersSent) {
    return;
  }

  res.status(statusCode).json({
    jsonrpc: '2.0',
    error: {
      code,
      message
    },
    id: null
  });
}

function listen(
  app: ReturnType<typeof createMcpExpressApp>,
  host: string,
  port: number
): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);

    server.once('listening', () => resolve(server));
    server.once('error', (error) => reject(error));
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function createReadinessCheck(dynamic: HttpServerOptions['dynamic']): () => Promise<void> {
  if (dynamic.backend === 'postgres') {
    if (!dynamic.postgres) {
      return async () => {
        throw new Error('Missing postgres dynamic registry config.');
      };
    }

    const pool = getSharedPostgresPool(dynamic.postgres.connectionString);
    return async () => {
      await pool.query('SELECT 1');
    };
  }

  return async () => Promise.resolve();
}
