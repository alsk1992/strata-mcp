# Strata MCP

Official capability-gated MCP access to Strata and Sonar. The server delegates
to `@stratabook/sdk`: it follows the live capability catalog and contains no
separate quote or execution logic.

The official hosted endpoint currently exposes market, exact-output, and
asset-to-asset Sonar quotes, together with quote-bound execution tools.
Capability gating is a runtime safety check so clients stop if policy changes;
it does **not** mean quotes are inactive.

## Local stdio

```sh
npx -y @stratabook/mcp
```

Example client configuration:

```json
{
  "mcpServers": {
    "strata": {
      "command": "npx",
      "args": ["-y", "@stratabook/mcp"]
    }
  }
}
```

The tools currently available are:

- `strata_capabilities`
- `strata_action_graph`
- `strata_platform_graph`
- `strata_status`
- `strata_candles`
- `strata_marks`
- `strata_twaps`
- `strata_twap_challenge`
- `strata_twap_cancel`
- `strata_twap_prepare`
- `strata_twap_submit`
- `strata_portfolio`
- `strata_portfolio_history`
- `strata_market_making_status`
- `strata_market_making_reputation`
- `strata_market_making_prepare` — start or stop a Strand/Current from a market label, decimal base size, spread, and duration; no arrays or atom conversion
- `strata_market_making_submit_and_wait` — submit the externally signed preparation idempotently and wait for matching chain-derived state
- `strata_market_making_strand_prepare`, `strata_market_making_strand_submit`
- `strata_market_making_current_prepare`, `strata_market_making_current_submit`
- `strata_vault_status`
- `strata_vault_setup`, `strata_vault_deposit`, `strata_vault_withdraw`, `strata_vault_delegate`, `strata_vault_policy`, `strata_vault_pause` — prepare owner actions with Strata as sponsored fee payer
- `strata_vault_submit` — submit the owner-signed preparation; Strata pays and broadcasts
- `strata_vault_submission` — durable outcome of a submission
- `strata_rewards`
- `strata_referrals`
- `strata_referral_link` — prepare externally signable consent or submit the signed link
- `strata_referral_claim` — prepare externally signable consent or submit the signed claim
- `strata_bugs`
- `strata_bug_submit` — prepare externally signable bytes or submit the signed report
- `strata_markets`
- `strata_quote` and `strata_exact_output_quote` — live market quotes (spend X / receive at least Y)
- `strata_swap_quote` — live catalog-asset swap quotes
- `strata_execution_challenge`
- `strata_execution_prepare`
- `strata_execution_submit`
- `strata_execution_status` — recover a durable immediate-execution receipt
- `strata_order_challenge`, when `orders.prepare` is enabled for MCP
- `strata_order_prepare`, when `orders.prepare` is enabled for MCP
- `strata_order_submit`, when `orders.submit` is enabled for MCP
- `strata_order_status`, when `orders.submit` is enabled for MCP

Every initialization response carries the compact Strata Agent Harness. The
server also publishes the complete harness as the
`strata://agent-harness/v1` resource and provides a `strata_start` prompt for
applying it to one concrete objective.
The live executable topology is also available as
`strata://action-graph/v1`. The complete entity, operation, and workflow map is
available as `strata://platform-graph/v2`.

The tool list follows the live public policy. Every call rechecks that policy,
so a disabled capability stops immediately even if a client cached an older
tool list. Tool discovery from the connected server remains authoritative for
self-hosted deployments or any future policy change.

For normal maker operation, use two calls:

1. Call `strata_market_making_prepare` with `action: "start"`, a label such as
   `SOL/USDC`, `product: "current"` or `"strand"`, `spreadBps`, a decimal size
   such as `0.01 SOL`, and the maker wallet. Duration defaults to ten minutes
   and levels default to three.
2. Verify and sign only `prepared.transaction_base64` in the external wallet,
   then pass it, `prepared.maker_control_id`, and the unchanged
   `preparationToken` to `strata_market_making_submit_and_wait`.

The second call returns only after Strata's chain-derived maker status matches
the exact product settings. The token contains no signing authority and keeps
the two-call flow working across stateless HTTP requests or an MCP process
restart. Use `action: "stop"` through the same pair. The older product-specific
tools remain available for strategies that deliberately manage every low-level
array and safety field.

For maker funding, initialize the market Vault if needed, activate the Strand
or Current, then deposit with `strata_vault_deposit`. The market keeps that
available collateral while a control is live and returns it after the final
control is disabled, exhausted, expired, or cancelled. Current follows Strata's
live mark and needs no separate publisher transaction.

## Hosted Streamable HTTP

The managed public endpoint is:

```text
https://api.stratabook.app/mcp
```

For a self-hosted or development process:

```sh
strata-mcp --transport http --port 8787
```

Place TLS and request limiting in front of `/mcp`. Loopback is the default bind;
the official MCP HTTP helper enforces Host validation for local installations.

`GET /health` is a readiness check, not a shallow process-liveness response. It
validates the live capability catalog against the bundled public contract and
agent harness. A stale SDK or incompatible contract therefore returns `503` and
blocks release activation. The same process serves the reviewed discovery
manifest at `/.well-known/strata-agent.json` and the graph at
`/.well-known/strata-action-graph.json`.

## Safety

The external agent owner decides what its agent may do and configures its
signer. MCP can request authorization bytes, prepare quote-bound trades,
bounded TWAP placement or cancellation, or atomic place, cancel, cancel-all,
replace, or bounded batch order controls, and
submit the externally signed result. It accepts
public keys, detached signatures, and signed transactions, never private keys,
seed phrases, or wallet secrets. Amounts are token atoms encoded as base-10
strings.

Quotes default to zero tolerance. `maximumToleranceBps` is the agent's own
floor (the most it accepts below the quoted output); `price_impact_pct` is
measured from the book. They are unrelated, and every quote result states both.
