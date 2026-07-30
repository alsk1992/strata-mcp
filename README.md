# Strata MCP

Official Model Context Protocol access to Strata and Sonar. The server is a thin
adapter over [`@stratabook/sdk`](https://github.com/alsk1992/strata-sdk-ts): it
follows Strata's live public capability policy and contains no separate quote or
execution logic.

Sonar is Strata's unified liquidity and matching system. It returns one
composition-opaque economic result without exposing private routing, venue
selection, or matching internals.

## Use the hosted server

The managed Streamable HTTP endpoint is:

```text
https://api.stratabook.app/mcp
```

Add that URL as a Streamable HTTP MCP server in any compatible agent. Tool
availability is discovered dynamically from Strata.

## Run over local stdio

```sh
npx -y @stratabook/mcp
```

Example configuration for clients that launch stdio servers:

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

## Public tools

The initial read-only capability set provides:

- `strata_capabilities` — inspect the versioned live capability catalog.
- `strata_markets` — list public markets and current quote readiness.
- `strata_quote` — request a validated, short-lived Sonar quote.

The server rebuilds and rechecks its exposed tool policy from the live public
catalog. If Strata disables a capability, a cached client cannot continue using
it.

All token values are unsigned base-10 atomic strings. Agents should preserve
those strings exactly and treat quote expiry and minimum output as hard
constraints.

## Self-host Streamable HTTP

```sh
npx -y @stratabook/mcp \
  --transport http \
  --host 127.0.0.1 \
  --port 8787
```

Loopback is the default bind. Put TLS, authentication policy, and request
limiting in front of any remotely reachable self-hosted process.

## Safety boundary

Version `0.1.x` is read-only. It cannot prepare, sign, or submit transactions
and never accepts wallet, private-key, keypair, or session-key material. A future
write capability must be explicit in the public contract and will not be
silently added to this release line.

Public product documentation lives at
[stratabook.app/docs](https://stratabook.app/docs/hello-agents). Security issues
should be reported privately as described in [SECURITY.md](SECURITY.md).
