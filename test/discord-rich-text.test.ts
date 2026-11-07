import { describe, expect, it } from 'vitest';
import { sanitiseReply, splitForDiscord, MAX_REPLY_CHARS } from '../src/discord-bridge.js';

const FENCE = '```';
describe('Discord rich text input', () => {
  it.each([
    '**Heading**\n\n- first\n- second',
    '\n\n    indented code\n\tline two\n\n',
    FENCE + 'yaml\nservices:\n  app:\n    image: example\n' + FENCE,
    '> quoted text\n\n[link](https://example.com) and _emphasis_',
    'hello 🧠\nこんにちは\nمرحبا',
  ])('preserves formatting and original logical line breaks: %s', (text) => {
    expect(sanitiseReply(text)).toBe(text + '\r');
  });
  it('normalizes carriage returns without turning them into multiple Enter keys', () => {
    const result = sanitiseReply('one\r\ntwo\rthree');
    expect(result).toBe('one\ntwo\nthree\r');
    expect(result!.match(/\r/g)).toHaveLength(1);
  });
  it('removes ANSI styles, OSC clipboard/link escapes and paste controls', () => {
    expect(sanitiseReply('\x1b[31mred\x1b[0m\n\x1b]52;c;evil\x07safe')).toBe('red\nsafe\r');
    expect(sanitiseReply('\x1b]8;;https://example.com\x1b\\label\x1b]8;;\x1b\\')).toBe('label\r');
    expect(sanitiseReply('\x1b[200~hello\x1b[201~\x00\x08\x7f')).toBe('hello\r');
  });
  it('retains messages beyond the old cutoff and refuses oversized input', () => {
    const text = 'x'.repeat(MAX_REPLY_CHARS);
    expect(sanitiseReply(text)).toBe(text + '\r');
    expect(sanitiseReply(text + 'x')).toBeNull();
  });
  it('preserves text while appending attachment metadata and ignores blank replies', () => {
    expect(sanitiseReply('one\n\ntwo', ['/tmp/file.png'])).toBe('one\n\ntwo [attached: /tmp/file.png]\r');
    expect(sanitiseReply(' \n\t ')).toBeNull();
    expect(sanitiseReply('', ['/tmp/file.png'])).toBe('[attached: /tmp/file.png]\r');
  });
});
describe('Discord rendered output chunks', () => {
  it('retains language hints and closes every chunk of a code block', () => {
    const text = [
      FENCE + 'typescript',
      ...Array.from({ length: 80 }, (_, i) => 'const value' + i + ' = ' + i + ';'),
      FENCE,
    ].join('\n');
    const parts = splitForDiscord(text, 256, 32);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.startsWith(FENCE + 'typescript\n')).toBe(true);
      expect(part.endsWith(FENCE)).toBe(true);
      expect(part.length).toBeLessThanOrEqual(256);
    }
    for (let i = 0; i < 80; i++) expect(parts.join('\n')).toContain('const value' + i + ' = ' + i + ';');
  });
  it('does not break surrogate pairs on a long Unicode line', () => {
    const text = '🧠'.repeat(500);
    const parts = splitForDiscord(text, 256, 32);
    expect(parts.join('').replaceAll('\n', '')).toBe(text);
    for (const part of parts) expect(part.isWellFormed()).toBe(true);
  });
  it('keeps overflow notices outside closed code fences and within the requested size', () => {
    const parts = splitForDiscord(FENCE + 'json\n' + 'x'.repeat(10000), 256, 2);
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p.length <= 256)).toBe(true);
    expect(parts[1]).toContain(FENCE + '\n*(The message continues');
  });
  it('refuses limits that could make chunking loop or exhaust memory', () => {
    expect(() => splitForDiscord('x', 0)).toThrow(RangeError);
    expect(() => splitForDiscord('x', 1900, 100000)).toThrow(RangeError);
  });
});
