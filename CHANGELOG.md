# Changelog

## [0.1.3] - 2026-04-11

### Added
- **Agent-layer tool params (experimental)** — three existing tools
  now accept the principal / attestation / agent instance fields
  propagated from `@hashlock-tech/sdk@^0.1.3`:
  - `create_rfq`: `minCounterpartyTier`, `hideIdentity`,
    `attestation`, `agentInstance`
  - `respond_rfq`: `hideIdentity`, `attestation`, `agentInstance`
  - `create_htlc`: `attestation`, `agentInstance`
- Shared zod schemas for `KycTier`, `PrincipalAttestation`, and
  `AgentInstance` are defined at the top of `src/index.ts` and
  reused across all three tools with EXPERIMENTAL descriptions.

### Changed
- Bumped `@hashlock-tech/sdk` dep from `^0.1.0` to `^0.1.3`.
  When `@hashlock-tech/sdk@0.1.4+` is installed, the SDK will
  emit a one-time console warning when any experimental field is
  set, reminding callers that GraphQL wire-through to the Cayman
  backend is not yet implemented.

### Fixed
- CI lint step (`tsc --noEmit`) was failing pre-existing because
  `tsconfig.json` omitted `DOM` from `lib` and `node` from
  `types`, and `**/*.test.ts` was not excluded from lint. All
  three are fixed; the lint step is now green. `@types/node` is
  added as a devDependency.

### Tests
- 4 new tests exercising the agent-layer pass-through for
  `create_rfq`, `respond_rfq`, `create_htlc`, plus a backward
  compat test verifying human flows without attestation still
  work and do not leak undefined fields to the GraphQL variables.
- All 19 tests pass.

### Not yet included
- GraphQL wire-through to the Cayman backend. The tools accept
  and pass through the agent-layer fields to the SDK, but the
  SDK currently drops them at the network layer. When the
  Cayman backend lands `PrincipalAttestationInput` and
  `AgentInstanceInput` in its GraphQL schema, a patch release
  of the SDK will wire them through automatically and the
  experimental warning will go away.

## [0.1.2] - 2026-04-09

### Added
- Registered on MCP Registry with `mcpName` field
  (`io.github.BarisSozen/hashlock-mcp`)

## [0.1.1] - 2026-04-09

### Fixed
- Use `/api/graphql` endpoint to bypass CSRF protection

## [0.1.0] - 2026-04-09

### Added
- Initial release
- Tools: create_htlc, withdraw_htlc, refund_htlc, get_htlc, create_rfq, respond_rfq
- Zod input validation for all tools
- stdio transport for Claude Desktop / Claude Code
- llms-install.md for agent auto-discovery
