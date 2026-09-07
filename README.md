# @hashlock-tech/mcp

> **Hashlock Markets** — the settlement layer for the agent economy, as MCP tools. Non-custodial cross-chain OTC: sealed RFQ + price negotiation + **HTLC atomic settlement** — both legs settle or both refund; no bridge, no custodian, no counterparty risk. BTC ↔ EVM / TRON.
>
> ⚠️ **Testnets only for now** (Ethereum Sepolia · TRON Nile · Bitcoin signet). Mainnet comes after the security-hardening gate — do not send real funds.

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

## Two ways to run

- **Local (stdio)** — the npm package below. You run it on your machine with **your own keys**; it can
  settle **autonomously** (SIWE login + on-chain signing with `HASHLOCK_*_KEY`). Full trust in yourself.
- **Remote (hosted, Streamable HTTP)** — a public URL (`https://dev.hashlock.markets/mcp`) anyone can add
  from Claude / ChatGPT / any MCP client; one-click OAuth, no install. Multi-tenant, so it is strictly
  **non-custodial**: settlement returns **unsigned** transactions you sign with your own wallet, and the
  server never holds keys or your swap preimage. See [Remote (hosted)](#remote-hosted) below.

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
        "HASHLOCK_BTC_KEY": "<agent BTC WIF, signet (optional)>",
        "HASHLOCK_SOLANA_KEY": "<agent Solana key, base58, devnet (optional)>"
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
| `HASHLOCK_SOLANA_KEY` | Solana | — signing only, see below |
| `HASHLOCK_TOKEN` | — | a ready JWT (alternative to a key) |

`HASHLOCK_SOLANA_KEY` is base58 — the 64-byte export a wallet gives you, or a bare 32-byte seed. It does
not mint the session; set it alongside whichever key does. It IS used to prove ownership of the wallet
(a signed, nonce-bearing message to `/me/link-solana`) the first time the agent posts an order, because
an order whose give leg is Solana is refused without it. If the account is already linked to a different
Solana wallet, that link is left alone and the order fails with both addresses named. Solana is also the one chain whose
transactions this package does not build: the escrow's ADDRESS is a hash of the agreed terms, so the
server composes each one and the agent signs the bytes it is handed. Set the agent's Solana address — `whoami` returns it as
`localSigners.addresses.solana` — as its settlement address with `set_settlement_address` before funding.

With none set, read-only tools (`list_assets`, `list_open_rfqs`, `get_rfq`) still work. Use dedicated **testnet** keys.

Other env: `HASHLOCK_API_URL` (default `https://dev.hashlock.markets/api`), `HASHLOCK_APP_URL` (share links; default derived), `HASHLOCK_EVM_RPC` (default a public Sepolia RPC), `HASHLOCK_TRON_HOST` (default Nile), `HASHLOCK_SECRETS_PATH` (default `~/.hashlock/mcp-secrets.json`, mode 0600).

## Remote (hosted)

The same server also runs as a **remote MCP over Streamable HTTP** so anyone can connect by URL — no
install. This is the multi-tenant, **non-custodial** surface: browse, RFQ, negotiate, and get **unsigned**
fund/claim/refund transactions you sign with your own wallet (there is no autonomous key-in-env signing
and no server-side secret storage here — you supply your own `hashlock` and keep your own preimage).

**Connect from a client:** add the server URL. Nothing else — the client discovers that it needs
authorization, sends you to Hashlock to sign in and approve, and receives its own key:

```
URL: https://dev.hashlock.markets/mcp
```

The grant then appears under [Developers](https://dev.hashlock.markets/developers) as an ordinary API key
and can be revoked there at any time. Clients that do not speak OAuth can still send a key they created
themselves as `Authorization: Bearer hk_…`.

<details><summary>How the OAuth flow works</summary>

Standard OAuth 2.1, so any compliant MCP client drives it unattended:

| Step | Endpoint |
|---|---|
| Unauthorized call names its metadata | `401` + `WWW-Authenticate: … resource_metadata=…` (RFC 9728) |
| Client reads the resource + server metadata | `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` (RFC 8414) |
| Client registers itself | `POST /oauth/register` (RFC 7591) |
| You sign in and approve, in the browser | `/oauth/authorize` |
| Client redeems the code for a key | `POST /oauth/token` — PKCE `S256` required (RFC 7636) |

Codes are single-use and expire in 60 seconds; redirect URIs are allowlisted, with loopback permitted per
RFC 8252. The issued token IS the API key, so a grant is revocable from the same list as every other key.

</details>

> **Testnets only** until the hardening gate.

**Run the hosted service yourself:**

```bash
docker build -t hashlock-mcp-http .
docker run -p 8080:8080 -e HASHLOCK_V1_URL=https://api-dev.hashlock.markets/v1 hashlock-mcp-http
# or, from source:
pnpm build && HASHLOCK_V1_URL=https://api-dev.hashlock.markets/v1 PORT=8080 pnpm start:http
```

Env: `HASHLOCK_V1_URL` (developer-API base, default `https://api.hashlock.markets/v1`) · `PORT` (default
`8080`). Put it behind your reverse proxy at `/mcp`; `GET /health` is a liveness probe.

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
