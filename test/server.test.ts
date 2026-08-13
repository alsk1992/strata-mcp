import assert from "node:assert/strict";
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
} from "@stratabook/sdk";
import { CONTRACT_VERSION } from "@stratabook/sdk";
import {
  STRATA_AGENT_HARNESS,
  STRATA_AGENT_HARNESS_INSTRUCTIONS,
  STRATA_AGENT_HARNESS_URI,
  STRATA_ACTION_GRAPH,
  STRATA_ACTION_GRAPH_URI,
} from "../src/generated-harness.js";
import {
  capabilityAvailable,
  createStrataMcpServer,
  probeStrataMcpReadiness,
} from "../src/server.js";
import { SERVER_VERSION } from "../src/version.js";

const require = createRequire(import.meta.url);
const packageMetadata = require("../../package.json") as { version: string };

test("server identity follows package metadata", () => {
  assert.equal(SERVER_VERSION, packageMetadata.version);
});

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

test("initialization instructions contain the mandatory first-run safety gates", () => {
  assert.match(STRATA_AGENT_HARNESS_INSTRUCTIONS, /Start every objective with strata_capabilities/);
  assert.match(STRATA_AGENT_HARNESS_INSTRUCTIONS, /strata_action_graph/);
  assert.match(STRATA_AGENT_HARNESS_INSTRUCTIONS, /exact input atoms/);
  assert.match(STRATA_AGENT_HARNESS_INSTRUCTIONS, /never private keys or seed phrases/i);
});

test("protocol tool discovery and calls obey the current public policy", async () => {
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
    reference_price: "150",
    price_impact_pct: "0.01",
    provider: "Sonar",
  };
  let quoteRequest: QuoteRequest | undefined;
  let challengeRequest: ExecutionChallengeRequest | undefined;
  let prepareRequest: ExecutionPrepareRequest | undefined;
  let submitRequest: ExecutionSubmitRequest | undefined;
  let orderChallengeRequest: PlatformOrderChallengeInput | undefined;
  let orderPrepareRequest: PlatformOrderPrepareInput | undefined;
  let orderSubmitRequest: PlatformOrderSubmitInput | undefined;
  let orderStatusRequest: PlatformOrderStatusInput | undefined;
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
  const fakePlatformClient = {
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
  });
  const protocolClient = new Client({ name: "strata-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await runtime.server.connect(serverTransport);
    await protocolClient.connect(clientTransport);

    const resources = await protocolClient.listResources();
    assert.deepEqual(
      resources.resources.map((resource) => resource.uri).sort(),
      [STRATA_ACTION_GRAPH_URI, STRATA_AGENT_HARNESS_URI].sort(),
    );
    const harness = await protocolClient.readResource({ uri: STRATA_AGENT_HARNESS_URI });
    assert.equal(harness.contents.length, 1);
    assert.deepEqual(
      JSON.parse("text" in harness.contents[0]! ? harness.contents[0]!.text : "{}"),
      STRATA_AGENT_HARNESS,
    );
    const graph = await protocolClient.readResource({ uri: STRATA_ACTION_GRAPH_URI });
    assert.deepEqual(
      JSON.parse("text" in graph.contents[0]! ? graph.contents[0]!.text : "{}"),
      STRATA_ACTION_GRAPH,
    );

    const prompts = await protocolClient.listPrompts();
    assert.deepEqual(prompts.prompts.map((prompt) => prompt.name), ["strata_start"]);
    const start = await protocolClient.getPrompt({
      name: "strata_start",
      arguments: { objective: "Quote selling 0.1 SOL for USDC." },
    });
    assert.match(JSON.stringify(start.messages), /strata_capabilities/);
    assert.match(JSON.stringify(start.messages), /Quote selling 0.1 SOL/);

    const initial = await protocolClient.listTools();
    assert.deepEqual(
      initial.tools.map((tool) => tool.name).sort(),
      [
        "strata_action_graph",
        "strata_capabilities",
        "strata_execution_challenge",
        "strata_execution_prepare",
        "strata_execution_submit",
        "strata_markets",
        "strata_order_challenge",
        "strata_order_prepare",
        "strata_order_status",
        "strata_order_submit",
        "strata_quote",
      ],
    );

    const result = await protocolClient.callTool({
      name: "strata_markets",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, markets);

    const quoteResult = await protocolClient.callTool({
      name: "strata_quote",
      arguments: {
        market: "SOL/USDC",
        side: "sell",
        amountInAtoms: "10000000",
      },
    });
    assert.equal(quoteResult.isError, undefined);
    assert.equal(quoteRequest?.slippageBps, 0);

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
    assert.equal(prepareRequest?.challengeId, challenge.challenge_id);

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
    assert.equal(orderPrepareRequest?.challengeId, orderChallenge.challenge_id);

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
        "strata_capabilities",
        "strata_execution_challenge",
        "strata_execution_prepare",
        "strata_execution_submit",
        "strata_markets",
        "strata_order_challenge",
        "strata_order_prepare",
        "strata_order_status",
        "strata_order_submit",
      ],
    );
  } finally {
    await protocolClient.close();
    await runtime.close();
  }
});
