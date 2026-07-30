# Strata MCP

Connect AI agents to live Strata markets and Sonar quotes.

Strata MCP gives compatible assistants a simple way to discover available
markets, check current availability, and request exact, short-lived quotes from
Sonar—Strata's unified liquidity and matching system.

## Connect to Strata

Use Strata's hosted Streamable HTTP server:

```text
https://api.stratabook.app/mcp
```

Add this URL as a remote MCP server in any client that supports Streamable HTTP.
There is nothing to install or host.

### Try asking

- “Which Strata markets are available right now?”
- “Get a Sonar sell quote for 0.1 SOL in SOL/USDC.”
- “Show me the expected output, fees, price impact, minimum output, and expiry.”

## Available tools

| Tool | What it does |
| --- | --- |
| `strata_capabilities` | Shows the Strata features currently available to agents |
| `strata_markets` | Lists markets and their current Sonar quote availability |
| `strata_quote` | Requests a Sonar quote for a market, side, amount, and slippage |

The available tool set automatically reflects the features currently offered by
Strata.

## Run locally

Run the server over stdio with Node.js 20+:

```sh
npx -y @stratabook/mcp
```

Example configuration for clients that launch local MCP servers:

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

To expose your own Streamable HTTP endpoint:

```sh
npx -y @stratabook/mcp \
  --transport http \
  --host 127.0.0.1 \
  --port 8787
```

The HTTP server binds to loopback by default. Add TLS, authentication, and rate
limiting before making a self-hosted instance remotely accessible.

## Working with Sonar quotes

One Sonar request returns a unified result for the complete Strata market,
including expected output, fees, price impact, minimum output, and expiry.

Token values are exact atomic-unit strings. Agents should preserve those values,
respect `minimum_output_atoms`, and request a new quote after expiry.

## Available today

The `0.1.x` release provides read-only market discovery and Sonar quotes. It
cannot prepare, sign, or submit transactions and never asks for wallet,
private-key, keypair, or session-key material.

## Documentation and support

- [Agent quick start](https://stratabook.app/docs/hello-agents)
- [MCP documentation](https://stratabook.app/docs/agent-mcp)
- [TypeScript SDK](https://github.com/alsk1992/strata-sdk-ts)
- [Report a bug or request a feature](https://github.com/alsk1992/strata-mcp/issues)
- [Report a security issue](SECURITY.md)

Licensed under either [Apache-2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT).
