import { SkillsExtension } from '@modelcontextprotocol/server/ext/skills';
import { nodeSkillFiles } from '@modelcontextprotocol/server/ext/skills/node';

/** In the skill's folder for an external skills catalog (the Bankr skills PR syncs from it); not part of the skill. */
const CATALOG_ONLY = new Set(['hashlock-markets/catalog.json', 'hashlock-markets/logo.svg']);

/**
 * The skill `name` under `root` (the repo's skills/ folder, one folder per skill), as a catalog of that one skill, which
 * the hosted server serves through the Skills extension: hashlock-markets to a developer key, hashlock-chat to a chat
 * assistant's.
 * Strict: a skill the SDK would skip fails the load instead, and so does one past the 400 KB Claude accepts, and so does
 * a missing folder (strict only warns on that, and the server would advertise an empty catalog). A failed load is
 * logged to stderr and gives undefined, so the server still serves its tools; skills.test.ts loads each skill the same
 * way, so a broken skill fails the tests instead.
 */
export async function loadSkills(root: string, name: string) {
  const disk = nodeSkillFiles(root);
  try {
    const catalog = await SkillsExtension.load(
      {
        list: async (dir) => (await disk.list(dir)).filter((e) => (dir === '' ? e.name === name : !CATALOG_ONLY.has(`${dir}/${e.name}`))),
        read: (path) => disk.read(path),
      },
      { strict: true, limits: { bytes: 400 * 1024 } },
    );
    if (catalog.entries.length === 0) throw new Error(`no ${name}/SKILL.md under ${root}`);
    return catalog;
  } catch (e) {
    console.error(`[hashlock-mcp] the ${name} skill is NOT served (the tools are):`, e);
    return undefined;
  }
}
