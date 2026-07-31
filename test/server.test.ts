import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  CapabilityCatalog,
  MarketsResponse,
  QuoteRequest,
  QuoteResponse,
  StrataClient,
} from "@stratabook/sdk";
import { capabilityAvailable, createStrataMcpServer } from "../src/server.js";

function catalog(
  enabled: boolean,
  exposure: "none" | "read" = "read",
): CapabilityCatalog {
  return {
    schema_version: 1,
    contract_version: "1.0",
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

test("write-risk capabilities cannot become MCP tools", () => {
  const value = catalog(true);
  value.capabilities[0] = {
    ...value.capabilities[0]!,
    id: "trade.submit",
    risk: "submit",
    mcp_exposure: "submit",
  };
  assert.equal(capabilityAvailable(value, "trade.submit"), false);
});

test("protocol tool discovery and calls obey the current public policy", async () => {
  let liveCatalog: CapabilityCatalog = {
    schema_version: 1,
    contract_version: "1.0",
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
    ],
  };
  const markets: MarketsResponse = {
    schema_version: 1,
    contract_version: "1.0",
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
    contract_version: "1.0",
    quote_id: "opaque-test-quote",
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
  const fakeClient = {
    capabilities: async () => liveCatalog,
    markets: async () => markets,
    quote: async (request: QuoteRequest) => {
      quoteRequest = request;
      return quote;
    },
  } as unknown as StrataClient;
  const runtime = await createStrataMcpServer({ client: fakeClient });
  const protocolClient = new Client({ name: "strata-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await runtime.server.connect(serverTransport);
    await protocolClient.connect(clientTransport);
    const initial = await protocolClient.listTools();
    assert.deepEqual(
      initial.tools.map((tool) => tool.name).sort(),
      ["strata_capabilities", "strata_markets", "strata_quote"],
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
      ["strata_capabilities", "strata_markets"],
    );
  } finally {
    await protocolClient.close();
    await runtime.close();
  }
});
