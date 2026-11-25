import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpApp } from './server.js';

// The SDK's own client against the hosted app in process. The API is never called: nothing here runs a tool.
const app = createHttpApp({ v1Url: 'http://127.0.0.1:9/v1' });
const skillFile = (path: string) => readFileSync(new URL(`../../skills/hashlock-markets/${path}`, import.meta.url));
const sha256 = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect(options: ConstructorParameters<typeof Client>[1], key = 'hk_live_test') {
  const client = new Client({ name: 'test', version: '0' }, options);
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
      fetch: (url, init) => app.request(String(url), init),
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}
const modern = (key?: string) => connect({ versionNegotiation: { mode: { pin: '2026-07-28' } } }, key);

describe('a 2026-07-28 client', () => {
  it('lists the hashlock-markets skill with a sha256 digest of each of its files, and only those files', async () => {
    const client = await modern();
    expect(client.getProtocolEra()).toBe('modern');
    const { skills } = await new SkillsClient(client).list();
    expect(skills.map((s) => s.frontmatter.name)).toEqual(['hashlock-markets']);
    const files = skills[0]!.resources;
    if (files === 'dynamic') throw new Error('a folder skill lists its files');
    expect(files.map((f) => [f.uri, f.digest])).toEqual(
      ['SKILL.md', 'references/bankr.md'].map((p) => [`skill://hashlock-markets/${p}`, sha256(skillFile(p))]),
    );
    // What Claude loads from a server: at most 100 KB a file.
    for (const f of files) expect(f.size, f.uri).toBeLessThanOrEqual(100 * 1024);
  });

  it("reads the skill's SKILL.md as the file's bytes", async () => {
    const client = await modern();
    const { contents } = await client.readResource({ uri: 'skill://hashlock-markets/SKILL.md' });
    expect(contents).toHaveLength(1);
    expect((contents[0] as { text: string }).text).toBe(skillFile('SKILL.md').toString('utf8'));
  });

  // The skill is written for a developer key's tools and has the agent make its own swap secret: a chat assistant has
  // neither the settlement tools nor the right to make a secret.
  it('gets no skill, and no resources, with an OAuth (chat assistant) key', async () => {
    const client = await modern('hk_oa_live_test');
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.resources).toBeUndefined();
    expect(Object.keys(capabilities?.extensions ?? {})).toEqual([]);
    expect((await new SkillsClient(client).list()).skills).toEqual([]);
    await expect(client.readResource({ uri: 'skill://hashlock-markets/SKILL.md' })).rejects.toThrow();
  });

  it('lists the tools', async () => {
    const { tools } = await (await modern()).listTools();
    expect(tools).toHaveLength(26);
    expect(tools.map((t) => t.name)).toContain('broadcast_tx');
  });
});

describe.each(['2025-06-18', '2025-11-25'])('a %s client', (version) => {
  it('still initializes and lists the tools', async () => {
    const client = await connect({ supportedProtocolVersions: [version] });
    expect(client.getProtocolEra()).toBe('legacy');
    expect(client.getNegotiatedProtocolVersion()).toBe(version);
    expect(client.getInstructions()).toContain('broadcast_tx');
    expect((await client.listTools()).tools).toHaveLength(26);
  });
});
