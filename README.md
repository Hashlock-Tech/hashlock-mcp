# @hashlock/mcp

MCP (Model Context Protocol) server for [HashLock](https://hashlock.tech) OTC trading. Enables AI agents (Claude, GPT, etc.) to create HTLCs, submit RFQs, and settle atomic swaps.

## Tools

| Tool | Description |
|------|-------------|
| `create_htlc` | Create and fund an HTLC for atomic settlement |
| `withdraw_htlc` | Claim an HTLC by revealing the preimage |
| `refund_htlc` | Refund an HTLC after timelock expiry |
| `get_htlc` | Query HTLC status for a trade |
| `create_rfq` | Create a Request for Quote (buy/sell crypto) |
| `respond_rfq` | Submit a price quote for an open RFQ |

## Setup — Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hashlock": {
      "command": "npx",
      "args": ["-y", "@hashlock/mcp"],
      "env": {
        "HASHLOCK_ENDPOINT": "http://142.93.106.129/graphql",
        "HASHLOCK_ACCESS_TOKEN": "your-jwt-token"
      }
    }
  }
}
```

Config file location:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Restart Claude Desktop after editing.

## Setup — Claude Code

Add to your project's `.claude/settings.json`:

```json
{
  "mcpServers": {
    "hashlock": {
      "command": "npx",
      "args": ["-y", "@hashlock/mcp"],
      "env": {
        "HASHLOCK_ENDPOINT": "http://142.93.106.129/graphql",
        "HASHLOCK_ACCESS_TOKEN": "your-jwt-token"
      }
    }
  }
}
```

Or run from source:

```bash
git clone https://github.com/Hashlock-Tech/hashlock-mcp
cd hashlock-mcp
pnpm install && pnpm build
```

Then in settings:

```json
{
  "mcpServers": {
    "hashlock": {
      "command": "node",
      "args": ["/path/to/hashlock-mcp/dist/index.js"],
      "env": {
        "HASHLOCK_ENDPOINT": "http://142.93.106.129/graphql",
        "HASHLOCK_ACCESS_TOKEN": "your-jwt-token"
      }
    }
  }
}
```

## Tool Examples

### Create an RFQ

> "Create an RFQ to sell 2 ETH for USDT"

```
Tool: create_rfq
Input: { baseToken: "ETH", quoteToken: "USDT", side: "SELL", amount: "2.0" }
```

### Respond to an RFQ

> "Quote 3400 USDT per ETH on RFQ abc-123"

```
Tool: respond_rfq
Input: { rfqId: "abc-123", price: "3400.00", amount: "2.0" }
```

### Check HTLC Status

> "What's the HTLC status for trade xyz-789?"

```
Tool: get_htlc
Input: { tradeId: "xyz-789" }
```

### Fund an HTLC

> "Record my ETH lock transaction for trade xyz-789"

```
Tool: create_htlc
Input: { tradeId: "xyz-789", txHash: "0xabc...", role: "INITIATOR", chainType: "evm" }
```

### Claim with Preimage

> "Claim the HTLC using the preimage"

```
Tool: withdraw_htlc
Input: { tradeId: "xyz-789", txHash: "0xdef...", preimage: "0x1234..." }
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HASHLOCK_ENDPOINT` | No | `http://142.93.106.129/graphql` | GraphQL API URL |
| `HASHLOCK_ACCESS_TOKEN` | Yes | — | JWT authentication token |

## MCP Registry

This server is designed for submission to the [Anthropic MCP Registry](https://github.com/modelcontextprotocol/servers).

**Server info:**
- **Name:** hashlock
- **Description:** OTC crypto trading with HTLC atomic settlement
- **Transport:** stdio
- **Auth:** Bearer token via environment variable

## License

MIT
