# Changelog

All notable changes to the Strata SDKs (`@stratabook/sdk`, `@stratabook/mcp`,
and the `strata-sdk` Rust crate) are recorded here. Versions move together.

## 0.2.19

- Stop implicitly activating self-trade cancellation for resting orders.
- Add an optional `selfTradePrevention` selector to `strata_order_execute`;
  omitted means normal placement, while an explicitly selected policy is
  applied on the authenticated order channel.
- Update agent guidance so callers no longer refuse orders merely because the
  user did not request a cancellation policy.

## 0.2.18

- Hot-reload locally paired session credentials inside a running MCP process;
  `connect`, session replacement, and disconnect no longer require a client
  restart.
- Expose `strata_order_execute` in simple mode with human limit-order intent:
  market label, side, percentage of available balance, and signed mark offset.
  Strata resolves exact asset atoms, decimals, mark and tick alignment.
- Keep authenticated order channels warm for durable dead-man heartbeats. A
  placement whose guard cannot be proven is cancelled fail-closed.
- Expand `strata_autonomy` into a public-key-only runtime handshake covering
  package version, mode, credential source, loaded/file/on-chain session
  consistency, execution readiness, expiry, and clock skew.
- Preserve exact `retry_after_ms` values instead of retrying every transient
  read after a fixed 150ms.

## 0.2.17

- Consume the matching strategy-timed TypeScript SDK and allow an optional
  zero cadence floor in advanced setup calls.
- Keep the local pairing listener alive longer and close its helper tab after
  credentials are saved, with a branded Strata return page as the fallback.

## 0.2.16

- Consume the matching TypeScript SDK 0.2.16 packaging-parity release. MCP
  tools and behavior are unchanged from 0.2.15.

## 0.2.15

- Add explicit IntentBook prepare/submit tools in advanced mode and a one-call
  post/permanent-revoke tool for locally configured Vault sessions.
- Apply the existing ask/limits/instant slider, USD budgets, capability gates,
  exact retry behavior, and sponsored-fee explanation to intent controls.

## 0.2.14

- Make `strata-mcp connect` the complete client-neutral trading setup flow:
  choose limits in Strata, sign once, save the secret locally, and return to a
  confirmed connected Control Center without environment variables or config
  editing.
- Re-running `connect` now rotates an existing local session atomically, and
  saves the new credential only after both activation and old-key revocation
  are confirmed.

## 0.2.13

- Add `strata-mcp connect`: generate the session secret locally, open the
  owner-wallet registration page with only its public key, verify activation,
  and save a mode-0600 local credential. No secret copying, chat, config-file,
  or environment-variable setup is required.
- Add `strata-mcp disconnect` for exact-session on-chain revocation followed
  by local credential removal.
- Automatically load the private local connection for MCP and `doctor`, while
  preserving explicit environment variables for managed deployments.
- Keep read-only tools immediate and client-neutral, and document hosted HTTP,
  Cursor, Claude Code, Codex, Windsurf, and generic stdio installation.

## 0.2.12

- Make MCP client-neutral: the primary setup works with any stdio or
  Streamable HTTP MCP host; Codex is only one optional client example.
- Replace the forced discovery preamble with direct read-only tool use and a
  compact 12-tool default. `--mode advanced` retains the complete protocol.
- Accept exact human quote and trade amounts such as `0.1 SOL`, `20 USDC`, and
  `$20`, resolving market labels and decimals without floating point.
- Add progressive `strata_trade`, `strata-mcp doctor`, one safe transient quote
  retry, and plain next steps for common failures.

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
