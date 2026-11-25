import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadSkills } from '../lib/skills.js';

/** A skills/ folder holding hashlock-markets with these files. */
const skillsDir = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'skills-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, 'hashlock-markets', path)), { recursive: true });
    writeFileSync(join(root, 'hashlock-markets', path), text);
  }
  return root;
};
const skillMd = (description: string) => `---\nname: hashlock-markets\ndescription: ${description}\n---\n\nBody.\n`;
const files = (catalog: NonNullable<Awaited<ReturnType<typeof loadSkills>>>) => {
  const resources = catalog.entries[0]!.resources;
  if (resources === 'dynamic') throw new Error('a folder skill lists its files');
  return resources.map((r) => r.uri.replace('skill://hashlock-markets/', ''));
};

describe('loadSkills', () => {
  it.each(['hashlock-markets', 'hashlock-chat'])("loads the package's %s skill strictly, and only it: a skill the SDK would skip or warn about fails here", async (name) => {
    const catalog = await loadSkills(fileURLToPath(new URL('../../skills', import.meta.url)), name);
    expect(catalog?.entries.map((s) => s.frontmatter.name)).toEqual([name]);
  });

  it('serves no skill, and says so on stderr, when the load fails: the server keeps its tools', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await loadSkills(skillsDir({ 'SKILL.md': skillMd('x'.repeat(1025)) }), 'hashlock-markets')).toBeUndefined();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT served'), expect.anything());
    } finally {
      error.mockRestore();
    }
  });

  it('serves no skill, and says so on stderr, when its folder holds no SKILL.md or is missing: no empty catalog is advertised', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await loadSkills(skillsDir({ 'references/notes.md': 'Notes.' }), 'hashlock-markets')).toBeUndefined();
      expect(await loadSkills(skillsDir({ 'SKILL.md': skillMd('A skill.') }), 'hashlock-chat')).toBeUndefined();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT served'), expect.anything());
    } finally {
      error.mockRestore();
    }
  });

  it("leaves out the skill root's catalog.json and logo.svg only", async () => {
    const root = skillsDir({ 'SKILL.md': skillMd('A skill.'), 'catalog.json': '{}', 'logo.svg': '<svg/>', 'references/catalog.json': '{}' });
    expect(files((await loadSkills(root, 'hashlock-markets'))!)).toEqual(['SKILL.md', 'references/catalog.json']);
  });
});
