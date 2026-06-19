# Changelog

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
