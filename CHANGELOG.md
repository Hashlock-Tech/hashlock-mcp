# Changelog

## [1.0.0-rc.2] - 2026-07-07

### Added — full multi-chain autonomy
- **Autonomous login on all three chains**: `HASHLOCK_TRON_KEY` (signMessageV2) and `HASHLOCK_BTC_KEY`
  (BIP-322 via bip322-js) alongside `HASHLOCK_EVM_KEY` (SIWE). The first configured key mints the
  session; each also signs settlement on its chain. Live-verified TRON + BTC login against dev.
- **On-chain settlement tools** `fund_leg` and `claim_leg`: the agent funds its side and claims its
  receive leg with its own keys — EVM (viem: approve + HTLCFactory.createSwap / clone.claim), TRON
  (TronWeb: SharedHTLC.fund/claim), BTC (bitcoinjs-lib: pay P2WSH / claim with witness
  [sig, preimage, 0x01, redeemScript] via Esplora). Chain params come from GET /config; RPC/host from env.
- **Config-driven URLs**: `HASHLOCK_APP_URL` (share links), `HASHLOCK_EVM_RPC`, `HASHLOCK_TRON_HOST` —
  no hardcoded dev domain.


## [1.0.0-rc.1] - 2026-07-06

### Changed — ground-up rebuild against the new Hashlock Markets platform
- **New backend**: targets the rebuilt REST API (`https://dev.hashlock.markets/api`) instead of the old GraphQL gateway. **TESTNETS ONLY** (Ethereum Sepolia, TRON Nile, Bitcoin signet) until the security-hardening gate — the previous "live on mainnet" claims no longer apply.
- **New tool surface (14)** matching the real OTC flow: `list_assets`, `list_open_rfqs`, `get_rfq`, `create_rfq` (public RFQ / private fixed-price order with share link), `cancel_rfq`, `respond_to_rfq`, `negotiate` (message/propose/accept_proposal/accept/reject), `my_rfqs`, `my_deals`, `deal_status`, `set_settlement_address`, `get_deal_secret`, `reveal_claim`, `whoami`.
- **Autonomous-agent auth**: `HASHLOCK_EVM_KEY` — the server performs the SIWE login itself (nonce → local sign → JWT; auto re-login on expiry). `HASHLOCK_TOKEN` (ready JWT) still supported; read-only tools work unauthenticated.
- **Local swap secrets**: on `negotiate(accept)` the preimage is generated locally (`~/.hashlock/mcp-secrets.json`, 0600) and only its sha256 hashlock is sent — the API never sees the secret.
- Amounts are human decimal strings, converted exactly (bigint) via the asset registry; assets referenced as `SYMBOL@chain`.

### Removed
- Sui and compute-capacity tools (out of scope of the rebuilt platform), the GraphQL client and `@hashlock-tech/sdk` dependency.


## [0.4.1] - 2026-06-20

### Fixed
- **Agent-discovery docs synced to source of truth** (`server.json` + `src/index.ts`):
  - `llms-install.md`: corrected package name `@hashlock/mcp` → `@hashlock-tech/mcp`, replaced the dead `http://142.93.106.129/graphql` endpoint with the production default `https://hashlock.markets/graphql`, rewrote **Available Tools** to the real 15-tool surface, and aligned auth (SIWE 7-day JWT) + supported assets/pairs with `server.json`.
  - `smithery.yaml`: replaced the stale "6 tools" list with the real 15, and fixed `HASHLOCK_ENDPOINT` default `…/api/graphql` → `…/graphql` (the `/api/graphql` SSR proxy ignores the `Authorization` header and 401s external MCP clients).
  - `README.md`: expanded the tool table to all 15 tools, fixed the "(6 tools)" claim, scoped the three-chain note to the HTLC tools, and corrected the `HASHLOCK_ENDPOINT` default to `…/graphql`.

## [0.1.0] - 2026-04-09

### Added
- Initial release
- Tools: create_htlc, withdraw_htlc, refund_htlc, get_htlc, create_rfq, respond_rfq
- Zod input validation for all tools
- stdio transport for Claude Desktop / Claude Code
- llms-install.md for agent auto-discovery
