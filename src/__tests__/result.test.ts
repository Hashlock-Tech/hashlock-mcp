import { describe, it, expect } from 'vitest';
import { okContent } from '../lib/result.js';

describe('okContent', () => {
  it('wraps a value as pretty JSON MCP text content', () => {
    const out = okContent({ a: 1 });
    expect(out).toEqual({ content: [{ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) }], structuredContent: { a: 1 } });
  });

  it('keeps an array as the JSON array in text, and as { items } in structuredContent', () => {
    const out = okContent([{ a: 1 }]);
    expect(out).toEqual({ content: [{ type: 'text', text: JSON.stringify([{ a: 1 }], null, 2) }], structuredContent: { items: [{ a: 1 }] } });
  });

  it('wraps anything else that is not an object as { value }, so structuredContent is never absent', () => {
    expect(okContent(null).structuredContent).toEqual({ value: null });
    expect(okContent('x').structuredContent).toEqual({ value: 'x' });
    expect(okContent(undefined).structuredContent).toEqual({ value: undefined });
  });
});
