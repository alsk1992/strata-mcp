/**
 * Session autonomy — the user-owned "how much may the agent finish by itself"
 * slider, enforced inside the MCP server.
 *
 * The default is `ask`: the MCP prepares trades but never signs them, so the
 * human signs every one. This is the calm default and it is unchanged from a
 * server with no session key at all. A user who wants unattended, popup-free
 * trading opts in by giving the MCP a Vault **session** secret key (capped and
 * revocable on-chain) and raising the level:
 *
 *   - `ask`     — read + prepare only; the agent hands back an unsigned
 *                 transaction for the human to sign. Never signs.
 *   - `limits`  — signs and submits instantly, but only within an extra
 *                 MCP-side ceiling (per-trade USD, per-day USD, allowed
 *                 markets). Anything above stops and hands back a prepare.
 *   - `instant` — signs and submits instantly within the on-chain session
 *                 caps (the owner's per-asset limits, tolerance, interval,
 *                 expiry). Hyperliquid-style.
 *
 * Vault withdrawal, policy, session rotation, and pause are never on this
 * slider — they always require the owner's wallet. An IntentBook seat's own
 * session-authorized revoke remains available as its permanent risk exit. The on-chain session caps are the hard ceiling;
 * this slider is a softer layer above them. An agent can *read* the level
 * (`strata_autonomy`) and *offer* to change it, but nothing an agent calls can
 * raise its own autonomy: the only knob is the human's (env / Agents page).
 */
import {
  StrataContractError,
  StrataPlatformClient,
  sessionSignerFromSecretKey,
  type StrataSessionSigner,
} from "@stratabook/sdk";

export const AUTONOMY_LEVELS = ["ask", "limits", "instant"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export interface AutonomyConfig {
  readonly level: AutonomyLevel;
  /** `limits` only: the most one trade may be, in USD. Undefined = no per-trade cap. */
  readonly maxUsdPerTrade?: number;
  /** `limits` only: the most all trades may total per UTC day, in USD. */
  readonly maxUsdPerDay?: number;
  /** `limits` only: opaque market IDs the agent may trade. Empty = every live market. */
  readonly allowedMarketIds?: readonly string[];
}

export interface SessionAutonomy {
  readonly signer: StrataSessionSigner;
  readonly ownerWallet: string;
  readonly config: AutonomyConfig;
  readonly dailyBudget: DailyUsdBudget;
}

function positiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Parse the autonomy slider from a plain env bag; defaults to the calm `ask`. */
export function parseAutonomyConfig(
  env: Record<string, string | undefined>,
): AutonomyConfig {
  const raw = (env.STRATA_AUTONOMY ?? "ask").trim().toLowerCase();
  const level: AutonomyLevel = (AUTONOMY_LEVELS as readonly string[]).includes(raw)
    ? (raw as AutonomyLevel)
    : "ask";
  const maxUsdPerTrade = positiveNumber(env.STRATA_AUTONOMY_MAX_USD_PER_TRADE);
  const maxUsdPerDay = positiveNumber(env.STRATA_AUTONOMY_MAX_USD_PER_DAY);
  const allowedMarketIds = (env.STRATA_AUTONOMY_MARKETS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^market_[0-9a-f]{32}$/.test(id));
  return {
    level,
    ...(maxUsdPerTrade === undefined ? {} : { maxUsdPerTrade }),
    ...(maxUsdPerDay === undefined ? {} : { maxUsdPerDay }),
    ...(allowedMarketIds.length > 0 ? { allowedMarketIds } : {}),
  };
}

/** Build the session-autonomy context from env, or null when no session key is set. */
export async function sessionAutonomyFromEnv(
  env: Record<string, string | undefined>,
): Promise<SessionAutonomy | null> {
  const secret = env.STRATA_SESSION_SECRET_KEY?.trim();
  const ownerWallet = env.STRATA_OWNER_WALLET?.trim();
  if (!secret) return null;
  if (!ownerWallet || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ownerWallet)) {
    throw new StrataContractError(
      "STRATA_SESSION_SECRET_KEY is set but STRATA_OWNER_WALLET is missing or invalid",
    );
  }
  const expected = env.STRATA_SESSION_PUBLIC_KEY?.trim();
  const signer = await sessionSignerFromSecretKey(secret, expected || undefined);
  return {
    signer,
    ownerWallet,
    config: parseAutonomyConfig(env),
    dailyBudget: new DailyUsdBudget(),
  };
}

/** In-memory per-UTC-day USD ledger. Resets on day change and on process restart. */
export class DailyUsdBudget {
  private day = "";
  private spent = 0;

  private roll(nowMs: number): void {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.spent = 0;
    }
  }

  spentToday(nowMs: number): number {
    this.roll(nowMs);
    return this.spent;
  }

  record(usd: number, nowMs: number): void {
    this.roll(nowMs);
    this.spent += Math.max(0, usd);
  }
}

export type AutonomyDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

/**
 * Decide whether a trade of `notionalUsd` on `marketId` may be signed now.
 * `notionalUsd` null means the notional could not be established — treated as
 * over budget under `limits` (fail closed), ignored under `instant`.
 */
export function decideAutonomy(
  autonomy: SessionAutonomy,
  marketId: string,
  notionalUsd: number | null,
  nowMs: number,
): AutonomyDecision {
  const { config } = autonomy;
  if (config.level === "ask") {
    return {
      allow: false,
      reason:
        "Autonomy is set to \"ask\": I prepared this trade but will not sign it. "
        + "Sign the returned transaction yourself, or raise the slider to \"limits\" or \"instant\".",
    };
  }
  if (config.level === "instant") {
    return { allow: true };
  }
  // limits
  if (config.allowedMarketIds && !config.allowedMarketIds.includes(marketId)) {
    return {
      allow: false,
      reason:
        `Autonomy \"limits\" does not include this market. Allowed: ${config.allowedMarketIds.join(", ")}. `
        + "Sign it yourself, add the market, or switch to \"instant\".",
    };
  }
  if (notionalUsd === null) {
    return {
      allow: false,
      reason:
        "Autonomy \"limits\" needs the trade's USD size to check the ceiling and I could not establish it, "
        + "so I will not sign automatically. Sign the returned transaction yourself, or switch to \"instant\".",
    };
  }
  if (config.maxUsdPerTrade !== undefined && notionalUsd > config.maxUsdPerTrade) {
    return {
      allow: false,
      reason:
        `This trade is about $${notionalUsd.toFixed(2)}, over the per-trade limit of `
        + `$${config.maxUsdPerTrade.toFixed(2)}. Sign it yourself, raise the limit, or switch to \"instant\".`,
    };
  }
  if (config.maxUsdPerDay !== undefined) {
    const remaining = config.maxUsdPerDay - autonomy.dailyBudget.spentToday(nowMs);
    if (notionalUsd > remaining) {
      return {
        allow: false,
        reason:
          `This trade is about $${notionalUsd.toFixed(2)} but only $${Math.max(0, remaining).toFixed(2)} `
          + `of today's $${config.maxUsdPerDay.toFixed(2)} budget is left. Sign it yourself or raise the daily budget.`,
      };
    }
  }
  return { allow: true };
}

/** A single cached join of platform market_id → its decimals + label. */
interface MarketMeta {
  readonly label: string;
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
}

const MARKET_META_TTL_MS = 60_000;

/**
 * Resolve base/quote decimals for opaque platform market IDs by joining the
 * platform market list (market_id ↔ label) with the Sonar market list
 * (label ↔ decimals). Cached briefly; both are cheap public reads.
 */
export class MarketMetaResolver {
  private byId: Map<string, MarketMeta> | null = null;
  private labelToId = new Map<string, string>();
  private fetchedAtMs = 0;

  constructor(
    private readonly platformClient: Pick<StrataPlatformClient, "markets">,
    private readonly sonarMarkets: () => Promise<
      ReadonlyArray<{ label: string; base_decimals: number; quote_decimals: number }>
    >,
    private readonly nowMs: () => number,
  ) {}

  private async load(): Promise<Map<string, MarketMeta>> {
    if (this.byId && this.nowMs() - this.fetchedAtMs < MARKET_META_TTL_MS) {
      return this.byId;
    }
    const byLabel = new Map<string, { baseDecimals: number; quoteDecimals: number }>();
    for (const market of await this.sonarMarkets()) {
      byLabel.set(market.label, {
        baseDecimals: market.base_decimals,
        quoteDecimals: market.quote_decimals,
      });
    }
    const meta = new Map<string, MarketMeta>();
    const labelToId = new Map<string, string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const response = await this.platformClient.markets.list(
        cursor === undefined ? { limit: 100 } : { limit: 100, cursor },
      );
      for (const market of response.markets) {
        labelToId.set(market.label, market.market_id);
        const decimals = byLabel.get(market.label);
        if (decimals) {
          meta.set(market.market_id, { label: market.label, ...decimals });
        }
      }
      if (!response.page.has_more || response.page.next_cursor === null) break;
      cursor = response.page.next_cursor;
    }
    this.byId = meta;
    this.labelToId = labelToId;
    this.fetchedAtMs = this.nowMs();
    return meta;
  }

  async get(marketId: string): Promise<MarketMeta | null> {
    return (await this.load()).get(marketId) ?? null;
  }

  /** Opaque platform market_id for a Sonar market label, or null if unknown. */
  async idForLabel(label: string): Promise<string | null> {
    await this.load();
    return this.labelToId.get(label) ?? null;
  }
}

/**
 * USD notional of an order/TWAP of `baseAtoms` base on `marketId`, from the
 * current mark. Best effort: returns null (→ fail closed under `limits`) when
 * decimals or a fresh mark are unavailable. Cancels pass `baseAtoms = 0n`.
 */
export async function estimateBaseNotionalUsd(
  resolver: MarketMetaResolver,
  markPriceAtomsPerBase: (marketId: string) => Promise<{
    price_atoms_per_base_unit: string | null;
    quote_decimals: number;
    stale: boolean;
  }>,
  marketId: string,
  baseAtoms: bigint,
): Promise<number | null> {
  if (baseAtoms <= 0n) return 0;
  const meta = await resolver.get(marketId);
  if (!meta) return null;
  const mark = await markPriceAtomsPerBase(marketId);
  if (mark.stale || mark.price_atoms_per_base_unit === null) return null;
  const price = Number(mark.price_atoms_per_base_unit);
  if (!Number.isFinite(price) || price <= 0) return null;
  const baseWhole = Number(baseAtoms) / 10 ** meta.baseDecimals;
  const usd = (baseWhole * price) / 10 ** mark.quote_decimals;
  return Number.isFinite(usd) ? usd : null;
}

/** USD notional of a Sonar quote: the quote-asset side, exact from the quote. */
export function quoteNotionalUsd(
  side: "buy" | "sell",
  amountInAtoms: string,
  minimumOutputAtoms: string,
  quoteDecimals: number,
): number | null {
  const quoteAtoms = side === "buy" ? amountInAtoms : minimumOutputAtoms;
  const value = Number(quoteAtoms);
  if (!Number.isFinite(value) || value < 0) return null;
  const usd = value / 10 ** quoteDecimals;
  return Number.isFinite(usd) ? usd : null;
}
