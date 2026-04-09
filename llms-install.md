# HashLock MCP — Installation Guide for AI Agents

## What is this?

HashLock MCP is a Model Context Protocol server that gives AI agents access to institutional OTC crypto trading with atomic settlement (HTLCs). You can create trades, lock assets, and settle trustlessly across Ethereum and Bitcoin.

## Quick Install

### Option 1: npx (no install needed)

Add this to your MCP client configuration:

```json
{
  "mcpServers": {
    "hashlock": {
      "command": "npx",
      "args": ["-y", "@hashlock/mcp"],
      "env": {
        "HASHLOCK_ENDPOINT": "http://142.93.106.129/graphql",
        "HASHLOCK_ACCESS_TOKEN": "<your-jwt-token>"
      }
    }
  }
}
```

### Option 2: Global install

```bash
npm install -g @hashlock/mcp
```

Config:
```json
{
  "mcpServers": {
    "hashlock": {
      "command": "hashlock-mcp",
      "env": {
        "HASHLOCK_ENDPOINT": "http://142.93.106.129/graphql",
        "HASHLOCK_ACCESS_TOKEN": "<your-jwt-token>"
      }
    }
  }
}
```

### Option 3: From source

```bash
git clone https://github.com/Hashlock-Tech/hashlock-mcp
cd hashlock-mcp
npm install && npm run build
```

Config:
```json
{
  "mcpServers": {
    "hashlock": {
      "command": "node",
      "args": ["<path-to-repo>/dist/index.js"],
      "env": {
        "HASHLOCK_ENDPOINT": "http://142.93.106.129/graphql",
        "HASHLOCK_ACCESS_TOKEN": "<your-jwt-token>"
      }
    }
  }
}
```

## Getting an Access Token

1. Register at the HashLock platform
2. Log in to receive a JWT access token
3. Set it as `HASHLOCK_ACCESS_TOKEN` in your environment

## Available Tools

- **create_rfq** — Post a request for quote to buy or sell crypto
- **respond_rfq** — Submit a price quote for an open RFQ
- **create_htlc** — Lock assets in an HTLC for atomic settlement
- **withdraw_htlc** — Claim locked assets by revealing the preimage
- **refund_htlc** — Reclaim assets after timelock expiry
- **get_htlc** — Check settlement status

## Supported Assets

ETH, BTC, USDT, USDC, WBTC, WETH on Ethereum mainnet + Bitcoin mainnet/signet.

## Troubleshooting

- **"Authentication required"** — Set HASHLOCK_ACCESS_TOKEN
- **"CSRF validation failed"** — Ensure you're connecting to the correct endpoint
- **Timeout errors** — Check network connectivity to the HashLock API
