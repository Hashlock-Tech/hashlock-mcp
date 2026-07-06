# Hashlock MCP — Installation Guide for AI Agents

## What is this?

The MCP server for **Hashlock Markets** — non-custodial cross-chain OTC trading with HTLC atomic settlement (both legs settle or both refund). You can browse the RFQ board, post requests, negotiate prices and track settlement across Bitcoin, Ethereum and TRON.

> ⚠️ **Testnets only** (Ethereum Sepolia · TRON Nile · Bitcoin signet). Do not use real funds or mainnet keys.

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
        "HASHLOCK_EVM_KEY": "0x<dedicated testnet private key>"
      }
    }
  }
}
```

The server logs in autonomously via SIWE with that key (nonce → sign → JWT, refreshed on expiry). Alternatively set `HASHLOCK_TOKEN` to a ready JWT. With neither, read-only tools still work.

### Option 2: Global install

```bash
npm install -g @hashlock-tech/mcp
```

Then use `"command": "hashlock-mcp"` in the config instead of npx.

## First steps

1. `list_assets` — see what's tradeable and the `SYMBOL@chain` refs.
2. `list_open_rfqs` — browse the board; `respond_to_rfq` with your price.
3. Or `create_rfq` — post your own request (public), or a private fixed-price order (returns a shareable link).
4. `negotiate` — counter, accept or decline in the deal thread; when BOTH parties accept, the HTLC swap is created.
5. `deal_status` + `set_settlement_address` — track settlement and set your receive/refund addresses.
6. Funding/claiming is signed with your own wallet. If you are the initiator, the swap secret was generated locally — `get_deal_secret` retrieves it; report your claim with `reveal_claim`.

## Notes for agents

- Amounts are human decimal strings ("0.5"); prices are the TOTAL quote amount, not per-unit.
- Errors come back as `{ error: { code, is_retryable, recovery_hint } }` — branch on `is_retryable`.
- Creating an RFQ requires the account to own a wallet for the asset you GIVE (the EVM key you authenticate with covers EVM assets).
