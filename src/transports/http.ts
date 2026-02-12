import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';

import { createMcpServer } from '../server/create-server.js';

export interface HttpTransportConfig {
  host: string;
  port: number;
  path: string;
}

export interface HttpServerHandle {
  stop: () => Promise<void>;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export async function startHttpTransport(config: HttpTransportConfig): Promise<HttpServerHandle> {
  const app = createMcpExpressApp({ host: config.host });
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
    const server = createMcpServer();
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
