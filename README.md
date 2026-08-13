# Strata MCP

Official capability-gated MCP access to Strata and Sonar. The server is a thin adapter
over `@stratabook/sdk`: it follows the live capability catalog and contains no
private execution logic.

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
- `strata_markets`, when `markets.read` is enabled for MCP
- `strata_quote`, when `quotes.read` is enabled for MCP
- `strata_execution_challenge`, when `trade.prepare` is enabled for MCP
- `strata_execution_prepare`, when `trade.prepare` is enabled for MCP
- `strata_execution_submit`, when `trade.submit` is enabled for MCP
- `strata_order_challenge`, when `orders.prepare` is enabled for MCP
- `strata_order_prepare`, when `orders.prepare` is enabled for MCP
- `strata_order_submit`, when `orders.submit` is enabled for MCP
- `strata_order_status`, when `orders.submit` is enabled for MCP

Every initialization response carries the compact Strata Agent Harness. The
server also publishes the complete harness as the
`strata://agent-harness/v1` resource and provides a `strata_start` prompt for
applying it to one concrete objective.
The live executable topology is also available as
`strata://action-graph/v1`.

The tool list follows the live public policy. Every call rechecks that policy,
so a disabled capability stops immediately even if a client cached an older
tool list.

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
signer. MCP can request authorization bytes, prepare quote-bound trades or
resting-order controls, and submit the externally signed result. It accepts
public keys, detached signatures, and signed transactions, never private keys,
seed phrases, or wallet secrets. Amounts are token atoms encoded as base-10
strings.

Quotes default to zero execution tolerance. An agent can request a non-zero
`slippageBps` explicitly when its task accepts a lower minimum output; price
impact remains a separate measure of current market depth.
