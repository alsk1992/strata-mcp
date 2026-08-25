import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_MAXIMUM_TOLERANCE_BPS,
  StrataApiError,
  StrataClient,
  StrataPlatformClient,
  type CapabilityCatalog,
  type ExecutionChallengeRequest,
  type ExecutionPrepareRequest,
  type ExecutionSubmitRequest,
  type MarketsResponse,
  type PlatformMarket,
  type PlatformMakerCurrentPrepareInput,
  type PlatformMakerIntentExecuteOperation,
  type PlatformMakerIntentPrepareInput,
  type PlatformMakerQuickstartPrepared,
  type PlatformMakerStopPrepared,
  type PlatformMakerStrandPrepareInput,
  type QuoteRequest,
  type QuoteResponse,
  type PlatformOrderChallengeInput,
  type PlatformTwapChallengeInput,
  type PlatformOrderBatchOperation,
  type PlatformOrderStatusResponse,
  type PlatformActionGraphResponse,
  type PlatformDiscoveryResponse,
  type PlatformSwapQuoteResponse,
  type PlatformReferralClaimResponse,
  type PlatformReferralLinkResponse,
  type PlatformOrderExecuteOperation,
  type PlatformTwapExecuteOperation,
} from "@stratabook/sdk";
import {
  decideAutonomy,
  estimateBaseNotionalUsd,
  quoteNotionalUsd,
  MarketMetaResolver,
  type SessionAutonomy,
} from "./autonomy.js";
import * as z from "zod/v4";
import {
  STRATA_AGENT_HARNESS,
  STRATA_AGENT_HARNESS_INSTRUCTIONS,
  STRATA_AGENT_HARNESS_URI,
  STRATA_ACTION_GRAPH_URI,
} from "./generated-harness.js";
import { SERVER_VERSION } from "./version.js";
import {
  SIMPLE_TOOL_NAMES,
  formatAtoms,
  friendlyApiError,
  humanQuoteAmount,
  type StrataMcpToolMode,
} from "./usability.js";

export interface StrataMcpOptions {
  apiBase?: string;
  timeoutMs?: number;
  client?: StrataClient;
  platformClient?: StrataPlatformClient;
  /** Compact direct-use tools by default; advanced exposes the full protocol surface. */
  toolMode?: StrataMcpToolMode;
  /**
   * When set, the MCP may finish trades itself with this Vault session key,
   * bounded by the user-owned autonomy slider. Absent = the calm default:
   * every trade is prepared for a human to sign. Built from env in the CLI.
   */
  sessionAutonomy?: SessionAutonomy;
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
export const STRATA_PLATFORM_GRAPH_URI = "strata://platform-graph/v2";

const makerPublicKeySchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const makerMarketIdSchema = z.string().regex(/^market_[0-9a-f]{32}$/);
const makerAssetIdSchema = z.string().regex(/^asset_[0-9a-f]{32}$/);
const makerControlIdSchema = z.string().regex(/^mc_[0-9a-f]{32}$/);
const makerAtomicSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/).max(20);
const makerPositiveAtomicSchema = z.string().regex(/^[1-9][0-9]*$/).max(20);
const makerBase64Schema = z.string().min(4).max(4_096)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const makerMarketSchema = z.object({
  market_id: makerMarketIdSchema,
  label: z.string().min(1).max(128),
  base_asset_id: makerAssetIdSchema,
  quote_asset_id: makerAssetIdSchema,
  status: z.enum([
    "active",
    "read_only",
    "quote_only",
    "cancel_only",
    "paused",
    "warming",
    "degraded",
    "unavailable",
  ]),
  available_actions: z.array(z.enum([
    "quote",
    "execute_immediate",
    "place_order",
    "schedule_twap",
  ])).max(4),
}).strict();
const makerAssetSchema = z.object({
  asset_id: makerAssetIdSchema,
  symbol: z.string().min(1).max(32),
  name: z.string().min(1).max(128),
  decimals: z.number().int().min(0).max(18),
  logo_url: z.string().url().optional(),
  network: z.literal("solana"),
}).strict();
const makerStrandOperationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("upsert"),
    makerWallet: makerPublicKeySchema,
    enabled: z.boolean(),
    asyncOnly: z.boolean(),
    syncSpreadTicks: z.number().int().min(0).max(65_535),
    midPriceAtoms: makerPositiveAtomicSchema,
    maxExposureBaseAtoms: makerPositiveAtomicSchema,
    bidOffsetsTicks: z.array(z.number().int().min(0).max(65_535)).length(16),
    askOffsetsTicks: z.array(z.number().int().min(0).max(65_535)).length(16),
    bidSizesBaseAtoms: z.array(makerAtomicSchema).length(16),
    askSizesBaseAtoms: z.array(makerAtomicSchema).length(16),
    validUntilSlot: makerPositiveAtomicSchema,
  }).strict(),
  z.object({
    action: z.literal("cancel"),
    makerWallet: makerPublicKeySchema,
  }).strict(),
]);
const makerCurrentOperationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("upsert"),
    makerWallet: makerPublicKeySchema,
    enabled: z.boolean(),
    asyncOnly: z.boolean(),
    halfSpreadBps: z.number().int().min(1).max(65_535),
    bandStepBps: z.number().int().min(0).max(65_535),
    maxConfidenceBps: z.number().int().min(1).max(100),
    maxOracleDeviationBps: z.number().int().min(1).max(500),
    maxOracleAgeSeconds: z.number().int().min(0).max(4_294_967_295),
    syncSpreadBps: z.number().int().min(0).max(65_535),
    maxExposureBaseAtoms: makerPositiveAtomicSchema,
    bidDepthBaseAtoms: z.array(makerAtomicSchema).length(8),
    askDepthBaseAtoms: z.array(makerAtomicSchema).length(8),
    validUntilSlot: makerPositiveAtomicSchema,
  }).strict(),
  z.object({
    action: z.literal("cancel"),
    makerWallet: makerPublicKeySchema,
  }).strict(),
]);
const makerPreparedResponseSchema = z.object({
  schema_version: z.literal(2),
  contract_version: z.literal("2.0"),
  maker_control_id: makerControlIdSchema,
  market_id: makerMarketIdSchema,
  maker_wallet: makerPublicKeySchema,
  product: z.enum(["strand", "current"]),
  action: z.enum([
    "strand_upsert",
    "strand_recenter",
    "strand_set_enabled",
    "strand_cancel",
    "current_upsert",
    "current_cancel",
  ]),
  transaction_base64: makerBase64Schema,
  recent_blockhash: makerPublicKeySchema,
  last_valid_block_height: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expires_at_ms: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
const makerPreparationSchema = z.object({
  market: makerMarketSchema,
  base_asset: makerAssetSchema.optional(),
  product: z.enum(["strand", "current"]),
  operation: z.union([makerStrandOperationSchema, makerCurrentOperationSchema]),
  prepared: makerPreparedResponseSchema,
}).strict();
const makerPreparationEnvelopeSchema = z.object({
  version: z.literal(1),
  preparation: makerPreparationSchema,
}).strict();

type MakerQuickstartPreparation = PlatformMakerQuickstartPrepared | PlatformMakerStopPrepared;

function encodeMakerPreparationToken(preparation: MakerQuickstartPreparation): string {
  const checked = makerPreparationSchema.parse(preparation);
  return Buffer.from(JSON.stringify({ version: 1, preparation: checked }), "utf8")
    .toString("base64url");
}

function decodeMakerPreparationToken(token: string): MakerQuickstartPreparation {
  let decoded: unknown;
  try {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) {
      throw new Error("non-canonical base64url");
    }
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("preparationToken is not valid encoded JSON");
  }
  const { preparation } = makerPreparationEnvelopeSchema.parse(decoded);
  const expectedAction = preparation.product === "strand"
    ? preparation.operation.action === "upsert" ? "strand_upsert" : "strand_cancel"
    : preparation.operation.action === "upsert" ? "current_upsert" : "current_cancel";
  if (
    preparation.prepared.product !== preparation.product
    || preparation.prepared.action !== expectedAction
    || preparation.prepared.market_id !== preparation.market.market_id
    || preparation.prepared.maker_wallet !== preparation.operation.makerWallet
    || (preparation.product === "strand"
      && preparation.operation.action === "upsert"
      && !("midPriceAtoms" in preparation.operation))
    || (preparation.product === "current"
      && preparation.operation.action === "upsert"
      && !("halfSpreadBps" in preparation.operation))
    || (preparation.operation.action === "upsert" && preparation.base_asset === undefined)
    || (preparation.base_asset !== undefined
      && preparation.base_asset.asset_id !== preparation.market.base_asset_id)
  ) {
    throw new Error("preparationToken contains inconsistent maker bindings");
  }
  return preparation as MakerQuickstartPreparation;
}

type ToolCapabilityRequirement = {
  readonly ids: readonly string[];
  readonly match?: "all" | "any";
};

const LEGACY_TOOL_CAPABILITIES: Readonly<Record<string, ToolCapabilityRequirement>> = {
  strata_markets: { ids: ["markets.read"] },
  strata_quote: { ids: ["quotes.read"] },
  // Always available for a read-only preview; it only submits when a session exists.
  strata_trade: { ids: ["quotes.read"] },
  strata_exact_output_quote: { ids: ["quotes.read"] },
  strata_execution_challenge: { ids: ["trade.prepare"] },
  strata_execution_prepare: { ids: ["trade.prepare"] },
  strata_execution_submit: { ids: ["trade.submit"] },
  strata_order_challenge: { ids: ["orders.prepare"] },
  strata_order_prepare: { ids: ["orders.prepare"] },
  strata_order_submit: { ids: ["orders.submit"] },
  strata_order_status: { ids: ["orders.submit"] },
  strata_market_making_strand_prepare: { ids: ["mm.strand.manage"] },
  strata_market_making_strand_submit: { ids: ["mm.strand.manage"] },
  strata_market_making_current_prepare: { ids: ["mm.current.manage"] },
  strata_market_making_current_submit: { ids: ["mm.current.manage"] },
  strata_market_making_intent_prepare: { ids: ["mm.intent.manage"] },
  strata_market_making_intent_submit: { ids: ["mm.intent.manage"] },
  strata_market_making_intent_execute: { ids: ["mm.intent.manage"] },
  strata_market_making_prepare: { ids: ["mm.strand.manage", "mm.current.manage"], match: "any" },
  strata_market_making_submit_and_wait: { ids: ["mm.strand.manage", "mm.current.manage"], match: "any" },
  strata_execute_quote: { ids: ["trade.submit"] },
  strata_order_execute: { ids: ["orders.prepare", "orders.submit"] },
};

const PLATFORM_TOOL_CAPABILITIES: Readonly<Record<string, ToolCapabilityRequirement>> = {
  strata_status: { ids: ["platform.status.read"] },
  strata_platform_graph: { ids: ["graphs.read"] },
  strata_candles: { ids: ["market_data.candles.read"] },
  strata_marks: { ids: ["market_data.marks.read"] },
  strata_quote: { ids: ["quotes.market.read"] },
  strata_trade: { ids: ["quotes.market.read"] },
  strata_swap_quote: { ids: ["quotes.swap.read"] },
  strata_exact_output_quote: { ids: ["quotes.exact_output.read"] },
  strata_execution_challenge: { ids: ["execution.prepare"] },
  strata_execution_prepare: { ids: ["execution.prepare"] },
  strata_execution_submit: { ids: ["execution.submit"] },
  strata_execution_status: { ids: ["execution.status.read"] },
  strata_order_challenge: { ids: ["orders.prepare"] },
  strata_order_prepare: { ids: ["orders.prepare"] },
  strata_order_submit: { ids: ["orders.submit"] },
  strata_twap_challenge: { ids: ["algos.twap.place"] },
  strata_twap_cancel: { ids: ["algos.twap.cancel"] },
  strata_twap_prepare: { ids: ["algos.twap.place", "algos.twap.cancel"], match: "any" },
  strata_twap_submit: { ids: ["algos.twap.place", "algos.twap.cancel"], match: "any" },
  strata_twaps: { ids: ["algos.twap.read"] },
  strata_portfolio: { ids: ["portfolio.read"] },
  strata_portfolio_history: { ids: ["portfolio.history.read"] },
  strata_vault_status: { ids: ["vault.status.read"] },
  strata_vault_setup: { ids: ["vault.setup"] },
  strata_vault_deposit: { ids: ["vault.deposit"] },
  strata_vault_withdraw: { ids: ["vault.withdraw"] },
  strata_vault_delegate: { ids: ["vault.delegate.manage"] },
  strata_vault_policy: { ids: ["vault.policy.manage"] },
  strata_vault_pause: { ids: ["vault.pause"] },
  strata_vault_submit: { ids: ["vault.relay"] },
  strata_vault_submission: { ids: ["vault.relay"] },
  strata_market_making_status: { ids: ["mm.status.read"] },
  strata_market_making_reputation: { ids: ["mm.reputation.read"] },
  strata_market_making_strand_prepare: { ids: ["mm.strand.manage"] },
  strata_market_making_strand_submit: { ids: ["mm.strand.manage"] },
  strata_market_making_current_prepare: { ids: ["mm.current.manage"] },
  strata_market_making_current_submit: { ids: ["mm.current.manage"] },
  strata_market_making_intent_prepare: { ids: ["mm.intent.manage"] },
  strata_market_making_intent_submit: { ids: ["mm.intent.manage"] },
  strata_market_making_intent_execute: { ids: ["mm.intent.manage"] },
  strata_market_making_prepare: { ids: ["mm.strand.manage", "mm.current.manage"], match: "any" },
  strata_market_making_submit_and_wait: { ids: ["mm.strand.manage", "mm.current.manage"], match: "any" },
  strata_rewards: { ids: ["rewards.read"] },
  strata_referrals: { ids: ["referrals.read"] },
  strata_referral_link: { ids: ["referrals.link"] },
  strata_referral_claim: { ids: ["referrals.claim"] },
  strata_bug_submit: { ids: ["bugs.submit"] },
  strata_bugs: { ids: ["bugs.read"] },
  strata_order_execute: { ids: ["orders.prepare", "orders.submit"] },
  strata_twap_execute: { ids: ["algos.twap.place", "algos.twap.cancel"], match: "any" },
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

type OrderOperationArgs = {
  action: "place" | "cancel" | "cancel_all" | "replace" | "batch";
  ownerWallet: string;
  sessionPublicKey: string;
  accountSequence?: string | undefined;
  clientOrderId?: string | undefined;
  side?: "buy" | "sell" | undefined;
  orderType?: "good_until_cancelled" | "post_only" | undefined;
  limitPriceAtoms?: string | undefined;
  sizeAtoms?: string | undefined;
  orderId?: string | undefined;
  operations?: Array<{
    action: "place" | "cancel" | "replace";
    accountSequence?: string | undefined;
    clientOrderId?: string | undefined;
    side?: "buy" | "sell" | undefined;
    orderType?: "good_until_cancelled" | "post_only" | undefined;
    limitPriceAtoms?: string | undefined;
    sizeAtoms?: string | undefined;
    orderId?: string | undefined;
  }> | undefined;
};

/** Map tool arguments onto one order-control operation, or a tool error. */
function orderOperationFromArgs(
  args: OrderOperationArgs,
): PlatformOrderChallengeInput | ReturnType<typeof toolError> {
      let request: PlatformOrderChallengeInput;
      if (args.action === "place") {
        if (
          args.clientOrderId === undefined
          || args.side === undefined
          || args.orderType === undefined
          || args.limitPriceAtoms === undefined
          || args.sizeAtoms === undefined
        ) {
          return toolError(
            "invalid_request",
            "Place requires clientOrderId, side, orderType, limitPriceAtoms, and sizeAtoms.",
            false,
          );
        }
        request = {
          action: "place",
          ownerWallet: args.ownerWallet,
          sessionPublicKey: args.sessionPublicKey,
          ...(args.accountSequence === undefined ? {} : { accountSequence: args.accountSequence }),
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
      } else if (args.action === "cancel_all") {
        request = {
          action: "cancel_all",
          ownerWallet: args.ownerWallet,
          sessionPublicKey: args.sessionPublicKey,
        };
      } else if (args.action === "replace") {
        if (
          args.orderId === undefined
          || args.clientOrderId === undefined
          || args.side === undefined
          || args.orderType === undefined
          || args.limitPriceAtoms === undefined
          || args.sizeAtoms === undefined
        ) {
          return toolError(
            "invalid_request",
            "Replace requires orderId, clientOrderId, side, orderType, limitPriceAtoms, and sizeAtoms.",
            false,
          );
        }
        request = {
          action: "replace",
          ownerWallet: args.ownerWallet,
          sessionPublicKey: args.sessionPublicKey,
          orderId: args.orderId,
          ...(args.accountSequence === undefined ? {} : { accountSequence: args.accountSequence }),
          clientOrderId: args.clientOrderId,
          side: args.side,
          orderType: args.orderType,
          limitPriceAtoms: args.limitPriceAtoms,
          sizeAtoms: args.sizeAtoms,
        };
      } else {
        if (args.operations === undefined) {
          return toolError("invalid_request", "Batch requires operations.", false);
        }
        const operations: PlatformOrderBatchOperation[] = [];
        for (const operation of args.operations) {
          if (operation.action === "cancel") {
            if (operation.orderId === undefined) {
              return toolError("invalid_request", "Batch cancel requires orderId.", false);
            }
            operations.push({ action: "cancel", orderId: operation.orderId });
            continue;
          }
          if (
            operation.clientOrderId === undefined
            || operation.side === undefined
            || operation.orderType === undefined
            || operation.limitPriceAtoms === undefined
            || operation.sizeAtoms === undefined
            || (operation.action === "replace" && operation.orderId === undefined)
          ) {
            return toolError(
              "invalid_request",
              `Batch ${operation.action} has incomplete fields.`,
              false,
            );
          }
          const place = {
            ...(operation.accountSequence === undefined
              ? {}
              : { accountSequence: operation.accountSequence }),
            clientOrderId: operation.clientOrderId,
            side: operation.side,
            orderType: operation.orderType,
            limitPriceAtoms: operation.limitPriceAtoms,
            sizeAtoms: operation.sizeAtoms,
          };
          operations.push(operation.action === "replace"
            ? { action: "replace", orderId: operation.orderId!, ...place }
            : { action: "place", ...place });
        }
        request = {
          action: "batch",
          ownerWallet: args.ownerWallet,
          sessionPublicKey: args.sessionPublicKey,
          operations,
        };
      }
      return request;
}

/** Opaque platform identity attached to each market the `strata_markets` tool lists. */
interface PlatformMarketIdentity {
  readonly market_id: string;
  readonly base_asset_id: string;
  readonly quote_asset_id: string;
  readonly status: PlatformMarket["status"];
  readonly available_actions: PlatformMarket["available_actions"];
}

type MarketsToolResponse = Omit<MarketsResponse, "markets"> & {
  readonly markets: ReadonlyArray<MarketsResponse["markets"][number] & Partial<PlatformMarketIdentity>>;
};

const PLATFORM_MARKET_PAGE_LIMIT = 100;
const PLATFORM_MARKET_MAX_PAGES = 20;

/**
 * Every live platform market keyed by label, so the tool can hand agents the
 * opaque `market_id` (and asset ids) that every by-market tool takes. A
 * platform read failure leaves the list unidentified rather than failing it.
 */
async function platformMarketIdentities(
  platformClient: Pick<StrataPlatformClient, "markets">,
): Promise<Map<string, PlatformMarketIdentity>> {
  const identities = new Map<string, PlatformMarketIdentity>();
  try {
    let cursor: string | undefined;
    for (let page = 0; page < PLATFORM_MARKET_MAX_PAGES; page += 1) {
      const response = await platformClient.markets.list(
        cursor === undefined
          ? { limit: PLATFORM_MARKET_PAGE_LIMIT }
          : { limit: PLATFORM_MARKET_PAGE_LIMIT, cursor },
      );
      for (const market of response.markets) {
        identities.set(market.label, {
          market_id: market.market_id,
          base_asset_id: market.base_asset_id,
          quote_asset_id: market.quote_asset_id,
          status: market.status,
          available_actions: market.available_actions,
        });
      }
      if (!response.page.has_more || response.page.next_cursor === null) break;
      cursor = response.page.next_cursor;
    }
  } catch {
    // Identity is a convenience layered on the Sonar list; never fail the list for it.
  }
  return identities;
}

export async function createStrataMcpServer(
  options: StrataMcpOptions = {},
): Promise<StrataMcpRuntime> {
  const client = strataClient(options);
  const toolMode = options.toolMode ?? "simple";
  const platformClient = options.platformClient ?? new StrataPlatformClient({
    apiBase: options.apiBase,
    timeoutMs: options.timeoutMs,
  });
  const initialCatalog = await client.capabilities();
  if (initialCatalog.contract_version !== STRATA_AGENT_HARNESS.contract_version) {
    throw new Error("agent harness and live contract versions differ");
  }
  const initialPlatformCatalog = await platformClient.discovery.read();
  const server = new McpServer(
    {
      name: "strata",
      version: SERVER_VERSION,
    },
    {
      instructions: STRATA_AGENT_HARNESS_INSTRUCTIONS,
    },
  );
  const { registerTool, handles: registeredTools } = trackedToolRegistrar(server);
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
    "strata_platform_graph",
    STRATA_PLATFORM_GRAPH_URI,
    {
      title: "Strata Platform Graph",
      description:
        "Complete customer-safe entity, operation, and workflow graph with live capability gates.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: STRATA_PLATFORM_GRAPH_URI,
          mimeType: "application/json",
          text: JSON.stringify(await platformClient.discovery.graph()),
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

  registerTool(
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

  registerTool(
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

  registerTool(
    "strata_platform_graph",
    {
      title: "Strata platform graph",
      description:
        "Discover every public module, entity relationship, operation binding, workflow, and live availability gate.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const graph: PlatformActionGraphResponse = await platformClient.discovery.graph();
      const liveOperations = graph.operations.filter((operation) => operation.available).length;
      return toolResult(
        graph,
        `${liveOperations} of ${graph.operations.length} mapped Strata operations are currently live.`,
      );
    },
  );

  registerTool(
    "strata_market_making_status",
    {
      title: "Read Strata maker status",
      description:
        "A maker's products, live exposure, health, and kill state in one market — public by wallet address, no signature.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ marketId, walletAddress }) => {
      const response = await platformClient.marketMaking.status(marketId, walletAddress);
      return toolResult(
        response,
        `${response.active_products} active maker products; reconcile Strand, Current, signed-quote, and dead-man state before changing exposure.`,
      );
    },
  );

  registerTool(
    "strata_market_making_reputation",
    {
      title: "Read Strata maker reputation",
      description:
        "A maker's reliability, participation, tier, and signed-quote eligibility in one market — public by wallet address, no signature.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ marketId, walletAddress }) => toolResult(
      await platformClient.marketMaking.reputation(marketId, walletAddress),
      "Maker reputation record. Use tier_progress and signed_quote_stream_eligible before choosing a maker transport.",
    ),
  );

  registerTool(
    "strata_status",
    {
      title: "Strata status",
      description: "Read product-level readiness and the number of currently live mapped operations.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const status = await platformClient.discovery.status();
      return toolResult(
        status,
        `Strata is ${status.status}; ${status.available_operations} mapped operations are live.`,
      );
    },
  );

  registerTool(
    "strata_candles",
    {
      title: "Strata candles",
      description: "Read bounded time-bucketed candles for one opaque Strata market ID.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        fromMs: z.number().int().nonnegative(),
        toMs: z.number().int().positive(),
        resolutionSeconds: z.number().int().min(60).max(86_400).optional().default(300),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ marketId, fromMs, toMs, resolutionSeconds }) => {
      const candles = await platformClient.marketData.candles(marketId, {
        fromMs,
        toMs,
        resolutionSeconds,
      });
      return toolResult(candles, `${candles.candles.length} Strata candles returned.`);
    },
  );

  registerTool(
    "strata_marks",
    {
      title: "Strata mark",
      description: "Read the current customer-facing reference price for one opaque market ID.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ marketId }) => {
      const mark = await platformClient.marketData.mark(marketId);
      return toolResult(mark, mark.stale ? "Strata mark is stale." : "Current Strata mark.");
    },
  );

  registerTool(
    "strata_book",
    {
      title: "Strata order book",
      description:
        "Read the executable order book for one opaque market ID: bids and asks, one size per price "
        + "level. Top of book is the best bid and ask.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        depth: z
          .number()
          .int()
          .min(1)
          .max(2_000)
          .optional()
          .describe("Price levels per side (default server depth; max 2000)."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ marketId, depth }) => {
      const book = await platformClient.books.snapshot(
        marketId,
        depth === undefined ? {} : { depth },
      );
      return toolResult(
        book,
        `Book for ${marketId}: ${book.bids.length} bid / ${book.asks.length} ask levels at sequence ${book.sequence}.`,
      );
    },
  );

  registerTool(
    "strata_bbo",
    {
      title: "Strata best bid/ask",
      description:
        "Read the current best bid and best ask (top of book) for one opaque market ID.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ marketId }) => {
      const bbo = await platformClient.books.bestBidAsk(marketId);
      return toolResult(
        bbo,
        `BBO for ${marketId}: bid ${bbo.best_bid?.price_atoms ?? "—"} / ask ${bbo.best_ask?.price_atoms ?? "—"}.`,
      );
    },
  );

  registerTool(
    "strata_trades",
    {
      title: "Strata recent trades",
      description:
        "Read recent anonymized prints for one opaque market ID: price, size, side, and time.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Most recent prints to return (default server limit; max 500)."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ marketId, limit }) => {
      const trades = await platformClient.books.trades(
        marketId,
        limit === undefined ? {} : { limit },
      );
      return toolResult(trades, `${trades.trades.length} recent prints for ${marketId}.`);
    },
  );

  registerTool(
    "strata_execution_status",
    {
      title: "Strata execution status",
      description: "Recover prepared state or a restart-durable confirmed execution receipt.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        executionId: z.string().regex(/^se_[0-9a-f]{32}$/),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ marketId, executionId }) => {
      const receipt = await platformClient.executions.status(marketId, executionId);
      return toolResult(receipt, `Execution is ${receipt.status}.`);
    },
  );

  registerTool(
    "strata_twaps",
    {
      title: "Strata TWAPs",
      description: "Read sanitized progress and terminal receipts for wallet-owned TWAP schedules.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ marketId, walletAddress }) => {
      const response = await platformClient.algos.twaps(marketId, walletAddress);
      return toolResult(response, `${response.twaps.length} TWAP schedules returned.`);
    },
  );

  registerTool(
    "strata_twap_challenge",
    {
      title: "Prepare a Strata TWAP authorization",
      description: "Request exact external-signing bytes for a bounded TWAP schedule.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        ownerWallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        sessionPublicKey: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        side: z.enum(["buy", "sell"]),
        totalSizeAtoms: z.string().regex(/^[1-9][0-9]*$/),
        slicesTotal: z.number().int().min(2).max(120),
        maximumToleranceBps: z.number().int().min(1).max(1_000),
        intervalSlots: z.number().int().min(25).max(4_500),
        limitPriceAtoms: z.string().regex(/^[1-9][0-9]*$/),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const response = await platformClient.algos.challenge(input.marketId, {
        action: "place",
        ownerWallet: input.ownerWallet,
        sessionPublicKey: input.sessionPublicKey,
        side: input.side,
        totalSizeAtoms: input.totalSizeAtoms,
        slicesTotal: input.slicesTotal,
        maximumToleranceBps: input.maximumToleranceBps,
        intervalSlots: input.intervalSlots,
        limitPriceAtoms: input.limitPriceAtoms,
      });
      return toolResult(response, "Sign the returned authorization payload externally.");
    },
  );

  registerTool(
    "strata_twap_cancel",
    {
      title: "Prepare Strata TWAP cancellation",
      description: "Request exact external-signing bytes to cancel one active owned TWAP.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        ownerWallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        sessionPublicKey: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        twapId: z.string().regex(/^twap_[0-9a-f]{32}$/),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const response = await platformClient.algos.challenge(input.marketId, {
        action: "cancel",
        ownerWallet: input.ownerWallet,
        sessionPublicKey: input.sessionPublicKey,
        twapId: input.twapId,
      });
      return toolResult(response, "Sign the returned cancellation payload externally.");
    },
  );

  registerTool(
    "strata_twap_prepare",
    {
      title: "Prepare Strata TWAP transaction",
      description:
        "Prepare a canonical TWAP transaction. One signature: pass the action itself (place fields or twapId to cancel) and sign only the returned transaction. (A challengeId + authorizationSignature is still accepted.)",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        challengeId: z.string().regex(/^twc_[0-9a-f]{32}$/).optional(),
        authorizationSignature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/).optional(),
        action: z.enum(["place", "cancel"]).optional(),
        ownerWallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
        sessionPublicKey: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
        side: z.enum(["buy", "sell"]).optional(),
        totalSizeAtoms: z.string().regex(/^[1-9][0-9]*$/).optional(),
        slicesTotal: z.number().int().min(2).max(120).optional(),
        maximumToleranceBps: z.number().int().min(1).max(1_000).optional(),
        intervalSlots: z.number().int().min(25).max(4_500).optional(),
        limitPriceAtoms: z.string().regex(/^[1-9][0-9]*$/).optional(),
        twapId: z.string().regex(/^twap_[0-9a-f]{32}$/).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      if (input.challengeId !== undefined || input.authorizationSignature !== undefined) {
        if (input.challengeId === undefined || input.authorizationSignature === undefined) {
          return toolError("invalid_request", "The two-step path needs both challengeId and authorizationSignature.", false);
        }
        const response = await platformClient.algos.prepare(input.marketId, {
          challengeId: input.challengeId,
          authorizationSignature: input.authorizationSignature,
        });
        return toolResult(response, "Verify and sign this canonical transaction externally.");
      }
      if (input.ownerWallet === undefined || input.sessionPublicKey === undefined || input.action === undefined) {
        return toolError("invalid_request", "Pass action, ownerWallet, and sessionPublicKey (or a signed challenge).", false);
      }
      let operation: PlatformTwapChallengeInput;
      if (input.action === "cancel") {
        if (input.twapId === undefined) return toolError("invalid_request", "Cancel requires twapId.", false);
        operation = {
          action: "cancel",
          ownerWallet: input.ownerWallet,
          sessionPublicKey: input.sessionPublicKey,
          twapId: input.twapId,
        };
      } else {
        if (
          input.side === undefined
          || input.totalSizeAtoms === undefined
          || input.slicesTotal === undefined
          || input.maximumToleranceBps === undefined
          || input.intervalSlots === undefined
          || input.limitPriceAtoms === undefined
        ) {
          return toolError("invalid_request", "Place requires side, totalSizeAtoms, slicesTotal, maximumToleranceBps, intervalSlots, and limitPriceAtoms.", false);
        }
        operation = {
          action: "place",
          ownerWallet: input.ownerWallet,
          sessionPublicKey: input.sessionPublicKey,
          side: input.side,
          totalSizeAtoms: input.totalSizeAtoms,
          slicesTotal: input.slicesTotal,
          maximumToleranceBps: input.maximumToleranceBps,
          intervalSlots: input.intervalSlots,
          limitPriceAtoms: input.limitPriceAtoms,
        };
      }
      const response = await platformClient.algos.prepare(input.marketId, { operation });
      return toolResult(
        response,
        "One signature: verify this canonical transaction, then sign it externally with the session key and submit.",
      );
    },
  );

  registerTool(
    "strata_twap_submit",
    {
      title: "Submit Strata TWAP transaction",
      description: "Submit the exact externally signed TWAP transaction idempotently.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        twapControlId: z.string().regex(/^twctl_[0-9a-f]{32}$/),
        signedTransactionBase64: z.string().min(4),
        idempotencyKey: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ marketId, twapControlId, signedTransactionBase64, idempotencyKey }) => {
      const response = await platformClient.algos.submit(marketId, {
        twapControlId,
        signedTransactionBase64,
        idempotencyKey,
      });
      return toolResult(response, `TWAP action submitted as ${response.signature}.`);
    },
  );

  registerTool(
    "strata_portfolio",
    {
      title: "Strata account",
      description:
        "The whole account in one public read, by wallet address: balances (total / available / locked, exact USD), positions, open orders, and recent fills across every live market. No signature, no session key, no market selection.",
      inputSchema: {
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ walletAddress }) => {
      const response = await platformClient.account.read(walletAddress);
      const activity = `${response.open_orders.length} open orders, ${response.recent_fills.length} recent fills`
        + (response.unavailable_market_ids.length > 0
          ? ` (${response.unavailable_market_ids.length} markets unavailable)`
          : "");
      return toolResult(
        response,
        response.valuation_complete
          ? `${response.balances.length} held assets; ${activity}; equity ${response.equity_usd_micros} USD micros at slot ${response.observed_slot}.`
          : `${response.balances.length} held assets; ${activity}; ${response.unpriced_asset_ids.length} unpriced, USD totals unavailable.`,
      );
    },
  );

  registerTool(
    "strata_portfolio_history",
    {
      title: "Strata portfolio history",
      description: "Read genuine stored account-equity history in exact USD micros.",
      inputSchema: {
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        range: z.enum(["24h", "7d", "30d"]).optional().default("24h"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ walletAddress, range }) => {
      const response = await platformClient.account.portfolioHistory(walletAddress, range);
      return toolResult(response, `${response.points.length} stored equity samples returned.`);
    },
  );

  registerTool(
    "strata_vault_status",
    {
      title: "Strata Vault status",
      description:
        "Read sealed owner state and optional external-session readiness without construction identifiers.",
      inputSchema: {
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        sessionPublicKey: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ walletAddress, sessionPublicKey }) => {
      const response = await platformClient.vault.status({ walletAddress, sessionPublicKey });
      return toolResult(
        response,
        response.session === null
          ? `Vault is ${response.state}; no session was requested.`
          : `Vault is ${response.state}; requested session is ${response.session.state}.`,
      );
    },
  );

  registerTool(
    "strata_vault_pause",
    {
      title: "Prepare Strata Vault pause",
      description:
        "Prepare an owner-authorized pause or resume transaction for external verification, signing, and broadcast.",
      inputSchema: {
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        paused: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ walletAddress, paused }) => {
      const response = await platformClient.vault.preparePause({ walletAddress, paused });
      return toolResult(
        response,
        `Verify this ${paused ? "pause" : "resume"} transaction, then owner-sign it and pass preparation_id + the signed transaction to strata_vault_submit (Strata pays the fee when sponsored is true).`,
      );
    },
  );

  registerTool(
    "strata_vault_setup",
    {
      title: "Prepare Strata Vault onboarding",
      description:
        "One-signature onboarding: register an external session key for a wallet. Only the wallet and the session key are needed; one session then trades every market. Policy fields are optional. A first strata_vault_deposit that names the session key does this in the same transaction.",
      inputSchema: {
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        sessionPublicKey: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/).optional(),
        spendingLimits: z
          .array(
            z.object({
              assetId: z.string().regex(/^asset_[0-9a-f]{32}$/),
              maximumPerExecutionAtoms: z.string().regex(/^[1-9][0-9]*$/).optional(),
            }),
          )
          .max(4)
          .optional(),
        expiresAtMs: z.number().int().positive().optional(),
        minimumIntervalSeconds: z.number().int().min(1).max(86_400).optional(),
        maximumToleranceBps: z.number().int().min(1).max(1_000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      walletAddress,
      sessionPublicKey,
      marketId,
      spendingLimits,
      expiresAtMs,
      minimumIntervalSeconds,
      maximumToleranceBps,
    }) => {
      const response = await platformClient.vault.prepareSetup({
        walletAddress,
        sessionPublicKey,
        marketId: marketId ?? null,
        expiresAtMs: expiresAtMs ?? null,
        minimumIntervalSeconds,
        maximumToleranceBps,
        spendingLimits: (spendingLimits ?? []).map((limit) => ({
          assetId: limit.assetId,
          maximumPerExecutionAtoms: limit.maximumPerExecutionAtoms ?? null,
        })),
      });
      return toolResult(
        response,
        "Verify every echoed session policy field, then owner-sign it and pass preparation_id + the signed transaction to strata_vault_submit (Strata pays the fee when sponsored is true).",
      );
    },
  );

  registerTool(
    "strata_vault_deposit",
    {
      title: "Prepare Strata Vault deposit",
      description: "Prepare an exact owner-funded Vault deposit using opaque market and asset IDs. Name sessionPublicKey and a first deposit also registers that session in the same transaction (one owner signature onboards and funds the wallet).",
      inputSchema: {
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        assetId: z.string().regex(/^asset_[0-9a-f]{32}$/),
        amountAtoms: z.string().regex(/^[1-9][0-9]*$/),
        sessionPublicKey: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ walletAddress, marketId, assetId, amountAtoms, sessionPublicKey }) => {
      const response = await platformClient.vault.prepareDeposit({
        walletAddress,
        marketId,
        assetId,
        amountAtoms,
        sessionPublicKey: sessionPublicKey ?? null,
      });
      return toolResult(
        response,
        response.registers_session
          ? "This deposit also registers the session key. Verify the exact market, asset, amount, and session, then owner-sign it and pass preparation_id + the signed transaction to strata_vault_submit (Strata pays the fee when sponsored is true)."
          : "Verify the exact market, asset, and amount, then owner-sign it and pass preparation_id + the signed transaction to strata_vault_submit (Strata pays the fee when sponsored is true).",
      );
    },
  );

  registerTool(
    "strata_vault_withdraw",
    {
      title: "Prepare Strata Vault withdrawal",
      description:
        "Prepare an exact owner-authorized withdrawal to a destination wallet.",
      inputSchema: {
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        assetId: z.string().regex(/^asset_[0-9a-f]{32}$/),
        destinationWalletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        amountAtoms: z.string().regex(/^[1-9][0-9]*$/),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ walletAddress, marketId, assetId, destinationWalletAddress, amountAtoms }) => {
      const response = await platformClient.vault.prepareWithdrawal({
        walletAddress,
        marketId,
        assetId,
        destinationWalletAddress,
        amountAtoms,
      });
      return toolResult(
        response,
        "Verify the exact destination and amount, then owner-sign it and pass preparation_id + the signed transaction to strata_vault_submit (Strata pays the fee when sponsored is true).",
      );
    },
  );

  registerTool(
    "strata_vault_delegate",
    {
      title: "Prepare Strata Vault session control",
      description:
        "Prepare owner-authorized revocation of one externally held Vault session key.",
      inputSchema: {
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        sessionPublicKey: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        action: z.literal("revoke"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ walletAddress, sessionPublicKey, action }) => {
      const response = await platformClient.vault.prepareDelegate({
        walletAddress,
        sessionPublicKey,
        action,
      });
      return toolResult(
        response,
        "Verify both identities and the destructive action, then owner-sign it and pass preparation_id + the signed transaction to strata_vault_submit (Strata pays the fee when sponsored is true).",
      );
    },
  );

  registerTool(
    "strata_vault_policy",
    {
      title: "Prepare Strata Vault withdrawal policy",
      description:
        "Prepare an owner-authorized blocked or restricted withdrawal access policy.",
      inputSchema: {
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        mode: z.enum(["blocked", "restricted"]),
        allowedWalletAddresses: z.array(
          z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        ).max(8).optional().default([]),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ walletAddress, mode, allowedWalletAddresses }) => {
      const response = await platformClient.vault.preparePolicy({
        walletAddress,
        withdrawalAccess: { mode, allowedWalletAddresses },
      });
      return toolResult(
        response,
        "Verify the exact withdrawal access policy, then owner-sign it and pass preparation_id + the signed transaction to strata_vault_submit (Strata pays the fee when sponsored is true).",
      );
    },
  );

  registerTool(
    "strata_vault_submit",
    {
      title: "Submit a prepared Strata Vault transaction",
      description:
        "Submit an owner-signed prepared Vault transaction (setup, deposit, withdrawal, session, "
        + "policy, pause). Strata verifies it is exactly the prepared transaction, pays the network "
        + "fee and any rent when the preparation was sponsored (owners without SOL; recovered later "
        + "from their deposits as network_cost_atoms), and broadcasts it — the owner needs no SOL "
        + "and no RPC. Idempotent per idempotencyKey; read the outcome with strata_vault_submission.",
      inputSchema: {
        preparationId: z.string().regex(/^vp_[0-9a-f]{32}$/).describe("preparation_id from the prepare response."),
        signedTransactionBase64: z.string().min(1).describe("The prepared transaction with the owner's signature added, base64."),
        idempotencyKey: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ preparationId, signedTransactionBase64, idempotencyKey }) => {
      const response = await platformClient.vault.submit({
        preparationId,
        signedTransactionBase64,
        idempotencyKey,
      });
      return toolResult(
        response,
        `Vault ${response.action} ${response.status}${response.sponsored ? " (Strata paid the fee)" : ""}: `
          + `signature ${response.signature}. Poll strata_vault_submission until confirmed.`,
      );
    },
  );

  registerTool(
    "strata_vault_submission",
    {
      title: "Strata Vault submission status",
      description: "Read the durable outcome of a submitted Vault transaction: submitted, confirmed, or failed.",
      inputSchema: {
        preparationId: z.string().regex(/^vp_[0-9a-f]{32}$/),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ preparationId }) => {
      const response = await platformClient.vault.submission(preparationId);
      return toolResult(
        response,
        `Vault ${response.action} is ${response.status}`
          + `${response.failure_code ? ` (${response.failure_code})` : ""}.`,
      );
    },
  );

  registerTool(
    "strata_rewards",
    {
      title: "Strata rewards",
      description: "Read the current rewards season, standings, and optional owner score.",
      inputSchema: {
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
        limit: z.number().int().min(1).max(100).optional().default(25),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ walletAddress, limit }) => {
      const response = await platformClient.rewards.read({ walletAddress, limit });
      return toolResult(response, `${response.standings.length} reward standings returned.`);
    },
  );

  registerTool(
    "strata_referrals",
    {
      title: "Strata referrals",
      description: "Read an owner's referral state and exact claimable reward atoms.",
      inputSchema: {
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ walletAddress }) => {
      const response = await platformClient.referrals.read(walletAddress);
      return toolResult(response, response.enabled ? "Referral state returned." : "Referrals are disabled.");
    },
  );

  registerTool(
    "strata_referral_link",
    {
      title: "Link a Strata referral",
      description:
        "Prepare or submit an externally authorized referral link for a new wallet.",
      inputSchema: {
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        referralCode: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
        authorizationSignature: z.string().regex(/^(?:0x)?[0-9a-fA-F]{128}$/).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ walletAddress, referralCode, authorizationSignature }) => {
      if (authorizationSignature === undefined) {
        const payload = platformClient.referrals.linkAuthorizationPayload(referralCode);
        return toolResult({
          wallet_address: walletAddress,
          authorization_payload_base64: Buffer.from(payload).toString("base64"),
        }, "Have the referred wallet sign this payload externally, then call again with its hex signature.");
      }
      const response: PlatformReferralLinkResponse = await platformClient.referrals.link({
        walletAddress,
        referralCode,
        authorizationSignature,
      });
      return toolResult(response, "Referral link is pending the wallet's first fill.");
    },
  );

  registerTool(
    "strata_referral_claim",
    {
      title: "Claim Strata referral rewards",
      description:
        "Prepare or submit an externally authorized request for currently claimable referral rewards.",
      inputSchema: {
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        payoutWalletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
        authorizationSignature: z.string().regex(/^(?:0x)?[0-9a-fA-F]{128}$/).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ walletAddress, payoutWalletAddress, authorizationSignature }) => {
      const payout = payoutWalletAddress ?? walletAddress;
      if (authorizationSignature === undefined) {
        const payload = platformClient.referrals.claimAuthorizationPayload(payout);
        return toolResult({
          wallet_address: walletAddress,
          payout_wallet_address: payout,
          authorization_payload_base64: Buffer.from(payload).toString("base64"),
        }, "Have the claiming wallet sign this payload externally, then call again with its hex signature.");
      }
      const response: PlatformReferralClaimResponse = await platformClient.referrals.claim({
        walletAddress,
        payoutWalletAddress: payout,
        authorizationSignature,
      });
      return toolResult(response, `${response.claimable_atoms} referral reward atoms requested.`);
    },
  );

  registerTool(
    "strata_bugs",
    {
      title: "Strata bug reports",
      description: "Read an owner's redacted bug reports and confirmed points.",
      inputSchema: {
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ walletAddress }) => {
      const response = await platformClient.bugs.read(walletAddress);
      return toolResult(response, `${response.reports.length} redacted bug reports returned.`);
    },
  );

  registerTool(
    "strata_bug_submit",
    {
      title: "Submit Strata bug report",
      description:
        "Prepare or submit a bug report. Omit authorizationSignature to receive the exact "
        + "payload for the owner wallet to sign externally; provide that hex signature to submit.",
      inputSchema: {
        ownerWallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        message: z.string().trim().min(1).max(2_000),
        authorizationSignature: z.string().regex(/^(?:0x)?[0-9a-fA-F]{128}$/).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ ownerWallet, message, authorizationSignature }) => {
      if (authorizationSignature === undefined) {
        const payload = platformClient.bugs.authorizationPayload(message);
        return toolResult({
          owner_wallet: ownerWallet,
          authorization_payload_base64: Buffer.from(payload).toString("base64"),
        }, "Sign this payload externally, then call strata_bug_submit again with the hex signature.");
      }
      const response = await platformClient.bugs.submit({
        ownerWallet,
        message,
        authorizationSignature,
      });
      return toolResult(response, `Bug report ${response.bug_id} is pending review.`);
    },
  );

  const markets = registerTool(
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
        const visible = includePaused
          ? response.markets
          : response.markets.filter((market) => market.ready);
        const identities = await platformMarketIdentities(platformClient);
        const output: MarketsToolResponse = {
          ...response,
          markets: visible.map((market) => {
            const identity = identities.get(market.label);
            return identity === undefined ? market : { ...market, ...identity };
          }),
        };
        const identified = output.markets.filter((market) => "market_id" in market).length;
        return toolResult(
          output,
          `${output.markets.length} Strata markets available`
            + (identified > 0
              ? `; ${identified} carry a market_id — pass it as marketId to every by-market tool.`
              : "."),
        );
      }),
  );

  const quote = registerTool(
    "strata_quote",
    {
      title: "Sonar quote",
      description:
        "Request a short-lived Sonar quote. Use a market label and a human amount such as "
        + "0.1 SOL, 20 USDC, or $20; exact input atoms remain available for advanced clients. "
        + "Returns expected output, fees, price impact, and expiry.",
      inputSchema: {
        market: z
          .string()
          .min(1)
          .max(128)
          .describe("Market label such as SOL/USDC, or its public market ID."),
        side: z.enum(["buy", "sell"]).describe("Buy or sell the market's base asset."),
        amount: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe("Human input amount, for example 0.1 SOL, 20 USDC, or $20."),
        amountInAtoms: z
          .string()
          .regex(/^[0-9]+$/)
          .max(20)
          .optional()
          .describe("Advanced: exact input amount in the input token's smallest atomic unit."),
        maximumToleranceBps: z
          .number()
          .int()
          .min(0)
          .max(1_000)
          .optional()
          .default(DEFAULT_MAXIMUM_TOLERANCE_BPS)
          .describe(
            "The most you accept below the quoted output, in basis points (default 0: the "
            + "quoted output exactly). This is YOUR choice. It is not price impact — "
            + "price_impact_pct in the response is measured from the book and is not a setting.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ market, side, amount, amountInAtoms, maximumToleranceBps }) =>
      guardedTool(client, "quotes.read", async () => {
        if ((amount === undefined) === (amountInAtoms === undefined)) {
          return toolError(
            "invalid_amount",
            "Give exactly one amount: a human value such as 0.1 SOL, or amountInAtoms for advanced use.",
            false,
          );
        }
        let resolvedMarket = market;
        let resolvedAtoms = amountInAtoms;
        let display:
          | { input: string; outputSymbol: string; outputDecimals: number }
          | undefined;
        if (amount !== undefined) {
          try {
            const parsed = humanQuoteAmount((await client.markets()).markets, market, side, amount);
            resolvedMarket = parsed.market.label;
            resolvedAtoms = parsed.atoms;
            display = {
              input: parsed.display,
              outputSymbol: parsed.outputSymbol,
              outputDecimals: parsed.outputDecimals,
            };
          } catch (error) {
            return toolError("invalid_amount", safeMessage(error), false);
          }
        }
        const request: QuoteRequest = {
          market: resolvedMarket,
          side,
          amountInAtoms: resolvedAtoms!,
          maximumToleranceBps,
        };
        const response: QuoteResponse = await retryReadOnce(() => client.quote(request));
        return toolResult(response, quoteSummary(response, display));
      }),
  );

  const exactOutputQuote = registerTool(
    "strata_exact_output_quote",
    {
      title: "Sonar exact-output quote",
      description:
        "Request a short-lived Sonar quote for an exact output amount (for example: buy "
        + "1 SOL). Strata inverts its best route and returns the input that delivers it as "
        + "amount_in_atoms; minimum_output_atoms is the requested amount lowered by the "
        + "optional maximumToleranceBps (default 0: exactly the requested amount or the "
        + "execution fails closed). Execute it with the same quote_id flow as strata_quote.",
      inputSchema: {
        market: z
          .string()
          .min(1)
          .max(128)
          .describe("Market label such as SOL/USDC, or its public market ID."),
        side: z.enum(["buy", "sell"]).describe("Buy or sell the market's base asset."),
        amountOutAtoms: z
          .string()
          .regex(/^[0-9]+$/)
          .max(20)
          .describe(
            "Output amount to receive at least, in the output token's smallest atomic unit "
            + "(base atoms for a buy, quote atoms for a sell).",
          ),
        maximumToleranceBps: z
          .number()
          .int()
          .min(0)
          .max(1_000)
          .optional()
          .default(DEFAULT_MAXIMUM_TOLERANCE_BPS)
          .describe(
            "The most you accept below the quoted output, in basis points (default 0: the "
            + "quoted output exactly). This is YOUR choice. It is not price impact — "
            + "price_impact_pct in the response is measured from the book and is not a setting.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ market, side, amountOutAtoms, maximumToleranceBps }) =>
      guardedTool(client, "quotes.read", async () => {
        const request: QuoteRequest = {
          market,
          side,
          amountOutAtoms,
          maximumToleranceBps,
        };
        const response: QuoteResponse = await retryReadOnce(() => client.quote(request));
        return toolResult(response, quoteSummary(response));
      }),
  );

  registerTool(
    "strata_trade",
    {
      title: "Trade on Strata",
      description:
        "Quote and trade in one obvious tool. Human amounts such as 0.1 SOL and $20 are supported. "
        + "Without a trading connection it returns the live read-only quote plus one setup link; "
        + "with a session it follows the user's autonomy limits and may submit.",
      inputSchema: {
        market: z.string().min(1).max(128).describe("Market label, for example SOL/USDC."),
        side: z.enum(["buy", "sell"]),
        amount: z.string().min(1).max(64).optional()
          .describe("Human input amount, for example 0.1 SOL, 20 USDC, or $20."),
        amountInAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional()
          .describe("Advanced alternative: exact input token atoms."),
        maximumToleranceBps: z.number().int().min(0).max(1_000).optional()
          .default(DEFAULT_MAXIMUM_TOLERANCE_BPS),
        idempotencyKey: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ market, side, amount, amountInAtoms, maximumToleranceBps, idempotencyKey }) =>
      guardedTool(client, "quotes.read", async () => {
        if ((amount === undefined) === (amountInAtoms === undefined)) {
          return toolError(
            "invalid_amount",
            "Give exactly one amount: a human value such as 0.1 SOL, or amountInAtoms for advanced use.",
            false,
          );
        }
        const sonarMarkets = (await client.markets()).markets;
        let resolvedMarket = market;
        let resolvedAtoms = amountInAtoms;
        let inputDisplay = amountInAtoms ? `${amountInAtoms} input atoms` : amount!;
        if (amount !== undefined) {
          try {
            const parsed = humanQuoteAmount(sonarMarkets, market, side, amount);
            resolvedMarket = parsed.market.label;
            resolvedAtoms = parsed.atoms;
            inputDisplay = parsed.display;
          } catch (error) {
            return toolError("invalid_amount", safeMessage(error), false);
          }
        }
        const freshQuote = await retryReadOnce(() => client.quote({
          market: resolvedMarket,
          side,
          amountInAtoms: resolvedAtoms!,
          maximumToleranceBps,
        }));
        if (!options.sessionAutonomy) {
          return toolResult(
            {
              executed: false,
              reason: "trading_not_connected",
              quote: freshQuote,
              connect_url: "https://stratabook.app/agents",
            },
            `Live quote ready for ${inputDisplay}; no transaction was sent. Trading is not connected. `
              + "Open https://stratabook.app/agents when you want to trade; read-only tools need no setup.",
          );
        }
        const liveCatalog = await client.capabilities();
        if (!capabilityAvailable(liveCatalog, "trade.submit")) {
          return toolError(
            "trading_temporarily_unavailable",
            "The quote works, but trading submission is temporarily unavailable. No transaction was sent.",
            true,
          );
        }
        const sonar = sonarMarkets.find((candidate) => candidate.market_pda === freshQuote.market_id)
          ?? sonarMarkets.find((candidate) => candidate.label === resolvedMarket);
        const notional = sonar
          ? quoteNotionalUsd(
              freshQuote.side,
              freshQuote.amount_in_atoms,
              freshQuote.minimum_output_atoms,
              sonar.quote_decimals,
            )
          : null;
        const resolver = new MarketMetaResolver(platformClient, async () => sonarMarkets, () => Date.now());
        const marketId = sonar ? await resolver.idForLabel(sonar.label) : null;
        const decision = decideAutonomy(options.sessionAutonomy, marketId ?? "", notional, Date.now());
        if (!decision.allow) {
          return toolResult(
            { executed: false, reason: decision.reason, quote: freshQuote },
            `${decision.reason} The live quote is attached; no transaction was sent.`,
          );
        }
        const receipt = await client.executeQuote({
          quote: freshQuote,
          ownerWallet: options.sessionAutonomy.ownerWallet,
          signer: options.sessionAutonomy.signer,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        });
        if (notional !== null) options.sessionAutonomy.dailyBudget.record(notional, Date.now());
        return toolResult(
          { executed: true, receipt, notional_usd: notional },
          `Executed ${side} ${inputDisplay} as ${receipt.signature}.`,
        );
      }),
  );

  registerTool(
    "strata_swap_quote",
    {
      title: "Sonar asset swap quote",
      description:
        "Request short-lived exact-input customer economics between two opaque Strata asset IDs.",
      inputSchema: {
        inputAssetId: z.string().regex(/^asset_[0-9a-f]{32}$/),
        outputAssetId: z.string().regex(/^asset_[0-9a-f]{32}$/),
        amountInAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20),
        maximumToleranceBps: z.number().int().min(0).max(1_000).optional().default(0),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ inputAssetId, outputAssetId, amountInAtoms, maximumToleranceBps }) => {
      const response: PlatformSwapQuoteResponse = await platformClient.quotes.swap({
        inputAssetId,
        outputAssetId,
        amountInAtoms,
        maximumToleranceBps,
      });
      return toolResult(
        response,
        `Sonar swap quote: ${response.amount_in_consumed_atoms} input atoms for `
          + `${response.amount_out_atoms} user-net output atoms; minimum `
          + `${response.minimum_output_atoms}; expires at ${response.expires_at_ms}.`,
      );
    },
  );

  const executionChallenge = registerTool(
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
          .optional()
          .describe(
            "Optional Vault market account sequence as an unsigned decimal string. Omit it and Strata resolves the next sequence from the Vault's confirmed market account.",
          ),
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
          ...(accountSequence === undefined ? {} : { accountSequence }),
        };
        const response = await client.executionChallenge(request);
        return toolResult(
          response,
          `Authorization challenge ${response.challenge_id}; expires at ${response.expires_at_ms}.`,
        );
      }),
  );

  const executionPrepare = registerTool(
    "strata_execution_prepare",
    {
      title: "Prepare Strata execution",
      description:
        "Prepare a quote-bound partially signed transaction. One signature: pass quoteId + ownerWallet + sessionPublicKey and sign only the returned transaction. (A challengeId + authorizationSignature from strata_execution_challenge is still accepted.)",
      inputSchema: {
        market: z.string().min(1).max(128).describe("Market label or public market ID."),
        quoteId: z.string().regex(/^sq_[0-9a-f]{32}$/).optional().describe("Unexpired Sonar quote ID (direct, one-signature path)."),
        ownerWallet: z.string().min(32).max(44).optional(),
        sessionPublicKey: z.string().min(32).max(44).optional(),
        accountSequence: z.string().regex(/^[0-9]+$/).max(20).optional(),
        challengeId: z
          .string()
          .regex(/^sc_[0-9a-f]{32}$/)
          .optional()
          .describe("Execution challenge ID returned by Strata (two-step path)."),
        authorizationSignature: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[1-9A-HJ-NP-Za-km-z]+$/)
          .optional()
          .describe("Base58 Ed25519 signature made externally over the challenge payload (two-step path)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ market, quoteId, ownerWallet, sessionPublicKey, accountSequence, challengeId, authorizationSignature }) =>
      guardedTool(client, "trade.prepare", async () => {
        let request: ExecutionPrepareRequest;
        if (challengeId !== undefined || authorizationSignature !== undefined) {
          if (challengeId === undefined || authorizationSignature === undefined) {
            return toolError("invalid_request", "The two-step path needs both challengeId and authorizationSignature.", false);
          }
          request = { market, challengeId, authorizationSignature };
        } else {
          if (quoteId === undefined || ownerWallet === undefined || sessionPublicKey === undefined) {
            return toolError("invalid_request", "Pass quoteId, ownerWallet, and sessionPublicKey (or a signed challenge).", false);
          }
          request = {
            market,
            quoteId,
            ownerWallet,
            sessionPublicKey,
            ...(accountSequence === undefined ? {} : { accountSequence }),
          };
        }
        const response = await client.executionPrepare(request);
        return toolResult(
          response,
          `Prepared execution ${response.execution_id}; verify it, then sign the transaction externally with the session key before ${response.expires_at_ms} and submit.`,
        );
      }),
  );

  const executionSubmit = registerTool(
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

  const orderChallenge = registerTool(
    "strata_order_challenge",
    {
      title: "Strata order challenge",
      description:
        "Bind an atomic place, cancel, cancel-all, replace, or bounded batch request to canonical bytes for the agent owner's external signer.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        action: z.enum(["place", "cancel", "cancel_all", "replace", "batch"]),
        ownerWallet: z.string().min(32).max(44),
        sessionPublicKey: z.string().min(32).max(44),
        accountSequence: z
          .string()
          .regex(/^[0-9]+$/)
          .max(20)
          .optional()
          .describe(
            "Optional Vault market account sequence. Omit it and Strata resolves the next sequence from the Vault's confirmed market account.",
          ),
        clientOrderId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
        side: z.enum(["buy", "sell"]).optional(),
        orderType: z.enum(["good_until_cancelled", "post_only"]).optional(),
        limitPriceAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
        sizeAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
        orderId: z.string().regex(/^order_[0-9a-f]{32}$/).optional(),
        operations: z.array(z.object({
          action: z.enum(["place", "cancel", "replace"]),
          accountSequence: z.string().regex(/^[0-9]+$/).max(20).optional(),
          clientOrderId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
          side: z.enum(["buy", "sell"]).optional(),
          orderType: z.enum(["good_until_cancelled", "post_only"]).optional(),
          limitPriceAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
          sizeAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
          orderId: z.string().regex(/^order_[0-9a-f]{32}$/).optional(),
        }).strict()).min(1).max(6).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => guardedTool(client, "orders.prepare", async () => {
      const mapped = orderOperationFromArgs(args);
      if ("content" in mapped) return mapped;
      const request = mapped;
      const response = await platformClient.orders.challenge(args.marketId, request);
      return toolResult(
        response,
        `Order challenge ${response.challenge_id} binds ${response.order_ids.length} opaque order ID(s); expires at ${response.expires_at_ms}.`,
      );
    }),
  );

  const orderPrepare = registerTool(
    "strata_order_prepare",
    {
      title: "Prepare Strata order control",
      description:
        "Prepare an immutable partially signed order-control transaction. One signature: pass the operation itself (same fields as strata_order_challenge) and sign only the returned transaction with the session key. (A challengeId + authorizationSignature from strata_order_challenge is still accepted.)",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        challengeId: z.string().regex(/^oc_[0-9a-f]{32}$/).optional(),
        authorizationSignature: z
          .string()
          .min(64)
          .max(88)
          .regex(/^[1-9A-HJ-NP-Za-km-z]+$/)
          .optional(),
        action: z.enum(["place", "cancel", "cancel_all", "replace", "batch"]).optional(),
        ownerWallet: z.string().min(32).max(44).optional(),
        sessionPublicKey: z.string().min(32).max(44).optional(),
        accountSequence: z.string().regex(/^[0-9]+$/).max(20).optional(),
        clientOrderId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
        side: z.enum(["buy", "sell"]).optional(),
        orderType: z.enum(["good_until_cancelled", "post_only"]).optional(),
        limitPriceAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
        sizeAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
        orderId: z.string().regex(/^order_[0-9a-f]{32}$/).optional(),
        operations: z.array(z.object({
          action: z.enum(["place", "cancel", "replace"]),
          accountSequence: z.string().regex(/^[0-9]+$/).max(20).optional(),
          clientOrderId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
          side: z.enum(["buy", "sell"]).optional(),
          orderType: z.enum(["good_until_cancelled", "post_only"]).optional(),
          limitPriceAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
          sizeAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
          orderId: z.string().regex(/^order_[0-9a-f]{32}$/).optional(),
        }).strict()).min(1).max(6).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      guardedTool(client, "orders.prepare", async () => {
        if (args.challengeId !== undefined || args.authorizationSignature !== undefined) {
          if (args.challengeId === undefined || args.authorizationSignature === undefined) {
            return toolError("invalid_request", "The two-step path needs both challengeId and authorizationSignature.", false);
          }
          const response = await platformClient.orders.prepare(args.marketId, {
            challengeId: args.challengeId,
            authorizationSignature: args.authorizationSignature,
          });
          return toolResult(
            response,
            `Prepared ${response.action} control ${response.order_control_id}; externally verify and sign before ${response.expires_at_ms}.`,
          );
        }
        if (args.action === undefined || args.ownerWallet === undefined || args.sessionPublicKey === undefined) {
          return toolError("invalid_request", "Pass action, ownerWallet, and sessionPublicKey (or a signed challenge).", false);
        }
        const mapped = orderOperationFromArgs({
          ...args,
          action: args.action,
          ownerWallet: args.ownerWallet,
          sessionPublicKey: args.sessionPublicKey,
        });
        if ("content" in mapped) return mapped;
        const response = await platformClient.orders.prepare(args.marketId, { operation: mapped });
        return toolResult(
          response,
          `Prepared ${response.action} control ${response.order_control_id} — one signature: verify it, sign the transaction externally with the session key before ${response.expires_at_ms}, then submit.`,
        );
      }),
  );

  const orderSubmit = registerTool(
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

  const orderStatus = registerTool(
    "strata_order_status",
    {
      title: "Read Strata order-control status",
      description:
        "Recover the durable result for an externally signed order submission after a timeout or restart.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        orderControlId: z.string().regex(/^or_[0-9a-f]{32}$/),
        idempotencyKey: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ marketId, orderControlId, idempotencyKey }) =>
      guardedTool(client, "orders.submit", async () => {
        const response: PlatformOrderStatusResponse = await platformClient.orders.status(
          marketId,
          { orderControlId, idempotencyKey },
        );
        return toolResult(
          response,
          `Order control ${response.order_control_id} is ${response.status}.`,
        );
      }),
  );

  const makerPrepare = registerTool(
    "strata_market_making_prepare",
    {
      title: "Prepare simple Strata market making",
      description:
        "Prepare a pro-level Strand or Current from a market label, decimal base size, spread, and duration. Strata resolves IDs, decimals, live mark, tick grid, expiry, safety bounds, and fixed on-chain arrays. Sign only the returned transaction externally, then call submit_and_wait.",
      inputSchema: {
        action: z.enum(["start", "stop"]),
        market: z.string().min(1).max(128),
        product: z.enum(["strand", "current"]),
        makerWallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        spreadBps: z.number().int().min(1).max(5_000).optional(),
        size: z.string().min(1).max(64).optional(),
        duration: z.union([
          z.number().int().min(1).max(604_800),
          z.string().regex(/^[1-9][0-9]*(?:s|m|h|d)$/i),
        ]).optional(),
        levels: z.number().int().min(1).max(16).optional(),
        levelStepBps: z.number().int().min(1).max(5_000).optional(),
        side: z.enum(["both", "buy", "sell"]).optional(),
        asyncOnly: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => guardedTool(client, `mm.${args.product}.manage`, async () => {
      const prepared = args.action === "stop"
        ? await platformClient.marketMaking.prepareStop({
            market: args.market,
            product: args.product,
            makerWallet: args.makerWallet,
          })
        : (() => {
            if (args.spreadBps === undefined || args.size === undefined) {
              return undefined;
            }
            return platformClient.marketMaking.prepareStart({
              market: args.market,
              product: args.product,
              makerWallet: args.makerWallet,
              spreadBps: args.spreadBps,
              size: args.size,
              ...(args.duration === undefined ? {} : { duration: args.duration }),
              ...(args.levels === undefined ? {} : { levels: args.levels }),
              ...(args.levelStepBps === undefined ? {} : { levelStepBps: args.levelStepBps }),
              ...(args.side === undefined ? {} : { side: args.side }),
              ...(args.asyncOnly === undefined ? {} : { asyncOnly: args.asyncOnly }),
            });
          })();
      if (prepared === undefined) {
        return toolError("invalid_request", "Starting market making requires spreadBps and size.", false);
      }
      const resolved = await prepared;
      const response = {
        action: args.action,
        market: resolved.market,
        product: resolved.product,
        ...("base_asset" in resolved ? { base_asset: resolved.base_asset } : {}),
        operation: resolved.operation,
        prepared: resolved.prepared,
        preparationToken: encodeMakerPreparationToken(resolved),
      };
      return toolResult(
        response,
        `Prepared ${args.action} for ${resolved.market.label} as ${resolved.prepared.maker_control_id}. Verify and sign only prepared.transaction_base64, then pass preparationToken unchanged to submit_and_wait within 30 seconds.`,
      );
    }),
  );

  const makerSubmitAndWait = registerTool(
    "strata_market_making_submit_and_wait",
    {
      title: "Submit and confirm Strata market making",
      description:
        "Submit the exact externally signed quickstart transaction with the unchanged preparation token and wait until Strata's chain-derived maker state confirms the product started or stopped. The token survives stateless HTTP requests and server restarts; the control ID is its default idempotency key.",
      inputSchema: {
        makerControlId: z.string().regex(/^mc_[0-9a-f]{32}$/),
        preparationToken: z.string().min(16).max(32_768).regex(/^[A-Za-z0-9_-]+$/),
        signedTransactionBase64: z.string().min(4).max(4_096).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        idempotencyKey: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
        confirmationTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      let prepared: MakerQuickstartPreparation;
      try {
        prepared = decodeMakerPreparationToken(args.preparationToken);
      } catch {
        return toolError(
          "invalid_request",
          "preparationToken is invalid. Pass the token returned by strata_market_making_prepare unchanged.",
          false,
        );
      }
      if (prepared.prepared.maker_control_id !== args.makerControlId) {
        return toolError(
          "binding_mismatch",
          "makerControlId does not match preparationToken.",
          false,
        );
      }
      return guardedTool(client, `mm.${prepared.product}.manage`, async () => {
        const response = await platformClient.marketMaking.submitPrepared({
          prepared,
          signedTransactionBase64: args.signedTransactionBase64,
          ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
          ...(args.confirmationTimeoutMs === undefined
            ? {}
            : { confirmationTimeoutMs: args.confirmationTimeoutMs }),
        });
        return toolResult(
          response,
          `${response.product} is confirmed ${response.operation.action === "cancel" ? "stopped" : "live"} on ${response.market.label}.`,
        );
      });
    },
  );

  const makerStrandPrepare = registerTool(
    "strata_market_making_strand_prepare",
    {
      title: "Prepare Strata Strand control",
      description:
        "Build one exact unsigned maker-owned Strand transaction. Every exposure and level size is expressed in base-asset atoms, never lots or whole tokens. Verify and sign it externally with the maker wallet, then submit it with the Strand submit tool.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        action: z.enum(["upsert", "recenter", "set_enabled", "cancel"]),
        makerWallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        enabled: z.boolean().optional(),
        asyncOnly: z.boolean().optional(),
        syncSpreadTicks: z.number().int().min(0).max(65_535).optional(),
        midPriceAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
        maxExposureBaseAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
        bidOffsetsTicks: z.array(z.number().int().min(0).max(65_535)).length(16).optional(),
        askOffsetsTicks: z.array(z.number().int().min(0).max(65_535)).length(16).optional(),
        bidSizesBaseAtoms: z.array(z.string().regex(/^(?:0|[1-9][0-9]*)$/).max(20)).length(16).optional(),
        askSizesBaseAtoms: z.array(z.string().regex(/^(?:0|[1-9][0-9]*)$/).max(20)).length(16).optional(),
        newMidPriceAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
        validUntilSlot: z.string().regex(/^(?:0|[1-9][0-9]*)$/).max(20).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => guardedTool(client, "mm.strand.manage", async () => {
      let request: PlatformMakerStrandPrepareInput;
      if (args.action === "upsert") {
        if (
          args.enabled === undefined || args.asyncOnly === undefined
          || args.syncSpreadTicks === undefined || args.midPriceAtoms === undefined
          || args.maxExposureBaseAtoms === undefined || args.bidOffsetsTicks === undefined
          || args.askOffsetsTicks === undefined || args.bidSizesBaseAtoms === undefined
          || args.askSizesBaseAtoms === undefined || args.validUntilSlot === undefined
        ) {
          return toolError("invalid_request", "Strand upsert requires every level, exposure, midpoint, spread, flag, and expiry field.", false);
        }
        request = {
          action: "upsert",
          makerWallet: args.makerWallet,
          enabled: args.enabled,
          asyncOnly: args.asyncOnly,
          syncSpreadTicks: args.syncSpreadTicks,
          midPriceAtoms: args.midPriceAtoms,
          maxExposureBaseAtoms: args.maxExposureBaseAtoms,
          bidOffsetsTicks: args.bidOffsetsTicks,
          askOffsetsTicks: args.askOffsetsTicks,
          bidSizesBaseAtoms: args.bidSizesBaseAtoms,
          askSizesBaseAtoms: args.askSizesBaseAtoms,
          validUntilSlot: args.validUntilSlot,
        };
      } else if (args.action === "recenter") {
        if (args.newMidPriceAtoms === undefined || args.validUntilSlot === undefined) {
          return toolError("invalid_request", "Strand recenter requires newMidPriceAtoms and validUntilSlot.", false);
        }
        request = {
          action: "recenter",
          makerWallet: args.makerWallet,
          newMidPriceAtoms: args.newMidPriceAtoms,
          validUntilSlot: args.validUntilSlot,
        };
      } else if (args.action === "set_enabled") {
        if (args.enabled === undefined) {
          return toolError("invalid_request", "Strand set_enabled requires enabled.", false);
        }
        request = { action: "set_enabled", makerWallet: args.makerWallet, enabled: args.enabled };
      } else {
        request = { action: "cancel", makerWallet: args.makerWallet };
      }
      const response = await platformClient.marketMaking.strand.prepare(args.marketId, request);
      return toolResult(
        response,
        `Prepared ${response.action} control ${response.maker_control_id}; verify and sign only this transaction with ${response.maker_wallet} before ${response.expires_at_ms}.`,
      );
    }),
  );

  const makerStrandSubmit = registerTool(
    "strata_market_making_strand_submit",
    {
      title: "Submit Strata Strand control",
      description: "Submit the exact externally maker-signed Strand transaction with a stable retry key.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        makerControlId: z.string().regex(/^mc_[0-9a-f]{32}$/),
        signedTransactionBase64: z.string().min(4).max(4_096).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        idempotencyKey: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ marketId, makerControlId, signedTransactionBase64, idempotencyKey }) =>
      guardedTool(client, "mm.strand.manage", async () => {
        const response = await platformClient.marketMaking.strand.submit(marketId, {
          makerControlId,
          signedTransactionBase64,
          idempotencyKey,
        });
        return toolResult(response, `Submitted ${response.action} as ${response.signature}.`);
      }),
  );

  const makerCurrentPrepare = registerTool(
    "strata_market_making_current_prepare",
    {
      title: "Prepare Strata Current control",
      description:
        "Build one exact unsigned maker-owned Current transaction. Upsert prices its bands from the market's live Strata mark; cancel remains available independently.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        action: z.enum(["upsert", "cancel"]),
        makerWallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        enabled: z.boolean().optional(),
        asyncOnly: z.boolean().optional(),
        halfSpreadBps: z.number().int().min(1).max(65_535).optional(),
        bandStepBps: z.number().int().min(0).max(65_535).optional(),
        maxConfidenceBps: z.number().int().min(1).max(100).optional(),
        maxOracleDeviationBps: z.number().int().min(1).max(500).optional(),
        maxOracleAgeSeconds: z.number().int().min(0).max(4_294_967_295).optional(),
        syncSpreadBps: z.number().int().min(0).max(65_535).optional(),
        maxExposureBaseAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
        bidDepthBaseAtoms: z.array(z.string().regex(/^(?:0|[1-9][0-9]*)$/).max(20)).length(8).optional(),
        askDepthBaseAtoms: z.array(z.string().regex(/^(?:0|[1-9][0-9]*)$/).max(20)).length(8).optional(),
        validUntilSlot: z.string().regex(/^(?:0|[1-9][0-9]*)$/).max(20).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => guardedTool(client, "mm.current.manage", async () => {
      let request: PlatformMakerCurrentPrepareInput;
      if (args.action === "cancel") {
        request = { action: "cancel", makerWallet: args.makerWallet };
      } else {
        if (
          args.enabled === undefined || args.asyncOnly === undefined
          || args.halfSpreadBps === undefined || args.bandStepBps === undefined
          || args.maxConfidenceBps === undefined || args.maxOracleDeviationBps === undefined
          || args.maxOracleAgeSeconds === undefined || args.syncSpreadBps === undefined
          || args.maxExposureBaseAtoms === undefined || args.bidDepthBaseAtoms === undefined
          || args.askDepthBaseAtoms === undefined || args.validUntilSlot === undefined
        ) {
          return toolError("invalid_request", "Current upsert requires every depth, exposure, spread, oracle-bound, flag, and expiry field.", false);
        }
        request = {
          action: "upsert",
          makerWallet: args.makerWallet,
          enabled: args.enabled,
          asyncOnly: args.asyncOnly,
          halfSpreadBps: args.halfSpreadBps,
          bandStepBps: args.bandStepBps,
          maxConfidenceBps: args.maxConfidenceBps,
          maxOracleDeviationBps: args.maxOracleDeviationBps,
          maxOracleAgeSeconds: args.maxOracleAgeSeconds,
          syncSpreadBps: args.syncSpreadBps,
          maxExposureBaseAtoms: args.maxExposureBaseAtoms,
          bidDepthBaseAtoms: args.bidDepthBaseAtoms,
          askDepthBaseAtoms: args.askDepthBaseAtoms,
          validUntilSlot: args.validUntilSlot,
        };
      }
      const response = await platformClient.marketMaking.current.prepare(args.marketId, request);
      return toolResult(
        response,
        `Prepared ${response.action} control ${response.maker_control_id}; verify and sign only this transaction with ${response.maker_wallet} before ${response.expires_at_ms}.`,
      );
    }),
  );

  const makerCurrentSubmit = registerTool(
    "strata_market_making_current_submit",
    {
      title: "Submit Strata Current control",
      description: "Submit the exact externally maker-signed Current transaction with a stable retry key.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        makerControlId: z.string().regex(/^mc_[0-9a-f]{32}$/),
        signedTransactionBase64: z.string().min(4).max(4_096).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        idempotencyKey: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ marketId, makerControlId, signedTransactionBase64, idempotencyKey }) =>
      guardedTool(client, "mm.current.manage", async () => {
        const response = await platformClient.marketMaking.current.submit(marketId, {
          makerControlId,
          signedTransactionBase64,
          idempotencyKey,
        });
        return toolResult(response, `Submitted ${response.action} as ${response.signature}.`);
      }),
  );

  const makerIntentPrepare = registerTool(
    "strata_market_making_intent_prepare",
    {
      title: "Prepare Strata IntentBook control",
      description:
        "Prepare one sponsored Vault-session transaction for an existing curated IntentBook seat. "
        + "Post updates its side, price band, and maximum fill. Revoke permanently closes the seat; "
        + "it cannot be posted again. The owner wallet does not sign each update.",
      inputSchema: {
        marketId: makerMarketIdSchema,
        action: z.enum(["post", "revoke"]),
        ownerWallet: makerPublicKeySchema,
        sessionPublicKey: makerPublicKeySchema,
        side: z.enum(["buy", "sell", "both"]).optional(),
        minPriceAtoms: makerPositiveAtomicSchema.optional(),
        maxPriceAtoms: makerPositiveAtomicSchema.optional(),
        maxFillSizeAtoms: makerPositiveAtomicSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => guardedTool(client, "mm.intent.manage", async () => {
      let request: PlatformMakerIntentPrepareInput;
      if (args.action === "revoke") {
        request = {
          action: "revoke",
          ownerWallet: args.ownerWallet,
          sessionPublicKey: args.sessionPublicKey,
        };
      } else {
        if (
          args.side === undefined
          || args.minPriceAtoms === undefined
          || args.maxPriceAtoms === undefined
          || args.maxFillSizeAtoms === undefined
        ) {
          return toolError(
            "invalid_request",
            "Intent post requires side, minPriceAtoms, maxPriceAtoms, and maxFillSizeAtoms.",
            false,
          );
        }
        request = {
          action: "post",
          ownerWallet: args.ownerWallet,
          sessionPublicKey: args.sessionPublicKey,
          side: args.side,
          minPriceAtoms: args.minPriceAtoms,
          maxPriceAtoms: args.maxPriceAtoms,
          maxFillSizeAtoms: args.maxFillSizeAtoms,
        };
      }
      const response = await platformClient.marketMaking.intent.prepare(args.marketId, request);
      return toolResult(
        response,
        `Prepared IntentBook ${response.action}; verify and add only the session signature before ${response.expires_at_ms}. Strata pays the network fee.`,
      );
    }),
  );

  const makerIntentSubmit = registerTool(
    "strata_market_making_intent_submit",
    {
      title: "Submit Strata IntentBook control",
      description:
        "Submit the exact session-signed IntentBook packet. Exact retries during the packet's live "
        + "blockhash window return the original confirmed signature.",
      inputSchema: {
        marketId: makerMarketIdSchema,
        signedTransactionBase64: makerBase64Schema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ marketId, signedTransactionBase64 }) =>
      guardedTool(client, "mm.intent.manage", async () => {
        const response = await platformClient.marketMaking.intent.submit(marketId, {
          signedTransactionBase64,
        });
        return toolResult(response, `Submitted IntentBook control as ${response.signature}.`);
      }),
  );

  registerAutonomyTools(registerTool, client, platformClient, options.sessionAutonomy, () =>
    typeof Date !== "undefined" ? Date.now() : 0,
  );

  void [
    markets,
    quote,
    exactOutputQuote,
    executionChallenge,
    executionPrepare,
    executionSubmit,
    orderChallenge,
    orderPrepare,
    orderSubmit,
    orderStatus,
    makerPrepare,
    makerSubmitAndWait,
    makerStrandPrepare,
    makerStrandSubmit,
    makerCurrentPrepare,
    makerCurrentSubmit,
    makerIntentPrepare,
    makerIntentSubmit,
  ];
  applyToolAvailability(registeredTools, initialCatalog, initialPlatformCatalog, toolMode);
  let closed = false;
  const refresh = async () => {
    if (closed) return;
    const [catalog, platformCatalog] = await Promise.all([
      client.capabilities(),
      platformClient.discovery.read(),
    ]);
    applyToolAvailability(registeredTools, catalog, platformCatalog, toolMode);
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

function registerAutonomyTools(
  registerTool: McpServer["registerTool"],
  client: StrataClient,
  platformClient: StrataPlatformClient,
  autonomy: SessionAutonomy | undefined,
  nowMs: () => number,
): void {
  // Always present, always read-only: the agent may show the slider and offer
  // to change it, but nothing it calls can raise its own autonomy.
  registerTool(
    "strata_autonomy",
    {
      title: "Strata session autonomy",
      description:
        "Read how much this MCP may finish by itself: the autonomy level (ask / limits / instant), "
        + "any USD ceilings, and how to change it. Read-only — the level is the user's, set out-of-band "
        + "(the Agents page or the MCP's own env), never by an agent.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const howToChange = {
        setup: "Open the Agents page, connect the owner wallet, register once, then copy the MCP trading config into your client's local settings.",
        agents_page: "https://stratabook.app/agents",
        generic_clients: "Claude Desktop, Cursor, Windsurf, Codex, or any local stdio MCP host",
        note: "Read-only tools need none of this. Only the user changes trading authority; an agent can never raise its own level.",
        advanced_environment_reference: {
          level_env: "STRATA_AUTONOMY = ask | limits | instant",
          per_trade_env: "STRATA_AUTONOMY_MAX_USD_PER_TRADE",
          per_day_env: "STRATA_AUTONOMY_MAX_USD_PER_DAY",
          markets_env: "STRATA_AUTONOMY_MARKETS (comma-separated opaque market IDs)",
          session_env: "STRATA_SESSION_SECRET_KEY + STRATA_OWNER_WALLET (register the key on the Agents page)",
        },
      };
      if (!autonomy) {
        return toolResult(
          { session_configured: false, level: "ask", how_to_change: howToChange },
          "Read-only is ready. Trading is not connected, so I cannot send transactions. "
            + "If you want trading, open https://stratabook.app/agents and copy its MCP trading config "
            + "into your client; never paste the session secret into chat.",
        );
      }
      const { config } = autonomy;
      const spentToday = autonomy.dailyBudget.spentToday(nowMs());
      const state = {
        session_configured: true,
        wallet_address: autonomy.ownerWallet,
        session_public_key: autonomy.signer.publicKey,
        level: config.level,
        max_usd_per_trade: config.maxUsdPerTrade ?? null,
        max_usd_per_day: config.maxUsdPerDay ?? null,
        spent_today_usd: Number(spentToday.toFixed(2)),
        remaining_today_usd:
          config.maxUsdPerDay === undefined
            ? null
            : Number(Math.max(0, config.maxUsdPerDay - spentToday).toFixed(2)),
        allowed_market_ids: config.allowedMarketIds ?? null,
        how_to_change: howToChange,
      };
      const summary =
        config.level === "instant"
          ? "Autonomy: instant — I trade within your on-chain session caps without asking."
          : config.level === "limits"
            ? `Autonomy: limits — I trade instantly up to ${config.maxUsdPerTrade !== undefined ? "$" + config.maxUsdPerTrade + "/trade" : "no per-trade cap"}`
              + `${config.maxUsdPerDay !== undefined ? ", $" + config.maxUsdPerDay + "/day" : ""}; above that I stop and ask.`
            : "Autonomy: ask — I prepare trades but never sign them; you sign each one.";
      return toolResult(state, summary);
    },
  );

  if (!autonomy) return;

  const resolver = new MarketMetaResolver(
    platformClient,
    async () => (await client.markets()).markets,
    nowMs,
  );
  const markFor = async (marketId: string) => {
    const mark = await platformClient.marketData.mark(marketId);
    return {
      price_atoms_per_base_unit: mark.price_atoms_per_base_unit,
      quote_decimals: mark.quote_decimals,
      stale: mark.stale,
    };
  };
  const refuse = (reason: string, prepared: unknown, summary: string) =>
    toolResult({ executed: false, reason, prepared }, summary);

  // ── one-shot existing IntentBook seat control ──────────────────────────────
  registerTool(
    "strata_market_making_intent_execute",
    {
      title: "Execute Strata IntentBook control",
      description:
        "Post or permanently revoke an existing curated IntentBook seat in one call. The configured "
        + "Vault session verifies and signs; Strata pays the network fee. Under ask, or above a limits "
        + "ceiling, this prepares the exact packet but does not sign it.",
      inputSchema: {
        marketId: makerMarketIdSchema,
        action: z.enum(["post", "revoke"]),
        side: z.enum(["buy", "sell", "both"]).optional(),
        minPriceAtoms: makerPositiveAtomicSchema.optional(),
        maxPriceAtoms: makerPositiveAtomicSchema.optional(),
        maxFillSizeAtoms: makerPositiveAtomicSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => guardedTool(client, "mm.intent.manage", async () => {
      let operation: PlatformMakerIntentExecuteOperation;
      if (args.action === "revoke") {
        operation = { action: "revoke", ownerWallet: autonomy.ownerWallet };
      } else {
        if (
          args.side === undefined
          || args.minPriceAtoms === undefined
          || args.maxPriceAtoms === undefined
          || args.maxFillSizeAtoms === undefined
        ) {
          return toolError(
            "invalid_request",
            "Intent post requires side, minPriceAtoms, maxPriceAtoms, and maxFillSizeAtoms.",
            false,
          );
        }
        operation = {
          action: "post",
          ownerWallet: autonomy.ownerWallet,
          side: args.side,
          minPriceAtoms: args.minPriceAtoms,
          maxPriceAtoms: args.maxPriceAtoms,
          maxFillSizeAtoms: args.maxFillSizeAtoms,
        };
      }
      const baseAtoms = operation.action === "post" ? BigInt(operation.maxFillSizeAtoms) : 0n;
      const notional = await estimateBaseNotionalUsd(resolver, markFor, args.marketId, baseAtoms);
      const decision = decideAutonomy(autonomy, args.marketId, notional, nowMs());
      if (!decision.allow) {
        const prepared = await platformClient.marketMaking.intent.prepare(args.marketId, {
          ...operation,
          sessionPublicKey: autonomy.signer.publicKey,
        });
        return refuse(decision.reason, prepared, decision.reason);
      }
      const receipt = await platformClient.marketMaking.intent.execute(args.marketId, {
        operation,
        signer: autonomy.signer,
      });
      if (notional !== null) autonomy.dailyBudget.record(notional, nowMs());
      return toolResult(
        { executed: true, receipt, notional_usd: notional },
        `Executed IntentBook ${operation.action} as ${receipt.signature}.`,
      );
    }),
  );

  // ── one-shot immediate execution from a fresh Sonar quote ─────────────────
  registerTool(
    "strata_execute_quote",
    {
      title: "Execute a Strata quote",
      description:
        "Take a fresh Sonar quote and, within the autonomy slider, sign it with the session key and "
        + "submit it in one call. Under \"ask\" (or over a \"limits\" ceiling) it does not sign — it returns "
        + "the quote and asks you to sign or raise the slider.",
      inputSchema: {
        market: z.string().min(2).max(64).describe("Market label such as SOL/USDC, or its public market ID."),
        side: z.enum(["buy", "sell"]),
        amountInAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20),
        toleranceBps: z.number().int().min(0).max(1_000).optional(),
        idempotencyKey: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      guardedTool(client, "trade.submit", async () => {
        const quote: QuoteResponse = await retryReadOnce(() => client.quote({
          market: args.market,
          side: args.side,
          amountInAtoms: args.amountInAtoms,
          ...(args.toleranceBps === undefined ? {} : { toleranceBps: args.toleranceBps }),
        }));
        const sonar = (await client.markets()).markets.find(
          (market) => market.market_pda === quote.market_id,
        );
        const notional = sonar
          ? quoteNotionalUsd(
              quote.side,
              quote.amount_in_atoms,
              quote.minimum_output_atoms,
              sonar.quote_decimals,
            )
          : null;
        const marketId = sonar ? await resolver.idForLabel(sonar.label) : null;
        const decision = decideAutonomy(autonomy, marketId ?? "", notional, nowMs());
        if (!decision.allow) {
          return refuse(decision.reason, quote, decision.reason);
        }
        const receipt = await client.executeQuote({
          quote,
          ownerWallet: autonomy.ownerWallet,
          signer: autonomy.signer,
          ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
        });
        if (notional !== null) autonomy.dailyBudget.record(notional, nowMs());
        return toolResult(
          { executed: true, receipt, notional_usd: notional },
          `Executed ${quote.side} on ${quote.market_id} as ${receipt.signature}.`,
        );
      }),
  );

  // ── one-shot order control (place / cancel / replace / batch) ─────────────
  registerTool(
    "strata_order_execute",
    {
      title: "Execute a Strata order control",
      description:
        "Place, cancel, replace, or batch orders and, within the autonomy slider, sign with the session "
        + "key and submit in one call. Owner wallet and session key come from the configured session. "
        + "Under \"ask\" (or over a \"limits\" ceiling) it prepares the transaction and asks you to sign.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        action: z.enum(["place", "cancel", "cancel_all", "replace", "batch"]),
        clientOrderId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
        side: z.enum(["buy", "sell"]).optional(),
        orderType: z.enum(["good_until_cancelled", "post_only"]).optional(),
        limitPriceAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
        sizeAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
        orderId: z.string().regex(/^order_[0-9a-f]{32}$/).optional(),
        operations: z.array(z.object({
          action: z.enum(["place", "cancel", "replace"]),
          clientOrderId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
          side: z.enum(["buy", "sell"]).optional(),
          orderType: z.enum(["good_until_cancelled", "post_only"]).optional(),
          limitPriceAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
          sizeAtoms: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
          orderId: z.string().regex(/^order_[0-9a-f]{32}$/).optional(),
        }).strict()).min(1).max(6).optional(),
        idempotencyKey: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      guardedTool(client, "orders.submit", async () => {
        const challenge = orderOperationFromArgs({
          ...args,
          ownerWallet: autonomy.ownerWallet,
          sessionPublicKey: autonomy.signer.publicKey,
        });
        if ("content" in challenge) return challenge;
        // A place/replace risks new base; a cancel reduces it (notional 0).
        const baseAtoms =
          (args.action === "place" || args.action === "replace") && args.sizeAtoms !== undefined
            ? BigInt(args.sizeAtoms)
            : 0n;
        const notional = await estimateBaseNotionalUsd(resolver, markFor, args.marketId, baseAtoms);
        const decision = decideAutonomy(autonomy, args.marketId, notional, nowMs());
        if (!decision.allow) {
          const prepared = await platformClient.orders.prepare(args.marketId, {
            operation: challenge,
          });
          return refuse(decision.reason, prepared, decision.reason);
        }
        const { sessionPublicKey: _session, ...operation } = challenge;
        const receipt = await platformClient.orders.execute(args.marketId, {
          operation: operation as PlatformOrderExecuteOperation,
          signer: autonomy.signer,
          ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
        });
        if (notional !== null) autonomy.dailyBudget.record(notional, nowMs());
        return toolResult(
          { executed: true, receipt, notional_usd: notional },
          `Executed ${receipt.action} control ${receipt.order_control_id} as ${receipt.signature}.`,
        );
      }),
  );

  // ── one-shot TWAP (schedule / cancel) ─────────────────────────────────────
  registerTool(
    "strata_twap_execute",
    {
      title: "Execute a Strata TWAP",
      description:
        "Schedule or cancel a TWAP and, within the autonomy slider, sign with the session key and submit "
        + "in one call. Owner wallet and session key come from the configured session. Under \"ask\" (or over "
        + "a \"limits\" ceiling) it prepares the transaction and asks you to sign.",
      inputSchema: {
        marketId: z.string().regex(/^market_[0-9a-f]{32}$/),
        action: z.enum(["place", "cancel"]),
        side: z.enum(["buy", "sell"]).optional(),
        totalSizeAtoms: z.string().regex(/^[1-9][0-9]*$/).optional(),
        slicesTotal: z.number().int().min(2).max(120).optional(),
        maximumToleranceBps: z.number().int().min(1).max(1_000).optional(),
        intervalSlots: z.number().int().min(25).max(4_500).optional(),
        limitPriceAtoms: z.string().regex(/^[1-9][0-9]*$/).optional(),
        twapId: z.string().regex(/^twap_[0-9a-f]{32}$/).optional(),
        idempotencyKey: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      safeTool(async () => {
        let operation: PlatformTwapExecuteOperation;
        if (args.action === "cancel") {
          if (args.twapId === undefined) return toolError("invalid_request", "Cancel requires twapId.", false);
          operation = { action: "cancel", ownerWallet: autonomy.ownerWallet, twapId: args.twapId };
        } else {
          if (
            args.side === undefined
            || args.totalSizeAtoms === undefined
            || args.slicesTotal === undefined
            || args.maximumToleranceBps === undefined
            || args.intervalSlots === undefined
            || args.limitPriceAtoms === undefined
          ) {
            return toolError("invalid_request", "Place requires side, totalSizeAtoms, slicesTotal, maximumToleranceBps, intervalSlots, and limitPriceAtoms.", false);
          }
          operation = {
            action: "place",
            ownerWallet: autonomy.ownerWallet,
            side: args.side,
            totalSizeAtoms: args.totalSizeAtoms,
            slicesTotal: args.slicesTotal,
            maximumToleranceBps: args.maximumToleranceBps,
            intervalSlots: args.intervalSlots,
            limitPriceAtoms: args.limitPriceAtoms,
          };
        }
        const baseAtoms =
          args.action === "place" && args.totalSizeAtoms !== undefined ? BigInt(args.totalSizeAtoms) : 0n;
        const notional = await estimateBaseNotionalUsd(resolver, markFor, args.marketId, baseAtoms);
        const decision = decideAutonomy(autonomy, args.marketId, notional, nowMs());
        if (!decision.allow) {
          const prepared = await platformClient.algos.prepare(args.marketId, {
            operation: {
              ...operation,
              sessionPublicKey: autonomy.signer.publicKey,
            } as PlatformTwapChallengeInput,
          });
          return refuse(decision.reason, prepared, decision.reason);
        }
        const receipt = await platformClient.algos.execute(args.marketId, {
          operation,
          signer: autonomy.signer,
          ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
        });
        if (notional !== null) autonomy.dailyBudget.record(notional, nowMs());
        return toolResult(
          { executed: true, receipt, notional_usd: notional },
          `Executed TWAP ${receipt.twap_control_id} as ${receipt.signature}.`,
        );
      }),
  );
}

function trackedToolRegistrar(server: McpServer): {
  registerTool: McpServer["registerTool"];
  handles: Map<string, RegisteredTool>;
} {
  const handles = new Map<string, RegisteredTool>();
  const register = server.registerTool.bind(server) as (...args: unknown[]) => RegisteredTool;
  const registerTool = ((...args: unknown[]) => {
    const tool = register(...args);
    const name = args[0];
    if (typeof name === "string") handles.set(name, tool);
    return tool;
  }) as typeof server.registerTool;
  return { registerTool, handles };
}

function platformCapabilityAvailable(
  catalog: PlatformDiscoveryResponse,
  id: string,
): boolean {
  return catalog.capabilities.some(
    (capability) =>
      capability.id === id
      && capability.transports.includes("mcp")
      && capability.mcp_exposure !== "none",
  );
}

function requirementAvailable(
  requirement: ToolCapabilityRequirement | undefined,
  available: (id: string) => boolean,
): boolean {
  if (requirement === undefined) return true;
  return requirement.match === "any"
    ? requirement.ids.some(available)
    : requirement.ids.every(available);
}

function applyToolAvailability(
  handles: ReadonlyMap<string, RegisteredTool>,
  catalog: CapabilityCatalog,
  platformCatalog: PlatformDiscoveryResponse,
  toolMode: StrataMcpToolMode,
): void {
  for (const [name, tool] of handles) {
    const legacyAvailable = requirementAvailable(
      LEGACY_TOOL_CAPABILITIES[name],
      (id) => capabilityAvailable(catalog, id),
    );
    const platformAvailable = requirementAvailable(
      PLATFORM_TOOL_CAPABILITIES[name],
      (id) => platformCapabilityAvailable(platformCatalog, id),
    );
    const modeAvailable = toolMode === "advanced" || SIMPLE_TOOL_NAMES.has(name);
    setToolEnabled(tool, modeAvailable && legacyAvailable && platformAvailable);
  }
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
      return toolError(error.code, friendlyApiError(error.code, error.message), error.retryable);
    }
    return toolError("request_failed", safeMessage(error), true);
  }
}

async function safeTool(operation: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof StrataApiError) {
      return toolError(error.code, friendlyApiError(error.code, error.message), error.retryable);
    }
    return toolError("request_failed", safeMessage(error), true);
  }
}

/** Retry an idempotent public read once; trading writes are deliberately never retried here. */
async function retryReadOnce<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof StrataApiError) || !error.retryable) throw error;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return operation();
  }
}

/**
 * One line that keeps the two numbers apart: price impact is measured from the
 * book; the tolerance is the caller's own floor.
 */
function quoteSummary(
  response: QuoteResponse,
  display?: { input: string; outputSymbol: string; outputDecimals: number },
): string {
  if (display) {
    const output = `${formatAtoms(response.amount_out_atoms, display.outputDecimals)} ${display.outputSymbol}`;
    const minimum = `${formatAtoms(response.minimum_output_atoms, display.outputDecimals)} ${display.outputSymbol}`;
    return (
      `Sonar ${response.side} quote: ${display.input} → about ${output}; minimum ${minimum}; `
      + `price impact ${response.price_impact_pct}%; tolerance ${response.maximum_tolerance_bps} bps. `
      + `This is a read-only quote and expires at ${response.expires_at_ms}.`
    );
  }
  return (
    `Sonar ${response.side} quote: ${response.amount_in_consumed_atoms} input atoms for `
    + `${response.amount_out_atoms} user-net output atoms; price impact ${response.price_impact_pct}% `
    + `(measured from the book); your tolerance ${response.maximum_tolerance_bps} bps, so the `
    + `user-net floor is ${response.minimum_output_atoms}; expires at ${response.expires_at_ms}.`
  );
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
