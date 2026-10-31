/**
 * @fileoverview Regression coverage for lifecycle-log DOM rendering.
 * Port: N/A (JSDOM exercises the real settings-ui.js renderer).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const SETTINGS_UI = readFileSync(new URL('../src/web/public/settings-ui.js', import.meta.url), 'utf8');

interface LifecycleApp {
  loadLifecycleLog(): Promise<void>;
}

function boot(entries: Record<string, unknown>[]) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <select id="lifecycleFilterEvent"><option value=""></option></select>
      <input id="lifecycleFilterSession" value="">
      <table><tbody id="lifecycleTableBody"></tbody></table>
      <div id="lifecycleEmpty"></div>
    </body></html>`,
    { runScripts: 'outside-only', url: 'http://localhost/' }
  );
  const win = dom.window as unknown as Window &
    typeof globalThis & {
      __CodemanApp: new () => LifecycleApp;
      fetch: ReturnType<typeof vi.fn>;
    };

  win.fetch = vi.fn(async () => ({
    json: async () => ({ success: true, data: { entries } }),
  }));
  (win as unknown as { eval: (source: string) => void }).eval(
    `class CodemanApp { getShortId(id) { return id.slice(0, 8); } }
${SETTINGS_UI}
window.__CodemanApp = CodemanApp;`
  );

  return { dom, app: Object.create(win.__CodemanApp.prototype) as LifecycleApp };
}

describe('lifecycle log rendering', () => {
  it('renders persisted lifecycle fields as text instead of executable markup', async () => {
    const payload = `<img src=x onerror="document.body.dataset.xss='executed'">`;
    const sessionId = `session-"><svg id="session-id-xss" onload="alert(1)"></svg>`;
    const reason = `<script>document.body.dataset.xss='reason'</script>`;
    const mode = `<iframe srcdoc="<script>alert(1)</script>"></iframe>`;
    const { dom, app } = boot([
      {
        ts: Date.now(),
        event: 'exit',
        sessionId,
        name: payload,
        reason,
        mode,
        exitCode: 1,
      },
    ]);

    await app.loadLifecycleLog();

    const cells = dom.window.document.querySelectorAll('#lifecycleTableBody td');
    expect(cells[2]?.textContent).toBe(payload);
    expect(cells[2]?.getAttribute('title')).toBe(sessionId);
    expect(cells[3]?.textContent).toBe(reason);
    expect(cells[4]?.textContent).toBe(`code=1, ${mode}`);
    expect(
      dom.window.document.querySelector(
        '#lifecycleTableBody img, #lifecycleTableBody svg, #lifecycleTableBody script, #lifecycleTableBody iframe'
      )
    ).toBeNull();
    expect(dom.window.document.body.dataset.xss).toBeUndefined();
    dom.window.close();
  });
});
