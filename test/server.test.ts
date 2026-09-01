import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  CapabilityCatalog,
  ExecutionChallengeRequest,
  ExecutionChallengeResponse,
  ExecutionPrepareRequest,
  ExecutionPrepareResponse,
  ExecutionSubmitRequest,
  ExecutionSubmitResponse,
  MarketsResponse,
  QuoteRequest,
  QuoteResponse,
  StrataClient,
  StrataPlatformClient,
  PlatformOrderChallengeInput,
  PlatformOrderChallengeResponse,
  PlatformOrderPrepareInput,
  PlatformOrderPrepareResponse,
  PlatformOrderStatusInput,
  PlatformOrderStatusResponse,
  PlatformOrderSubmitInput,
  PlatformOrderSubmitResponse,
  PlatformOrderCommandConnection,
  PlatformActionGraphResponse,
  PlatformDiscoveryResponse,
  PlatformCandlesResponse,
  PlatformExecutionStatusResponse,
  PlatformMakerStatusResponse,
  PlatformMakerControlPrepareResponse,
  PlatformMakerControlSubmitInput,
  PlatformMakerControlSubmitResponse,
  PlatformMakerCurrentPrepareInput,
  PlatformMakerIntentPrepareInput,
  PlatformMakerIntentPrepareResponse,
  PlatformMakerIntentSubmitInput,
  PlatformMakerIntentSubmitResponse,
  PlatformMakerQuickstartPrepareInput,
  PlatformMakerQuickstartPrepared,
  PlatformMakerSubmitPreparedInput,
  PlatformMakerStrandPrepareInput,
  PlatformPortfolioHistoryResponse,
  PlatformPortfolioResponse,
  PlatformPointsResponse,
  PlatformRewardsResponse,
  PlatformReferralsResponse,
  PlatformReferralClaimInput,
  PlatformReferralClaimResponse,
  PlatformReferralLinkInput,
  PlatformReferralLinkResponse,
  PlatformBugsResponse,
  PlatformBugSubmitResponse,
  PlatformMarkResponse,
  PlatformServiceStatusResponse,
  PlatformSwapQuoteInput,
  PlatformSwapQuoteResponse,
  PlatformTwapChallengeInput,
  PlatformTwapChallengeResponse,
  PlatformTwapPrepareInput,
  PlatformVaultStatusResponse,
  PlatformVaultPausePrepareResponse,
  PlatformVaultSetupPrepareInput,
  PlatformVaultSetupPrepareResponse,
  PlatformVaultDelegatePrepareInput,
  PlatformVaultDelegatePrepareResponse,
  PlatformVaultPolicyPrepareInput,
  PlatformVaultPolicyPrepareResponse,
  PlatformVaultDepositPrepareInput,
  PlatformVaultDepositPrepareResponse,
  PlatformVaultWithdrawPrepareInput,
  PlatformVaultWithdrawPrepareResponse,
  PlatformVaultSubmitInput,
  PlatformVaultSubmitResponse,
  PlatformTwapPrepareResponse,
  PlatformTwapSubmitInput,
  PlatformTwapSubmitResponse,
  PlatformTwapsResponse,
} from "@stratabook/sdk";
import { CONTRACT_VERSION } from "@stratabook/sdk";
import {
  STRATA_AGENT_BRANCHES,
  STRATA_AGENT_BRANCH_URI_PREFIX,
  STRATA_AGENT_HARNESS,
  STRATA_AGENT_HARNESS_INSTRUCTIONS,
  STRATA_AGENT_HARNESS_URI,
  STRATA_AGENT_KERNEL,
  STRATA_AGENT_KERNEL_URI,
  STRATA_AGENT_ROUTER,
  STRATA_AGENT_ROUTER_URI,
  STRATA_AGENT_TOOL_REGISTRY,
  STRATA_AGENT_TOOL_REGISTRY_URI,
  STRATA_ACTION_GRAPH,
  STRATA_ACTION_GRAPH_URI,
} from "../src/generated-harness.js";
import {
  capabilityAvailable,
  createStrataMcpServer,
  probeStrataMcpReadiness,
  STRATA_PLATFORM_GRAPH_URI,
} from "../src/server.js";
import { SERVER_VERSION } from "../src/version.js";
import { DailyUsdBudget, type SessionAutonomy } from "../src/autonomy.js";

const require = createRequire(import.meta.url);
const packageMetadata = require("../../package.json") as { version: string };

test("server identity follows package metadata", () => {
  assert.equal(SERVER_VERSION, packageMetadata.version);
});


/**
 * Resolve a public contract fixture in both the monorepo (mcp nested under
 * sdk/, contract a sibling of the package) and the published mirror (mcp is the
 * repo root, contract shipped at its root) by walking up from this test file.
 */
function contractFixture(relative: string): URL {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, "contract", relative);
    if (existsSync(candidate)) return new URL(`file://${candidate}`);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`contract fixture not found: ${relative}`);
}

function catalog(
  enabled: boolean,
  exposure: "none" | "read" = "read",
): CapabilityCatalog {
  return {
    schema_version: 1,
    contract_version: CONTRACT_VERSION,
    capabilities: [
      {
        id: "quotes.read",
        introduced_in: "1.0",
        stability: "beta",
        required_scope: "market:read",
        risk: "read",
        default_enabled: enabled,
        public_sdk: true,
        mcp_exposure: exposure,
      },
    ],
  };
}

function autonomyCatalog(): CapabilityCatalog {
  const value = catalog(true);
  value.capabilities.push(
    {
      ...value.capabilities[0]!,
      id: "trade.submit",
      risk: "submit",
      mcp_exposure: "submit",
    },
    {
      ...value.capabilities[0]!,
      id: "orders.prepare",
      risk: "prepare",
      mcp_exposure: "prepare",
    },
    {
      ...value.capabilities[0]!,
      id: "orders.submit",
      risk: "submit",
      mcp_exposure: "submit",
    },
    {
      ...value.capabilities[0]!,
      id: "mm.intent.manage",
      risk: "submit",
      mcp_exposure: "submit",
    },
  );
  return value;
}

function platformCatalog(disabled: readonly string[] = []): PlatformDiscoveryResponse {
  const disabledIds = new Set(disabled);
  const definitions = [
    ["graphs.read", "read"],
    ["platform.status.read", "read"],
    ["points.read", "read"],
    ["rewards.read", "read"],
    ["vault.status.read", "read"],
    ["vault.pause", "destructive"],
    ["market_data.candles.read", "read"],
    ["market_data.marks.read", "read"],
    ["quotes.market.read", "read"],
    ["quotes.swap.read", "read"],
    ["quotes.exact_output.read", "read"],
    ["execution.prepare", "prepare"],
    ["execution.submit", "submit"],
    ["execution.status.read", "read"],
    ["orders.prepare", "prepare"],
    ["orders.submit", "submit"],
    ["algos.twap.place", "submit"],
    ["algos.twap.cancel", "destructive"],
    ["algos.twap.read", "read"],
    ["portfolio.read", "read"],
    ["portfolio.history.read", "read"],
    ["vault.setup", "submit"],
    ["vault.deposit", "submit"],
    ["vault.withdraw", "destructive"],
    ["vault.delegate.manage", "destructive"],
    ["vault.policy.manage", "destructive"],
    ["vault.relay", "submit"],
    ["mm.status.read", "read"],
    ["mm.reputation.read", "read"],
    ["mm.strand.manage", "submit"],
    ["mm.current.manage", "submit"],
    ["mm.intent.manage", "submit"],
    ["referrals.read", "read"],
    ["referrals.link", "submit"],
    ["referrals.claim", "submit"],
    ["bugs.submit", "submit"],
    ["bugs.read", "read"],
  ] as const;
  return {
    schema_version: 2,
    contract_version: "2.0",
    server_time_ms: 1_786_550_400_000,
    authority: {
      permission_source: "external_agent_owner",
      signing_location: "external",
      accepts_private_keys: false,
    },
    capabilities: definitions
      .filter(([id]) => !disabledIds.has(id))
      .map(([id, risk]) => ({
        id,
        risk,
        required_scope: "test",
        transports: ["http", "mcp"],
        mcp_exposure: risk === "read" ? "read" : risk === "prepare" ? "prepare" : "submit",
      })),
  };
}

test("MCP exposure requires every reviewed live-policy gate", () => {
  assert.equal(capabilityAvailable(catalog(true), "quotes.read"), true);
  assert.equal(capabilityAvailable(catalog(false), "quotes.read"), false);
  assert.equal(capabilityAvailable(catalog(true, "none"), "quotes.read"), false);
  assert.equal(capabilityAvailable(catalog(true), "trade.submit"), false);
});

test("reviewed prepare and submit capabilities can become exact-risk MCP tools", () => {
  const value = catalog(true);
  value.capabilities[0] = {
    ...value.capabilities[0]!,
    id: "trade.submit",
    risk: "submit",
    mcp_exposure: "submit",
  };
  assert.equal(capabilityAvailable(value, "trade.submit"), true);
  value.capabilities[0] = { ...value.capabilities[0]!, mcp_exposure: "read" };
  assert.equal(capabilityAvailable(value, "trade.submit"), false);
});

test("readiness validates the live contract instead of reporting a shallow liveness check", async () => {
  const readyClient = {
    capabilities: async () => catalog(true),
  } as unknown as StrataClient;
  assert.deepEqual(await probeStrataMcpReadiness({ client: readyClient }), {
    ok: true,
    service: "strata-mcp",
    version: SERVER_VERSION,
    contract_version: CONTRACT_VERSION,
    harness_version: STRATA_AGENT_HARNESS.harness_version,
  });

  const staleClient = {
    capabilities: async () => ({ ...catalog(true), contract_version: "1.0" }),
  } as unknown as StrataClient;
  await assert.rejects(
    probeStrataMcpReadiness({ client: staleClient }),
    /harness and live contract versions differ/,
  );
  await assert.rejects(
    createStrataMcpServer({ client: staleClient }),
    /harness and live contract versions differ/,
  );
});

test("initialization instructions make read-only use direct and reserve setup for writes", () => {
  assert.doesNotMatch(STRATA_AGENT_HARNESS_INSTRUCTIONS, /Start every objective with strata_capabilities/);
  assert.match(STRATA_AGENT_HARNESS_INSTRUCTIONS, /Call the requested direct tool/);
  assert.match(STRATA_AGENT_HARNESS_INSTRUCTIONS, /read-only tools work immediately/i);
  assert.match(STRATA_AGENT_HARNESS_INSTRUCTIONS, /connection-scoped profile physically limits tools/i);
  assert.match(STRATA_AGENT_HARNESS_INSTRUCTIONS, /never request or accept private keys/i);
  assert.match(STRATA_AGENT_HARNESS_INSTRUCTIONS, /needed only for a requested trading write/i);
  assert.match(STRATA_AGENT_HARNESS_INSTRUCTIONS, /objective is ambiguous/);
  assert.match(STRATA_AGENT_HARNESS_INSTRUCTIONS, /0\.1 SOL/);
  assert.match(STRATA_AGENT_HARNESS_INSTRUCTIONS, /preparation and RPC broadcast are not settlement/i);
  assert.ok(Buffer.byteLength(STRATA_AGENT_HARNESS_INSTRUCTIONS) <= 1_536);
});

test("the canonical registry owns every implemented tool and every branch", () => {
  const names = STRATA_AGENT_TOOL_REGISTRY.tools.map((tool) => tool.name);
  assert.equal(names.length, 60);
  assert.equal(new Set(names).size, names.length);
  for (const tool of STRATA_AGENT_TOOL_REGISTRY.tools) {
    assert.ok(tool.profiles.includes(tool.primary_branch));
  }
  for (const branchId of Object.keys(STRATA_AGENT_BRANCHES)) {
    assert.ok(
      STRATA_AGENT_TOOL_REGISTRY.tools.some((tool) => tool.primary_branch === branchId),
      `${branchId} must own at least one tool`,
    );
  }
});

test("connection-scoped profiles physically remove unrelated tools", async () => {
  const fakeClient = {
    capabilities: async () => catalog(true),
  } as unknown as StrataClient;
  const fakePlatformClient = {
    discovery: { read: async () => platformCatalog() },
  } as unknown as StrataPlatformClient;

  for (const [toolMode, expected] of [
    ["simple", ["strata_points", "strata_rewards"]],
    ["advanced", ["strata_points", "strata_rewards"]],
  ] as const) {
    const runtime = await createStrataMcpServer({
      client: fakeClient,
      platformClient: fakePlatformClient,
      toolMode,
      toolProfile: "points",
    });
    const protocolClient = new Client({ name: `points-${toolMode}`, version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await runtime.server.connect(serverTransport);
      await protocolClient.connect(clientTransport);
      const listed = await protocolClient.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, expected);
      assert.ok(Buffer.byteLength(JSON.stringify(listed.tools)) <= 4_096);
      assert.ok(!names.includes("strata_trade"));
      assert.ok(!names.includes("strata_vault_withdraw"));
      const guessed = await protocolClient.callTool({ name: "strata_trade", arguments: {} });
      assert.equal(guessed.isError, true);
      assert.match(JSON.stringify(guessed.content), /not found|disabled/i);
      const start = await protocolClient.getPrompt({
        name: "strata_start",
        arguments: { objective: "Read my Points rank." },
      });
      assert.match(JSON.stringify(start.messages), /strata_points/);
      assert.doesNotMatch(JSON.stringify(start.messages), /strata_order_execute/);
      await assert.rejects(
        protocolClient.getPrompt({
          name: "strata_start",
          arguments: { objective: "Place an order.", branch: "limit_orders" },
        }),
        /outside the active points runtime profile/,
      );
    } finally {
      await protocolClient.close();
      await runtime.close();
    }
  }
});

test("protocol tool discovery and calls obey the current public policy", async () => {
  let livePlatformCatalog = platformCatalog();
  let liveCatalog: CapabilityCatalog = {
    schema_version: 1,
    contract_version: CONTRACT_VERSION,
    capabilities: [
      {
        id: "markets.read",
        introduced_in: "1.0",
        stability: "beta",
        required_scope: "market:read",
        risk: "read",
        default_enabled: true,
        public_sdk: true,
        mcp_exposure: "read",
      },
      {
        id: "quotes.read",
        introduced_in: "1.0",
        stability: "beta",
        required_scope: "market:read",
        risk: "read",
        default_enabled: true,
        public_sdk: true,
        mcp_exposure: "read",
      },
      {
        id: "trade.prepare",
        introduced_in: "1.1",
        stability: "beta",
        required_scope: "trade:prepare",
        risk: "prepare",
        default_enabled: true,
        public_sdk: true,
        mcp_exposure: "prepare",
      },
      {
        id: "trade.submit",
        introduced_in: "1.1",
        stability: "beta",
        required_scope: "trade:submit",
        risk: "submit",
        default_enabled: true,
        public_sdk: true,
        mcp_exposure: "submit",
      },
      {
        id: "orders.prepare",
        introduced_in: "1.1",
        stability: "beta",
        required_scope: "orders:prepare",
        risk: "prepare",
        default_enabled: true,
        public_sdk: true,
        mcp_exposure: "prepare",
      },
      {
        id: "orders.submit",
        introduced_in: "1.1",
        stability: "beta",
        required_scope: "orders:submit",
        risk: "submit",
        default_enabled: true,
        public_sdk: true,
        mcp_exposure: "submit",
      },
      {
        id: "mm.intent.manage",
        introduced_in: "1.1",
        stability: "beta",
        required_scope: "mm:write",
        risk: "submit",
        default_enabled: true,
        public_sdk: true,
        mcp_exposure: "submit",
      },
      {
        id: "mm.strand.manage",
        introduced_in: "1.1",
        stability: "beta",
        required_scope: "mm:write",
        risk: "submit",
        default_enabled: true,
        public_sdk: true,
        mcp_exposure: "submit",
      },
      {
        id: "mm.current.manage",
        introduced_in: "1.1",
        stability: "beta",
        required_scope: "mm:write",
        risk: "submit",
        default_enabled: true,
        public_sdk: true,
        mcp_exposure: "submit",
      },
    ],
  };
  const markets: MarketsResponse = {
    schema_version: 1,
    contract_version: CONTRACT_VERSION,
    markets: [
      {
        base: "So11111111111111111111111111111111111111112",
        quote: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        market_pda: "G3uTbTDGFQrNwdvDNSCu2rQbSx4Ujfm75vgUdENR8h4J",
        label: "SOL/USDC",
        ready: true,
        base_decimals: 9,
        quote_decimals: 6,
        quote_path: "/sonar/markets/sol-usdc/quote",
      },
    ],
  };
  const quote: QuoteResponse = {
    schema_version: 1,
    contract_version: CONTRACT_VERSION,
    quote_id: "sq_0123456789abcdef0123456789abcdef",
    server_time_ms: 1_785_420_000_000,
    expires_at_ms: 1_785_420_005_000,
    market_id: markets.markets[0]!.market_pda!,
    side: "sell",
    amount_in_atoms: "10000000",
    amount_in_consumed_atoms: "10000000",
    amount_out_atoms: "1500000",
    minimum_output_atoms: "1492500",
    input_fee_atoms: "0",
    output_fee_atoms: "750",
    maximum_tolerance_bps: 50,
    reference_price: "150",
    price_impact_pct: "0.01",
    provider: "Sonar",
  };
  let quoteRequest: QuoteRequest | undefined;
  let swapQuoteRequest: PlatformSwapQuoteInput | undefined;
  let challengeRequest: ExecutionChallengeRequest | undefined;
  let prepareRequest: ExecutionPrepareRequest | undefined;
  let submitRequest: ExecutionSubmitRequest | undefined;
  let orderChallengeRequest: PlatformOrderChallengeInput | undefined;
  let orderPrepareRequest: PlatformOrderPrepareInput | undefined;
  let orderSubmitRequest: PlatformOrderSubmitInput | undefined;
  let orderStatusRequest: PlatformOrderStatusInput | undefined;
  let strandPrepareRequest: PlatformMakerStrandPrepareInput | undefined;
  let strandSubmitRequest: PlatformMakerControlSubmitInput | undefined;
  let currentPrepareRequest: PlatformMakerCurrentPrepareInput | undefined;
  let currentSubmitRequest: PlatformMakerControlSubmitInput | undefined;
  let intentPrepareRequest: PlatformMakerIntentPrepareInput | undefined;
  let intentSubmitRequest: PlatformMakerIntentSubmitInput | undefined;
  let makerQuickstartPrepareRequest: PlatformMakerQuickstartPrepareInput | undefined;
  let makerQuickstartSubmitRequest: PlatformMakerSubmitPreparedInput | undefined;
  let twapChallengeRequest: PlatformTwapChallengeInput | undefined;
  let twapPrepareRequest: PlatformTwapPrepareInput | undefined;
  let twapSubmitRequest: PlatformTwapSubmitInput | undefined;
  let referralLinkRequest: PlatformReferralLinkInput | undefined;
  let referralClaimRequest: PlatformReferralClaimInput | undefined;
  let vaultSetupRequest: PlatformVaultSetupPrepareInput | undefined;
  let vaultDelegateRequest: PlatformVaultDelegatePrepareInput | undefined;
  let vaultPolicyRequest: PlatformVaultPolicyPrepareInput | undefined;
  let vaultDepositRequest: PlatformVaultDepositPrepareInput | undefined;
  let vaultWithdrawRequest: PlatformVaultWithdrawPrepareInput | undefined;
  const challenge: ExecutionChallengeResponse = {
    schema_version: 1,
    contract_version: CONTRACT_VERSION,
    challenge_id: "sc_0123456789abcdef0123456789abcdef",
    quote_id: quote.quote_id,
    market_id: quote.market_id,
    side: quote.side,
    amount_in_atoms: quote.amount_in_atoms,
    minimum_output_atoms: quote.minimum_output_atoms,
    authorization_payload_base64: "AQ==",
    server_time_ms: quote.server_time_ms,
    expires_at_ms: quote.expires_at_ms,
  };
  const prepared: ExecutionPrepareResponse = {
    schema_version: 1,
    contract_version: CONTRACT_VERSION,
    execution_id: "se_0123456789abcdef0123456789abcdef",
    quote_id: quote.quote_id,
    market_id: quote.market_id,
    side: quote.side,
    amount_in_atoms: quote.amount_in_atoms,
    minimum_output_atoms: quote.minimum_output_atoms,
    transaction_base64: "AQ==",
    recent_blockhash: "11111111111111111111111111111111",
    last_valid_block_height: 123,
    expires_at_ms: quote.expires_at_ms,
  };
  const submitted: ExecutionSubmitResponse = {
    schema_version: 1,
    contract_version: CONTRACT_VERSION,
    execution_id: prepared.execution_id,
    signature: "1111111111111111111111111111111111111111111111111111111111111111",
    status: "submitted",
  };
  const platformMarketId = "market_22222222222222222222222222222222";
  const orderChallenge: PlatformOrderChallengeResponse = {
    schema_version: 2,
    contract_version: "2.0",
    challenge_id: "oc_11111111111111111111111111111111",
    market_id: platformMarketId,
    action: "cancel_all",
    order_ids: ["order_33333333333333333333333333333333"],
    authorization_payload_base64: "AQ==",
    server_time_ms: 1_785_420_000_000,
    expires_at_ms: 1_785_420_060_000,
  };
  const orderPrepared: PlatformOrderPrepareResponse = {
    schema_version: 2,
    contract_version: "2.0",
    order_control_id: "or_44444444444444444444444444444444",
    market_id: platformMarketId,
    action: "cancel_all",
    order_ids: orderChallenge.order_ids,
    transaction_base64: "AQ==",
    recent_blockhash: "11111111111111111111111111111111",
    last_valid_block_height: 123,
    expires_at_ms: orderChallenge.expires_at_ms,
  };
  const orderSubmitted: PlatformOrderSubmitResponse = {
    schema_version: 2,
    contract_version: "2.0",
    order_control_id: orderPrepared.order_control_id,
    market_id: platformMarketId,
    action: "cancel_all",
    order_ids: orderChallenge.order_ids,
    signature: submitted.signature,
    status: "submitted",
  };
  const orderStatus: PlatformOrderStatusResponse = {
    ...orderSubmitted,
    status: "submitted",
    failure_code: null,
    updated_at_ms: 1_785_420_001_000,
  };
  const makerControlPrepared: PlatformMakerControlPrepareResponse = {
    schema_version: 2,
    contract_version: "2.0",
    maker_control_id: "mc_55555555555555555555555555555555",
    market_id: platformMarketId,
    maker_wallet: "5Ji61Fbeb22Yntgv1hhHeSSLgdEdZchHeM1Tv1MjGhSL",
    product: "strand",
    action: "strand_cancel",
    transaction_base64: "AQ==",
    recent_blockhash: "11111111111111111111111111111111",
    last_valid_block_height: 123,
    expires_at_ms: 1_785_420_060_000,
  };
  const makerControlSubmitted: PlatformMakerControlSubmitResponse = {
    schema_version: 2,
    contract_version: "2.0",
    maker_control_id: makerControlPrepared.maker_control_id,
    market_id: platformMarketId,
    maker_wallet: makerControlPrepared.maker_wallet,
    product: "strand",
    action: "strand_cancel",
    signature: submitted.signature,
    status: "submitted",
  };
  const makerIntentPrepared: PlatformMakerIntentPrepareResponse = {
    schema_version: 2,
    contract_version: "2.0",
    market_id: platformMarketId,
    owner_wallet: makerControlPrepared.maker_wallet,
    vault_address: "11111111111111111111111111111111",
    session_public_key: "22222222222222222222222222222222",
    intent_address: "33333333333333333333333333333333",
    action: "revoke",
    transaction_base64: "AQ==",
    recent_blockhash: "11111111111111111111111111111111",
    last_valid_block_height: 123,
    expires_at_ms: 1_785_420_060_000,
    sponsored: true,
  };
  const makerIntentSubmitted: PlatformMakerIntentSubmitResponse = {
    signature: submitted.signature,
  };
  const platformGraph: PlatformActionGraphResponse = {
    schema_version: 2,
    contract_version: "2.0",
    graph_version: "2.0",
    entry_operation_id: "platform.capabilities.read",
    authority: {
      permission_source: "external_agent_owner",
      signing_location: "external",
      accepts_private_keys: false,
    },
    entities: ["platform"],
    relations: [],
    modules: [{
      id: "discovery",
      client_property: "discovery",
      capability_ids: ["platform.discover"],
    }],
    operations: [{
      id: "platform.capabilities.read",
      capability_id: "platform.discover",
      kind: "discovery",
      summary: "Read live capabilities.",
      transports: [{ transport: "http", method: "GET", path: "/v2/capabilities" }],
      available: true,
    }],
    workflows: [{
      id: "discover",
      entry_node: "capabilities",
      nodes: [{
        id: "capabilities",
        kind: "discovery",
        capability_id: "platform.discover",
        operation_ids: ["platform.capabilities.read"],
        available: true,
      }],
      edges: [],
    }],
  };
  const platformCandles: PlatformCandlesResponse = {
    schema_version: 2,
    contract_version: "2.0",
    market_id: platformMarketId,
    server_time_ms: 1_785_420_000_000,
    resolution_seconds: 300,
    candles: [{
      started_at_ms: 1_785_419_700_000,
      open_price: "149.9",
      high_price: "150.1",
      low_price: "149.8",
      close_price: "150",
    }],
  };
  const platformMark: PlatformMarkResponse = {
    schema_version: 2,
    contract_version: "2.0",
    market_id: platformMarketId,
    server_time_ms: 1_785_420_000_000,
    price_atoms_per_base_unit: "150000000",
    quote_decimals: 6,
    stale: false,
    age_ms: 25,
  };
  const platformSwapQuote: PlatformSwapQuoteResponse = {
    schema_version: 2,
    contract_version: "2.0",
    quote_id: "sq_fedcba9876543210fedcba9876543210",
    server_time_ms: 1_785_420_000_000,
    expires_at_ms: 1_785_420_003_000,
    input_asset_id: "asset_11111111111111111111111111111111",
    output_asset_id: "asset_22222222222222222222222222222222",
    amount_in_atoms: "10000000",
    amount_in_consumed_atoms: "10000000",
    amount_out_atoms: "1990000",
    minimum_output_atoms: "1980050",
    input_fee_atoms: "0",
    output_fee_atoms: "995",
    maximum_tolerance_bps: 50,
    reference_price: "199.1",
    price_impact_pct: "0.0005",
    provider: "Sonar",
  };
  const platformExecutionStatus: PlatformExecutionStatusResponse = {
    schema_version: 2,
    contract_version: "2.0",
    execution_id: "se_0123456789abcdef0123456789abcdef",
    market_id: platformMarketId,
    status: "confirmed",
    signature: submitted.signature,
    settlement: "confirmed",
    updated_at_ms: 1_785_420_000_000,
  };
  const platformTwaps: PlatformTwapsResponse = {
    schema_version: 2,
    contract_version: "2.0",
    market_id: platformMarketId,
    wallet_address: "5Ji61Fbeb22Yntgv1hhHeSSLgdEdZchHeM1Tv1MjGhSL",
    server_time_ms: 1_785_420_000_000,
    twaps: [],
  };
  const twapChallenge: PlatformTwapChallengeResponse = {
    schema_version: 2,
    contract_version: "2.0",
    challenge_id: "twc_55555555555555555555555555555555",
    market_id: platformMarketId,
    action: "place",
    twap_id: "twap_66666666666666666666666666666666",
    authorization_payload_base64: "AQ==",
    server_time_ms: 1_785_420_000_000,
    expires_at_ms: 1_785_420_060_000,
  };
  const twapPrepared: PlatformTwapPrepareResponse = {
    schema_version: 2,
    contract_version: "2.0",
    twap_control_id: "twctl_77777777777777777777777777777777",
    market_id: platformMarketId,
    action: "place",
    twap_id: twapChallenge.twap_id,
    transaction_base64: "AQ==",
    recent_blockhash: "11111111111111111111111111111111",
    last_valid_block_height: 123,
    expires_at_ms: twapChallenge.expires_at_ms,
  };
  const twapSubmitted: PlatformTwapSubmitResponse = {
    schema_version: 2,
    contract_version: "2.0",
    twap_control_id: twapPrepared.twap_control_id,
    market_id: platformMarketId,
    action: "place",
    twap_id: twapChallenge.twap_id,
    signature: submitted.signature,
    status: "submitted",
  };
  const walletAddress = "5Ji61Fbeb22Yntgv1hhHeSSLgdEdZchHeM1Tv1MjGhSL";
  let makerStatusRequestedFor: string | undefined;
  let makerReputationRequestedFor: string | undefined;
  const platformMakerReputation = JSON.parse(
    await readFile(contractFixture("v2/maker-reputation.json"), "utf8"),
  ) as Record<string, unknown>;
  const platformMakerStatus: PlatformMakerStatusResponse = {
    schema_version: 2,
    contract_version: "2.0",
    market_id: platformMarketId,
    maker_id: "maker_66666666666666666666666666666666",
    wallet_address: walletAddress,
    server_time_ms: 1_785_420_000_000,
    current_slot: "372000000",
    firm_orders: {
      resting_orders: 0,
      bid_orders: 0,
      ask_orders: 0,
      bid_size_atoms: "0",
      ask_size_atoms: "0",
    },
    intent: null,
    signed_quotes: { eligible: false, live_quotes: [] },
    strands: [],
    currents: [],
    dead_man_guards: [],
    active_products: 0,
  };
  const makerQuickstartPrepared: PlatformMakerQuickstartPrepared = {
    market: {
      market_id: platformMarketId,
      label: "SOL/USDC",
      base_asset_id: "asset_f7aaf74f7aada9a787dff38b120db490",
      quote_asset_id: "asset_d5d994a8b7bd6754169178beb2784cec",
      status: "active",
      available_actions: ["quote", "execute_immediate", "place_order", "schedule_twap"],
    },
    base_asset: {
      asset_id: "asset_f7aaf74f7aada9a787dff38b120db490",
      symbol: "SOL",
      name: "Solana",
      decimals: 9,
      network: "solana",
    },
    product: "current",
    operation: {
      action: "upsert",
      makerWallet: makerControlPrepared.maker_wallet,
      enabled: true,
      asyncOnly: false,
      halfSpreadBps: 5,
      bandStepBps: 5,
      maxConfidenceBps: 100,
      maxOracleDeviationBps: 500,
      maxOracleAgeSeconds: 10,
      syncSpreadBps: 0,
      maxExposureBaseAtoms: "10000000",
      bidDepthBaseAtoms: ["3333334", "3333333", "3333333", "0", "0", "0", "0", "0"],
      askDepthBaseAtoms: ["3333334", "3333333", "3333333", "0", "0", "0", "0", "0"],
      validUntilSlot: "372001500",
    },
    prepared: {
      ...makerControlPrepared,
      product: "current",
      action: "current_upsert",
    },
  };
  const platformPortfolio: PlatformPortfolioResponse = {
    schema_version: 2,
    contract_version: "2.0",
    wallet_address: walletAddress,
    server_time_ms: 1_785_420_000_000,
    observed_at_ms: 1_785_419_999_500,
    observed_slot: "372000000",
    market_count: 1,
    balances: [{
      asset_id: "asset_11111111111111111111111111111111",
      available_atoms: "1500000000",
      locked_atoms: "600000000",
      total_atoms: "2100000000",
      value_usd_micros: "314989500",
    }],
    positions: [{
      market_id: platformMarketId,
      base_asset_id: "asset_11111111111111111111111111111111",
      quote_asset_id: "asset_22222222222222222222222222222222",
      base_available_atoms: "1000000000",
      base_locked_atoms: "600000000",
      quote_available_atoms: "0",
      quote_locked_atoms: "0",
    }],
    open_orders: [],
    recent_fills: [],
    unavailable_market_ids: [],
    equity_usd_micros: "314989500",
    available_usd_micros: "224992500",
    locked_usd_micros: "89997000",
    valuation_complete: true,
    unpriced_asset_ids: [],
  };
  const platformPortfolioHistory: PlatformPortfolioHistoryResponse = {
    schema_version: 2,
    contract_version: "2.0",
    wallet_address: walletAddress,
    server_time_ms: 1_785_420_000_000,
    range: "24h",
    points: [{
      recorded_at_ms: 1_785_419_700_000,
      equity_usd_micros: "150000000",
      available_usd_micros: "120000000",
      locked_usd_micros: "30000000",
      market_count: 2,
    }],
    collecting: false,
    first_sample_ms: 1_785_419_700_000,
    last_sample_ms: 1_785_419_700_000,
  };
  const platformVaultStatus: PlatformVaultStatusResponse = {
    schema_version: 2,
    contract_version: "2.0",
    server_time_ms: 1_785_420_000_000,
    wallet_address: walletAddress,
    state: "active",
    session: null,
    withdrawal_access: {
      mode: "unrestricted",
      allowed_wallet_addresses: [],
    },
  };
  const platformVaultPause: PlatformVaultPausePrepareResponse = {
    schema_version: 2,
    contract_version: "2.0",
    server_time_ms: 1_785_420_000_000,
    wallet_address: walletAddress,
    paused: true,
    transaction_base64: "AQIDBA==",
    recent_blockhash: "11111111111111111111111111111111",
    owner_signature_required: true,
    preparation_id: "vp_00000000000000000000000000000001",
    sponsored: true,
    submit_by_ms: 1_785_420_090_000,
  };
  const platformVaultSetup: PlatformVaultSetupPrepareResponse = {
    schema_version: 2,
    contract_version: "2.0",
    server_time_ms: 1_785_420_000_000,
    wallet_address: walletAddress,
    session_public_key: "9Uu7cLBgfMk233BAjMvTS8XJy6KbZK7oQ7NXuCTi3Fg2",
    replace_session_public_key: null,
    market_id: "market_33333333333333333333333333333333",
    mode: "create",
    expires_at_ms: null,
    permanent: true,
    minimum_interval_seconds: 0,
    maximum_tolerance_bps: 100,
    spending_limits: [
      {
        asset_id: "asset_0123456789abcdef0123456789abcdef",
        maximum_per_execution_atoms: null,
      },
      {
        asset_id: "asset_fedcba9876543210fedcba9876543210",
        maximum_per_execution_atoms: "100000000",
      },
    ],
    transaction_base64: "AQIDBA==",
    recent_blockhash: "11111111111111111111111111111111",
    owner_signature_required: true,
    preparation_id: "vp_00000000000000000000000000000002",
    sponsored: true,
    submit_by_ms: 1_785_420_090_000,
  };
  const platformVaultDelegate: PlatformVaultDelegatePrepareResponse = {
    schema_version: 2,
    contract_version: "2.0",
    server_time_ms: 1_785_420_000_000,
    wallet_address: walletAddress,
    session_public_key: platformVaultSetup.session_public_key,
    action: "revoke",
    transaction_base64: "AQIDBA==",
    recent_blockhash: "11111111111111111111111111111111",
    owner_signature_required: true,
    preparation_id: "vp_00000000000000000000000000000003",
    sponsored: true,
    submit_by_ms: 1_785_420_090_000,
  };
  const platformVaultPolicy: PlatformVaultPolicyPrepareResponse = {
    schema_version: 2,
    contract_version: "2.0",
    server_time_ms: 1_785_420_000_000,
    wallet_address: walletAddress,
    withdrawal_access: {
      mode: "restricted",
      allowed_wallet_addresses: [walletAddress],
    },
    transaction_base64: "AQIDBA==",
    recent_blockhash: "11111111111111111111111111111111",
    owner_signature_required: true,
    preparation_id: "vp_00000000000000000000000000000004",
    sponsored: true,
    submit_by_ms: 1_785_420_090_000,
  };
  const platformVaultDeposit: PlatformVaultDepositPrepareResponse = {
    schema_version: 2,
    contract_version: "2.0",
    server_time_ms: 1_785_420_000_000,
    wallet_address: walletAddress,
    market_id: "market_33333333333333333333333333333333",
    asset_id: "asset_0123456789abcdef0123456789abcdef",
    amount_atoms: "10000000",
    network_cost_atoms: "0",
    session_public_key: "9Uu7cLBgfMk233BAjMvTS8XJy6KbZK7oQ7NXuCTi3Fg2",
    registers_session: true,
    transaction_base64: "AQIDBA==",
    recent_blockhash: "11111111111111111111111111111111",
    owner_signature_required: true,
    preparation_id: "vp_00000000000000000000000000000005",
    sponsored: true,
    submit_by_ms: 1_785_420_090_000,
  };
  const platformVaultWithdraw: PlatformVaultWithdrawPrepareResponse = {
    schema_version: 2,
    contract_version: "2.0",
    server_time_ms: 1_785_420_000_000,
    wallet_address: walletAddress,
    market_id: "market_33333333333333333333333333333333",
    asset_id: "asset_fedcba9876543210fedcba9876543210",
    destination_wallet_address: walletAddress,
    amount_atoms: "5000000",
    transaction_base64: "AQIDBA==",
    recent_blockhash: "11111111111111111111111111111111",
    owner_signature_required: true,
    preparation_id: "vp_00000000000000000000000000000006",
    sponsored: true,
    submit_by_ms: 1_785_420_090_000,
  };
  const platformVaultSubmit: PlatformVaultSubmitResponse = {
    schema_version: 2,
    contract_version: "2.0",
    preparation_id: platformVaultWithdraw.preparation_id,
    action: "withdraw",
    wallet_address: walletAddress,
    sponsored: true,
    signature: "1".repeat(64),
    status: "submitted",
    failure_code: null,
    updated_at_ms: 1_785_420_001_000,
  };
  let vaultSubmitRequest: PlatformVaultSubmitInput | undefined;
  const platformPoints: PlatformPointsResponse = {
    schema_version: 2,
    contract_version: "2.0",
    server_time_ms: 1_788_825_600_000,
    program_scope: "all_live_markets",
    season: "Genesis",
    season_index: 0,
    season_start_ms: 1_788_134_400_000,
    genesis_ms: 1_788_134_400_000,
    genesis_epochs: 6,
    epoch_index: 1,
    epoch_in_season: 1,
    epoch_start_ms: 1_788_739_200_000,
    epoch_end_ms: 1_789_344_000_000,
    allocation_finalizes_after_ms: 1_789_345_800_000,
    balances_include_closed_epochs_only: true,
    weekly_points_budget: "1000000",
    weights_bps: { volume: 3000, maker: 5000, bugs: 1500, referrals: 500 },
    total_wallets: 1,
    owner: {
      wallet_address: walletAddress,
      rank: 1,
      points: "1250",
      volume_points: "1000",
      maker_points: "100",
      bug_points: "100",
      referral_points: "50",
    },
    standings: [{
      rank: 1,
      wallet_address: walletAddress,
      points: "1250",
      volume_points: "1000",
      maker_points: "100",
      bug_points: "100",
      referral_points: "50",
    }],
  };
  const platformRewards: PlatformRewardsResponse = {
    schema_version: 2,
    contract_version: "2.0",
    server_time_ms: 1_785_420_000_000,
    season: "season-1",
    total_wallets: 1,
    owner: {
      wallet_address: walletAddress,
      rank: 1,
      points: "1250",
      trading_points: "1000",
      making_points: "100",
      bug_points: "100",
      referral_points: "50",
    },
    standings: [{ rank: 1, wallet_address: walletAddress, points: "1250" }],
  };
  const platformReferrals: PlatformReferralsResponse = {
    schema_version: 2,
    contract_version: "2.0",
    server_time_ms: 1_785_420_000_000,
    wallet_address: walletAddress,
    enabled: true,
    cash_rewards_enabled: true,
    referral_code: "STRATA1",
    referred_wallets: 2,
    referral_points: "50",
    referred_by: null,
    referral_locked: false,
    cash_accrued_atoms: "500000",
    cash_paid_atoms: "100000",
    cash_claimable_atoms: "400000",
  };
  const platformReferralLink: PlatformReferralLinkResponse = {
    schema_version: 2,
    contract_version: "2.0",
    server_time_ms: 1_785_420_000_000,
    wallet_address: walletAddress,
    referral_code: "STRATA1",
    status: "pending_first_fill",
  };
  const platformReferralClaim: PlatformReferralClaimResponse = {
    schema_version: 2,
    contract_version: "2.0",
    server_time_ms: 1_785_420_000_000,
    wallet_address: walletAddress,
    payout_wallet_address: walletAddress,
    claimable_atoms: "400000",
    status: "requested",
  };
  const platformBugs: PlatformBugsResponse = {
    schema_version: 2,
    contract_version: "2.0",
    server_time_ms: 1_785_420_000_000,
    wallet_address: walletAddress,
    points: "100",
    confirmed_reports: 1,
    reports: [{
      bug_id: "bug_0123456789abcdef0123456789abcdef",
      status: "confirmed",
      severity: 2,
      points: "100",
      created_at_ms: 1_785_419_000_000,
      triaged_at_ms: 1_785_419_100_000,
      completed_at_ms: 1_785_419_200_000,
    }],
  };
  const platformBugSubmit: PlatformBugSubmitResponse = {
    schema_version: 2,
    contract_version: "2.0",
    server_time_ms: 1_785_420_000_000,
    bug_id: "bug_fedcba9876543210fedcba9876543210",
    status: "pending",
  };
  const fakeClient = {
    capabilities: async () => liveCatalog,
    actionGraph: async () => STRATA_ACTION_GRAPH,
    markets: async () => markets,
    quote: async (request: QuoteRequest) => {
      quoteRequest = request;
      return quote;
    },
    executionChallenge: async (request: ExecutionChallengeRequest) => {
      challengeRequest = request;
      return challenge;
    },
    executionPrepare: async (request: ExecutionPrepareRequest) => {
      prepareRequest = request;
      return prepared;
    },
    executionSubmit: async (request: ExecutionSubmitRequest) => {
      submitRequest = request;
      return submitted;
    },
  } as unknown as StrataClient;
  const platformMarketList = {
    schema_version: 2 as const,
    contract_version: "2.0" as const,
    server_time_ms: 1_785_420_000_000,
    markets: [
      {
        market_id: "market_19238016c19cdee72169382a91b676a1",
        label: "SOL/USDC",
        base_asset_id: "asset_f7aaf74f7aada9a787dff38b120db490",
        quote_asset_id: "asset_d5d994a8b7bd6754169178beb2784cec",
        status: "active" as const,
        available_actions: ["quote", "execute_immediate", "place_order", "schedule_twap"] as const,
      },
    ],
    page: { next_cursor: null, has_more: false },
  };
  const fakePlatformClient = {
    markets: {
      list: async () => platformMarketList,
    },
    discovery: {
      read: async () => livePlatformCatalog,
      graph: async () => platformGraph,
      status: async () => ({
        schema_version: 2,
        contract_version: "2.0",
        server_time_ms: 1786550400000,
        status: "operational",
        available_operations: 34,
      } satisfies PlatformServiceStatusResponse),
    },
    marketData: {
      candles: async () => platformCandles,
      mark: async () => platformMark,
    },
    quotes: {
      swap: async (request: PlatformSwapQuoteInput) => {
        swapQuoteRequest = request;
        return platformSwapQuote;
      },
    },
    executions: {
      status: async () => platformExecutionStatus,
    },
    algos: {
      twaps: async () => platformTwaps,
      challenge: async (_marketId: string, request: PlatformTwapChallengeInput) => {
        twapChallengeRequest = request;
        return { ...twapChallenge, action: request.action };
      },
      prepare: async (_marketId: string, request: PlatformTwapPrepareInput) => {
        twapPrepareRequest = request;
        return twapPrepared;
      },
      submit: async (_marketId: string, request: PlatformTwapSubmitInput) => {
        twapSubmitRequest = request;
        return twapSubmitted;
      },
    },
    account: {
      read: async () => platformPortfolio,
      portfolio: async () => platformPortfolio,
      portfolioHistory: async () => platformPortfolioHistory,
    },
    marketMaking: {
      prepareStart: async (request: PlatformMakerQuickstartPrepareInput) => {
        makerQuickstartPrepareRequest = request;
        return makerQuickstartPrepared;
      },
      prepareStop: async () => ({
        market: makerQuickstartPrepared.market,
        product: "current" as const,
        operation: { action: "cancel" as const, makerWallet: makerControlPrepared.maker_wallet },
        prepared: { ...makerControlPrepared, product: "current" as const, action: "current_cancel" as const },
      }),
      submitPrepared: async (request: PlatformMakerSubmitPreparedInput) => {
        makerQuickstartSubmitRequest = request;
        return {
          ...makerQuickstartPrepared,
          receipt: {
            ...makerControlSubmitted,
            product: "current" as const,
            action: "current_upsert" as const,
          },
          status: "confirmed" as const,
          maker_status: platformMakerStatus,
        };
      },
      strand: {
        prepare: async (_marketId: string, request: PlatformMakerStrandPrepareInput) => {
          strandPrepareRequest = request;
          const action = request.action === "upsert" ? "strand_upsert" as const
            : request.action === "recenter" ? "strand_recenter" as const
              : request.action === "set_enabled" ? "strand_set_enabled" as const
                : "strand_cancel" as const;
          return { ...makerControlPrepared, product: "strand" as const, action };
        },
        submit: async (_marketId: string, request: PlatformMakerControlSubmitInput) => {
          strandSubmitRequest = request;
          return makerControlSubmitted;
        },
      },
      current: {
        prepare: async (_marketId: string, request: PlatformMakerCurrentPrepareInput) => {
          currentPrepareRequest = request;
          return {
            ...makerControlPrepared,
            product: "current" as const,
            action: request.action === "upsert" ? "current_upsert" as const : "current_cancel" as const,
          };
        },
        submit: async (_marketId: string, request: PlatformMakerControlSubmitInput) => {
          currentSubmitRequest = request;
          return {
            ...makerControlSubmitted,
            product: "current" as const,
            action: "current_cancel" as const,
          };
        },
      },
      intent: {
        prepare: async (_marketId: string, request: PlatformMakerIntentPrepareInput) => {
          intentPrepareRequest = request;
          return { ...makerIntentPrepared, action: request.action };
        },
        submit: async (_marketId: string, request: PlatformMakerIntentSubmitInput) => {
          intentSubmitRequest = request;
          return makerIntentSubmitted;
        },
      },
      status: async (_marketId: string, maker: unknown) => {
        makerStatusRequestedFor = String(maker);
        return platformMakerStatus;
      },
      reputation: async (_marketId: string, maker: unknown) => {
        makerReputationRequestedFor = String(maker);
        return platformMakerReputation;
      },
    },
    vault: {
      status: async () => platformVaultStatus,
      prepareSetup: async (request: PlatformVaultSetupPrepareInput) => {
        vaultSetupRequest = request;
        return platformVaultSetup;
      },
      prepareDelegate: async (request: PlatformVaultDelegatePrepareInput) => {
        vaultDelegateRequest = request;
        return platformVaultDelegate;
      },
      preparePolicy: async (request: PlatformVaultPolicyPrepareInput) => {
        vaultPolicyRequest = request;
        return platformVaultPolicy;
      },
      prepareDeposit: async (request: PlatformVaultDepositPrepareInput) => {
        vaultDepositRequest = request;
        return platformVaultDeposit;
      },
      prepareWithdrawal: async (request: PlatformVaultWithdrawPrepareInput) => {
        vaultWithdrawRequest = request;
        return platformVaultWithdraw;
      },
      preparePause: async () => platformVaultPause,
      submit: async (request: PlatformVaultSubmitInput) => {
        vaultSubmitRequest = request;
        return platformVaultSubmit;
      },
      submission: async () => ({ ...platformVaultSubmit, status: "confirmed" as const }),
    },
    points: {
      read: async () => platformPoints,
    },
    rewards: {
      read: async () => platformRewards,
    },
    referrals: {
      read: async () => platformReferrals,
      linkAuthorizationPayload: (code: string) =>
        new TextEncoder().encode(`strata-referral:v1:${code.trim()}`),
      claimAuthorizationPayload: (payout: string) =>
        new TextEncoder().encode(`strata-referral-claim:v1:${payout}`),
      link: async (request: PlatformReferralLinkInput) => {
        referralLinkRequest = request;
        return platformReferralLink;
      },
      claim: async (request: PlatformReferralClaimInput) => {
        referralClaimRequest = request;
        return platformReferralClaim;
      },
    },
    bugs: {
      authorizationPayload: (message: string) =>
        new TextEncoder().encode(`strata-bug-report:v1:${message.trim()}`),
      read: async () => platformBugs,
      submit: async () => platformBugSubmit,
    },
    orders: {
      challenge: async (_marketId: string, request: PlatformOrderChallengeInput) => {
        orderChallengeRequest = request;
        return orderChallenge;
      },
      prepare: async (_marketId: string, request: PlatformOrderPrepareInput) => {
        orderPrepareRequest = request;
        return orderPrepared;
      },
      submit: async (_marketId: string, request: PlatformOrderSubmitInput) => {
        orderSubmitRequest = request;
        return orderSubmitted;
      },
      status: async (_marketId: string, request: PlatformOrderStatusInput) => {
        orderStatusRequest = request;
        return orderStatus;
      },
    },
  } as unknown as StrataPlatformClient;
  const runtime = await createStrataMcpServer({
    client: fakeClient,
    platformClient: fakePlatformClient,
    toolMode: "advanced",
  });
  const protocolClient = new Client({ name: "strata-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await runtime.server.connect(serverTransport);
    await protocolClient.connect(clientTransport);

    const resources = await protocolClient.listResources();
    assert.deepEqual(
      resources.resources.map((resource) => resource.uri).sort(),
      [
        STRATA_ACTION_GRAPH_URI,
        STRATA_AGENT_HARNESS_URI,
        STRATA_AGENT_KERNEL_URI,
        STRATA_AGENT_ROUTER_URI,
        STRATA_AGENT_TOOL_REGISTRY_URI,
        STRATA_PLATFORM_GRAPH_URI,
        ...Object.keys(STRATA_AGENT_BRANCHES).map(
          (branchId) => `${STRATA_AGENT_BRANCH_URI_PREFIX}${branchId}/v1`,
        ),
      ].sort(),
    );
    const harness = await protocolClient.readResource({ uri: STRATA_AGENT_HARNESS_URI });
    assert.equal(harness.contents.length, 1);
    assert.deepEqual(
      JSON.parse("text" in harness.contents[0]! ? harness.contents[0]!.text : "{}"),
      STRATA_AGENT_HARNESS,
    );
    const router = await protocolClient.readResource({ uri: STRATA_AGENT_ROUTER_URI });
    assert.deepEqual(
      JSON.parse("text" in router.contents[0]! ? router.contents[0]!.text : "{}"),
      STRATA_AGENT_ROUTER,
    );
    const kernel = await protocolClient.readResource({ uri: STRATA_AGENT_KERNEL_URI });
    assert.deepEqual(
      JSON.parse("text" in kernel.contents[0]! ? kernel.contents[0]!.text : "{}"),
      STRATA_AGENT_KERNEL,
    );
    const toolRegistry = await protocolClient.readResource({ uri: STRATA_AGENT_TOOL_REGISTRY_URI });
    assert.deepEqual(
      JSON.parse("text" in toolRegistry.contents[0]! ? toolRegistry.contents[0]!.text : "{}"),
      STRATA_AGENT_TOOL_REGISTRY,
    );
    const pointsBranch = await protocolClient.readResource({
      uri: `${STRATA_AGENT_BRANCH_URI_PREFIX}points/v1`,
    });
    const pointsContext = JSON.parse(
      "text" in pointsBranch.contents[0]! ? pointsBranch.contents[0]!.text : "{}",
    ) as { branch_id: string; tools: string[] };
    assert.equal(pointsContext.branch_id, "points");
    assert.ok(pointsContext.tools.includes("strata_points"));
    assert.ok(!pointsContext.tools.includes("strata_trade"));
    const graph = await protocolClient.readResource({ uri: STRATA_ACTION_GRAPH_URI });
    assert.deepEqual(
      JSON.parse("text" in graph.contents[0]! ? graph.contents[0]!.text : "{}"),
      STRATA_ACTION_GRAPH,
    );
    const completeGraph = await protocolClient.readResource({ uri: STRATA_PLATFORM_GRAPH_URI });
    assert.deepEqual(
      JSON.parse("text" in completeGraph.contents[0]! ? completeGraph.contents[0]!.text : "{}"),
      platformGraph,
    );

    const prompts = await protocolClient.listPrompts();
    assert.deepEqual(prompts.prompts.map((prompt) => prompt.name), ["strata_start"]);
    const start = await protocolClient.getPrompt({
      name: "strata_start",
      arguments: { objective: "Quote selling 0.1 SOL for USDC." },
    });
    assert.match(JSON.stringify(start.messages), /initialized Strata safety kernel/);
    assert.match(JSON.stringify(start.messages), /Quote selling 0.1 SOL/);
    assert.match(JSON.stringify(start.messages), /agent-branch\/market_data\/v1/);
    const pointsStart = await protocolClient.getPrompt({
      name: "strata_start",
      arguments: { objective: "Read my Points rank.", branch: "points" },
    });
    assert.match(JSON.stringify(pointsStart.messages), /strata_points/);
    assert.doesNotMatch(JSON.stringify(pointsStart.messages), /strata_order_execute/);

    const initial = await protocolClient.listTools();
    assert.deepEqual(
      initial.tools.map((tool) => tool.name).sort(),
      [
        "strata_action_graph",
        "strata_autonomy",
        "strata_bbo",
        "strata_book",
        "strata_bug_submit",
        "strata_bugs",
        "strata_candles",
        "strata_capabilities",
        "strata_exact_output_quote",
        "strata_execute_quote",
        "strata_execution_challenge",
        "strata_execution_prepare",
        "strata_execution_status",
        "strata_execution_submit",
        "strata_market_making_current_prepare",
        "strata_market_making_current_submit",
        "strata_market_making_intent_execute",
        "strata_market_making_intent_prepare",
        "strata_market_making_intent_submit",
        "strata_market_making_prepare",
        "strata_market_making_reputation",
        "strata_market_making_status",
        "strata_market_making_strand_prepare",
        "strata_market_making_strand_submit",
        "strata_market_making_submit_and_wait",
        "strata_markets",
        "strata_marks",
        "strata_order_challenge",
        "strata_order_execute",
        "strata_order_prepare",
        "strata_order_status",
        "strata_order_submit",
        "strata_platform_graph",
        "strata_points",
        "strata_portfolio",
        "strata_portfolio_history",
        "strata_quote",
        "strata_referral_claim",
        "strata_referral_link",
        "strata_referrals",
        "strata_rewards",
        "strata_status",
        "strata_swap_quote",
        "strata_trade",
        "strata_trades",
        "strata_twap_cancel",
        "strata_twap_challenge",
        "strata_twap_execute",
        "strata_twap_prepare",
        "strata_twap_submit",
        "strata_twaps",
        "strata_vault_delegate",
        "strata_vault_deposit",
        "strata_vault_pause",
        "strata_vault_policy",
        "strata_vault_setup",
        "strata_vault_status",
        "strata_vault_submission",
        "strata_vault_submit",
        "strata_vault_withdraw",
      ],
    );

    const result = await protocolClient.callTool({
      name: "strata_markets",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    // Every listed market carries its opaque platform identity so an MCP-only
    // agent can reach every by-market tool without any other lookup.
    assert.deepEqual(result.structuredContent, {
      ...markets,
      markets: [
        {
          ...markets.markets[0],
          market_id: "market_19238016c19cdee72169382a91b676a1",
          base_asset_id: "asset_f7aaf74f7aada9a787dff38b120db490",
          quote_asset_id: "asset_d5d994a8b7bd6754169178beb2784cec",
          status: "active",
          available_actions: ["quote", "execute_immediate", "place_order", "schedule_twap"],
        },
      ],
    });
    assert.match(
      (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "",
      /1 carry a market_id/,
    );

    const platformGraphResult = await protocolClient.callTool({
      name: "strata_platform_graph",
      arguments: {},
    });
    assert.equal(platformGraphResult.isError, undefined);
    assert.deepEqual(platformGraphResult.structuredContent, platformGraph);

    const statusResult = await protocolClient.callTool({
      name: "strata_status",
      arguments: {},
    });
    assert.equal(statusResult.isError, undefined);
    assert.equal(
      (statusResult.structuredContent as PlatformServiceStatusResponse).available_operations,
      34,
    );

    const candlesResult = await protocolClient.callTool({
      name: "strata_candles",
      arguments: {
        marketId: platformMarketId,
        fromMs: 1_785_419_700_000,
        toMs: 1_785_420_000_000,
      },
    });
    assert.deepEqual(candlesResult.structuredContent, platformCandles);
    const markResult = await protocolClient.callTool({
      name: "strata_marks",
      arguments: { marketId: platformMarketId },
    });
    assert.deepEqual(markResult.structuredContent, platformMark);

    const executionStatusResult = await protocolClient.callTool({
      name: "strata_execution_status",
      arguments: {
        marketId: platformMarketId,
        executionId: platformExecutionStatus.execution_id,
      },
    });
    assert.deepEqual(executionStatusResult.structuredContent, platformExecutionStatus);
    const twapsResult = await protocolClient.callTool({
      name: "strata_twaps",
      arguments: {
        marketId: platformMarketId,
        walletAddress: platformTwaps.wallet_address,
      },
    });
    assert.deepEqual(twapsResult.structuredContent, platformTwaps);

    const twapChallengeResult = await protocolClient.callTool({
      name: "strata_twap_challenge",
      arguments: {
        marketId: platformMarketId,
        ownerWallet: "11111111111111111111111111111111",
        sessionPublicKey: "22222222222222222222222222222222",
        side: "buy",
        totalSizeAtoms: "10000000",
        slicesTotal: 10,
        maximumToleranceBps: 100,
        intervalSlots: 100,
        limitPriceAtoms: "150000000",
      },
    });
    assert.equal(twapChallengeResult.isError, undefined);
    assert.equal(twapChallengeRequest?.action, "place");

    const twapCancelResult = await protocolClient.callTool({
      name: "strata_twap_cancel",
      arguments: {
        marketId: platformMarketId,
        ownerWallet: "11111111111111111111111111111111",
        sessionPublicKey: "22222222222222222222222222222222",
        twapId: twapChallenge.twap_id,
      },
    });
    assert.equal(twapCancelResult.isError, undefined);
    assert.equal(twapChallengeRequest?.action, "cancel");

    const twapPrepareResult = await protocolClient.callTool({
      name: "strata_twap_prepare",
      arguments: {
        marketId: platformMarketId,
        challengeId: twapChallenge.challenge_id,
        authorizationSignature: "2".repeat(64),
      },
    });
    assert.equal(twapPrepareResult.isError, undefined);
    assert.ok(twapPrepareRequest && "challengeId" in twapPrepareRequest);
    assert.equal(twapPrepareRequest.challengeId, twapChallenge.challenge_id);

    // One signature: the TWAP action itself prepares.
    const directTwapPrepare = await protocolClient.callTool({
      name: "strata_twap_prepare",
      arguments: {
        marketId: platformMarketId,
        action: "cancel",
        ownerWallet: "11111111111111111111111111111111",
        sessionPublicKey: "22222222222222222222222222222222",
        twapId: twapChallenge.twap_id,
      },
    });
    assert.equal(directTwapPrepare.isError, undefined);
    const twapDirect = twapPrepareRequest as { operation?: { action: string } } | undefined;
    assert.equal(twapDirect?.operation?.action, "cancel");

    const twapSubmitResult = await protocolClient.callTool({
      name: "strata_twap_submit",
      arguments: {
        marketId: platformMarketId,
        twapControlId: twapPrepared.twap_control_id,
        signedTransactionBase64: "AQ==",
        idempotencyKey: twapPrepared.twap_control_id,
      },
    });
    assert.equal(twapSubmitResult.isError, undefined);
    assert.equal(twapSubmitRequest?.twapControlId, twapPrepared.twap_control_id);

    const portfolioResult = await protocolClient.callTool({
      name: "strata_portfolio",
      arguments: { walletAddress },
    });
    assert.deepEqual(portfolioResult.structuredContent, platformPortfolio);
    const portfolioHistoryResult = await protocolClient.callTool({
      name: "strata_portfolio_history",
      arguments: { walletAddress, range: "24h" },
    });
    assert.deepEqual(portfolioHistoryResult.structuredContent, platformPortfolioHistory);
    // Maker reads are public by wallet address: one call, no signature dance.
    const makerStatusResult = await protocolClient.callTool({
      name: "strata_market_making_status",
      arguments: { marketId: platformMarketId, walletAddress },
    });
    assert.deepEqual(makerStatusResult.structuredContent, platformMakerStatus);
    assert.equal(makerStatusRequestedFor, walletAddress);
    const makerQuickstartPrepareResult = await protocolClient.callTool({
      name: "strata_market_making_prepare",
      arguments: {
        action: "start",
        market: "SOL/USDC",
        product: "current",
        makerWallet: makerControlPrepared.maker_wallet,
        spreadBps: 5,
        size: "0.01 SOL",
        duration: "10m",
      },
    });
    assert.equal(makerQuickstartPrepareResult.isError, undefined);
    assert.equal(makerQuickstartPrepareRequest?.market, "SOL/USDC");
    assert.equal(makerQuickstartPrepareRequest?.size, "0.01 SOL");
    assert.equal(
      (makerQuickstartPrepareResult.structuredContent as { prepared?: { maker_control_id?: string } })
        .prepared?.maker_control_id,
      makerControlPrepared.maker_control_id,
    );
    const makerPreparationToken = (
      makerQuickstartPrepareResult.structuredContent as { preparationToken?: string }
    ).preparationToken;
    assert.match(makerPreparationToken ?? "", /^[A-Za-z0-9_-]+$/);
    // Hosted Streamable HTTP creates a fresh runtime for each request. Prove
    // the continuation does not depend on process-local preparation state.
    const restartedRuntime = await createStrataMcpServer({
      client: fakeClient,
      platformClient: fakePlatformClient,
      toolMode: "advanced",
    });
    const restartedClient = new Client({ name: "strata-mcp-restart-test", version: "1.0.0" });
    const [restartedClientTransport, restartedServerTransport] =
      InMemoryTransport.createLinkedPair();
    let makerQuickstartSubmitResult;
    try {
      await restartedRuntime.server.connect(restartedServerTransport);
      await restartedClient.connect(restartedClientTransport);
      makerQuickstartSubmitResult = await restartedClient.callTool({
        name: "strata_market_making_submit_and_wait",
        arguments: {
          makerControlId: makerControlPrepared.maker_control_id,
          preparationToken: makerPreparationToken,
          signedTransactionBase64: "AQ==",
        },
      });
    } finally {
      await restartedClient.close();
      await restartedRuntime.close();
    }
    assert.equal(makerQuickstartSubmitResult.isError, undefined);
    assert.equal(makerQuickstartSubmitRequest?.signedTransactionBase64, "AQ==");
    assert.equal(
      (makerQuickstartSubmitResult.structuredContent as { status?: string }).status,
      "confirmed",
    );
    const mismatchedMakerQuickstartSubmitResult = await protocolClient.callTool({
      name: "strata_market_making_submit_and_wait",
      arguments: {
        makerControlId: "mc_99999999999999999999999999999999",
        preparationToken: makerPreparationToken,
        signedTransactionBase64: "AQ==",
      },
    });
    assert.equal(mismatchedMakerQuickstartSubmitResult.isError, true);
    assert.match(
      JSON.stringify(mismatchedMakerQuickstartSubmitResult.structuredContent),
      /binding_mismatch/,
    );
    const reputationResult = await protocolClient.callTool({
      name: "strata_market_making_reputation",
      arguments: { marketId: platformMarketId, walletAddress },
    });
    assert.deepEqual(reputationResult.structuredContent, platformMakerReputation);
    assert.equal(makerReputationRequestedFor, walletAddress);
    const vaultStatusResult = await protocolClient.callTool({
      name: "strata_vault_status",
      arguments: { walletAddress },
    });
    assert.deepEqual(vaultStatusResult.structuredContent, platformVaultStatus);
    const vaultSetupResult = await protocolClient.callTool({
      name: "strata_vault_setup",
      arguments: {
        walletAddress,
        sessionPublicKey: platformVaultSetup.session_public_key,
        marketId: platformVaultSetup.market_id,
        spendingLimits: [
          { assetId: platformVaultSetup.spending_limits[0]!.asset_id },
          {
            assetId: platformVaultSetup.spending_limits[1]!.asset_id,
            maximumPerExecutionAtoms: "100000000",
          },
        ],
      },
    });
    assert.deepEqual(vaultSetupResult.structuredContent, platformVaultSetup);
    assert.deepEqual(vaultSetupRequest, {
      walletAddress,
      sessionPublicKey: platformVaultSetup.session_public_key,
      marketId: platformVaultSetup.market_id,
      expiresAtMs: null,
      minimumIntervalSeconds: undefined,
      maximumToleranceBps: undefined,
      spendingLimits: [
        {
          assetId: platformVaultSetup.spending_limits[0]!.asset_id,
          maximumPerExecutionAtoms: null,
        },
        {
          assetId: platformVaultSetup.spending_limits[1]!.asset_id,
          maximumPerExecutionAtoms: "100000000",
        },
      ],
    });
    const vaultDepositResult = await protocolClient.callTool({
      name: "strata_vault_deposit",
      arguments: {
        walletAddress,
        marketId: platformVaultDeposit.market_id,
        assetId: platformVaultDeposit.asset_id,
        amountAtoms: "10000000",
        sessionPublicKey: platformVaultSetup.session_public_key,
      },
    });
    assert.deepEqual(vaultDepositResult.structuredContent, platformVaultDeposit);
    assert.deepEqual(vaultDepositRequest, {
      walletAddress,
      marketId: platformVaultDeposit.market_id,
      assetId: platformVaultDeposit.asset_id,
      amountAtoms: "10000000",
      sessionPublicKey: platformVaultSetup.session_public_key,
    });
    const vaultWithdrawResult = await protocolClient.callTool({
      name: "strata_vault_withdraw",
      arguments: {
        walletAddress,
        marketId: platformVaultWithdraw.market_id,
        assetId: platformVaultWithdraw.asset_id,
        destinationWalletAddress: walletAddress,
        amountAtoms: "5000000",
      },
    });
    assert.deepEqual(vaultWithdrawResult.structuredContent, platformVaultWithdraw);
    assert.deepEqual(vaultWithdrawRequest, {
      walletAddress,
      marketId: platformVaultWithdraw.market_id,
      assetId: platformVaultWithdraw.asset_id,
      destinationWalletAddress: walletAddress,
      amountAtoms: "5000000",
    });
    const vaultDelegateResult = await protocolClient.callTool({
      name: "strata_vault_delegate",
      arguments: {
        walletAddress,
        sessionPublicKey: platformVaultDelegate.session_public_key,
        action: "revoke",
      },
    });
    assert.deepEqual(vaultDelegateResult.structuredContent, platformVaultDelegate);
    assert.deepEqual(vaultDelegateRequest, {
      walletAddress,
      sessionPublicKey: platformVaultDelegate.session_public_key,
      action: "revoke",
    });
    const vaultPolicyResult = await protocolClient.callTool({
      name: "strata_vault_policy",
      arguments: {
        walletAddress,
        mode: "restricted",
        allowedWalletAddresses: [walletAddress],
      },
    });
    assert.deepEqual(vaultPolicyResult.structuredContent, platformVaultPolicy);
    assert.deepEqual(vaultPolicyRequest, {
      walletAddress,
      withdrawalAccess: {
        mode: "restricted",
        allowedWalletAddresses: [walletAddress],
      },
    });
    const vaultPauseResult = await protocolClient.callTool({
      name: "strata_vault_pause",
      arguments: { walletAddress, paused: true },
    });
    assert.deepEqual(vaultPauseResult.structuredContent, platformVaultPause);
    const vaultSubmitResult = await protocolClient.callTool({
      name: "strata_vault_submit",
      arguments: {
        preparationId: platformVaultWithdraw.preparation_id,
        signedTransactionBase64: "AQIDBA==",
        idempotencyKey: "withdraw-1",
      },
    });
    assert.deepEqual(vaultSubmitResult.structuredContent, platformVaultSubmit);
    assert.deepEqual(vaultSubmitRequest, {
      preparationId: platformVaultWithdraw.preparation_id,
      signedTransactionBase64: "AQIDBA==",
      idempotencyKey: "withdraw-1",
    });
    const vaultSubmissionResult = await protocolClient.callTool({
      name: "strata_vault_submission",
      arguments: { preparationId: platformVaultWithdraw.preparation_id },
    });
    assert.equal(
      (vaultSubmissionResult.structuredContent as { status: string }).status,
      "confirmed",
    );
    const pointsResult = await protocolClient.callTool({
      name: "strata_points",
      arguments: { walletAddress, limit: 25 },
    });
    assert.deepEqual(pointsResult.structuredContent, platformPoints);
    const rewardsResult = await protocolClient.callTool({
      name: "strata_rewards",
      arguments: { walletAddress, limit: 25 },
    });
    assert.deepEqual(rewardsResult.structuredContent, platformRewards);
    const referralsResult = await protocolClient.callTool({
      name: "strata_referrals",
      arguments: { walletAddress },
    });
    assert.deepEqual(referralsResult.structuredContent, platformReferrals);
    const linkPayloadResult = await protocolClient.callTool({
      name: "strata_referral_link",
      arguments: { walletAddress, referralCode: "STRATA1" },
    });
    assert.deepEqual(linkPayloadResult.structuredContent, {
      wallet_address: walletAddress,
      authorization_payload_base64: Buffer.from("strata-referral:v1:STRATA1").toString("base64"),
    });
    const linkResult = await protocolClient.callTool({
      name: "strata_referral_link",
      arguments: {
        walletAddress,
        referralCode: "STRATA1",
        authorizationSignature: "2".repeat(128),
      },
    });
    assert.deepEqual(linkResult.structuredContent, platformReferralLink);
    assert.equal(referralLinkRequest?.referralCode, "STRATA1");
    const claimPayloadResult = await protocolClient.callTool({
      name: "strata_referral_claim",
      arguments: { walletAddress },
    });
    assert.deepEqual(claimPayloadResult.structuredContent, {
      wallet_address: walletAddress,
      payout_wallet_address: walletAddress,
      authorization_payload_base64: Buffer.from(
        `strata-referral-claim:v1:${walletAddress}`,
      ).toString("base64"),
    });
    const claimResult = await protocolClient.callTool({
      name: "strata_referral_claim",
      arguments: {
        walletAddress,
        authorizationSignature: "3".repeat(128),
      },
    });
    assert.deepEqual(claimResult.structuredContent, platformReferralClaim);
    assert.equal(referralClaimRequest?.payoutWalletAddress, walletAddress);
    const bugsResult = await protocolClient.callTool({
      name: "strata_bugs",
      arguments: { walletAddress },
    });
    assert.deepEqual(bugsResult.structuredContent, platformBugs);
    const bugPayloadResult = await protocolClient.callTool({
      name: "strata_bug_submit",
      arguments: { ownerWallet: walletAddress, message: "  visible issue  " },
    });
    assert.deepEqual(bugPayloadResult.structuredContent, {
      owner_wallet: walletAddress,
      authorization_payload_base64: Buffer.from(
        "strata-bug-report:v1:visible issue",
      ).toString("base64"),
    });
    const bugSubmitResult = await protocolClient.callTool({
      name: "strata_bug_submit",
      arguments: {
        ownerWallet: walletAddress,
        message: "visible issue",
        authorizationSignature: "1".repeat(128),
      },
    });
    assert.deepEqual(bugSubmitResult.structuredContent, platformBugSubmit);

    const quoteResult = await protocolClient.callTool({
      name: "strata_quote",
      arguments: {
        market: "SOL/USDC",
        side: "sell",
        amountInAtoms: "10000000",
      },
    });
    assert.equal(quoteResult.isError, undefined);
    assert.equal(quoteRequest?.maximumToleranceBps, 0);

    const humanQuoteResult = await protocolClient.callTool({
      name: "strata_quote",
      arguments: {
        market: "sol-usdc",
        side: "sell",
        amount: "0.1 SOL",
      },
    });
    assert.equal(humanQuoteResult.isError, undefined);
    assert.equal(quoteRequest?.market, "SOL/USDC");
    assert.equal(quoteRequest?.amountInAtoms, "100000000");
    assert.match(JSON.stringify(humanQuoteResult.content), /0\.1 SOL/);

    const exactOutputResult = await protocolClient.callTool({
      name: "strata_exact_output_quote",
      arguments: {
        market: "SOL/USDC",
        side: "buy",
        amountOutAtoms: "1000000000",
        maximumToleranceBps: 25,
      },
    });
    assert.equal(exactOutputResult.isError, undefined);
    assert.equal(quoteRequest?.amountOutAtoms, "1000000000");
    assert.equal(quoteRequest?.amountInAtoms, undefined);
    assert.equal(quoteRequest?.maximumToleranceBps, 25);

    const swapQuoteResult = await protocolClient.callTool({
      name: "strata_swap_quote",
      arguments: {
        inputAssetId: platformSwapQuote.input_asset_id,
        outputAssetId: platformSwapQuote.output_asset_id,
        amountInAtoms: platformSwapQuote.amount_in_atoms,
        maximumToleranceBps: 50,
      },
    });
    assert.equal(swapQuoteResult.isError, undefined);
    assert.deepEqual(swapQuoteResult.structuredContent, platformSwapQuote);
    assert.equal(swapQuoteRequest?.maximumToleranceBps, 50);

    const challengeResult = await protocolClient.callTool({
      name: "strata_execution_challenge",
      arguments: {
        market: "SOL/USDC",
        quoteId: quote.quote_id,
        ownerWallet: "11111111111111111111111111111111",
        sessionPublicKey: "11111111111111111111111111111111",
        accountSequence: "7",
      },
    });
    assert.equal(challengeResult.isError, undefined);
    assert.equal(challengeRequest?.quoteId, quote.quote_id);

    const prepareResult = await protocolClient.callTool({
      name: "strata_execution_prepare",
      arguments: {
        market: "SOL/USDC",
        challengeId: challenge.challenge_id,
        authorizationSignature:
          "1111111111111111111111111111111111111111111111111111111111111111",
      },
    });
    assert.equal(prepareResult.isError, undefined);
    assert.ok(prepareRequest && "challengeId" in prepareRequest);
    assert.equal(prepareRequest.challengeId, challenge.challenge_id);

    // One signature: the quote binding itself prepares.
    const directPrepare = await protocolClient.callTool({
      name: "strata_execution_prepare",
      arguments: {
        market: "SOL/USDC",
        quoteId: quote.quote_id,
        ownerWallet: "11111111111111111111111111111111",
        sessionPublicKey: "22222222222222222222222222222222",
        accountSequence: "7",
      },
    });
    assert.equal(directPrepare.isError, undefined);
    assert.ok(prepareRequest && "quoteId" in prepareRequest);
    assert.equal(prepareRequest.quoteId, quote.quote_id);

    const submitResult = await protocolClient.callTool({
      name: "strata_execution_submit",
      arguments: {
        market: "SOL/USDC",
        executionId: prepared.execution_id,
        signedTransactionBase64: "AQ==",
        idempotencyKey: prepared.execution_id,
      },
    });
    assert.equal(submitResult.isError, undefined);
    assert.equal(submitRequest?.executionId, prepared.execution_id);

    const orderChallengeResult = await protocolClient.callTool({
      name: "strata_order_challenge",
      arguments: {
        marketId: platformMarketId,
        action: "cancel_all",
        ownerWallet: "11111111111111111111111111111111",
        sessionPublicKey: "22222222222222222222222222222222",
      },
    });
    assert.equal(orderChallengeResult.isError, undefined);
    assert.equal(orderChallengeRequest?.action, "cancel_all");

    const orderPrepareResult = await protocolClient.callTool({
      name: "strata_order_prepare",
      arguments: {
        marketId: platformMarketId,
        challengeId: orderChallenge.challenge_id,
        authorizationSignature: "2".repeat(64),
      },
    });
    assert.equal(orderPrepareResult.isError, undefined);
    assert.ok(orderPrepareRequest && "challengeId" in orderPrepareRequest);
    assert.equal(orderPrepareRequest.challengeId, orderChallenge.challenge_id);

    // One signature: the operation itself prepares; no challenge round trip.
    const directOrderPrepare = await protocolClient.callTool({
      name: "strata_order_prepare",
      arguments: {
        marketId: platformMarketId,
        action: "cancel_all",
        ownerWallet: "11111111111111111111111111111111",
        sessionPublicKey: "22222222222222222222222222222222",
      },
    });
    assert.equal(directOrderPrepare.isError, undefined);
    const orderDirect = orderPrepareRequest as { operation?: { action: string } } | undefined;
    assert.equal(orderDirect?.operation?.action, "cancel_all");
    const halfSigned = await protocolClient.callTool({
      name: "strata_order_prepare",
      arguments: { marketId: platformMarketId, challengeId: orderChallenge.challenge_id },
    });
    assert.equal(halfSigned.isError, true);

    const orderSubmitResult = await protocolClient.callTool({
      name: "strata_order_submit",
      arguments: {
        marketId: platformMarketId,
        orderControlId: orderPrepared.order_control_id,
        signedTransactionBase64: "AQ==",
        idempotencyKey: orderPrepared.order_control_id,
      },
    });
    assert.equal(orderSubmitResult.isError, undefined);
    assert.equal(orderSubmitRequest?.orderControlId, orderPrepared.order_control_id);

    const orderStatusResult = await protocolClient.callTool({
      name: "strata_order_status",
      arguments: {
        marketId: platformMarketId,
        orderControlId: orderPrepared.order_control_id,
        idempotencyKey: orderPrepared.order_control_id,
      },
    });
    assert.equal(orderStatusResult.isError, undefined);
    assert.equal(orderStatusRequest?.orderControlId, orderPrepared.order_control_id);

    const strandPrepareResult = await protocolClient.callTool({
      name: "strata_market_making_strand_prepare",
      arguments: {
        marketId: platformMarketId,
        action: "cancel",
        makerWallet: makerControlPrepared.maker_wallet,
      },
    });
    assert.equal(strandPrepareResult.isError, undefined);
    assert.equal(strandPrepareRequest?.action, "cancel");
    const strandSubmitResult = await protocolClient.callTool({
      name: "strata_market_making_strand_submit",
      arguments: {
        marketId: platformMarketId,
        makerControlId: makerControlPrepared.maker_control_id,
        signedTransactionBase64: "AQ==",
        idempotencyKey: "strand-cancel-1",
      },
    });
    assert.equal(strandSubmitResult.isError, undefined);
    assert.equal(strandSubmitRequest?.idempotencyKey, "strand-cancel-1");

    const currentPrepareResult = await protocolClient.callTool({
      name: "strata_market_making_current_prepare",
      arguments: {
        marketId: platformMarketId,
        action: "cancel",
        makerWallet: makerControlPrepared.maker_wallet,
      },
    });
    assert.equal(currentPrepareResult.isError, undefined);
    assert.equal(currentPrepareRequest?.action, "cancel");
    const currentSubmitResult = await protocolClient.callTool({
      name: "strata_market_making_current_submit",
      arguments: {
        marketId: platformMarketId,
        makerControlId: makerControlPrepared.maker_control_id,
        signedTransactionBase64: "AQ==",
        idempotencyKey: "current-cancel-1",
      },
    });
    assert.equal(currentSubmitResult.isError, undefined);
    assert.equal(currentSubmitRequest?.idempotencyKey, "current-cancel-1");

    const intentPrepareResult = await protocolClient.callTool({
      name: "strata_market_making_intent_prepare",
      arguments: {
        marketId: platformMarketId,
        action: "revoke",
        ownerWallet: makerIntentPrepared.owner_wallet,
        sessionPublicKey: makerIntentPrepared.session_public_key,
      },
    });
    assert.equal(intentPrepareResult.isError, undefined);
    assert.equal(intentPrepareRequest?.action, "revoke");
    const intentSubmitResult = await protocolClient.callTool({
      name: "strata_market_making_intent_submit",
      arguments: {
        marketId: platformMarketId,
        signedTransactionBase64: "AQ==",
      },
    });
    assert.equal(intentSubmitResult.isError, undefined);
    assert.equal(intentSubmitRequest?.signedTransactionBase64, "AQ==");

    const batchResult = await protocolClient.callTool({
      name: "strata_order_challenge",
      arguments: {
        marketId: platformMarketId,
        action: "batch",
        ownerWallet: "11111111111111111111111111111111",
        sessionPublicKey: "22222222222222222222222222222222",
        operations: [
          { action: "cancel", orderId: "order_33333333333333333333333333333333" },
          {
            action: "replace",
            orderId: "order_55555555555555555555555555555555",
            accountSequence: "8",
            clientOrderId: "replacement-8",
            side: "sell",
            orderType: "post_only",
            limitPriceAtoms: "151000000",
            sizeAtoms: "2000000",
          },
        ],
      },
    });
    assert.equal(batchResult.isError, undefined);
    const batchRequest = orderChallengeRequest as PlatformOrderChallengeInput | undefined;
    assert.equal(batchRequest?.action, "batch");
    if (batchRequest?.action === "batch") {
      assert.equal(batchRequest.operations.length, 2);
      assert.equal(batchRequest.operations[1]?.action, "replace");
    }

    liveCatalog = {
      ...liveCatalog,
      capabilities: liveCatalog.capabilities.map((capability) =>
        capability.id === "quotes.read"
          ? { ...capability, default_enabled: false, mcp_exposure: "none" }
          : capability),
    };
    const staleCall = await protocolClient.callTool({
      name: "strata_quote",
      arguments: {
        market: "SOL/USDC",
        side: "sell",
        amountInAtoms: "10000000",
      },
    });
    assert.equal(staleCall.isError, true);
    assert.match(JSON.stringify(staleCall.structuredContent), /capability_disabled/);

    await runtime.refreshCapabilities();
    const refreshed = await protocolClient.listTools();
    assert.deepEqual(
      refreshed.tools.map((tool) => tool.name).sort(),
      [
        "strata_action_graph",
        "strata_autonomy",
        "strata_bbo",
        "strata_book",
        "strata_bug_submit",
        "strata_bugs",
        "strata_candles",
        "strata_capabilities",
        "strata_execute_quote",
        "strata_execution_challenge",
        "strata_execution_prepare",
        "strata_execution_status",
        "strata_execution_submit",
        "strata_market_making_current_prepare",
        "strata_market_making_current_submit",
        "strata_market_making_intent_execute",
        "strata_market_making_intent_prepare",
        "strata_market_making_intent_submit",
        "strata_market_making_prepare",
        "strata_market_making_reputation",
        "strata_market_making_status",
        "strata_market_making_strand_prepare",
        "strata_market_making_strand_submit",
        "strata_market_making_submit_and_wait",
        "strata_markets",
        "strata_marks",
        "strata_order_challenge",
        "strata_order_execute",
        "strata_order_prepare",
        "strata_order_status",
        "strata_order_submit",
        "strata_platform_graph",
        "strata_points",
        "strata_portfolio",
        "strata_portfolio_history",
        "strata_referral_claim",
        "strata_referral_link",
        "strata_referrals",
        "strata_rewards",
        "strata_status",
        "strata_swap_quote",
        "strata_trades",
        "strata_twap_cancel",
        "strata_twap_challenge",
        "strata_twap_execute",
        "strata_twap_prepare",
        "strata_twap_submit",
        "strata_twaps",
        "strata_vault_delegate",
        "strata_vault_deposit",
        "strata_vault_pause",
        "strata_vault_policy",
        "strata_vault_setup",
        "strata_vault_status",
        "strata_vault_submission",
        "strata_vault_submit",
        "strata_vault_withdraw",
      ],
    );

    livePlatformCatalog = platformCatalog(["referrals.link", "referrals.claim"]);
    await runtime.refreshCapabilities();
    const platformRefreshedNames = (await protocolClient.listTools()).tools
      .map((tool) => tool.name);
    assert.ok(platformRefreshedNames.includes("strata_referrals"));
    assert.ok(!platformRefreshedNames.includes("strata_referral_link"));
    assert.ok(!platformRefreshedNames.includes("strata_referral_claim"));
  } finally {
    await protocolClient.close();
    await runtime.close();
  }
});

test("session autonomy adds one-shot execute tools and a read-only slider", async () => {
  let executedTwapAction: string | undefined;
  let executedIntentAction: string | undefined;
  const fakeClient = {
    capabilities: async () => autonomyCatalog(),
    markets: async () => ({
      schema_version: 1,
      contract_version: CONTRACT_VERSION,
      markets: [],
    }),
  } as unknown as StrataClient;
  const fakePlatformClient = {
    discovery: { read: async () => platformCatalog() },
    markets: { list: async () => ({ markets: [], page: { next_cursor: null, has_more: false } }) },
    algos: {
      execute: async (_marketId: string, request: { operation: { action: string } }) => {
        executedTwapAction = request.operation.action;
        return {
          action: request.operation.action,
          twap_control_id: "twctl_44444444444444444444444444444444",
          signature: "1".repeat(64),
        };
      },
    },
    marketMaking: {
      intent: {
        execute: async (_marketId: string, request: { operation: { action: string } }) => {
          executedIntentAction = request.operation.action;
          return { signature: "1".repeat(64) };
        },
      },
    },
  } as unknown as StrataPlatformClient;
  const signer = {
    publicKey: "Sess1111111111111111111111111111111111111111",
    signMessage: async () => new Uint8Array(),
    signTransaction: async () => "",
  };
  const runtime = await createStrataMcpServer({
    client: fakeClient,
    platformClient: fakePlatformClient,
    toolMode: "advanced",
    sessionAutonomy: {
      signer,
      ownerWallet: "Ownr1111111111111111111111111111111111111111",
      config: { level: "instant" },
      dailyBudget: new DailyUsdBudget(),
    },
  });
  const protocolClient = new Client({ name: "autonomy-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await runtime.server.connect(serverTransport);
    await protocolClient.connect(clientTransport);

    const listed = await protocolClient.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const expected of [
      "strata_autonomy",
      "strata_order_execute",
      "strata_twap_execute",
      "strata_execute_quote",
      "strata_market_making_intent_execute",
    ]) {
      assert.ok(names.includes(expected), `expected ${expected} to be registered`);
    }
    // The execute tools are destructive so the host gates them; the slider read is not.
    const tools = (await protocolClient.listTools()).tools;
    assert.equal(tools.find((t) => t.name === "strata_autonomy")?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === "strata_order_execute")?.annotations?.destructiveHint, true);

    const read = await protocolClient.callTool({ name: "strata_autonomy", arguments: {} });
    assert.equal(read.isError, undefined);
    const state = read.structuredContent as Record<string, unknown>;
    assert.equal(state.session_configured, true);
    assert.equal(state.level, "instant");
    assert.equal(state.wallet_address, "Ownr1111111111111111111111111111111111111111");

    const cancel = await protocolClient.callTool({
      name: "strata_twap_execute",
      arguments: {
        marketId: "market_22222222222222222222222222222222",
        action: "cancel",
        twapId: "twap_33333333333333333333333333333333",
      },
    });
    assert.equal(cancel.isError, undefined);
    assert.equal(executedTwapAction, "cancel");
    const revoke = await protocolClient.callTool({
      name: "strata_market_making_intent_execute",
      arguments: {
        marketId: "market_22222222222222222222222222222222",
        action: "revoke",
      },
    });
    assert.equal(revoke.isError, undefined);
    assert.equal(executedIntentAction, "revoke");
  } finally {
    await runtime.close();
  }
});

test("simple limit-order intent hot-loads a session and keeps a guarded order channel warm", async () => {
  const marketId = `market_${"2".repeat(32)}`;
  const ownerWallet = "Ownr1111111111111111111111111111111111111111";
  const signer = {
    publicKey: "Sess1111111111111111111111111111111111111111",
    signMessage: async () => new Uint8Array(),
    signTransaction: async () => "",
  };
  let liveAutonomy: SessionAutonomy | null = null;
  let placed: Record<string, unknown> | undefined;
  let armedTimeout: number | undefined;
  let armShouldFail = false;
  let portfolioReads = 0;
  const executedActions: string[] = [];
  const selectedSelfTradePolicies: string[] = [];
  let channelClosed = false;
  const connection = {
    ready: Promise.resolve(),
    execute: async (input: {
      operation: Record<string, unknown>;
      selfTradePrevention?: string;
    }) => {
      executedActions.push(String(input.operation.action));
      selectedSelfTradePolicies.push(input.selfTradePrevention ?? "omitted");
      if (input.operation.action === "place") placed = input.operation;
      return {
        schema_version: 2,
        contract_version: "2.0",
        order_control_id: `or_${"3".repeat(32)}`,
        market_id: marketId,
        action: input.operation.action,
        order_ids: [`order_${"4".repeat(32)}`],
        signature: "5".repeat(64),
        status: "submitted",
      };
    },
    status: async () => ({
      schema_version: 2,
      contract_version: "2.0",
      order_control_id: `or_${"3".repeat(32)}`,
      market_id: marketId,
      action: "place",
      order_ids: [`order_${"4".repeat(32)}`],
      signature: "5".repeat(64),
      status: "submitted",
      failure_code: null,
      updated_at_ms: 1_786_550_400_100,
    }),
    armDeadMan: async ({ timeoutMs }: { timeoutMs: number }) => {
      if (armShouldFail) throw new Error("guard unavailable");
      armedTimeout = timeoutMs;
      return {
        status: "armed",
        timeout_ms: timeoutMs,
        heartbeat_deadline_ms: 1_786_550_410_000,
        order_control_id: `or_${"6".repeat(32)}`,
        idempotency_key: `guard-or_${"3".repeat(32)}`,
        signed_transaction_expires_at_ms: 1_786_550_500_000,
        signature: null,
        failure_code: null,
      };
    },
    close: () => { channelClosed = true; },
  } as unknown as PlatformOrderCommandConnection;
  const fakeClient = {
    capabilities: async () => autonomyCatalog(),
    markets: async () => ({ schema_version: 1, contract_version: CONTRACT_VERSION, markets: [] }),
  } as unknown as StrataClient;
  const fakePlatformClient = {
    discovery: { read: async () => platformCatalog() },
    markets: {
      resolve: async () => ({
        market_id: marketId,
        label: "SOL/USDC",
        base_asset_id: `asset_${"a".repeat(32)}`,
        quote_asset_id: `asset_${"b".repeat(32)}`,
        status: "active",
        available_actions: ["place_order"],
      }),
      list: async () => ({ markets: [], page: { next_cursor: null, has_more: false } }),
    },
    assets: {
      list: async () => ({
        assets: [
          { asset_id: `asset_${"a".repeat(32)}`, symbol: "SOL", name: "Solana", decimals: 9, network: "solana" },
          { asset_id: `asset_${"b".repeat(32)}`, symbol: "USDC", name: "USD Coin", decimals: 6, network: "solana" },
        ],
      }),
    },
    marketData: {
      mark: async () => ({
        server_time_ms: 1_786_550_400_000,
        price_atoms_per_base_unit: "150000000",
        quote_decimals: 6,
        stale: false,
      }),
    },
    books: {
      status: async () => ({ tick_size_atoms: "10000", minimum_order_size_atoms: "1" }),
      fees: async () => ({ passive_maker_fee_bps: 0 }),
    },
    account: {
      portfolio: async () => {
        portfolioReads += 1;
        return {
          observed_slot: "300000000",
          observed_at_ms: 1_786_550_400_000,
          unavailable_market_ids: [],
          balances: [{
            asset_id: `asset_${"a".repeat(32)}`,
            available_atoms: "2000000000",
            locked_atoms: "0",
            total_atoms: "2000000000",
            value_usd_micros: "300000000",
          }],
          open_orders: portfolioReads > 1 ? [{
            order_id: `order_${"4".repeat(32)}`,
            market_id: marketId,
            side: "sell",
            order_type: "post_only",
            state: "open",
            limit_price_atoms: "154500000",
            original_size_atoms: "200000000",
            remaining_size_atoms: "200000000",
          }] : [],
        };
      },
    },
    orders: { connect: async () => connection },
  } as unknown as StrataPlatformClient;
  const runtime = await createStrataMcpServer({
    client: fakeClient,
    platformClient: fakePlatformClient,
    sessionAutonomyProvider: async () => liveAutonomy,
  });
  const protocolClient = new Client({ name: "friendly-order-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await runtime.server.connect(serverTransport);
    await protocolClient.connect(clientTransport);
    assert.ok((await protocolClient.listTools()).tools.some((tool) => tool.name === "strata_order_execute"));
    const before = await protocolClient.callTool({ name: "strata_autonomy", arguments: {} });
    assert.equal((before.structuredContent as Record<string, unknown>).session_configured, false);

    liveAutonomy = {
      signer,
      ownerWallet,
      config: { level: "instant" },
      dailyBudget: new DailyUsdBudget(),
    };
    const result = await protocolClient.callTool({
      name: "strata_order_execute",
      arguments: {
        action: "place",
        market: "SOL/USDC",
        side: "sell",
        availablePercent: 10,
        markOffsetBps: 300,
      },
    });
    assert.equal(result.isError, undefined);
    assert.equal(placed?.action, "place");
    assert.equal(placed?.sizeAtoms, "200000000");
    assert.equal(placed?.limitPriceAtoms, "154500000");
    assert.equal(placed?.orderType, "post_only");
    assert.equal(selectedSelfTradePolicies[0], "none");
    assert.equal(armedTimeout, 10_000);
    assert.match(JSON.stringify(result.structuredContent), /confirmed_open/);

    const optedIn = await protocolClient.callTool({
      name: "strata_order_execute",
      arguments: {
        action: "place",
        market: "SOL/USDC",
        side: "sell",
        availablePercent: 10,
        markOffsetBps: 300,
        clientOrderId: "explicit-stp-case",
        selfTradePrevention: "cancel_both",
      },
    });
    assert.equal(optedIn.isError, undefined);
    assert.equal(selectedSelfTradePolicies[1], "cancel_both");

    armShouldFail = true;
    const failClosed = await protocolClient.callTool({
      name: "strata_order_execute",
      arguments: {
        action: "place",
        market: "SOL/USDC",
        side: "sell",
        availablePercent: 10,
        markOffsetBps: 300,
        clientOrderId: "guard-failure-case",
      },
    });
    assert.equal(failClosed.isError, true);
    assert.match(JSON.stringify(failClosed.structuredContent), /dead_man_setup_failed/);
    assert.deepEqual(executedActions.slice(-2), ["place", "cancel"]);
  } finally {
    await protocolClient.close();
    await runtime.close();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(channelClosed, true);
});

test("the default surface stays compact and reports trading as optional", async () => {
  const defaultMarkets: MarketsResponse = {
    schema_version: 1,
    contract_version: CONTRACT_VERSION,
    markets: [{
      base: "So11111111111111111111111111111111111111112",
      quote: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      market_pda: "G3uTbTDGFQrNwdvDNSCu2rQbSx4Ujfm75vgUdENR8h4J",
      label: "SOL/USDC",
      ready: true,
      base_decimals: 9,
      quote_decimals: 6,
      quote_path: "/sonar/markets/sol-usdc/quote",
    }],
  };
  const fakeClient = {
    capabilities: async () => catalog(true),
    markets: async () => defaultMarkets,
    quote: async () => ({
      schema_version: 1,
      contract_version: CONTRACT_VERSION,
      quote_id: "sq_0123456789abcdef0123456789abcdef",
      server_time_ms: 1,
      expires_at_ms: 2,
      market_id: defaultMarkets.markets[0]!.market_pda!,
      side: "sell",
      amount_in_atoms: "100000000",
      amount_in_consumed_atoms: "100000000",
      amount_out_atoms: "15000000",
      minimum_output_atoms: "15000000",
      input_fee_atoms: "0",
      output_fee_atoms: "0",
      maximum_tolerance_bps: 0,
      reference_price: "150",
      price_impact_pct: "0.01",
      provider: "Sonar",
    } satisfies QuoteResponse),
  } as unknown as StrataClient;
  const fakePlatformClient = {
    discovery: { read: async () => platformCatalog() },
    markets: { list: async () => ({ markets: [], page: { next_cursor: null, has_more: false } }) },
  } as unknown as StrataPlatformClient;
  const runtime = await createStrataMcpServer({ client: fakeClient, platformClient: fakePlatformClient });
  const protocolClient = new Client({ name: "autonomy-default-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await runtime.server.connect(serverTransport);
    await protocolClient.connect(clientTransport);
    const listed = await protocolClient.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.length <= STRATA_AGENT_TOOL_REGISTRY.default_simple_tools.length);
    assert.ok(
      names.every((name) => STRATA_AGENT_TOOL_REGISTRY.default_simple_tools.includes(name)),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(listed.tools)) <= 20_000);
    assert.ok(names.includes("strata_autonomy"));
    assert.ok(names.includes("strata_trade"));
    assert.ok(!names.includes("strata_capabilities"));
    assert.ok(!names.includes("strata_exact_output_quote"));
    const read = await protocolClient.callTool({ name: "strata_autonomy", arguments: {} });
    const state = read.structuredContent as Record<string, unknown>;
    assert.equal(state.session_configured, false);
    assert.equal(state.level, "ask");
    const preview = await protocolClient.callTool({
      name: "strata_trade",
      arguments: { market: "SOL/USDC", side: "sell", amount: "0.1 SOL" },
    });
    assert.equal(preview.isError, undefined);
    assert.match(JSON.stringify(preview.structuredContent), /trading_not_connected/);
    assert.match(JSON.stringify(preview.structuredContent), /stratabook\.app\/agents/);
  } finally {
    await runtime.close();
  }
});
