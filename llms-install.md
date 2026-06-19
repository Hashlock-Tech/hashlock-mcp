# HashLock MCP — Installation Guide for AI Agents

## What is this?

HashLock MCP is a Model Context Protocol server that gives AI agents access to cross-chain atomic settlement (HTLCs). You can run sealed-bid RFQ auctions, get quotes, and settle trustlessly across Ethereum, Bitcoin, and Sui.

## Quick Install

### Option 1: npx (no install needed)

Add this to your MCP client configuration:

```json
{
  "mcpServers": {
    "hashlock": {
      "command": "npx",
      "args": ["-y", "@hashlock-tech/mcp"],
      "env": {
        "HASHLOCK_ENDPOINT": "https://hashlock.markets/graphql",
        "HASHLOCK_ACCESS_TOKEN": "<your-jwt-token>"
      }
    }
  }
}
```

### Option 2: Global install

```bash
npm install -g @hashlock-tech/mcp
```

Config:
```json
{
  "mcpServers": {
    "hashlock": {
      "command": "hashlock-mcp",
      "env": {
        "HASHLOCK_ENDPOINT": "https://hashlock.markets/graphql",
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
        "HASHLOCK_ENDPOINT": "https://hashlock.markets/graphql",
        "HASHLOCK_ACCESS_TOKEN": "<your-jwt-token>"
      }
    }
  }
}
```

## Getting an Access Token

Hashlock Markets uses SIWE (Sign-In With Ethereum) bearer tokens.

1. Visit [hashlock.markets/sign/login](https://hashlock.markets/sign/login)
2. Sign a message with your Ethereum wallet to receive a **7-day JWT**
3. Set it as `HASHLOCK_ACCESS_TOKEN` in your environment (the remote streamable-http transport uses an `Authorization: Bearer <token>` header instead)
4. Re-sign after expiry

## Available Tools

**Sealed-bid RFQ**
- **create_rfq** — Open a sealed-bid RFQ (optional Ghost Auction) for an OTC swap; broadcasts to market makers.
- **respond_rfq** — Market-maker side: submit a sealed-bid price quote on an open RFQ.
- **list_open_rfqs** — List open (ACTIVE) RFQs awaiting market-maker quotes (read-only).

**One-call swap facade**
- **swap_quote** — One call: opens a sealed-bid Ghost Auction and returns a `swap_handle` + best bid so far.
- **swap_status** — Re-poll an open swap by its `swap_handle` (read-only): current best bid + bid count.
- **swap_execute** — Accept the winning sealed bid and create the trade.
- **swap_cancel** — Abort an open swap before it executes (cancels the RFQ; no funds locked).

**HTLC atomic settlement**
- **create_htlc** — Record an on-chain HTLC lock tx to advance atomic settlement (DvP); EVM, Bitcoin, or Sui leg.
- **withdraw_htlc** — Atomically claim a swap by revealing the 32-byte preimage (unlocks both legs).
- **refund_htlc** — Reclaim locked funds after the timelock expires (original sender only, post-deadline).
- **get_htlc** — Per-leg HTLC settlement state for a trade (read-only).

**Discovery**
- **list_supported_pairs** — List the chain-qualified token pairs Hashlock supports (read-only).
- **list_my_trades** — List your trades, active + historical (read-only); primary tool to resync state after context loss.

**Compute capacity** (requires the `compute_trading` account flag)
- **create_compute_capacity_listing** — Provider side: list a compute-capacity batch for sale (Sepolia / USDC).
- **accept_compute_capacity_listing** — Buyer side: commit to purchase a listed compute-capacity batch.

## Supported Assets

Symbols: ETH, BTC, SUI, USDC, USDT, WBTC, WETH.

Chain-qualified pairs (pass `baseChain`/`quoteChain` to disambiguate same-symbol, different-chain markets):
ETH/ethereum, ETH/sepolia, BTC/bitcoin, BTC/bitcoin-signet, USDC/ethereum, USDC/sepolia, USDT/ethereum, WBTC/ethereum, WETH/ethereum, SUI/sui, SUI/sui-testnet.

Cross-chain RFQs (e.g. SUI/sui ↔ ETH/sepolia) are first-class. Call `list_supported_pairs` for the live list.

## Troubleshooting

- **"Authentication required"** — Set HASHLOCK_ACCESS_TOKEN
- **"CSRF validation failed"** — Ensure you're connecting to the correct endpoint
- **Timeout errors** — Check network connectivity to the HashLock API
