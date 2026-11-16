/**
 * @fileoverview The manifest link must be fetched with credentials. Browsers fetch the web app
 * manifest without cookies unless the link says `crossorigin="use-credentials"`, and every
 * non-exempt path needs the `codeman_session` cookie when a password is set, so without the
 * attribute the manifest answers 401 and the browser refuses to install Codeman as an app.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf-8');

describe('PWA manifest link', () => {
  it('requests the manifest with credentials so a password-protected install can be installed', () => {
    const links = HTML.match(/<link\b[^>]*rel="manifest"[^>]*>/g) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('crossorigin="use-credentials"');
  });
});
