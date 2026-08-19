import assert from "node:assert/strict";
import test from "node:test";
import {
  DailyUsdBudget,
  decideAutonomy,
  parseAutonomyConfig,
  quoteNotionalUsd,
  type SessionAutonomy,
} from "../src/autonomy.js";

const FIXED_MS = 1_787_000_000_000;

function autonomy(config: SessionAutonomy["config"]): SessionAutonomy {
  return {
    signer: { publicKey: "SessionPubKey", signMessage: async () => new Uint8Array(), signTransaction: async () => "" },
    ownerWallet: "OwnerWallet",
    config,
    dailyBudget: new DailyUsdBudget(),
  };
}

test("parseAutonomyConfig defaults to the calm ask with no ceilings", () => {
  const config = parseAutonomyConfig({});
  assert.equal(config.level, "ask");
  assert.equal(config.maxUsdPerTrade, undefined);
  assert.equal(config.maxUsdPerDay, undefined);
  assert.equal(config.allowedMarketIds, undefined);
});

test("parseAutonomyConfig reads the slider and rejects junk", () => {
  const config = parseAutonomyConfig({
    STRATA_AUTONOMY: "LIMITS",
    STRATA_AUTONOMY_MAX_USD_PER_TRADE: "200",
    STRATA_AUTONOMY_MAX_USD_PER_DAY: "1000",
    STRATA_AUTONOMY_MARKETS: "market_" + "a".repeat(32) + ", not-a-market ,market_" + "b".repeat(32),
  });
  assert.equal(config.level, "limits");
  assert.equal(config.maxUsdPerTrade, 200);
  assert.equal(config.maxUsdPerDay, 1000);
  assert.deepEqual(config.allowedMarketIds, ["market_" + "a".repeat(32), "market_" + "b".repeat(32)]);

  assert.equal(parseAutonomyConfig({ STRATA_AUTONOMY: "yolo" }).level, "ask");
  assert.equal(parseAutonomyConfig({ STRATA_AUTONOMY_MAX_USD_PER_TRADE: "-5" }).maxUsdPerTrade, undefined);
});

test("ask never signs, whatever the notional", () => {
  const decision = decideAutonomy(autonomy({ level: "ask" }), "market_x", 1, FIXED_MS);
  assert.equal(decision.allow, false);
  if (!decision.allow) assert.match(decision.reason, /ask/);
});

test("instant always signs, even when the notional is unknown", () => {
  assert.equal(decideAutonomy(autonomy({ level: "instant" }), "market_x", null, FIXED_MS).allow, true);
  assert.equal(decideAutonomy(autonomy({ level: "instant" }), "market_x", 9_999_999, FIXED_MS).allow, true);
});

test("limits fails closed when the USD size is unknown", () => {
  const decision = decideAutonomy(autonomy({ level: "limits", maxUsdPerTrade: 100 }), "market_x", null, FIXED_MS);
  assert.equal(decision.allow, false);
});

test("limits enforces the per-trade ceiling", () => {
  const config = { level: "limits" as const, maxUsdPerTrade: 100 };
  assert.equal(decideAutonomy(autonomy(config), "market_x", 99.99, FIXED_MS).allow, true);
  const over = decideAutonomy(autonomy(config), "market_x", 100.01, FIXED_MS);
  assert.equal(over.allow, false);
  if (!over.allow) assert.match(over.reason, /per-trade limit/);
});

test("limits enforces the market allow-list", () => {
  const config = { level: "limits" as const, allowedMarketIds: ["market_ok"] };
  assert.equal(decideAutonomy(autonomy(config), "market_ok", 1, FIXED_MS).allow, true);
  assert.equal(decideAutonomy(autonomy(config), "market_no", 1, FIXED_MS).allow, false);
});

test("limits enforces and consumes the daily budget", () => {
  const ctx = autonomy({ level: "limits", maxUsdPerDay: 100 });
  assert.equal(decideAutonomy(ctx, "market_x", 60, FIXED_MS).allow, true);
  ctx.dailyBudget.record(60, FIXED_MS);
  // 40 left → a 60 trade is refused, a 40 trade is allowed.
  assert.equal(decideAutonomy(ctx, "market_x", 60, FIXED_MS).allow, false);
  assert.equal(decideAutonomy(ctx, "market_x", 40, FIXED_MS).allow, true);
});

test("daily budget resets across a UTC day boundary", () => {
  const budget = new DailyUsdBudget();
  const day1 = Date.parse("2026-08-19T23:00:00Z");
  const day2 = Date.parse("2026-08-20T01:00:00Z");
  budget.record(80, day1);
  assert.equal(budget.spentToday(day1), 80);
  assert.equal(budget.spentToday(day2), 0);
});

test("quoteNotionalUsd uses the quote-asset side of the trade", () => {
  // buy: spend 5 USDC (6 decimals) → $5
  assert.equal(quoteNotionalUsd("buy", "5000000", "0", 6), 5);
  // sell: receive at least 3 USDC → $3
  assert.equal(quoteNotionalUsd("sell", "0", "3000000", 6), 3);
  assert.equal(quoteNotionalUsd("buy", "not-a-number", "0", 6), null);
});
