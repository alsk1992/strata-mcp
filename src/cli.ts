#!/usr/bin/env node

import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DEFAULT_API_BASE } from "@stratabook/sdk";
import {
  STRATA_ACTION_GRAPH,
  STRATA_AGENT_HARNESS,
} from "./generated-harness.js";
import { createStrataMcpServer, probeStrataMcpReadiness } from "./server.js";
import { sessionAutonomyFromEnv } from "./autonomy.js";
import { SERVER_VERSION } from "./version.js";

interface Options {
  transport: "stdio" | "http";
  apiBase: string;
  timeoutMs: number;
  host: string;
  port: number;
  sessionAutonomy?: NonNullable<Awaited<ReturnType<typeof sessionAutonomyFromEnv>>>;
}

function parse(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      help();
      process.exit(0);
    }
    if (!token?.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${token} requires a value`);
    values.set(token.slice(2), next);
    index++;
  }
  const transport = values.get("transport") ?? process.env.STRATA_MCP_TRANSPORT ?? "stdio";
  if (transport !== "stdio" && transport !== "http") {
    throw new Error("--transport must be stdio or http");
  }
  const timeoutMs = boundedInteger(
    values.get("timeout-ms") ?? process.env.STRATA_MCP_TIMEOUT_MS ?? "10000",
    "timeout-ms",
    250,
    60_000,
  );
  const port = boundedInteger(
    values.get("port") ?? process.env.STRATA_MCP_PORT ?? "8787",
    "port",
    1,
    65_535,
  );
  const host = values.get("host") ?? process.env.STRATA_MCP_HOST ?? "localhost";
  if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host)) throw new Error("host is invalid");
  return {
    transport,
    apiBase: values.get("api-base") ?? process.env.STRATA_API_BASE ?? DEFAULT_API_BASE,
    timeoutMs,
    host,
    port,
  };
}

function boundedInteger(raw: string, name: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function help(): void {
  process.stdout.write(`Strata MCP server

Usage:
  strata-mcp
  strata-mcp --transport http [--host localhost] [--port 8787]

Options:
  --transport stdio|http   Local stdio by default; Streamable HTTP for hosting
  --api-base URL           Strata public API (default: ${DEFAULT_API_BASE})
  --timeout-ms N           Upstream timeout, 250..60000 (default: 10000)
  --host HOST              HTTP bind host (default: localhost)
  --port N                 HTTP port (default: 8787)

This server exposes capability-gated quote and execution operations. The external
agent owner controls permission and signing. Strata accepts public keys,
signatures, and signed transactions, never private keys or seed phrases.
`);
}

async function runStdio(options: Options): Promise<void> {
  const runtime = await createStrataMcpServer(options);
  const transport = new StdioServerTransport();
  await runtime.server.connect(transport);
  const close = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

async function runHttp(options: Options): Promise<void> {
  // The official helper validates Host headers for loopback binds, protecting
  // local MCP installations from DNS-rebinding attacks.
  const app = createMcpExpressApp({ host: options.host });
  app.disable("x-powered-by");

  app.get("/health", async (_request: Request, response: Response) => {
    try {
      const readiness = await probeStrataMcpReadiness(options);
      response.status(200).set("Cache-Control", "no-store").json(readiness);
    } catch (error) {
      process.stderr.write(`[strata-mcp] readiness failed: ${safeError(error)}\n`);
      response.status(503).set("Cache-Control", "no-store").json({
        ok: false,
        service: "strata-mcp",
        version: SERVER_VERSION,
        readiness: "failed",
      });
    }
  });

  app.get("/.well-known/strata-agent.json", (_request: Request, response: Response) => {
    response
      .status(200)
      .set("Cache-Control", "public, max-age=300")
      .json(STRATA_AGENT_HARNESS);
  });

  app.get("/.well-known/strata-action-graph.json", (_request: Request, response: Response) => {
    response
      .status(200)
      .set("Cache-Control", "public, max-age=300")
      .json(STRATA_ACTION_GRAPH);
  });

  app.post("/mcp", async (request: Request, response: Response) => {
    let runtime: Awaited<ReturnType<typeof createStrataMcpServer>> | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      runtime = await createStrataMcpServer(options);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      response.once("close", () => {
        transport?.close().catch(() => undefined);
        runtime?.close().catch(() => undefined);
      });
      await runtime.server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      process.stderr.write(`[strata-mcp] request failed: ${safeError(error)}\n`);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Strata MCP request failed." },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_request: Request, response: Response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const listener = app.listen(options.port, options.host, () => {
    process.stderr.write(
      `[strata-mcp] listening on http://${options.host}:${options.port}/mcp\n`,
    );
  });
  const close = () => {
    listener.close(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  return `${error.name}: ${error.message}`.replace(/[\r\n\t]/g, " ").slice(0, 300);
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  const sessionAutonomy = await sessionAutonomyFromEnv(process.env);
  const withSession: Options = sessionAutonomy ? { ...options, sessionAutonomy } : options;
  if (sessionAutonomy) {
    process.stderr.write(
      `[strata-mcp] session autonomy: ${sessionAutonomy.config.level} `
        + `(wallet ${sessionAutonomy.ownerWallet.slice(0, 6)}…, session ${sessionAutonomy.signer.publicKey.slice(0, 6)}…)\n`,
    );
  }
  if (withSession.transport === "stdio") await runStdio(withSession);
  else await runHttp(withSession);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Strata MCP failed to start."}\n`,
  );
  process.exitCode = 1;
});
