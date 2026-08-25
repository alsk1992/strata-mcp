# Changelog

All notable changes to the Strata SDKs (`@stratabook/sdk`, `@stratabook/mcp`,
and the `strata-sdk` Rust crate) are recorded here. Versions move together.

## 0.2.11

- Consume the exact TypeScript SDK 0.2.11 release containing the installed
  maker-conformance CLI entrypoint fix.
- Make the zero-credential read-only path explicit in MCP initialization:
  markets, books, marks, candles, trades, quotes, public portfolios, and maker
  reads work immediately. Agents must not request session secrets in chat or
  begin write onboarding unless the user asks to trade.

## 0.2.10

- Consume the matching SDK conformance release. The safe deployment gate now
  exercises hosted MCP discovery, maker reads, and fresh-request Strand and
  Current preparations after every activation; funded mode proves the
  restart-safe prepare/submit path with a real externally signed Current.

## 0.2.9

- Correct the maker preparation terminology inherited from the SDK:
  `transaction_version=0` is browser-safe native Solana v0, not legacy.
  Runtime behavior is unchanged from 0.2.8.

## 0.2.8

- Consume `@stratabook/sdk` 0.2.8 so hosted maker quickstarts request
  browser-safe native-v0 preparations compatible with external wallets.

## 0.2.7

- Consume `@stratabook/sdk` 0.2.7 so maker quickstarts accept the human base
  symbol from the selected market label, including `SOL` for `SOL/USDC`, and
  inherit its post-sign transaction-message invariant.

## 0.2.6

- Carry verified maker preparations across stateless HTTP requests with the
  returned `preparationToken`; submit validates all market, product, wallet,
  operation, transaction, and control-ID bindings before using it.
- Add both maker quickstart tools to the canonical machine-readable harness.

## 0.2.5

- Add `strata_market_making_prepare` and
  `strata_market_making_submit_and_wait`. Agents now provide a market label,
  product, spread, decimal base size, and duration, sign one exact transaction
  externally, and receive chain-derived confirmation without managing arrays,
  atoms, opaque IDs, tick math, or expiry slots.

## 0.2.2

- Correct every Strand exposure and level-size tool input from `BaseLots` to
  `BaseAtoms` so agents receive the actual on-chain unit.
- State explicitly that positive base-atom amounts are valid order sizes and
  the market price denominator is not a minimum order size.

## 0.2.0

The unattended-agent release: an external agent can now onboard, hold one
balance across markets, trade instantly under a user-owned safety slider, and see the book it
trades into — all without a human signing each action, and without any venue,
route, or pool ever crossing the boundary.

### Onboarding & signing
- **One-signature onboarding.** `vault.setup` works for every user-bounded
  market — register a capped, revocable session key with a single wallet
  signature; the first deposit registers the session in the same owner-signed
  transaction.
- **One signature per action.** `orders.prepare`, `algos.twap.prepare`, and
  `execution.prepare` accept the operation itself and build immediately — the
  session's transaction signature is the whole authorization. The signed-
  challenge form still works. SDK one-call helpers (`orders.execute`,
  `algos.execute`, `executeQuote`) sign and submit in one call with a built-in
  transaction verifier; `sessionSignerFromSecretKey` turns a session secret
  into a ready signer.
- **Sponsored Vault lifecycle** (`vault.relay`): the owner needs no SOL and no
  RPC; Strata pays the fee (and pre-funds rent) when the wallet is low and
  recovers exactly what it spent from later deposits, Jupiter-style.

### Reads
- **One account read.** `GET /v2/account/{wallet}/portfolio` — balances,
  positions, open orders, and recent fills across every live market in one
  public read by wallet address (`account`/`portfolio`, `strata_portfolio`).
- **Order book, best bid/ask, and recent trades in MCP** — `strata_book`,
  `strata_bbo`, `strata_trades` (already in the SDK `books` module).
- **Maker reads public by wallet** — status, reputation, and the fills stream
  need no signature.
- **Exact-output market quotes** ("buy at least 1 SOL"): `amount_out_atoms` on
  the same quote handle and execution flow.
- Sequenced **execution**, **TWAP**, and **maker fill** streams.

### Autonomy (MCP)
- **Session-autonomy slider.** With a session key in the MCP's env
  (`STRATA_SESSION_SECRET_KEY` + `STRATA_OWNER_WALLET`), `strata_execute_quote`,
  `strata_order_execute`, and `strata_twap_execute` sign and submit within
  `STRATA_AUTONOMY` = `ask` (default; prepare only) / `limits` (up to
  `STRATA_AUTONOMY_MAX_USD_PER_TRADE` / `_PER_DAY` / `_MARKETS`) / `instant`.
  `strata_autonomy` is read-only; nothing an agent calls raises its own
  autonomy. Withdraw/policy/pause/revoke stay owner-only.

### Other
- `strata_markets` carries each market's opaque `market_id` and asset ids.
- Account sequence is optional (server-resolved).
- Tolerance is named `maximum_tolerance_bps` and echoed on every quote (never
  conflated with price impact).
- CLI: `session-keygen`, `account`, `execute-quote`, direct `twap-prepare` /
  `execution-prepare`.

Nothing about venues, routes, pools, adapters, legs, counterparties, or how a fill was built, is exposed at any surface; the contract privacy gate enforces it.

## 0.1.x

Initial public SDK: capabilities, markets, action graph, market quote, quote execution (challenge → prepare → submit), firm orders, and the
opaque market/asset contract.
