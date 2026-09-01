import assert from "node:assert/strict";
import test from "node:test";
import type { Market } from "@stratabook/sdk";
import {
  formatAtoms,
  friendlyApiError,
  humanQuoteAmount,
  parseToolMode,
  parseToolProfile,
  resolveMarket,
  SIMPLE_TOOL_NAMES,
  toolAvailableInMode,
  toolAvailableInProfile,
} from "../src/usability.js";

const solUsdc: Market = {
  base: "So11111111111111111111111111111111111111112",
  quote: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  market_pda: "7Ymarket",
  label: "SOL/USDC",
  ready: true,
  base_decimals: 9,
  quote_decimals: 6,
  quote_path: "/v1/quote/SOL-USDC",
};

test("simple is the default tool mode and advanced is explicit", () => {
  assert.equal(parseToolMode(undefined), "simple");
  assert.equal(parseToolMode(" ADVANCED "), "advanced");
  assert.throws(() => parseToolMode("everything"), /simple or advanced/);
  assert.equal(SIMPLE_TOOL_NAMES.size, 15);
  assert.equal(SIMPLE_TOOL_NAMES.has("strata_points"), true);
  assert.equal(SIMPLE_TOOL_NAMES.has("strata_rewards"), false);
});

test("tool profiles are exact domain boundaries", () => {
  assert.equal(parseToolProfile(undefined), "default");
  assert.equal(parseToolProfile(" POINTS "), "points");
  assert.throws(() => parseToolProfile("trade"), /profile must be default or one of/);
  assert.equal(toolAvailableInProfile("strata_points", "points"), true);
  assert.equal(toolAvailableInProfile("strata_trade", "points"), false);
  assert.equal(toolAvailableInProfile("strata_trade", "default"), true);
  assert.equal(toolAvailableInProfile("strata_markets", "limit_orders"), true);
  assert.equal(toolAvailableInMode("strata_rewards", "simple", "default"), false);
  assert.equal(toolAvailableInMode("strata_rewards", "simple", "points"), true);
  assert.equal(toolAvailableInMode("strata_referral_link", "simple", "referrals"), false);
  assert.equal(toolAvailableInMode("strata_referral_link", "advanced", "referrals"), true);
});

test("human quote amounts resolve side, symbol, decimals, and friendly market spelling", () => {
  assert.equal(resolveMarket([solUsdc], "sol-usdc"), solUsdc);
  assert.deepEqual(humanQuoteAmount([solUsdc], "SOL/USDC", "sell", "0.1 SOL"), {
    atoms: "100000000",
    market: solUsdc,
    inputSymbol: "SOL",
    inputDecimals: 9,
    outputSymbol: "USDC",
    outputDecimals: 6,
    display: "0.1 SOL",
  });
  assert.equal(humanQuoteAmount([solUsdc], "SOL_USDC", "buy", "$20").atoms, "20000000");
  assert.equal(humanQuoteAmount([solUsdc], "7Ymarket", "buy", "2.50 USDC").atoms, "2500000");
  assert.throws(
    () => humanQuoteAmount([solUsdc], "SOL/USDC", "sell", "20 USDC"),
    /uses SOL as input/,
  );
  assert.throws(
    () => humanQuoteAmount([solUsdc], "SOL/USDC", "sell", "$20"),
    /USD-like/,
  );
});

test("atom formatting stays exact", () => {
  assert.equal(formatAtoms("100000000", 9), "0.1");
  assert.equal(formatAtoms("2500000", 6), "2.5");
  assert.equal(formatAtoms("1", 0), "1");
});

test("common API failures are explained as next actions", () => {
  assert.match(friendlyApiError("session_not_configured", "no"), /Trading is not connected/);
  assert.match(friendlyApiError("insufficient_balance", "no"), /reduce the amount/);
  assert.match(friendlyApiError("market_warming", "no"), /Try again shortly/);
  assert.equal(friendlyApiError("other", "original"), "original");
});
