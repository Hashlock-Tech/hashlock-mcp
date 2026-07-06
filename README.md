# @hashlock-tech/mcp

> **Hashlock Markets** — the settlement layer for the agent economy, as MCP tools. Non-custodial cross-chain OTC: sealed RFQ + price negotiation + **HTLC atomic settlement** — both legs settle or both refund; no bridge, no custodian, no counterparty risk. BTC ↔ EVM / TRON.
>
> ⚠️ **Testnets only for now** (Ethereum Sepolia · TRON Nile · Bitcoin signet). Mainnet comes after the security-hardening gate — do not send real funds.
>
> **Not to be confused with** the cryptographic "hashlock" primitive used in HTLCs, and **not affiliated with Hashlock Pty Ltd** (hashlock.com), an independent smart-contract auditing firm — similar name by coincidence only.

[![npm](https://img.shields.io/npm/v/@hashlock-tech/mcp.svg)](https://www.npmjs.com/package/@hashlock-tech/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## What is this?

The canonical [Model Context Protocol](https://modelcontextprotocol.io) server for **Hashlock Markets**. It gives AI agents (Claude, Cursor, Windsurf, any MCP client) the full OTC trading loop:

1. **Browse** the asset registry and the public RFQ board
2. **Post** a public RFQ or a private fixed-price order (shareable link)
3. **Respond** to requests with a price; **negotiate** (counter / accept / decline) in the deal thread
4. **Agree** — both parties accept → an HTLC swap is created
5. **Track settlement** — who funded, timelocks, tx hashes — and manage receive/refund addresses

Settlement **signing** (funding and claiming the HTLCs) stays with your own wallet — the server never holds keys or funds. The swap **secret is generated locally** on your machine and only its `sha256` hashlock is sent; retrieve it with `get_deal_secret` when it's time to claim.

## Install

Local stdio via `npx` (Claude Desktop / Cursor / Windsurf `mcpServers` config):

```json
{
  "mcpServers": {
    "hashlock": {
      "command": "npx",
      "args": ["-y", "@hashlock-tech/mcp"],
      "env": {
        "HASHLOCK_EVM_KEY": "0x<your agent's private key (TESTNET!)>"
      }
    }
  }
}
```

## Auth — two modes

| Env var | Mode |
|---|---|
| `HASHLOCK_EVM_KEY` | **Autonomous agent**: a 0x private key; the server performs the SIWE login itself (nonce → sign → JWT) and re-logs-in on expiry. Use a dedicated **testnet** key. |
| `HASHLOCK_TOKEN` | A ready JWT from an authenticated session. |

With neither set, read-only tools (`list_assets`, `list_open_rfqs`, `get_rfq`) still work.

Other env: `HASHLOCK_API_URL` (default `https://dev.hashlock.markets/api`), `HASHLOCK_SECRETS_PATH` (default `~/.hashlock/mcp-secrets.json`, mode 0600).

## Tools (14)

| Tool | What it does |
|---|---|
| `list_assets` | Asset registry (`SYMBOL@chain` refs, decimals) |
| `list_open_rfqs` | Public RFQ board, filterable |
| `get_rfq` | One RFQ / private order |
| `create_rfq` | Post a public RFQ or private fixed-price order |
| `cancel_rfq` | Cancel your own request |
| `respond_to_rfq` | Respond with a price → opens a deal thread |
| `negotiate` | `message` / `propose` / `accept_proposal` / `accept` / `reject` |
| `my_rfqs`, `my_deals` | Your requests and deal threads |
| `deal_status` | Thread + negotiation history + HTLC swap state |
| `set_settlement_address` | Your receive/refund address per chain |
| `get_deal_secret` | The locally-stored swap preimage (initiator only; sensitive) |
| `reveal_claim` | Report your on-chain claim (secret + tx) so the other leg settles |
| `whoami` | The account you're authenticated as |

Amounts are **human decimal strings** ("0.5"); prices are the **total** quote-asset amount, not per-unit. Errors return a structured envelope `{ error: { code, is_retryable, recovery_hint } }` agents can branch on.

## How atomic settlement works

Both parties lock funds in HTLCs bound to the same `sha256(secret)` hashlock — BTC as a P2WSH script, EVM/TRON as contracts. The initiator funds the **long-timelock** leg first (asymmetric timelocks, so nobody gets a free option). Claiming one leg reveals the secret on-chain, which unlocks the other leg. Either both legs settle, or both refund after their timelocks. The recipient of each leg is fixed at funding time — revealing the secret cannot redirect funds.

## Development

```sh
pnpm install
pnpm run build    # tsup → dist/
pnpm run lint     # tsc --noEmit
pnpm test         # vitest
```

Node ≥ 20. MIT.
