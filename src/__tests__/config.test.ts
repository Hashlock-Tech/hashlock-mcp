import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

// No default API URL (owner, 2026-10-01): the dev stand is not public, so an
// install must name its deployment rather than silently reach one of them.
describe('loadConfig', () => {
  it('refuses to start without HASHLOCK_API_URL, and says what to set', () => {
    expect(() => loadConfig({})).toThrow(/HASHLOCK_API_URL is required/);
    expect(() => loadConfig({ HASHLOCK_API_URL: '  ' })).toThrow(/HASHLOCK_API_URL is required/);
  });
  it('takes the URL it is given, without a trailing slash', () => {
    expect(loadConfig({ HASHLOCK_API_URL: 'https://example.test/api/' }).apiUrl).toBe('https://example.test/api');
  });
});
