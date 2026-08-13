import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_SLIPPAGE_BPS,
  StrataApiError,
  StrataClient,
  StrataPlatformClient,
  type CapabilityCatalog,
  type ExecutionChallengeRequest,
  type ExecutionPrepareRequest,
  type ExecutionSubmitRequest,
  type MarketsResponse,
  type QuoteRequest,
  type QuoteResponse,
  type PlatformOrderChallengeInput,
} from "@stratabook/sdk";
import * as z from "zod/v4";
import {
  STRATA_AGENT_HARNESS,
  STRATA_AGENT_HARNESS_INSTRUCTIONS,
  STRATA_AGENT_HARNESS_URI,
  STRATA_ACTION_GRAPH_URI,
} from "./generated-harness.js";
import { SERVER_VERSION } from "./version.js";

export interface StrataMcpOptions {
  apiBase?: string;
  timeoutMs?: number;
  client?: StrataClient;
  platformClient?: StrataPlatformClient;
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
  executionChallenge: RegisteredTool;
  executionPrepare: RegisteredTool;
  executionSubmit: RegisteredTool;
  orderChallenge: RegisteredTool;
  orderPrepare: RegisteredTool;
  orderSubmit: RegisteredTool;
};

export function capabilityAvailable(catalog: CapabilityCatalog, id: string): boolean {
  return catalog.capabilities.some(
    (capability) =>
      capability.id === id
      && capability.default_enabled
      && capability.public_sdk
      && capability.mcp_exposure !== "none"
      && capability.risk === capability.mcp_exposure,
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
  const platformClient = options.platformClient ?? new StrataPlatformClient({
    apiBase: options.apiBase,
    timeoutMs: options.timeoutMs,
  });
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

  server.registerResource(
    "strata_action_graph",
    STRATA_ACTION_GRAPH_URI,
    {
      title: "Strata Action Graph",
      description:
        "Live executable topology for discovery, quoting, external signing, and submission.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: STRATA_ACTION_GRAPH_URI,
          mimeType: "application/json",
          text: JSON.stringify(await client.actionGraph()),
        },
      ],
    }),
  );

  server.registerPrompt(
    "strata_start",
    {
      title: "Start a Strata objective",
      description: "Apply the Strata Agent Harness to a concrete objective.",
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

  server.registerTool(
    "strata_action_graph",
    {
      title: "Strata action graph",
      description:
        "Discover live operations, required capabilities, transition conditions, and external signing boundaries.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => toolResult(await client.actionGraph(), "Current Strata action graph."),
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

  const executionChallenge = server.registerTool(
    "strata_execution_challenge",
    {
      title: "Strata execution challenge",
      description:
        "Request canonical quote-bound authorization bytes for the external signer configured by the agent owner.",
      inputSchema: {
        market: z.string().min(1).max(128).describe("Market label or public market ID."),
        quoteId: z.string().regex(/^sq_[0-9a-f]{32}$/).describe("Unexpired Sonar quote ID."),
        ownerWallet: z.string().min(32).max(44).describe("Base58 owner wallet public key."),
        sessionPublicKey: z
          .string()
          .min(32)
          .max(44)
          .describe("Base58 public key for the externally configured signer."),
        accountSequence: z
          .string()
          .regex(/^[0-9]+$/)
          .max(20)
          .describe("Current Vault account sequence as an unsigned decimal string."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ market, quoteId, ownerWallet, sessionPublicKey, accountSequence }) =>
      guardedTool(client, "trade.prepare", async () => {
        const request: ExecutionChallengeRequest = {
          market,
          quoteId,
          ownerWallet,
          sessionPublicKey,
          accountSequence,
        };
        const response = await client.executionChallenge(request);
        return toolResult(
          response,
          `Authorization challenge ${response.challenge_id}; expires at ${response.expires_at_ms}.`,
        );
      }),
  );

  const executionPrepare = server.registerTool(
    "strata_execution_prepare",
    {
      title: "Prepare Strata execution",
      description:
        "Exchange an externally signed authorization challenge for a quote-bound partially signed transaction.",
      inputSchema: {
        market: z.string().min(1).max(128).describe("Market label or public market ID."),
        challengeId: z
          .string()
          .regex(/^sc_[0-9a-f]{32}$/)
          .describe("Execution challenge ID returned by Strata."),
        authorizationSignature: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[1-9A-HJ-NP-Za-km-z]+$/)
          .describe("Base58 Ed25519 signature made externally over the challenge payload."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ market, challengeId, authorizationSignature }) =>
      guardedTool(client, "trade.prepare", async () => {
        const request: ExecutionPrepareRequest = {
          market,
          challengeId,
          authorizationSignature,
        };
        const response = await client.executionPrepare(request);
        return toolResult(
          response,
          `Prepared execution ${response.execution_id}; externally verify and sign before ${response.expires_at_ms}.`,
        );
      }),
  );

  const executionSubmit = server.registerTool(
    "strata_execution_submit",
    {
      title: "Submit Strata execution",
      description:
        "Submit an externally signed prepared transaction with an idempotency key.",
      inputSchema: {
        market: z.string().min(1).max(128).describe("Market label or public market ID."),
        executionId: z
          .string()
          .regex(/^se_[0-9a-f]{32}$/)
          .describe("Prepared execution ID returned by Strata."),
        signedTransactionBase64: z
          .string()
          .min(4)
          .max(8_192)
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
          .describe("The externally signed Solana transaction in canonical base64."),
        idempotencyKey: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9._-]+$/)
          .describe("Stable retry key for exactly this execution."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ market, executionId, signedTransactionBase64, idempotencyKey }) =>
      guardedTool(client, "trade.submit", async () => {
        const request: ExecutionSubmitRequest = {
          market,
          executionId,
          signedTransactionBase64,
          idempotencyKey,
        };
        const response = await client.executionSubmit(request);
        return toolResult(
          response,
          `Submitted execution ${response.execution_id} as ${response.signature}.`,
        );
      }),
  );

  const orderChallenge = server.registerTool(
    "strata_order_challenge",
    {
      title: "Strata order challenge",
      description:
        "Bind a product-level place, cancel, or cancel-all request to canonical bytes for the agent owner's external signer.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        action: z.enum(["place", "cancel", "cancel_all"]),
        ownerWallet: z.string().min(32).max(44),
        sessionPublicKey: z.string().min(32).max(44),
        accountSequence: z.string().regex(/^[0-9]+$/).max(20).optional(),
        clientOrderId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
        side: z.enum(["buy", "sell"]).optional(),
        orderType: z.enum(["good_until_cancelled", "post_only"]).optional(),
        limitPriceAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
        sizeAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
        orderId: z.string().regex(/^order_[0-9a-f]{32}$/).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => guardedTool(client, "orders.prepare", async () => {
      let request: PlatformOrderChallengeInput;
      if (args.action === "place") {
        if (
          args.accountSequence === undefined
          || args.clientOrderId === undefined
          || args.side === undefined
          || args.orderType === undefined
          || args.limitPriceAtoms === undefined
          || args.sizeAtoms === undefined
        ) {
          return toolError(
            "invalid_request",
            "Place requires accountSequence, clientOrderId, side, orderType, limitPriceAtoms, and sizeAtoms.",
            false,
          );
        }
        request = {
          action: "place",
          ownerWallet: args.ownerWallet,
          sessionPublicKey: args.sessionPublicKey,
          accountSequence: args.accountSequence,
          clientOrderId: args.clientOrderId,
          side: args.side,
          orderType: args.orderType,
          limitPriceAtoms: args.limitPriceAtoms,
          sizeAtoms: args.sizeAtoms,
        };
      } else if (args.action === "cancel") {
        if (args.orderId === undefined) {
          return toolError("invalid_request", "Cancel requires orderId.", false);
        }
        request = {
          action: "cancel",
          ownerWallet: args.ownerWallet,
          sessionPublicKey: args.sessionPublicKey,
          orderId: args.orderId,
        };
      } else {
        request = {
          action: "cancel_all",
          ownerWallet: args.ownerWallet,
          sessionPublicKey: args.sessionPublicKey,
        };
      }
      const response = await platformClient.orders.challenge(args.marketId, request);
      return toolResult(
        response,
        `Order challenge ${response.challenge_id} binds ${response.order_ids.length} opaque order ID(s); expires at ${response.expires_at_ms}.`,
      );
    }),
  );

  const orderPrepare = server.registerTool(
    "strata_order_prepare",
    {
      title: "Prepare Strata order control",
      description:
        "Exchange an externally signed order challenge for an immutable partially signed transaction.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        challengeId: z.string().regex(/^oc_[0-9a-f]{32}$/),
        authorizationSignature: z
          .string()
          .min(64)
          .max(88)
          .regex(/^[1-9A-HJ-NP-Za-km-z]+$/),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ marketId, challengeId, authorizationSignature }) =>
      guardedTool(client, "orders.prepare", async () => {
        const response = await platformClient.orders.prepare(marketId, {
          challengeId,
          authorizationSignature,
        });
        return toolResult(
          response,
          `Prepared ${response.action} control ${response.order_control_id}; externally verify and sign before ${response.expires_at_ms}.`,
        );
      }),
  );

  const orderSubmit = server.registerTool(
    "strata_order_submit",
    {
      title: "Submit Strata order control",
      description: "Submit an externally signed order transaction with a stable retry key.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        orderControlId: z.string().regex(/^or_[0-9a-f]{32}$/),
        signedTransactionBase64: z
          .string()
          .min(4)
          .max(8_192)
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        idempotencyKey: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ marketId, orderControlId, signedTransactionBase64, idempotencyKey }) =>
      guardedTool(client, "orders.submit", async () => {
        const response = await platformClient.orders.submit(marketId, {
          orderControlId,
          signedTransactionBase64,
          idempotencyKey,
        });
        return toolResult(
          response,
          `Submitted ${response.action} control ${response.order_control_id} as ${response.signature}.`,
        );
      }),
  );

  const handles: ToolHandles = {
    markets,
    quote,
    executionChallenge,
    executionPrepare,
    executionSubmit,
    orderChallenge,
    orderPrepare,
    orderSubmit,
  };
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
  setToolEnabled(handles.executionChallenge, capabilityAvailable(catalog, "trade.prepare"));
  setToolEnabled(handles.executionPrepare, capabilityAvailable(catalog, "trade.prepare"));
  setToolEnabled(handles.executionSubmit, capabilityAvailable(catalog, "trade.submit"));
  setToolEnabled(handles.orderChallenge, capabilityAvailable(catalog, "orders.prepare"));
  setToolEnabled(handles.orderPrepare, capabilityAvailable(catalog, "orders.prepare"));
  setToolEnabled(handles.orderSubmit, capabilityAvailable(catalog, "orders.submit"));
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
