<p align="center">
  <a href="https://stratabook.app">
    <img src="https://raw.githubusercontent.com/alsk1992/strata-mcp/main/assets/readme-hero.svg?v=20260826-2" alt="Strata MCP — The deepest book in DeFi" width="100%" />
  </a>
</p>

<p align="center">
  <a href="https://stratabook.app">Trade</a> ·
  <a href="https://stratabook.org/docs/agent-mcp">Docs</a> ·
  <a href="https://www.npmjs.com/package/@stratabook/mcp">npm</a> ·
  <a href="https://api.stratabook.app/mcp">Hosted MCP</a>
</p>

# Strata MCP

Give any MCP-compatible agent direct access to Strata markets and Sonar. It
works across Claude Desktop, Cursor, Windsurf, Codex and any standards-based
MCP host.

Read-only access works immediately. No wallet, API key, session key, environment
variable or settings screen is required to explore markets, books, prices,
candles, trades, quotes and public maker data.

| How you connect | Best for | What stays private |
| --- | --- | --- |
| Hosted: `https://api.stratabook.app/mcp` | Instant reads, Sonar quotes and externally signed prepare/submit flows | The shared server never receives a session secret |
| Local: `npx -y @stratabook/mcp` | Reads now; optional one-call trading after `connect` | The session secret remains in a mode-0600 file on the user's machine |

Intent, Strand and Current controls are live. A connected local MCP can execute
session-backed trades, orders, TWAPs and Intent updates in one call. The hosted
shared MCP exposes Intent prepare/submit instead because it deliberately never
stores a user's session secret. Current tracks Strata's live mark automatically.

Tool availability follows Strata's live safety policy. If an operation is
paused, its tool disappears immediately; everyday reads and quotes require no
activation.

The default tool mode is deliberately compact. Agents call the requested tool
directly instead of burning discovery calls before a quote. Use
`--mode advanced` (or `STRATA_MCP_MODE=advanced`) only when an integration
needs the explicit challenge / prepare / submit protocol tools.

## Start locally

Read-only use needs no wallet, key, autonomy setting, or environment variable:

```sh
npx -y @stratabook/mcp
```

Trading setup is optional. When needed, the local MCP generates its own key,
opens the owner-wallet page, and saves the secret in a mode-0600 local file.
The browser and Strata receive only the public key:

```sh
npx -y @stratabook/mcp connect
```

This opens the client-neutral Strata limit picker, registers the locally
generated key with one wallet signature, saves the credential privately, and
returns to the live Control Center. Run the same command again to replace the
old key atomically; the old key is revoked in the same signed transaction.

There is no secret to paste into chat, no environment-variable screen, and no
client config to edit after the read-only server is installed. Restart or
refresh the MCP client after the browser confirms connection. Revoke the exact
session and delete its local credential with:

```sh
npx -y @stratabook/mcp disconnect
```

Generic configuration for Claude Desktop, Cursor, Windsurf, and other
JSON-config MCP clients:

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

Codex happens to support a one-line client-specific installer:

```sh
codex mcp add strata -- npx -y @stratabook/mcp
```

Check the whole read-only connection without placing a trade:

```sh
npx -y @stratabook/mcp doctor
```

The private credential defaults to `~/.config/strata/mcp.json` on macOS/Linux
and `%APPDATA%\Strata\mcp.json` on Windows. Override it with
`STRATA_MCP_CREDENTIALS_FILE` when a managed secret volume is required.

The compact default exposes the tools ordinary users need:

- `strata_markets`, `strata_marks`, `strata_book`, `strata_candles`, `strata_trades`
- `strata_quote` — accepts `0.1 SOL`, `20 USDC`, or `$20`; token atoms remain optional
- `strata_portfolio` and `strata_market_making_status`
- `strata_trade` — returns a live quote when trading is not connected, with one setup link; follows the user's session limits when connected
- `strata_market_making_prepare` and `strata_market_making_submit_and_wait`
- `strata_autonomy` — reports whether optional trading is connected and the user's limits

Advanced mode additionally exposes the complete protocol surface, including:

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
- `strata_market_making_intent_prepare`, `strata_market_making_intent_submit` — control an existing curated IntentBook seat with a Vault session; Strata pays the fee
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

Every initialization response carries the compact Strata Agent Harness. It
instructs an agent to call normal read tools directly. The
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

With a local trading session, `strata_market_making_intent_execute` posts or
permanently revokes an existing curated IntentBook seat in one call under the
same ask/limits/instant slider. The session signs only the SDK-verified packet;
the owner wallet does not sign each update. Exact submit retries return the
original confirmed signature while the packet remains live.

For maker funding, initialize the market Vault if needed, activate the Strand
or Current, then deposit with `strata_vault_deposit`. The market keeps that
available collateral while a control is live and returns it after the final
control is disabled, exhausted, expired, or cancelled. Current tracks Strata's
live mark automatically.

The matching TypeScript package ships `strata-maker-conformance`. Its default
`safe` mode exercises this hosted MCP's discovery, public maker reads, and
fresh-request Strand and Current preparations without signing or broadcasting.
The explicitly confirmed `funded` mode signs a Current preparation externally,
submits it in a separate MCP request, waits for chain-derived state, and stops
it through the same restart-safe continuation path. Production activation runs
the safe suite automatically and rolls back the MCP release if it fails.

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
seed phrases, or wallet secrets. Simple quote and trade tools accept exact
decimal strings with their symbol; conversion never uses floating-point
arithmetic. Advanced protocol fields remain token atoms encoded as base-10
strings.

Quotes default to zero tolerance. `maximumToleranceBps` is the agent's own
floor (the most it accepts below the quoted output); `price_impact_pct` is
measured from the book. They are unrelated, and every quote result states both.
