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
        "HASHLOCK_EVM_KEY": "0x<agent EVM key (TESTNET!)>",
        "HASHLOCK_TRON_KEY": "<agent TRON key, 64-hex (optional)>",
        "HASHLOCK_BTC_KEY": "<agent BTC WIF, signet (optional)>"
      }
    }
  }
}
```

## Auth — autonomous, per chain

The agent owns its key(s); the server does the login itself (nonce → sign → JWT, refreshed on expiry).
The first configured key (EVM → TRON → BTC) mints the session; each key also signs settlement on its chain.

| Env var | Chain | Login |
|---|---|---|
| `HASHLOCK_EVM_KEY` | EVM | SIWE `personal_sign` |
| `HASHLOCK_TRON_KEY` | TRON | `signMessageV2` |
| `HASHLOCK_BTC_KEY` | Bitcoin | BIP-322 |
| `HASHLOCK_TOKEN` | — | a ready JWT (alternative to a key) |

With none set, read-only tools (`list_assets`, `list_open_rfqs`, `get_rfq`) still work. Use dedicated **testnet** keys.

Other env: `HASHLOCK_API_URL` (default `https://dev.hashlock.markets/api`), `HASHLOCK_APP_URL` (share links; default derived), `HASHLOCK_EVM_RPC` (default a public Sepolia RPC), `HASHLOCK_TRON_HOST` (default Nile), `HASHLOCK_SECRETS_PATH` (default `~/.hashlock/mcp-secrets.json`, mode 0600).

## Tools (16)

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
| `get_deal_secret` | The locally-stored swap preimage (gated on both legs funded) |
| `reveal_claim` | Report an out-of-band claim (secret + tx) so the other leg settles |
| `whoami` | The account you're authenticated as |
| **`fund_leg`** | **Autonomous:** fund your side of a swap on-chain with the agent's own key (EVM/TRON/BTC) |
| **`claim_leg`** | **Autonomous:** claim your receive leg with the preimage (reveals the secret on-chain) |

Amounts are **human decimal strings** ("0.5"); prices are the **total** quote-asset amount, not per-unit. Errors return a structured envelope `{ error: { code, is_retryable, recovery_hint } }` agents can branch on.

## Fully autonomous loop

With a key set for each chain a swap touches, an agent can run end to end with no human:
`create_rfq`/`respond_to_rfq` → `negotiate` (accept) → `set_settlement_address` (both chains) →
`fund_leg` → `claim_leg`. Funding/claiming is signed locally with the agent's keys; the swap secret is
generated + stored locally and only its hashlock leaves the machine. Use dedicated testnet keys.

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
