import type { Market } from "@stratabook/sdk";

export type StrataMcpToolMode = "simple" | "advanced";

/**
 * The default surface is intentionally small enough for an agent to choose a
 * useful tool directly. `advanced` keeps the complete protocol machinery for
 * integrators that need explicit challenge / prepare / submit control.
 */
export const SIMPLE_TOOL_NAMES = new Set([
  "strata_markets",
  "strata_quote",
  "strata_book",
  "strata_trades",
  "strata_candles",
  "strata_marks",
  "strata_portfolio",
  "strata_market_making_status",
  "strata_market_making_prepare",
  "strata_market_making_submit_and_wait",
  "strata_autonomy",
  "strata_trade",
]);

export function parseToolMode(raw: string | undefined): StrataMcpToolMode {
  const value = raw?.trim().toLowerCase() || "simple";
  if (value === "simple" || value === "advanced") return value;
  throw new TypeError("mode must be simple or advanced");
}

export interface HumanQuoteAmount {
  readonly atoms: string;
  readonly market: Market;
  readonly inputSymbol: string;
  readonly inputDecimals: number;
  readonly outputSymbol: string;
  readonly outputDecimals: number;
  readonly display: string;
}

/** Resolve friendly market spellings without making opaque IDs stop working. */
export function resolveMarket(markets: readonly Market[], requested: string): Market {
  const trimmed = requested.trim();
  const normalized = normalizedMarketLabel(trimmed);
  const match = markets.find((market) =>
    market.market_pda === trimmed || normalizedMarketLabel(market.label) === normalized
  );
  if (match) return match;
  throw new TypeError(
    `Unknown market ${trimmed}. Try a label from strata_markets, for example SOL/USDC.`,
  );
}

/**
 * Convert an exact decimal amount to atoms without ever passing through a
 * floating-point number. For buys the input is quote; for sells it is base.
 */
export function humanQuoteAmount(
  markets: readonly Market[],
  requestedMarket: string,
  side: "buy" | "sell",
  amount: string,
): HumanQuoteAmount {
  const market = resolveMarket(markets, requestedMarket);
  // Sonar's base/quote fields may be mint addresses; the public label carries
  // the display symbols agents and users actually type.
  const [labelBase, labelQuote] = market.label.split("/", 2).map((part) => part.trim());
  const inputSymbol = side === "buy"
    ? labelQuote || market.quote
    : labelBase || market.base;
  const inputDecimals = side === "buy" ? market.quote_decimals : market.base_decimals;
  const outputSymbol = side === "buy"
    ? labelBase || market.base
    : labelQuote || market.quote;
  const outputDecimals = side === "buy" ? market.base_decimals : market.quote_decimals;
  const value = amount.trim();
  const dollar = value.startsWith("$");
  const match = /^(?:\$\s*)?([0-9]+)(?:\.([0-9]+))?(?:\s*([A-Za-z0-9._-]+))?$/.exec(value);
  if (!match) {
    throw new TypeError(`amount must look like 0.1 ${inputSymbol} or 20 ${inputSymbol}`);
  }
  if (dollar && !isDollarSymbol(inputSymbol)) {
    throw new TypeError(`$ amounts are only valid when the input token is USD-like; this input is ${inputSymbol}`);
  }
  const suppliedSymbol = match[3];
  if (suppliedSymbol && suppliedSymbol.toLowerCase() !== inputSymbol.toLowerCase()) {
    throw new TypeError(`This ${side} uses ${inputSymbol} as input, not ${suppliedSymbol}`);
  }
  const fraction = match[2] ?? "";
  if (fraction.length > inputDecimals) {
    throw new TypeError(`${inputSymbol} supports at most ${inputDecimals} decimal places`);
  }
  const scale = 10n ** BigInt(inputDecimals);
  const atoms = BigInt(match[1]!) * scale
    + BigInt((fraction + "0".repeat(inputDecimals)).slice(0, inputDecimals) || "0");
  if (atoms <= 0n || atoms > 18_446_744_073_709_551_615n) {
    throw new TypeError("amount is outside the supported token range");
  }
  return {
    atoms: atoms.toString(),
    market,
    inputSymbol,
    inputDecimals,
    outputSymbol,
    outputDecimals,
    display: `${formatAtoms(atoms.toString(), inputDecimals)} ${inputSymbol}`,
  };
}

export function formatAtoms(atoms: string, decimals: number): string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(atoms)) return atoms;
  if (decimals === 0) return atoms;
  const padded = atoms.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function friendlyApiError(code: string, message: string): string {
  const normalized = code.toLowerCase();
  if (normalized.includes("session") || normalized.includes("delegate")) {
    return "Trading is not connected. Open https://stratabook.app/agents, connect your wallet, and copy the MCP trading config for your client. Read-only tools still work now.";
  }
  if (normalized.includes("balance") || normalized.includes("fund")) {
    return "There is not enough available balance for this action. Deposit funds or reduce the amount, then try again.";
  }
  if (normalized.includes("warm") || normalized.includes("temporar") || normalized.includes("unavailable")) {
    return "This market is temporarily warming up. Try again shortly; no transaction was sent.";
  }
  if (normalized.includes("expired")) {
    return "The quote or prepared transaction expired. Request a fresh one and try again.";
  }
  return message;
}

function normalizedMarketLabel(value: string): string {
  return value.trim().toUpperCase().replace(/[\s:_-]+/g, "/");
}

function isDollarSymbol(symbol: string): boolean {
  return ["USD", "USDC", "USDT", "USDG"].includes(symbol.toUpperCase());
}
