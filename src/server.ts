import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_SLIPPAGE_BPS,
  StrataApiError,
  StrataClient,
  type CapabilityCatalog,
  type MarketsResponse,
  type QuoteRequest,
  type QuoteResponse,
} from "@stratabook/sdk";
import * as z from "zod/v4";
import {
  STRATA_AGENT_HARNESS,
  STRATA_AGENT_HARNESS_INSTRUCTIONS,
  STRATA_AGENT_HARNESS_URI,
} from "./generated-harness.js";
import { SERVER_VERSION } from "./version.js";

export interface StrataMcpOptions {
  apiBase?: string;
  timeoutMs?: number;
  client?: StrataClient;
}

export interface StrataMcpRuntime {
  server: McpServer;
  refreshCapabilities(): Promise<void>;
  close(): Promise<void>;
}

export interface StrataMcpReadiness {
  ok: true;
  service: "strata-mcp";
  version: string;
  contract_version: string;
  harness_version: string;
}

const REFRESH_INTERVAL_MS = 5_000;

type ToolHandles = {
  markets: RegisteredTool;
  quote: RegisteredTool;
};

export function capabilityAvailable(catalog: CapabilityCatalog, id: string): boolean {
  return catalog.capabilities.some(
    (capability) =>
      capability.id === id
      && capability.default_enabled
      && capability.public_sdk
      && capability.risk === "read"
      && capability.mcp_exposure === "read",
  );
}

function strataClient(options: StrataMcpOptions): StrataClient {
  return options.client
    ?? new StrataClient({
      apiBase: options.apiBase,
      timeoutMs: options.timeoutMs,
    });
}

export async function probeStrataMcpReadiness(
  options: StrataMcpOptions = {},
): Promise<StrataMcpReadiness> {
  const catalog = await strataClient(options).capabilities();
  if (catalog.contract_version !== STRATA_AGENT_HARNESS.contract_version) {
    throw new Error("agent harness and live contract versions differ");
  }
  return {
    ok: true,
    service: "strata-mcp",
    version: SERVER_VERSION,
    contract_version: catalog.contract_version,
    harness_version: STRATA_AGENT_HARNESS.harness_version,
  };
}

export async function createStrataMcpServer(
  options: StrataMcpOptions = {},
): Promise<StrataMcpRuntime> {
  const client = strataClient(options);
  const initialCatalog = await client.capabilities();
  if (initialCatalog.contract_version !== STRATA_AGENT_HARNESS.contract_version) {
    throw new Error("agent harness and live contract versions differ");
  }
  const server = new McpServer(
    {
      name: "strata",
      version: SERVER_VERSION,
    },
    {
      instructions: STRATA_AGENT_HARNESS_INSTRUCTIONS,
    },
  );

  server.registerResource(
    "strata_agent_harness",
    STRATA_AGENT_HARNESS_URI,
    {
      title: "Strata Agent Harness",
      description: "Canonical capability-gated first-run workflow for Strata agents.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: STRATA_AGENT_HARNESS_URI,
          mimeType: "application/json",
          text: JSON.stringify(STRATA_AGENT_HARNESS),
        },
      ],
    }),
  );

  server.registerPrompt(
    "strata_start",
    {
      title: "Start a Strata objective",
      description: "Apply the Strata Agent Harness to a concrete read-only objective.",
      argsSchema: {
        objective: z
          .string()
          .min(1)
          .max(2_000)
          .describe("The user's concrete Strata market or quote objective."),
      },
    },
    async ({ objective }) => ({
      description: "Capability-gated Strata objective",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${STRATA_AGENT_HARNESS_INSTRUCTIONS}\n\nObjective: ${objective.trim()}`,
          },
        },
      ],
    }),
  );

  server.registerTool(
    "strata_capabilities",
    {
      title: "Strata capabilities",
      description:
        "See which Strata features are currently available to MCP clients.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => toolResult(await client.capabilities(), "Current Strata capabilities."),
  );

  const markets = server.registerTool(
    "strata_markets",
    {
      title: "Strata markets",
      description:
        "List Strata markets and their current Sonar quote availability.",
      inputSchema: {
        includePaused: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include markets whose public Sonar quote operation is paused."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ includePaused }) =>
      guardedTool(client, "markets.read", async () => {
        const response = await client.markets();
        const output: MarketsResponse = includePaused
          ? response
          : {
              ...response,
              markets: response.markets.filter((market) => market.ready),
            };
        return toolResult(output, `${output.markets.length} Strata markets available.`);
      }),
  );

  const quote = server.registerTool(
    "strata_quote",
    {
      title: "Sonar quote",
      description:
        "Request a short-lived Sonar quote for a Strata market. Returns expected "
        + "output, minimum output, fees, price impact, and expiry.",
      inputSchema: {
        market: z
          .string()
          .min(1)
          .max(128)
          .describe("Market label such as SOL/USDC, or its public market ID."),
        side: z.enum(["buy", "sell"]).describe("Buy or sell the market's base asset."),
        amountInAtoms: z
          .string()
          .regex(/^[0-9]+$/)
          .max(20)
          .describe("Exact input amount in the input token's smallest atomic unit."),
        slippageBps: z
          .number()
          .int()
          .min(0)
          .max(1_000)
          .optional()
          .default(DEFAULT_SLIPPAGE_BPS)
          .describe(
            "Optional maximum execution tolerance in basis points. "
            + "The default 0 requires exact quoted output.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ market, side, amountInAtoms, slippageBps }) =>
      guardedTool(client, "quotes.read", async () => {
        const request: QuoteRequest = {
          market,
          side,
          amountInAtoms,
          slippageBps,
        };
        const response: QuoteResponse = await client.quote(request);
        return toolResult(
          response,
          `Sonar ${response.side} quote: ${response.amount_in_consumed_atoms} input atoms `
            + `for ${response.amount_out_atoms} output atoms; minimum `
            + `${response.minimum_output_atoms}; expires at ${response.expires_at_ms}.`,
        );
      }),
  );

  const handles: ToolHandles = { markets, quote };
  applyCapabilityCatalog(handles, initialCatalog);
  let closed = false;
  const refresh = async () => {
    if (closed) return;
    applyCapabilityCatalog(handles, await client.capabilities());
  };
  const timer = setInterval(() => {
    refresh().catch((error: unknown) => {
      process.stderr.write(`[strata-mcp] capability refresh failed: ${safeMessage(error)}\n`);
    });
  }, REFRESH_INTERVAL_MS);
  timer.unref();

  return {
    server,
    refreshCapabilities: refresh,
    close: async () => {
      closed = true;
      clearInterval(timer);
      await server.close();
    },
  };
}

function applyCapabilityCatalog(handles: ToolHandles, catalog: CapabilityCatalog): void {
  setToolEnabled(handles.markets, capabilityAvailable(catalog, "markets.read"));
  setToolEnabled(handles.quote, capabilityAvailable(catalog, "quotes.read"));
}

function setToolEnabled(tool: RegisteredTool, enabled: boolean): void {
  if (enabled) tool.enable();
  else tool.disable();
}

async function guardedTool(
  client: StrataClient,
  capabilityId: string,
  operation: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    const catalog = await client.capabilities();
    if (!capabilityAvailable(catalog, capabilityId)) {
      return toolError(
        "capability_disabled",
        `${capabilityId} is not currently exposed to MCP clients.`,
        true,
      );
    }
    return await operation();
  } catch (error) {
    if (error instanceof StrataApiError) {
      return toolError(error.code, error.message, error.retryable);
    }
    return toolError("request_failed", safeMessage(error), true);
  }
}

function toolResult(value: unknown, summary: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `${summary}\n${JSON.stringify(value)}`,
      },
    ],
    structuredContent: value as Record<string, unknown>,
  };
}

function toolError(code: string, message: string, retryable: boolean): CallToolResult {
  const error = { error: { code, message, retryable } };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(error) }],
    structuredContent: error,
  };
}

function safeMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Strata could not complete the request.";
}
