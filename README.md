# dynamic-mcp

A production-oriented MCP server template built on top of the official TypeScript SDK.

## Why this repo

- Uses official `@modelcontextprotocol/sdk` APIs.
- Supports both `stdio` (local clients) and Streamable HTTP (remote clients).
- Includes strict TypeScript, linting, tests, CI, and Docker deployment.

## Stack

- Node.js `>=20`
- TypeScript
- MCP SDK: `@modelcontextprotocol/sdk`
- Validation: `zod`
- Testing: `vitest`
- Lint/format: `eslint` + `prettier`

## Quick start

```bash
npm install
npm run dev:stdio
```

For HTTP mode:

```bash
npm run dev:http
```

Default HTTP endpoint: `http://127.0.0.1:8788/mcp`

## Environment variables

See `.env.example`.

- `MCP_TRANSPORT`: `stdio` or `http`
- `MCP_HOST`: HTTP bind host
- `MCP_PORT`: HTTP bind port
- `MCP_PATH`: HTTP MCP route

## Scripts

- `npm run dev`
- `npm run dev:stdio`
- `npm run dev:http`
- `npm run lint`
- `npm run test`
- `npm run build`
- `npm run typecheck`

## Built-in MCP capabilities

Tools:

- `system.health`
- `dev.echo`
- `time.now`

Resource:

- `dynamic://service/meta`

Prompt:

- `tool-call-checklist`

## Claude Desktop (stdio) example

Use the built output in your MCP config:

```json
{
  "mcpServers": {
    "dynamic-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/dynamic-mcp/dist/index.js", "--transport", "stdio"]
    }
  }
}
```

## HTTP deployment

Local run:

```bash
MCP_TRANSPORT=http MCP_HOST=127.0.0.1 MCP_PORT=8788 MCP_PATH=/mcp npm run dev
```

Docker:

```bash
docker build -t dynamic-mcp:latest .
docker run --rm -p 8788:8788 dynamic-mcp:latest
```

## Engineering checklist

- CI pipeline on Node 20/22
- Strict TS compile
- Integration test with in-memory MCP transport
- Session-aware Streamable HTTP implementation
