import { describe, it, expect } from 'vitest';
import { okContent } from '../lib/result.js';

describe('okContent', () => {
  it('wraps a value as pretty JSON MCP text content', () => {
    const out = okContent({ a: 1 });
    expect(out).toEqual({ content: [{ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) }] });
  });
});
