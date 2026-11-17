import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// One package, many clients: Agent Plugins (plugin.json + mcp.json — Codex/ChatGPT, Cursor, VS Code, Devin),
// Claude Code (.claude-plugin — also read by Grok Build and, before plugin.json, OpenClaw), Gemini CLI (gemini-extension.json). A release bumps
// package.json; every manifest must follow, and all must name the same remote server and ship the skill.
const json = (p: string) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));
const pkg = json('package.json');
const URL_ = 'https://hashlock.markets/mcp';

describe('plugin manifests', () => {
  it('carry the package version', () => {
    for (const p of ['plugin.json', '.claude-plugin/plugin.json', 'gemini-extension.json']) expect(json(p).version, p).toBe(pkg.version);
  });

  it('point every client at the same hosted server', () => {
    expect(json('mcp.json').mcpServers.hashlock).toEqual({ type: 'streamable-http', url: URL_ });
    expect(json('.claude-plugin/plugin.json').mcpServers.hashlock).toEqual({ type: 'http', url: URL_ });
    expect(json('gemini-extension.json').mcpServers.hashlock).toEqual({ httpUrl: URL_ });
  });

  it('ship the skill and the icon they name', () => {
    expect(existsSync(new URL('../../skills/hashlock-markets/SKILL.md', import.meta.url))).toBe(true);
    const ui = json('plugin.json').extensions['com.openai'].interface;
    for (const f of [ui.composerIcon, ui.logo]) expect(existsSync(new URL(`../../${f}`, import.meta.url)), f).toBe(true);
  });
});
