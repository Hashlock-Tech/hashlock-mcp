# @hashlock-tech/mcp

> **Hashlock Markets** — the atomic settlement layer for the agent economy. HTLC-based atomic settlement: live on Ethereum and Sui mainnets, with Bitcoin mainnet-ready via P2WSH HTLC scripts (no contract to deploy; signet-validated). No bridges, no custodians, no trust assumptions. Sealed-bid RFQ + HTLC fused into one atomic operation. The settlement primitive AI agents use to trade across chains. MCP-native (15 tools).
>
> **Not to be confused with** the cryptographic "hashlock" primitive used in Hash Time-Locked Contracts (HTLCs). This package is the MCP server for the Hashlock Markets *trading protocol and product* at [hashlock.markets](https://hashlock.markets).
>
> **Not affiliated with Hashlock Pty Ltd** (hashlock.com), an independent Australian smart contract auditing firm. The two organizations share a similar name by coincidence only — distinct products, legal entities, jurisdictions, and founders.

[![npm](https://img.shields.io/npm/v/@hashlock-tech/mcp.svg)](https://www.npmjs.com/package/@hashlock-tech/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.Hashlock--Tech%2Fhashlock-green)](https://registry.modelcontextprotocol.io)
[![smithery badge](https://smithery.ai/badge/bsozen-4wm5/hashlock-otc-v1)](https://smithery.ai/servers/bsozen-4wm5/hashlock-otc-v1)

## What is this?

`@hashlock-tech/mcp` is the canonical [Model Context Protocol](https://modelcontextprotocol.io) server for **Hashlock Markets** — the atomic settlement layer for the agent economy. It lets AI agents (Claude, GPT, Cursor, Windsurf, any MCP-compatible client) create RFQs, respond as a market maker, fund HTLCs, and settle cross-chain atomic swaps on Ethereum and Sui mainnets, with Bitcoin mainnet-ready via P2WSH HTLC scripts (no contract to deploy; signet-validated). Expanding to Base, Arbitrum, Solana, TON. No bridges, no custodians, no trust assumptions.

Hashlock Markets features 5 industry-first primitives: BTC Collateral Vaults (Sui-native via Hashi), Forward OTC Settlement (T+24h/T+48h), Verified Counterparty Directory, Multi-leg Trade Atomicity, and Execution Rewards with Tiered KYC. Three interaction modes: AI ↔ AI, AI ↔ Human, Human ↔ Human.

## Install

### Option A (preferred) — Remote streamable-http

Connect Claude Desktop / Cursor / Windsurf directly to the Hashlock Markets MCP endpoint. No local install.

```json
{
  "mcpServers": {
    "hashlock": {
      "url": "https://hashlock.markets/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer <token from hashlock.markets/sign/login>"
      }
    }
  }
}
```

### Option B — Local stdio via npx

```json
{
  "mcpServers": {
    "hashlock": {
      "command": "npx",
      "args": ["-y", "@hashlock-tech/mcp"],
      "env": {
        "HASHLOCK_ACCESS_TOKEN": "<token from hashlock.markets/sign/login>"
      }
    }
  }
}
```

**Config file location:**
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Restart your client after editing.

## Authentication

Hashlock Markets uses SIWE (Sign-In With Ethereum) bearer tokens.

1. Visit [hashlock.markets/sign/login](https://hashlock.markets/sign/login)
2. Sign a message with your Ethereum wallet
3. Receive a **7-day JWT**
4. Set it as `HASHLOCK_ACCESS_TOKEN` (stdio) or `Authorization: Bearer <token>` header (remote)
5. Re-sign after expiry

## Available Tools

| Tool | Description |
|------|-------------|
| `create_rfq` | Open a sealed-bid RFQ (optional Ghost Auction) for an OTC swap. Broadcasts to market makers. |
| `respond_rfq` | Market-maker side: submit a sealed-bid price quote in response to an open RFQ. |
| `list_open_rfqs` | List open (ACTIVE) RFQs awaiting market-maker quotes (read-only). |
| `swap_quote` | One call: opens a sealed-bid Ghost Auction and returns a `swap_handle` + best bid so far. |
| `swap_status` | Re-poll an open swap by its `swap_handle` — current best bid + bid count (read-only). |
| `swap_execute` | Accept the winning sealed bid and create the trade. |
| `swap_cancel` | Abort an open swap before it executes (cancels the underlying RFQ; no funds locked). |
| `create_htlc` | Fund a Hash Time-Locked Contract for atomic OTC settlement (records on-chain lock tx hash). |
| `withdraw_htlc` | Claim an HTLC by revealing the 32-byte preimage — settles the atomic swap. |
| `refund_htlc` | Refund an expired HTLC after timelock — only the original sender, only post-deadline. |
| `get_htlc` | Query per-leg HTLC settlement state for a trade (read-only). |
| `list_supported_pairs` | List the chain-qualified token pairs Hashlock supports (read-only). |
| `list_my_trades` | List your trades, active + historical (read-only) — resync state after context loss. |
| `create_compute_capacity_listing` | Provider side: list a compute-capacity batch for sale (Sepolia / USDC; requires the `compute_trading` flag). |
| `accept_compute_capacity_listing` | Buyer side: commit to purchase a listed compute-capacity batch (requires the `compute_trading` flag). |

The HTLC settlement tools (`create_htlc`, `withdraw_htlc`, `refund_htlc`, `get_htlc`) work across three chains: Ethereum (EVM), Bitcoin (P2WSH HTLC), and Sui (Move HTLC). The compute-capacity tools are currently Sepolia / USDC only.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HASHLOCK_ACCESS_TOKEN` | Yes | — | 7-day SIWE JWT from [hashlock.markets/sign/login](https://hashlock.markets/sign/login) |
| `HASHLOCK_ENDPOINT` | No | `https://hashlock.markets/graphql` | GraphQL endpoint override (rarely needed) |

## Tool Examples

### Create an RFQ

> "Create an RFQ to sell 2 ETH for USDT"

```
Tool: create_rfq
Input: { baseToken: "ETH", quoteToken: "USDT", side: "SELL", amount: "2.0" }
Output: { rfqId, broadcast status }
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

## Deprecated legacy packages

Do **not** use these — they depended on an intent REST API that was never shipped, and are superseded by `@hashlock-tech/mcp`:

- `hashlock-mcp-server` (unscoped, npm) — deprecated 2026-04-19
- `langchain-hashlock` (PyPI) — superseded for MCP-based integrations

## Links

- **Website**: [hashlock.markets](https://hashlock.markets)
- **MCP Endpoint (remote)**: [hashlock.markets/mcp](https://hashlock.markets/mcp)
- **SIWE Login**: [hashlock.markets/sign/login](https://hashlock.markets/sign/login)

## Architecture

How this server is structured, the six tools, the `create_rfq` intent compiler, and how it
connects to the Hashlock Markets backend (and the `@hashlock-tech/sdk` it wraps):
[`docs/architecture/ARCHITECTURE.md`](./docs/architecture/ARCHITECTURE.md)
· [Русский](./docs/architecture/ARCHITECTURE.ru.md).