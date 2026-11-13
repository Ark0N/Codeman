/**
 * @fileoverview The Codeman Desktop connect page (packages/desktop/assets/connect.html), driven in
 * a real browser through every state of both tabs.
 *
 * The page is the app's whole interface before Codeman's own UI loads. It asks the native side for
 * things with `window.ipc.postMessage(JSON)` and hears back through
 * `window.__codemanDesktop.onNative(msg)`: here a stub records the first and the test plays the
 * second. The page is served with the Content-Security-Policy the app serves it with, read out of
 * packages/desktop/src/assets.rs, so a script that policy would block fails here as it would in the
 * app.
 *
 * Chromium stands in for the app's WKWebView, so what this pins is the page's own logic and layout,
 * not WebKit's rendering. The Rust side of the same messages is pinned by the unit tests in
 * packages/desktop/src (policy.rs), which do not build on Linux CI.
 *
 * Each test is one long, ordered walk through the page (a later step builds on the state the
 * earlier ones left), so a walk collects every check that fails and reports them together.
 *
 * Browser-driven, so excluded from `npm test` (config/test-suites.ts). Run locally:
 *   npm run test:browser -- test/desktop-connect-page.browser.test.ts
 *
 * Port: N/A (the page is served by request interception; nothing listens).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const PKG = resolve(import.meta.dirname, '../packages/desktop');
const html = readFileSync(resolve(PKG, 'assets/connect.html'), 'utf8');
const icon = readFileSync(resolve(PKG, 'assets/icon.png'));
const assetsRs = readFileSync(resolve(PKG, 'src/assets.rs'), 'utf8');
// The connect page's real CSP (assets::CSP), so a check that needs eval or an outside resource
// fails here as it would in the app. Only img-src also admits the test origin, since the icon
// comes from http://app.test here, not codemanapp:.
const CSP = /const CSP: &str = "([^"]*)";/.exec(assetsRs)![1];
const CSP_HERE = CSP.replace('img-src codemanapp:', 'img-src codemanapp: http://app.test');
const WEBKIT_NOTICE =
  'Codeman needs a newer WebKit than this Mac has: macOS 13.3 or later, or Safari 16.4 or later on macOS 11 and 12.';

// The native side as the page sees it: `ipc.postMessage` records what the page asks for.
const IPC_STUB = `window.__posted = []; Object.defineProperty(window, 'ipc', { value: Object.freeze({ postMessage: function (s) { window.__posted.push(JSON.parse(s)); } }) });`;

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    __posted: any[];
    __codemanDesktop: { onNative(msg: unknown): void };
    __codemanStaticBlocks?: boolean;
    ipc: { postMessage(message: string): void };
  }
}

/** The checks of the walk under way that did not hold, as `name -> what was seen`. */
const failed: string[] = [];
function check(name: string, cond: unknown, extra?: unknown) {
  if (!cond) failed.push(extra === undefined ? name : `${name} -> ${JSON.stringify(extra)}`);
}

// Serves the connect page under its real CSP; `body` replaces the page for one test.
async function serveConnect(page: Page, body?: string) {
  await page.route('http://app.test/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/icon.png') return route.fulfill({ body: icon, contentType: 'image/png' });
    return route.fulfill({
      body: body || html,
      contentType: 'text/html',
      headers: { 'Content-Security-Policy': CSP_HERE },
    });
  });
}

async function everyState(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  const cspViolations = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text());
  });
  await serveConnect(page);
  await page.addInitScript(IPC_STUB);
  const posted = () => page.evaluate(() => window.__posted.filter((m) => m.cmd !== 'localStatus'));
  const native = (msg) => page.evaluate((m) => window.__codemanDesktop.onNative(m), msg);
  const visible = (sel) => page.locator(sel).isVisible();
  const remoteTab = () => page.click('#tab-remote');

  // 1. First run: no servers.
  await page.goto('http://app.test/index.html');
  check('connect page posts ready on load', JSON.stringify(await posted()) === '[{"cmd":"ready"}]', await posted());
  await native({ type: 'init', servers: [], autoConnect: true, startFullscreen: false, version: '0.1.0' });
  check(
    'first run opens the This Mac tab and asks about this Mac',
    (await visible('#pane-local')) &&
      !(await visible('#form')) &&
      (await page.evaluate(() => window.__posted.some((m) => m.cmd === 'localStatus' && m.quick === false)))
  );
  check('first run does not auto-connect', (await posted()).length === 1);
  check('version shown in footer', (await page.textContent('#version')).includes('0.1.0'));
  // The static-block probe passes under the real CSP (no eval needed).
  check(
    'page is served with the real CSP (no unsafe-eval)',
    /script-src 'unsafe-inline';/.test(CSP) && !CSP.includes('unsafe-eval'),
    CSP
  );
  // In a later task: code running inside page.evaluate may use eval whatever the
  // CSP says (CDP's allowUnsafeEvalBlockedByCSP), a timer callback may not.
  const evalResult = await page.evaluate(
    () =>
      new Promise((resolve) =>
        setTimeout(() => {
          try {
            new Function('return 1');
            resolve('allowed');
          } catch (e) {
            resolve(e.name);
          }
        }, 0)
      )
  );
  check('the real CSP blocks new Function, so the probe cannot use it', evalResult === 'EvalError', evalResult);
  check(
    'a WebKit with static blocks: no notice, Connect enabled',
    !(await visible('#webkit')) &&
      !(await page.isDisabled('#connect')) &&
      (await page.evaluate(() => window.__codemanStaticBlocks)) === true
  );
  check(
    'the icon loads under the CSP',
    await page.evaluate(() => {
      const i = document.querySelector('header img');
      return i.complete && i.naturalWidth > 0;
    })
  );

  // 2. Returning user with auto-connect.
  await page.goto('http://app.test/index.html');
  await native({
    type: 'init',
    servers: [
      { url: 'http://127.0.0.1:3000/' },
      { url: 'https://box.tail.ts.net/', username: 'admin', hasSavedPassword: true },
    ],
    autoConnect: true,
    startFullscreen: true,
    version: '0.1.0',
  });
  let p = await posted();
  check(
    'auto-connect posts connect for the last server',
    p[1] && p[1].cmd === 'connect' && p[1].url === 'http://127.0.0.1:3000/' && !('password' in p[1]),
    p
  );
  check(
    'busy state: connect disabled, cancel shown',
    (await page.isDisabled('#connect')) && (await visible('#cancel'))
  );
  check('recent chips rendered', (await page.locator('.chip').count()) === 2);
  check('full screen checkbox reflects init', await page.isChecked('#fullscreen'));

  // 3. Manual mode (Switch Server) never auto-connects.
  await page.goto('http://app.test/index.html?manual=1');
  await native({ type: 'init', servers: [{ url: 'http://127.0.0.1:3000/' }], autoConnect: true, version: '0.1.0' });
  check('manual=1 suppresses auto-connect', (await posted()).length === 1, await posted());

  // 4. Needs login -> login fields, then a typed password goes out.
  await native({
    type: 'probeResult',
    url: 'http://127.0.0.1:3000/',
    outcome: { kind: 'needsLogin' },
    canStart: false,
  });
  check('needsLogin reveals the login fields', await visible('#login'));
  check('username defaults to admin', (await page.inputValue('#username')) === 'admin');
  check('needsLogin message shown', (await page.textContent('#status')).includes('asks for a login'));
  await page.fill('#password', 's3cret');
  await page.click('#connect');
  p = await posted();
  const last = p[p.length - 1];
  check(
    'submit sends username + password + remember',
    last.cmd === 'connect' && last.username === 'admin' && last.password === 's3cret' && last.remember === true,
    last
  );
  await native({
    type: 'probeResult',
    url: 'http://127.0.0.1:3000/',
    outcome: { kind: 'badCredentials' },
    canStart: false,
  });
  check('badCredentials message shown', (await page.textContent('#status')).includes('Wrong username or password'));

  // 5. Nothing listening on loopback -> Start button -> startServer -> reconnect.
  await native({ type: 'probeResult', url: 'http://127.0.0.1:3000/', outcome: { kind: 'refused' }, canStart: true });
  check('refused + canStart shows the Start button', await visible('#start'));
  check('refused + canStart explains', (await page.textContent('#status')).includes('not running on this Mac'));
  await page.click('#start');
  p = await posted();
  check(
    'Start posts startServer with the URL',
    p[p.length - 1].cmd === 'startServer' && p[p.length - 1].url === 'http://127.0.0.1:3000/',
    p[p.length - 1]
  );
  await native({ type: 'serverStarting' });
  check('starting hides Start and shows the spinner', !(await visible('#start')) && (await visible('#spinner')));
  const before = (await posted()).length;
  await native({
    type: 'serverStartResult',
    ok: true,
    output: 'Codeman started (pid 123)',
    url: 'http://127.0.0.1:3000/',
  });
  p = await posted();
  check(
    'server started -> connects again',
    p.length === before + 1 && p[p.length - 1].cmd === 'connect',
    p.slice(before)
  );
  await native({ type: 'probeResult', url: 'http://10.0.0.2:3000/', outcome: { kind: 'refused' }, canStart: false });
  check('refused without canStart hides the Start button', !(await visible('#start')));

  // 6. Other outcomes are explained, and server text is never HTML.
  await native({
    type: 'probeResult',
    url: 'https://127.0.0.1:3000/',
    outcome: { kind: 'tlsUntrusted', detail: 'UnknownIssuer' },
    canStart: false,
  });
  const tls = await page.textContent('#status');
  check(
    'tlsUntrusted explains the self-signed case',
    tls.includes('not trusted') && tls.includes('self-signed') && tls.includes('UnknownIssuer')
  );
  // findings2 contested [con1]: Keychain trust can only help at the names the certificate carries.
  check(
    'tlsUntrusted at 127.0.0.1: Keychain advice, hedged, and http://127.0.0.1',
    tls.includes('Keychain Access may also work') &&
      tls.includes('http://127.0.0.1:PORT') &&
      !tls.includes('tailscale serve'),
    tls
  );
  await native({
    type: 'probeResult',
    url: 'https://localhost:3000/',
    outcome: { kind: 'tlsUntrusted' },
    canStart: false,
  });
  let tls2 = await page.textContent('#status');
  check('tlsUntrusted at localhost: Keychain advice too', tls2.includes('Keychain Access may also work'), tls2);
  for (const u of [
    'https://192.168.1.20:3000/',
    'https://studio.local:3000/',
    'https://box.tail.ts.net/',
    'https://[::1]:3000/',
    'https://127.0.0.1.nip.io:3000/',
  ]) {
    await native({
      type: 'probeResult',
      url: u,
      outcome: { kind: 'tlsUntrusted', detail: 'NotValidForName' },
      canStart: false,
    });
    tls2 = await page.textContent('#status');
    check(
      `tlsUntrusted at ${u}: no Keychain advice; tailscale serve, a reverse proxy, http://127.0.0.1 for this Mac`,
      !tls2.includes('Keychain') &&
        tls2.includes('tailscale serve') &&
        tls2.includes('reverse proxy with a real certificate') &&
        tls2.includes('http://127.0.0.1:PORT') &&
        tls2.includes('names only localhost and 127.0.0.1') &&
        tls2.includes('NotValidForName'),
      tls2
    );
  }
  await native({
    type: 'probeResult',
    url: 'http://h/',
    outcome: { kind: 'notCodeman', status: 404 },
    canStart: false,
  });
  check('notCodeman shows the status', (await page.textContent('#status')).includes('HTTP 404'));
  await native({ type: 'serverStartResult', ok: false, output: '<img src=x onerror="window.__xss=1">' });
  check(
    'server output is rendered as text, not HTML',
    (await page.evaluate(() => window.__xss)) === undefined && (await page.textContent('#status')).includes('<img')
  );
  await native({ type: 'probeResult', url: 'http://h/', outcome: { kind: 'hostNotAllowed' }, canStart: false });
  check(
    'hostNotAllowed names CODEMAN_ALLOWED_HOSTS',
    (await page.textContent('#status')).includes('CODEMAN_ALLOWED_HOSTS')
  );

  // 7. Preferences, forget, cancel, external links.
  await native({
    type: 'init',
    servers: [{ url: 'http://127.0.0.1:3000/' }],
    autoConnect: false,
    startFullscreen: false,
    version: '0.1.0',
  });
  await remoteTab();
  await page.click('#fullscreen');
  await page.click('#auto');
  await page.click('.chip button.x');
  await page.click('#docs');
  p = (await posted()).slice(-4);
  check('full screen pref posted', p[0].cmd === 'setStartFullscreen' && p[0].value === true, p[0]);
  check('auto-connect pref posted', p[1].cmd === 'setAutoConnect' && p[1].value === true, p[1]);
  check('forget posted', p[2].cmd === 'forget' && p[2].url === 'http://127.0.0.1:3000/', p[2]);
  check(
    'help link goes out through the app',
    p[3].cmd === 'openExternal' && p[3].url.startsWith('https://github.com/Ark0N/Codeman'),
    p[3]
  );

  // 8. One request at a time: a double click on a recent server sends one probe.
  await page.goto('http://app.test/index.html?manual=1');
  await native({
    type: 'init',
    servers: [{ url: 'http://127.0.0.1:3000/' }, { url: 'http://10.0.0.5:3000/' }],
    autoConnect: false,
    startFullscreen: false,
    version: '0.1.0',
  });
  await remoteTab();
  let n0 = (await posted()).length;
  await page.dblclick('.chip button:not(.x) >> nth=1');
  p = (await posted()).slice(n0);
  check(
    'chip double-click posts one connect',
    p.length === 1 && p[0].cmd === 'connect' && p[0].url === 'http://10.0.0.5:3000/',
    p
  );
  check(
    'chips are disabled while busy',
    await page.evaluate(() => Array.from(document.querySelectorAll('#recent button')).every((b) => b.disabled))
  );
  n0 = (await posted()).length;
  await page.evaluate(() => {
    const b = document.querySelector('.chip button');
    b.disabled = false;
    b.click();
    document.getElementById('form').requestSubmit();
  });
  check(
    'chip click and submit are refused while busy, even when re-enabled',
    (await posted()).length === n0,
    (await posted()).slice(n0)
  );
  await native({ type: 'servers', servers: [{ url: 'http://127.0.0.1:3000/' }] });
  check('a server list that arrives mid-probe stays disabled', await page.isDisabled('.chip button'));
  await native({ type: 'probeResult', url: 'http://10.0.0.5:3000/', outcome: { kind: 'refused' }, canStart: false });
  check('chips enabled again after the result', !(await page.isDisabled('.chip button')));

  // 9. Starting Codeman: no Cancel, and the result connects only to the server that was asked for.
  await page.fill('#url', '127.0.0.1:3000');
  await page.click('#connect');
  await native({ type: 'probeResult', url: 'http://127.0.0.1:3000/', outcome: { kind: 'refused' }, canStart: true });
  await page.click('#start');
  p = await posted();
  check(
    'Start asks for the typed server',
    p[p.length - 1].cmd === 'startServer' && p[p.length - 1].url === '127.0.0.1:3000',
    p[p.length - 1]
  );
  await native({ type: 'serverStarting' });
  check(
    'serverStarting: Cancel hidden, Connect disabled, chips disabled',
    !(await visible('#cancel')) && (await page.isDisabled('#connect')) && (await page.isDisabled('.chip button'))
  );
  n0 = (await posted()).length;
  await native({ type: 'serverStartResult', ok: true, output: 'started', url: 'http://127.0.0.1:4000/' });
  check(
    'serverStartResult for another URL does not connect',
    (await posted()).length === n0 && (await page.textContent('#status')).includes('Codeman started'),
    (await posted()).slice(n0)
  );
  await native({ type: 'probeResult', url: 'http://127.0.0.1:3000/', outcome: { kind: 'refused' }, canStart: true });
  await page.click('#start');
  await native({ type: 'serverStarting' });
  await page.fill('#url', 'http://10.0.0.9:3000');
  n0 = (await posted()).length;
  await native({ type: 'serverStartResult', ok: true, output: 'started', url: 'http://127.0.0.1:3000/' });
  p = (await posted()).slice(n0);
  check(
    'a matching result (scheme and slash normalized) connects to the started server, not the edited field',
    p.length === 1 && p[0].cmd === 'connect' && p[0].url === 'http://127.0.0.1:3000/',
    p
  );
  await native({ type: 'probeResult', url: 'http://127.0.0.1:3000/', outcome: { kind: 'refused' }, canStart: true });
  await page.click('#start');
  await native({ type: 'serverStarting' });
  n0 = (await posted()).length;
  await native({ type: 'serverStartResult', ok: false, output: 'boom', url: 'http://127.0.0.1:3000/' });
  check(
    'a failed start does not connect',
    (await posted()).length === n0 && (await page.textContent('#status')).includes('did not start')
  );

  // 10. A page reloaded while a start runs shows it running and does not auto-connect.
  await page.goto('http://app.test/index.html');
  await native({
    type: 'init',
    servers: [{ url: 'http://127.0.0.1:3000/' }],
    autoConnect: true,
    startFullscreen: false,
    version: '0.1.0',
    starting: true,
  });
  check('init.starting does not auto-connect', (await posted()).length === 1, await posted());
  check(
    'init.starting shows the start running without Cancel',
    (await visible('#spinner')) &&
      !(await visible('#cancel')) &&
      (await page.isDisabled('#connect')) &&
      (await page.textContent('#status')).includes('Starting Codeman')
  );
  await native({ type: 'serverStartResult', ok: true, output: '', url: 'http://127.0.0.1:3000/' });
  p = await posted();
  check(
    'after a reload, the result connects to the server the field shows',
    p.length === 2 && p[1].cmd === 'connect' && p[1].url === 'http://127.0.0.1:3000/',
    p
  );
  await page.goto('http://app.test/index.html');
  await native({
    type: 'init',
    servers: [{ url: 'http://127.0.0.1:3000/' }],
    autoConnect: true,
    startFullscreen: false,
    version: '0.1.0',
    notice: 'Codeman did not open. Check that the server is still running.',
  });
  check(
    'init.notice shown and no auto-connect',
    (await page.textContent('#status')).includes('did not open') && (await posted()).length === 1
  );

  // 11. Menu changes reach the page.
  await native({ type: 'prefs', startFullscreen: true, autoConnect: true });
  check('prefs updates both checkboxes', (await page.isChecked('#fullscreen')) && (await page.isChecked('#auto')));
  await native({ type: 'prefs', startFullscreen: false });
  check(
    'prefs updates only what it carries',
    !(await page.isChecked('#fullscreen')) && (await page.isChecked('#auto'))
  );

  // 12. Rate limited: the login fields come back.
  await page.goto('http://app.test/index.html?manual=1');
  await native({ type: 'init', servers: [{ url: 'http://127.0.0.1:3000/' }], autoConnect: false, version: '0.1.0' });
  check('no saved username: login hidden', !(await visible('#login')));
  await native({
    type: 'probeResult',
    url: 'http://127.0.0.1:3000/',
    outcome: { kind: 'rateLimited', sentCredentials: false },
    canStart: false,
  });
  let st = await page.textContent('#status');
  check(
    'rateLimited reveals the login with admin and focuses the password',
    (await visible('#login')) &&
      (await page.inputValue('#username')) === 'admin' &&
      (await page.evaluate(() => document.activeElement.id)) === 'password'
  );
  check(
    'rateLimited text: enter the password or wait, no blame without credentials',
    st.includes('Too many failed logins') &&
      st.includes('single-user') &&
      st.includes('15 minutes') &&
      !st.includes('may be wrong'),
    st
  );
  await native({
    type: 'probeResult',
    url: 'http://127.0.0.1:3000/',
    outcome: { kind: 'rateLimited', sentCredentials: true },
    canStart: false,
  });
  check(
    'rateLimited with credentials says the password may be wrong',
    (await page.textContent('#status')).includes('may be wrong')
  );

  // 13. Redirects, with and without a suggested address.
  await native({
    type: 'probeResult',
    url: 'http://127.0.0.1:3000/',
    outcome: { kind: 'redirect', location: 'https://127.0.0.1:3000/api/status', suggested: 'https://127.0.0.1:3000/' },
    canStart: false,
  });
  st = await page.textContent('#status');
  check('redirect shows the location', st.includes('https://127.0.0.1:3000/api/status'), st);
  check(
    'redirect shows a Use <suggested> button',
    (await visible('#suggest')) && (await page.textContent('#suggest')) === 'Use https://127.0.0.1:3000/'
  );
  n0 = (await posted()).length;
  await page.dblclick('#suggest');
  p = (await posted()).slice(n0);
  check(
    'Use <suggested> fills the field and connects once',
    p.length === 1 &&
      p[0].cmd === 'connect' &&
      p[0].url === 'https://127.0.0.1:3000/' &&
      (await page.inputValue('#url')) === 'https://127.0.0.1:3000/',
    p
  );
  check(
    'suggest button disabled (not hidden) while busy',
    (await visible('#suggest')) && (await page.isDisabled('#suggest'))
  );
  await native({
    type: 'probeResult',
    url: 'http://h/',
    outcome: { kind: 'redirect', location: 'https://login.example/<b>x</b>', suggested: null },
    canStart: false,
  });
  st = await page.textContent('#status');
  check(
    'redirect without suggestion: location as text, no button',
    st.includes('https://login.example/<b>x</b>') && !(await visible('#suggest')),
    st
  );
  await native({
    type: 'probeResult',
    url: 'http://127.0.0.1:3000/',
    outcome: { kind: 'redirect', location: 'https://127.0.0.1:3000/api/status', suggested: 'https://127.0.0.1:3000/' },
    canStart: false,
  });
  await page.fill('#url', 'http://other:3000');
  check('editing the address hides the suggestion', !(await visible('#suggest')));

  // 14. Network outcomes and their hints.
  await native({
    type: 'probeResult',
    url: 'http://192.168.1.20:3000/',
    outcome: { kind: 'unreachable' },
    canStart: false,
  });
  st = await page.textContent('#status');
  check(
    'unreachable: Local Network hint and same network',
    st.includes('Privacy & Security > Local Network') && st.includes('same network') && st.includes('may'),
    st
  );
  await native({
    type: 'probeResult',
    url: 'http://127.0.0.1:3000/',
    outcome: { kind: 'maybeHttps' },
    canStart: false,
  });
  st = await page.textContent('#status');
  check(
    'maybeHttps: --https, https:// and the self-signed limit',
    st.includes('--https') && st.includes('https://') && st.includes('self-signed'),
    st
  );
  check(
    'maybeHttps offers the https:// address',
    (await visible('#suggest')) && (await page.textContent('#suggest')) === 'Use https://127.0.0.1:3000/'
  );
  check(
    'maybeHttps at 127.0.0.1: Keychain advice, hedged',
    st.includes('Keychain Access may work') && !st.includes('tailscale serve'),
    st
  );
  await native({ type: 'probeResult', url: 'http://10.0.0.2:3000/', outcome: { kind: 'maybeHttps' }, canStart: false });
  st = await page.textContent('#status');
  check(
    'maybeHttps at another host: no Keychain advice; tailscale serve or a reverse proxy',
    !st.includes('Keychain') &&
      st.includes('tailscale serve') &&
      st.includes('reverse proxy with a real certificate') &&
      st.includes('--https') &&
      st.includes('self-signed'),
    st
  );
  check(
    'maybeHttps at another host still offers the https:// address',
    (await visible('#suggest')) && (await page.textContent('#suggest')) === 'Use https://10.0.0.2:3000/'
  );
  await native({
    type: 'probeResult',
    url: 'http://studio.local:3000/',
    outcome: { kind: 'unresolvable' },
    canStart: false,
  });
  st = await page.textContent('#status');
  check('unresolvable .local: Local Network hint', st.includes('Local Network') && !(await visible('#suggest')), st);
  await native({
    type: 'probeResult',
    url: 'https://box.tail.ts.net/',
    outcome: { kind: 'unresolvable' },
    canStart: false,
  });
  st = await page.textContent('#status');
  check(
    'unresolvable .ts.net: Tailscale hint, no Local Network',
    st.includes('Tailscale') && !st.includes('Local Network'),
    st
  );

  // 15. Opening, including a forced password change.
  await page.click('#connect');
  await native({ type: 'opening', version: null, passwordChange: true });
  st = await page.textContent('#status');
  check(
    'opening with passwordChange explains the new password',
    st.includes('new password') && st.includes('next time'),
    st
  );
  check('opening keeps Cancel (the load can be abandoned)', await visible('#cancel'));
  await native({ type: 'opening', version: null });
  check(
    'opening without a version',
    (await page.textContent('#status')) === 'Opening Codeman…',
    await page.textContent('#status')
  );
  await native({ type: 'opening', version: '1.47.0' });
  check('opening with a version', (await page.textContent('#status')) === 'Opening Codeman 1.47.0…');
  n0 = (await posted()).length;
  await page.click('#cancel');
  p = (await posted()).slice(n0);
  check('Cancel while opening posts cancel', p.length === 1 && p[0].cmd === 'cancel', p);

  // 16. This Mac: the four states, Open / Start / Install, and the install wait.
  const all = () => page.evaluate(() => window.__posted.slice());
  const st16 = (state, extra) =>
    Object.assign(
      {
        url: 'http://127.0.0.1:3000/',
        state,
        version: null,
        service: false,
        installed: state !== 'notInstalled',
        installComplete: false,
        outcome: { kind: state === 'running' ? 'ok' : 'refused' },
      },
      extra || {}
    );
  await page.goto('http://app.test/index.html');
  await native({
    type: 'init',
    servers: [{ url: 'https://box.tail.ts.net/', username: 'admin', hasSavedPassword: true }],
    autoConnect: false,
    startFullscreen: false,
    version: '0.1.0',
  });
  check(
    'a remote server used last opens the Another machine tab, without a This Mac check',
    (await visible('#form')) && !(await visible('#pane-local')) && !(await all()).some((m) => m.cmd === 'localStatus')
  );
  check(
    'tabs: aria-selected follows the tab',
    (await page.getAttribute('#tab-remote', 'aria-selected')) === 'true' &&
      (await page.getAttribute('#tab-local', 'aria-selected')) === 'false'
  );
  await page.click('#tab-local');
  check(
    'switching to This Mac asks about this Mac once',
    (await all()).filter((m) => m.cmd === 'localStatus').length === 1 &&
      (await page.textContent('#local-title')).includes('Looking for Codeman')
  );
  await page.click('#tab-remote');
  await page.click('#tab-local');
  check(
    'switching back does not ask again while a check runs',
    (await all()).filter((m) => m.cmd === 'localStatus').length === 1
  );
  await page.focus('#tab-local');
  await page.keyboard.press('ArrowRight');
  check(
    'arrow keys move between the tabs',
    (await visible('#form')) && (await page.evaluate(() => document.activeElement.id)) === 'tab-remote'
  );
  await page.keyboard.press('ArrowLeft');

  await native({
    type: 'localStatus',
    status: st16('running', { version: '1.47.0', outcome: { kind: 'ok', version: '1.47.0' } }),
  });
  check(
    'running: Open shown, title and version',
    (await visible('#local-open')) &&
      !(await visible('#local-install')) &&
      (await page.textContent('#local-title')).includes('running') &&
      (await page.textContent('#local-detail')).includes('1.47.0')
  );
  n0 = (await all()).length;
  await page.dblclick('#local-open');
  p = (await all()).slice(n0);
  check(
    'Open connects once to the local URL, with no password from the page',
    p.length === 1 && p[0].cmd === 'connect' && p[0].url === 'http://127.0.0.1:3000/' && !('password' in p[0]),
    p
  );
  check(
    "Open never carries the remote server's username shown before (review #1)",
    !('username' in p[0]) && !(await page.isVisible('#login')),
    p
  );
  check(
    'Open: busy, Open disabled, Cancel shown',
    (await page.isDisabled('#local-open')) && (await visible('#cancel'))
  );
  await native({ type: 'probeResult', url: 'http://127.0.0.1:3000/', outcome: { kind: 'needsLogin' }, canStart: true });
  check(
    'a login asked for from This Mac moves to the login fields',
    (await visible('#form')) && (await visible('#login'))
  );
  await page.click('#tab-local');

  // A typed password for another server must not ride along to Start either.
  await page.click('#tab-remote');
  await page.fill('#url', 'https://other.example/');
  await native({
    type: 'probeResult',
    url: 'https://other.example/',
    outcome: { kind: 'needsLogin' },
    canStart: false,
  });
  await page.fill('#password', 'remote-secret');
  await page.click('#tab-local');
  await native({ type: 'localStatus', status: st16('stopped', { service: true }) });
  check(
    'stopped: Start and Check again, service named',
    (await visible('#local-start')) &&
      (await visible('#local-check')) &&
      !(await visible('#local-open')) &&
      (await page.textContent('#local-detail')).includes('start when you log in')
  );
  n0 = (await all()).length;
  await page.click('#local-start');
  p = (await all()).slice(n0);
  check(
    'Start posts startServer for the local URL',
    p.length === 1 && p[0].cmd === 'startServer' && p[0].url === 'http://127.0.0.1:3000/',
    p
  );
  check(
    "Start clears the other server's login from the form",
    (await page.inputValue('#password')) === '' && (await page.inputValue('#username')) === ''
  );
  await native({ type: 'serverStarting' });
  check('starting: Start disabled', await page.isDisabled('#local-start'));
  n0 = (await all()).length;
  await native({ type: 'serverStartResult', ok: true, output: 'started', url: 'http://127.0.0.1:3000/' });
  p = (await all()).slice(n0);
  check(
    'started: connects to the local URL',
    p.length === 1 && p[0].cmd === 'connect' && p[0].url === 'http://127.0.0.1:3000/',
    p
  );
  await native({ type: 'probeResult', url: 'http://127.0.0.1:3000/', outcome: { kind: 'refused' }, canStart: true });
  check('a refused Open from This Mac looks at this Mac again', (await all()).slice(-1)[0].cmd === 'localStatus');

  await native({ type: 'localStatus', status: st16('notInstalled') });
  check(
    'not installed: Install, no Open/Start',
    (await visible('#local-install')) && !(await visible('#local-open')) && !(await visible('#local-start'))
  );
  // Install opens the graphical install (test/desktop-connect-install.test.ts walks its screens).
  // The Terminal route is what it offers when it cannot go on, here after a failed preparation.
  const installInTerminal = async () => {
    await page.click('#local-install');
    await native({ type: 'installPrepareFailed', message: 'Could not get the installer.' });
    await page.click('#wiz-terminal');
  };
  n0 = (await all()).length;
  await page.dblclick('#local-install');
  p = (await all()).slice(n0);
  check('a double click on Install asks for the install once', p.length === 1 && p[0].cmd === 'installPrepare', p);
  await native({ type: 'installPrepareFailed', message: 'Could not get the installer.' });
  n0 = (await all()).length;
  await page.dblclick('#wiz-terminal');
  p = (await all()).slice(n0);
  check(
    'Install in Terminal instead posts installLocal once',
    p.length === 1 && p[0].cmd === 'installLocal' && p[0].network === false,
    p
  );
  check('Install disabled while Terminal opens', await page.isDisabled('#local-install'));
  await native({ type: 'installFailed', message: 'Could not open Terminal: <b>no</b>' });
  check(
    'install failure shown as text, Install enabled again',
    (await page.textContent('#status')).includes('<b>no</b>') && !(await page.isDisabled('#local-install'))
  );
  await installInTerminal();
  await page.clock.install();
  await native({ type: 'installStarted', port: 3001 });
  check(
    'install started: waiting state with Stop waiting',
    (await visible('#local-stop')) &&
      !(await visible('#local-install')) &&
      (await page.textContent('#local-title')).includes('Installing')
  );
  n0 = (await all()).length;
  await page.clock.runFor(3100);
  p = (await all()).slice(n0);
  check('the wait polls with quick checks', p.length === 1 && p[0].cmd === 'localStatus' && p[0].quick === true, p);
  // Port 3000 is a dev server; the install took 3001.
  await native({
    type: 'localStatus',
    status: st16('other', { installed: false, outcome: { kind: 'notCodeman', status: 404 } }),
  });
  check('something else on 3000 does not end a wait for 3001', await visible('#local-stop'));
  await page.clock.runFor(3100);
  n0 = (await all()).length;
  await native({
    type: 'localStatus',
    status: st16('running', {
      url: 'http://127.0.0.1:3001/',
      version: '1.47.0',
      service: true,
      installComplete: true,
      outcome: { kind: 'ok', version: '1.47.0' },
    }),
  });
  p = (await all()).slice(n0);
  check(
    'the installed server answering on its port opens Codeman',
    p.length === 1 &&
      p[0].cmd === 'connect' &&
      p[0].url === 'http://127.0.0.1:3001/' &&
      !(await visible('#local-stop')),
    p
  );
  await page.clock.runFor(10000);
  check('no more polling after the wait ends', !(await all()).slice(n0 + 1).some((m) => m.cmd === 'localStatus'));
  await native({ type: 'probeResult', url: 'http://127.0.0.1:3001/', outcome: { kind: 'timeout' }, canStart: true });

  // A finished install whose service never answers offers Start after 90 s.
  await native({ type: 'localStatus', status: st16('notInstalled') });
  await installInTerminal();
  await native({ type: 'installStarted', port: 3000 });
  await native({ type: 'localStatus', status: st16('stopped', { installComplete: true }) });
  await page.clock.runFor(60000);
  await native({ type: 'localStatus', status: st16('stopped', { installComplete: true }) });
  check('a finished install keeps waiting for its service for a while', await visible('#local-stop'));
  await page.clock.runFor(40000);
  await native({ type: 'localStatus', status: st16('stopped', { installComplete: true }) });
  check(
    'then stops waiting and offers Start',
    !(await visible('#local-stop')) &&
      (await visible('#local-start')) &&
      (await page.textContent('#status')).includes('not answering')
  );
  // Stop waiting by hand.
  await native({ type: 'localStatus', status: st16('notInstalled') });
  await installInTerminal();
  await native({ type: 'installStarted', port: 3000 });
  n0 = (await all()).length;
  await page.click('#local-stop');
  p = (await all()).slice(n0);
  check(
    'Stop waiting ends the wait and looks again (full check)',
    !(await visible('#local-stop')) && p.length === 1 && p[0].cmd === 'localStatus' && p[0].quick === false,
    p
  );
  await page.clock.runFor(10000);
  check(
    'no polling after Stop waiting',
    (await all()).slice(n0 + 1).every((m) => m.cmd !== 'localStatus' || m.quick === false)
  );

  // Review fixes: Check again looks deeper; a server elsewhere; an install still running; https and daemon.
  await native({ type: 'localStatus', status: st16('notInstalled') });
  n0 = (await all()).length;
  await page.click('#local-check');
  p = (await all()).slice(n0);
  check(
    'Check again asks for the deep look (interactive profile)',
    p.length === 1 && p[0].cmd === 'localStatus' && p[0].deep === true && p[0].quick === false,
    p
  );
  const elsewhere = [
    { url: 'https://127.0.0.1:4000/', version: null, state: 'certificate', isDefault: false },
    { url: 'http://192.168.1.5:3000/', version: '1.49.0', state: 'running', isDefault: false },
  ];
  await native({ type: 'localStatus', status: st16('runningElsewhere', { found: elsewhere }) });
  check(
    'a server running elsewhere: no Start, no Install, a row for each address',
    !(await visible('#local-start')) &&
      !(await visible('#local-install')) &&
      !(await visible('#local-open')) &&
      (await page.textContent('#local-found')).includes('http://192.168.1.5:3000/') &&
      (await page.locator('#local-found .found').count()) === 2 &&
      (await page.textContent('#local-title')).includes('already running')
  );
  const foundBox = await page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const card = r('.card');
    const rows = [...document.querySelectorAll('#local-found .found')].map((row) => row.getBoundingClientRect());
    return {
      order: [r('.local').bottom, rows[0].top, rows[1].bottom, r('#local-found-note').top, r('#local-check').top],
      inside: rows.every((row) => row.left >= card.left && row.right <= card.right),
      buttons: [...document.querySelectorAll('#local-found .found')].map((row) => {
        const b = row.querySelector('button');
        return b ? b.className : '';
      }),
    };
  });
  check(
    'the rows sit under the title, then the sentence about a second server, then Check again',
    foundBox.order.every((y, i) => i === 0 || y >= foundBox.order[i - 1]) && foundBox.inside,
    foundBox
  );
  check(
    'a server the app cannot open has no Connect; the first it can open is the main action',
    foundBox.buttons[0] === '' && foundBox.buttons[1] === 'primary',
    foundBox.buttons
  );
  n0 = (await all()).length;
  await page.locator('#local-found .found button').dblclick();
  p = (await all()).slice(n0);
  check(
    'Connect on a found server connects once, to its address',
    p.length === 1 && p[0].cmd === 'connect' && p[0].url === 'http://192.168.1.5:3000/' && !('password' in p[0]),
    p
  );
  await native({
    type: 'probeResult',
    url: 'http://192.168.1.5:3000/',
    outcome: { kind: 'refused' },
    canStart: false,
  });
  await native({
    type: 'localStatus',
    status: st16('running', {
      version: '1.49.0',
      outcome: { kind: 'ok', version: '1.49.0' },
      found: [{ url: 'http://127.0.0.1:3000/', version: '1.49.0', state: 'running', isDefault: true }, elsewhere[1]],
    }),
  });
  const alsoBox = await page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    return {
      open: r('#local-open').bottom,
      also: r('#local-also').top,
      rows: document.querySelectorAll('#local-also .found').length,
      head: document.querySelector('#local-also-head').textContent,
      button: document.querySelector('#local-also .found button').className,
    };
  });
  check(
    'running with another server on this Mac: it is listed under Open, as a secondary action',
    (await visible('#local-open')) &&
      alsoBox.also >= alsoBox.open &&
      alsoBox.rows === 1 &&
      alsoBox.head === 'Also running on this Mac' &&
      alsoBox.button === 'secondary' &&
      !(await visible('#local-found')),
    alsoBox
  );
  await native({ type: 'localStatus', status: st16('stopped', { url: 'https://127.0.0.1:3000/', service: true }) });
  check(
    'stopped with HTTPS: no Start (the app refuses its certificate), explained',
    !(await visible('#local-start')) && (await page.textContent('#local-detail')).includes('--https')
  );
  await native({ type: 'localStatus', status: st16('stopped', { service: true, daemon: true }) });
  check(
    'stopped under a system LaunchDaemon: no Start, the admin command shown',
    !(await visible('#local-start')) && (await page.textContent('#local-detail')).includes('launchctl kickstart')
  );
  await page.goto('http://app.test/index.html?manual=1');
  await native({ type: 'init', servers: [], autoConnect: false, startFullscreen: false, version: '0.1.0' });
  n0 = (await all()).length;
  await native({ type: 'localStatus', status: st16('notInstalled', { installRunning: true, installPort: 3002 }) });
  check(
    'an install still running (page shown again): waits for it, no Install',
    (await visible('#local-stop')) && !(await visible('#local-install'))
  );
  await page.clock.runFor(3100);
  n0 = (await all()).length;
  await native({
    type: 'localStatus',
    status: st16('running', {
      url: 'http://127.0.0.1:3002/',
      installRunning: true,
      installPort: 3002,
      outcome: { kind: 'ok', version: '1.47.0' },
    }),
  });
  p = (await all()).slice(n0);
  check(
    'and opens it on the port the installer took',
    p.length === 1 && p[0].cmd === 'connect' && p[0].url === 'http://127.0.0.1:3002/',
    p
  );
  await native({ type: 'probeResult', url: 'http://127.0.0.1:3002/', outcome: { kind: 'timeout' }, canStart: true });
  await native({ type: 'localStatus', status: st16('notInstalled', { installRunning: true }) });
  await page.click('#local-stop');
  await native({ type: 'localStatus', status: st16('notInstalled', { installRunning: true }) });
  check(
    'after Stop waiting, a running install shows as such and never offers Install',
    !(await visible('#local-stop')) &&
      !(await visible('#local-install')) &&
      (await page.textContent('#local-title')).includes('being installed')
  );
  await native({ type: 'error', message: 'Codeman Desktop could not read the saved password.', needsPassword: true });
  check(
    'an unreadable saved password shows the login fields (review #8)',
    (await visible('#login')) && (await visible('#form'))
  );
  await page.click('#tab-local');

  await native({
    type: 'localStatus',
    status: st16('other', { installed: false, outcome: { kind: 'notCodeman', status: 404 } }),
  });
  check(
    'a dev server on 3000 with no Codeman: Install still offered, says why',
    (await visible('#local-install')) && (await page.textContent('#local-detail')).includes('next free port')
  );
  await native({ type: 'localStatus', status: st16('other', { installed: true, outcome: { kind: 'tlsUntrusted' } }) });
  check(
    'installed but unusable (self-signed): explained, Check again only',
    (await page.textContent('#local-title')).includes('not trusted') &&
      (await visible('#local-check')) &&
      !(await visible('#local-install')) &&
      !(await visible('#local-open'))
  );
  await native({
    type: 'localStatus',
    status: st16('running', { url: 'http://127.0.0.1:3000/<img src=x onerror=window.__xss2=1>/' }),
  });
  check(
    'the local URL is shown as text',
    (await page.evaluate(() => window.__xss2)) === undefined &&
      (await page.textContent('#local-detail')).includes('<img')
  );

  // 17. Another machine: install over SSH, and copy the one-liner.
  await page.click('#tab-remote');
  await page.click('#elsewhere summary');
  check(
    'the SSH install opens under Another machine',
    (await visible('#ssh')) &&
      (await visible('#oneliner')) &&
      (await page.textContent('#oneliner')) === 'curl -fsSL https://getcodeman.com/install | bash'
  );
  n0 = (await all()).length;
  await page.click('#ssh-install');
  check(
    'an empty SSH field asks for the machine and posts nothing',
    (await all()).length === n0 && (await page.textContent('#status')).includes('user@host')
  );
  await page.fill('#ssh', '  kay@build-box  ');
  await page.press('#ssh', 'Enter');
  p = (await all()).slice(n0);
  check(
    'Enter in the SSH field installs (does not connect)',
    p.length === 1 && p[0].cmd === 'installRemote' && p[0].target === 'kay@build-box',
    p
  );
  check('Install disabled while Terminal opens', await page.isDisabled('#ssh-install'));
  await native({ type: 'installFailed', remote: true, message: 'Enter the machine the way ssh takes it' });
  check(
    'a refused SSH login is explained and Install is enabled again',
    (await page.textContent('#status')).includes('the way ssh takes it') && !(await page.isDisabled('#ssh-install'))
  );
  await page.click('#ssh-install');
  await native({ type: 'remoteInstallStarted', host: 'build-box', url: 'http://build-box:3000' });
  check(
    'remote install started: address suggested, instructions shown',
    (await page.inputValue('#url')) === 'http://build-box:3000' &&
      (await page.textContent('#status')).includes('installing Codeman on build-box') &&
      !(await page.isDisabled('#ssh-install'))
  );
  check(
    "remote install started: the earlier server's login is not shown for the new machine",
    !(await visible('#login')) && (await page.inputValue('#username')) === ''
  );
  n0 = (await all()).length;
  await page.click('#copy');
  p = (await all()).slice(n0);
  check(
    'Copy asks the app (no web clipboard)',
    p.length === 1 && p[0].cmd === 'copyInstallCommand' && Object.keys(p[0]).length === 1,
    p
  );
  await native({ type: 'copied' });
  check('copied confirmation', (await page.textContent('#status')).includes('Copied'));
  await page.click('#tab-local');
  await native({ type: 'localStatus', status: st16('notInstalled') });
  await page.clock.resume();

  check('no page errors on the connect page', errors.length === 0, errors);
  check(
    'no CSP violations on the connect page (besides the eval probe above)',
    cspViolations.filter((t) => !/eval/i.test(t)).length === 0,
    cspViolations
  );
  await ctx.close();
}

// Layout that does not move or cut the page off, the status line under the
// action, the deferred look at this Mac, and fields too long for the app.
async function layoutAndLimits(browser: Browser) {
  const open = async (viewport, query) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await serveConnect(page);
    await page.addInitScript(IPC_STUB);
    await page.goto('http://app.test/index.html' + (query || ''));
    const native = (msg) => page.evaluate((m) => window.__codemanDesktop.onNative(m), msg);
    const posted = (cmd) => page.evaluate((c) => window.__posted.filter((m) => m.cmd === c), cmd);
    const top = (sel) => page.evaluate((s) => Math.round(document.querySelector(s).getBoundingClientRect().top), sel);
    return { ctx, page, errors, native, posted, top };
  };
  const SAVED = [
    { url: 'https://box.tail.ts.net/', username: 'admin', hasSavedPassword: true },
    { url: 'http://192.168.1.20:3000/' },
  ];
  const localStatus = (s) => ({
    type: 'localStatus',
    status: Object.assign(
      {
        url: 'http://127.0.0.1:3000/',
        state: 'running',
        version: '1.48.0',
        service: true,
        daemon: false,
        installed: true,
        installComplete: true,
        installRunning: false,
        installPort: null,
        found: [],
        outcome: { kind: 'ok', version: '1.48.0' },
      },
      s
    ),
  });

  // a. The header stays where it is while the card changes.
  let t = await open({ width: 1280, height: 820 }, '?manual=1');
  const before = await t.top('header');
  await t.native({ type: 'init', servers: SAVED, autoConnect: false, version: '0.1.0' });
  const tops = [await t.top('header')];
  await t.page.click('#tab-local');
  tops.push(await t.top('header'));
  await t.native(localStatus({}));
  tops.push(await t.top('header'));
  await t.page.click('#tab-remote');
  await t.page.click('#connect');
  await t.native({ type: 'probeResult', url: SAVED[0].url, outcome: { kind: 'badCredentials' }, canStart: false });
  tops.push(await t.top('header'));
  check(
    'the header does not move between states',
    tops.every((y) => y === before),
    [before].concat(tops)
  );
  check(
    'a saved server with its login fits the default window without scrolling',
    await (async () => {
      await t.page.goto('http://app.test/index.html?manual=1');
      await t.native({ type: 'init', servers: SAVED, autoConnect: false, version: '0.1.0' });
      return t.page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight);
    })()
  );
  check('layout: no page errors', t.errors.length === 0, t.errors);
  await t.ctx.close();

  // b. The status line: hidden while empty, right under the action, above the install section.
  t = await open({ width: 1280, height: 820 }, '?manual=1');
  await t.native({ type: 'init', servers: SAVED, autoConnect: false, version: '0.1.0' });
  check('no status: the status row takes no room', !(await t.page.locator('#status-row').isVisible()));
  check('the install section shows on the Another machine tab', await t.page.locator('#elsewhere').isVisible());
  await t.page.click('#connect');
  await t.native({ type: 'probeResult', url: SAVED[0].url, outcome: { kind: 'timeout' }, canStart: false });
  const order = await t.page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    return {
      connectBottom: r('#connect').bottom,
      statusTop: r('#status-row').top,
      statusBottom: r('#status-row').bottom,
      installTop: r('#elsewhere').top,
    };
  });
  check(
    'an error sits between Connect and the install section',
    order.connectBottom <= order.statusTop && order.statusBottom <= order.installTop,
    order
  );
  await t.page.click('#tab-local');
  check('the install section is hidden on the This Mac tab', !(await t.page.locator('#elsewhere').isVisible()));
  check('switching tabs clears the status row', !(await t.page.locator('#status-row').isVisible()));
  await t.ctx.close();

  // c. A window smaller than the page scrolls from the top, and a new status is brought into view.
  t = await open({ width: 480, height: 360 }, '?manual=1');
  await t.native({ type: 'init', servers: SAVED, autoConnect: false, version: '0.1.0' });
  const small = await t.page.evaluate(() => ({
    headerTop: document.querySelector('header').getBoundingClientRect().top,
    scrolls: document.documentElement.scrollHeight > window.innerHeight,
    y: window.scrollY,
  }));
  check(
    'small window: the page starts at its top and scrolls',
    small.headerTop >= 0 && small.scrolls && small.y === 0,
    small
  );
  await t.page.click('#connect');
  await t.native({ type: 'probeResult', url: SAVED[0].url, outcome: { kind: 'badCredentials' }, canStart: false });
  const seen = await t.page.evaluate(() => {
    const r = document.querySelector('#status-row').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, h: window.innerHeight };
  });
  check('small window: an error is scrolled into view', seen.top >= 0 && seen.top < seen.h, seen);
  await t.page.evaluate(() => window.scrollTo(0, 0));
  check(
    'small window: the top is still reachable',
    (await t.page.evaluate(() => document.querySelector('header').getBoundingClientRect().top)) >= 0
  );
  await t.ctx.close();

  // d. An error that needs the login fields keeps its text (the tab switch used to wipe it).
  t = await open({ width: 1280, height: 820 }, '?manual=1');
  await t.native({
    type: 'init',
    servers: [{ url: 'http://127.0.0.1:3000/', username: 'admin', hasSavedPassword: true }],
    autoConnect: false,
    version: '0.1.0',
  });
  await t.native(localStatus({}));
  await t.page.click('#local-open');
  await t.native({
    type: 'error',
    message: 'The saved password could not be read from the Keychain. Enter it again.',
    needsPassword: true,
  });
  check(
    'needsPassword error: the Another machine tab with the login fields',
    (await t.page.locator('#form').isVisible()) && (await t.page.locator('#login').isVisible())
  );
  check(
    'needsPassword error: its text is still shown',
    (await t.page.textContent('#status')).includes('could not be read from the Keychain'),
    await t.page.textContent('#status')
  );
  await t.ctx.close();

  // e. An automatic connect to the Codeman on this Mac does not look at this Mac first.
  t = await open({ width: 1280, height: 820 }, '');
  await t.native({ type: 'init', servers: [{ url: 'http://127.0.0.1:3000/' }], autoConnect: true, version: '0.1.0' });
  check('auto-connect (local): the connect goes out', (await t.posted('connect')).length === 1);
  check(
    'auto-connect (local): no look at this Mac yet',
    (await t.posted('localStatus')).length === 0,
    await t.posted('localStatus')
  );
  await t.native({ type: 'probeResult', url: 'http://127.0.0.1:3000/', outcome: { kind: 'refused' }, canStart: true });
  check('auto-connect (local): a failed connect looks at this Mac', (await t.posted('localStatus')).length === 1);
  await t.ctx.close();

  t = await open({ width: 1280, height: 820 }, '');
  await t.native({ type: 'init', servers: [{ url: 'http://127.0.0.1:3000/' }], autoConnect: true, version: '0.1.0' });
  await t.page.click('#cancel');
  check(
    'auto-connect (local): Cancel looks at this Mac',
    (await t.posted('localStatus')).length === 1 && !(await t.page.locator('#status-row').isVisible())
  );
  await t.page.click('#cancel', { force: true }).catch(() => {});
  check('a second look is not started while one runs', (await t.posted('localStatus')).length === 1);
  await t.ctx.close();

  t = await open({ width: 1280, height: 820 }, '');
  await t.native({ type: 'init', servers: [{ url: 'http://127.0.0.1:3000/' }], autoConnect: true, version: '0.1.0' });
  await t.native({ type: 'error', message: 'Enter a valid address.' });
  check('auto-connect (local): an error looks at this Mac', (await t.posted('localStatus')).length === 1);
  await t.ctx.close();

  t = await open({ width: 1280, height: 820 }, '');
  await t.native({ type: 'init', servers: [{ url: 'http://127.0.0.1:3000/' }], autoConnect: false, version: '0.1.0' });
  check(
    'no auto-connect: the This Mac tab looks at once',
    (await t.posted('localStatus')).length === 1 && (await t.posted('connect')).length === 0
  );
  await t.ctx.close();

  // f. What the app would drop without an answer is refused on the page.
  t = await open({ width: 1280, height: 820 }, '?manual=1');
  await t.native({ type: 'init', servers: [], autoConnect: false, version: '0.1.0' });
  await t.page.click('#tab-remote');
  await t.page.fill('#url', 'http://h/' + 'a'.repeat(4096));
  await t.page.click('#connect');
  check(
    'an over-long address is refused with a reason',
    (await t.posted('connect')).length === 0 &&
      (await t.page.textContent('#status')).includes('too long') &&
      !(await t.page.isDisabled('#connect'))
  );
  await t.page.fill('#url', 'http://h/' + 'a'.repeat(4096 - 'http://h/'.length));
  await t.page.click('#connect');
  check('an address of exactly 4096 bytes goes out', (await t.posted('connect')).length === 1);
  await t.native({ type: 'probeResult', url: 'http://h/', outcome: { kind: 'needsLogin' }, canStart: false });
  await t.page.fill('#password', '€'.repeat(342));
  await t.page.click('#connect');
  check(
    'a password over 1024 bytes (342 x 3) is refused with a reason',
    (await t.posted('connect')).length === 1 && (await t.page.textContent('#status')).includes('too long'),
    await t.page.textContent('#status')
  );
  await t.page.fill('#password', '€'.repeat(341));
  await t.page.click('#connect');
  check('a password of 1023 bytes goes out', (await t.posted('connect')).length === 2);
  check(
    'the SSH field cannot hold more than the app accepts',
    (await t.page.getAttribute('#ssh', 'maxlength')) === '300'
  );
  // The byte count is the page's own: 4-byte characters (a surrogate pair each) and 2-byte ones.
  await t.native({ type: 'probeResult', url: 'http://h/', outcome: { kind: 'badCredentials' }, canStart: false });
  await t.page.fill('#password', '😀'.repeat(257));
  await t.page.click('#connect');
  check(
    '257 four-byte characters (1028 bytes) are refused',
    (await t.posted('connect')).length === 2 && (await t.page.textContent('#status')).includes('too long')
  );
  await t.page.fill('#password', '😀'.repeat(256));
  await t.page.click('#connect');
  check('256 four-byte characters (1024 bytes) go out', (await t.posted('connect')).length === 3);
  await t.native({ type: 'probeResult', url: 'http://h/', outcome: { kind: 'badCredentials' }, canStart: false });
  await t.page.fill('#password', 'é'.repeat(513));
  await t.page.click('#connect');
  check(
    '513 two-byte characters (1026 bytes) are refused',
    (await t.posted('connect')).length === 3 && (await t.page.textContent('#status')).includes('too long')
  );
  await t.page.fill('#password', 'é'.repeat(512));
  await t.page.click('#connect');
  check('512 two-byte characters (1024 bytes) go out', (await t.posted('connect')).length === 4);
  check('limits: no page errors', t.errors.length === 0, t.errors);
  await t.ctx.close();
}

// Double clicks, keys, the tab an answer belongs to, a server that is still
// starting, and what a screen reader hears.
async function clicksKeysAndStates(browser: Browser) {
  const open = async (viewport, query) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await serveConnect(page);
    await page.addInitScript(IPC_STUB);
    await page.goto('http://app.test/index.html' + (query || ''));
    const native = (msg) => page.evaluate((m) => window.__codemanDesktop.onNative(m), msg);
    const posted = (cmd) => page.evaluate((c) => window.__posted.filter((m) => m.cmd === c), cmd);
    return { ctx, page, errors, native, posted };
  };
  const SIX = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ url: 'http://' + n + '.example:3000/' }));
  const localStatus = (s) => ({
    type: 'localStatus',
    status: Object.assign(
      {
        url: 'http://127.0.0.1:3000/',
        state: 'running',
        version: '1.48.0',
        service: true,
        daemon: false,
        installed: true,
        installComplete: true,
        installRunning: false,
        installPort: null,
        found: [],
        outcome: { kind: 'ok', version: '1.48.0' },
      },
      s
    ),
  });
  const WIDE = { width: 1280, height: 820 };

  // a. The second click of a double click never lands on another control.
  let t = await open(WIDE, '?manual=1');
  await t.native({ type: 'init', servers: SIX, autoConnect: false, version: '0.1.0' });
  // The app answers `forget` with the new list (main.rs), so the chips are
  // rebuilt between the two clicks of a double click.
  await t.page.evaluate(() => {
    const push = window.__posted.push.bind(window.__posted);
    window.__posted.push = (m) => {
      const n = push(m);
      if (m.cmd === 'forget') {
        const left = Array.from(document.querySelectorAll('#recent .chip'))
          .map((chip) => chip.firstChild.title.replace('Connect to ', ''))
          .filter((url) => url !== m.url)
          .map((url) => ({ url }));
        window.__codemanDesktop.onNative({ type: 'servers', servers: left });
      }
      return n;
    };
  });
  const firstX = t.page.locator('#recent .chip .x').first();
  const box = await firstX.boundingBox();
  await t.page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  check(
    'double click on a Forget: one forget, no connect to the server that slid under the pointer',
    (await t.posted('forget')).length === 1 && (await t.posted('connect')).length === 0,
    { forget: await t.posted('forget'), connect: await t.posted('connect') }
  );
  check('double click on a Forget: five servers left', (await t.page.locator('#recent .chip').count()) === 5);
  // A label still takes both clicks of a double click (it stays under the pointer).
  const autoBefore = await t.page.isChecked('#auto');
  const label = await t.page.locator('label.check:has(#auto)').boundingBox();
  await t.page.mouse.dblclick(label.x + 40, label.y + label.height / 2);
  check(
    'double click on a checkbox label still toggles twice',
    (await t.page.isChecked('#auto')) === autoBefore && (await t.posted('setAutoConnect')).length === 2,
    await t.posted('setAutoConnect')
  );
  // The keyboard is not touched by the guard.
  await t.page.focus('#tab-remote');
  await t.page.keyboard.press('ArrowLeft');
  check('arrow keys still switch tabs', await t.page.locator('#pane-local').isVisible());
  await t.page.keyboard.press('ArrowRight');
  check('arrow keys switch back', await t.page.locator('#form').isVisible());
  await t.ctx.close();

  // b. Looking again keeps what was found on screen.
  t = await open(WIDE, '?manual=1');
  await t.native({ type: 'init', servers: [], autoConnect: false, version: '0.1.0' });
  await t.native(
    localStatus({
      state: 'notInstalled',
      installed: false,
      service: false,
      installComplete: false,
      version: null,
      outcome: { kind: 'refused' },
    })
  );
  const cardBefore = await t.page.evaluate(() =>
    Math.round(document.querySelector('.card').getBoundingClientRect().height)
  );
  await t.page.click('#local-check');
  const during = await t.page.evaluate(() => ({
    card: Math.round(document.querySelector('.card').getBoundingClientRect().height),
    title: document.querySelector('#local-title').textContent,
    install: !document.querySelector('#local-install').hidden,
    checkDisabled: document.querySelector('#local-check').disabled,
    dot: document.querySelector('#local-dot').className,
  }));
  check(
    'Check again: the card keeps its size and its text',
    during.card === cardBefore && /not installed/.test(during.title) && during.install,
    { cardBefore, during }
  );
  check(
    'Check again: the dot shows the look and the button waits',
    /busy/.test(during.dot) && during.checkDisabled,
    during
  );
  check(
    'Check again asks for the deep look',
    (await t.posted('localStatus')).some((m) => m.deep === true)
  );
  await t.native(localStatus({}));
  check(
    'Check again: the new status replaces the old one',
    (await t.page.textContent('#local-title')).includes('is running') && !(await t.page.isDisabled('#local-check'))
  );
  await t.ctx.close();

  // c. Return and Esc.
  t = await open(WIDE, '?manual=1');
  await t.native({ type: 'init', servers: [], autoConnect: false, version: '0.1.0' });
  await t.native(localStatus({}));
  await t.page.keyboard.press('Enter');
  check(
    'Return on This Mac presses Open Codeman',
    (await t.posted('connect')).length === 1 && (await t.posted('connect'))[0].url === 'http://127.0.0.1:3000/'
  );
  check('the connect shows Cancel', await t.page.locator('#cancel').isVisible());
  await t.page.keyboard.press('Escape');
  check(
    'Esc cancels the connect',
    (await t.posted('cancel')).length === 1 && !(await t.page.locator('#cancel').isVisible())
  );
  await t.page.keyboard.press('Escape');
  check('Esc with nothing to cancel does nothing', (await t.posted('cancel')).length === 1);
  await t.native(
    localStatus({
      state: 'notInstalled',
      installed: false,
      service: false,
      installComplete: false,
      version: null,
      outcome: { kind: 'refused' },
    })
  );
  await t.page.keyboard.press('Enter');
  check(
    'Return never starts an install',
    (await t.posted('installLocal')).length === 0 && (await t.page.locator('#local-install').isVisible())
  );
  await t.native(
    localStatus({
      state: 'runningElsewhere',
      version: null,
      outcome: { kind: 'refused' },
      found: [
        { url: 'https://127.0.0.1:4000/', version: null, state: 'certificate', isDefault: false },
        { url: 'http://127.0.0.1:5000/', version: '1.49.0', state: 'running', isDefault: false },
      ],
    })
  );
  await t.page.keyboard.press('Enter');
  check(
    'Return connects to the server found on this Mac when that is the main action',
    (await t.posted('connect')).length === 2 && (await t.posted('connect'))[1].url === 'http://127.0.0.1:5000/',
    await t.posted('connect')
  );
  await t.page.keyboard.press('Escape');
  await t.native(localStatus({ state: 'stopped', version: null, outcome: { kind: 'refused' } }));
  await t.page.focus('#local-check');
  await t.page.keyboard.press('Enter');
  check(
    'Return on a focused button presses that button, not the main one',
    (await t.posted('startServer')).length === 0 && (await t.posted('localStatus')).some((m) => m.deep === true),
    { start: await t.posted('startServer'), looks: await t.posted('localStatus') }
  );
  await t.ctx.close();

  // d. A connect answer goes to the tab that asked.
  t = await open(WIDE, '?manual=1');
  await t.native({ type: 'init', servers: [{ url: 'http://build-box:3000/' }], autoConnect: false, version: '0.1.0' });
  await t.page.click('#connect');
  await t.page.click('#tab-local');
  const looksBefore = (await t.posted('localStatus')).length;
  await t.native({ type: 'probeResult', url: 'http://build-box:3000/', outcome: { kind: 'refused' }, canStart: false });
  check(
    'a remote failure is shown on Another machine, even after a look at This Mac',
    (await t.page.locator('#form').isVisible()) &&
      (await t.page.textContent('#status')).includes('Nothing is answering')
  );
  check('a remote failure does not look at this Mac again', (await t.posted('localStatus')).length === looksBefore, {
    looksBefore,
    now: (await t.posted('localStatus')).length,
  });
  await t.ctx.close();

  // e. The login block never claims a saved password for another server.
  t = await open(WIDE, '?manual=1');
  await t.native({
    type: 'init',
    servers: [{ url: 'https://box.tail.ts.net/', username: 'admin', hasSavedPassword: true }],
    autoConnect: false,
    version: '0.1.0',
  });
  check(
    'a saved server shows its saved password',
    (await t.page.getAttribute('#password', 'placeholder')) === 'saved in Keychain'
  );
  await t.page.fill('#url', 'http://192.168.1.50:3000');
  check(
    'another address typed: no saved password claimed',
    (await t.page.getAttribute('#password', 'placeholder')) === ''
  );
  await t.page.fill('#url', 'https://box.tail.ts.net/');
  check(
    'the saved address typed again: its saved password is back',
    (await t.page.getAttribute('#password', 'placeholder')) === 'saved in Keychain'
  );
  await t.native({ type: 'servers', servers: [] });
  check(
    'the server forgotten: no saved password claimed',
    (await t.page.getAttribute('#password', 'placeholder')) === ''
  );
  await t.ctx.close();

  // f. Opening keeps the spinner; a long token stays inside the card; the status text can be selected.
  t = await open(WIDE, '?manual=1');
  await t.native({ type: 'init', servers: [{ url: 'http://build-box:3000/' }], autoConnect: false, version: '0.1.0' });
  await t.page.click('#connect');
  await t.native({ type: 'opening', version: '1.48.0' });
  check('Opening Codeman shows the spinner', await t.page.locator('#spinner').isVisible());
  await t.native({ type: 'error', message: 'Could not open https://sso.example.com/login?return=' + 'x'.repeat(400) });
  const fit = await t.page.evaluate(() => ({
    right: document.querySelector('#status-text').getBoundingClientRect().right,
    card: document.querySelector('.card').getBoundingClientRect().right,
    sideways: document.documentElement.scrollWidth > window.innerWidth,
    select: getComputedStyle(document.querySelector('#status-text')).userSelect,
  }));
  check('a long unbroken token wraps inside the card', fit.right <= fit.card && !fit.sideways, fit);
  check('the status text can be selected for a bug report', fit.select === 'text', fit.select);
  await t.ctx.close();

  // g. A login over plain http to another machine says so; not for this Mac, not for https.
  t = await open(WIDE, '?manual=1');
  await t.native({ type: 'init', servers: [], autoConnect: false, version: '0.1.0' });
  await t.page.click('#tab-remote');
  const ask = async (url) => {
    await t.page.fill('#url', url);
    await t.page.click('#connect');
    await t.native({ type: 'probeResult', url: url, outcome: { kind: 'needsLogin' }, canStart: false });
    return t.page.textContent('#status');
  };
  check(
    'http to another machine: the login notice says unencrypted',
    (await ask('http://build-box:3000/')).includes('unencrypted')
  );
  check('https: no such notice', !(await ask('https://box.tail.ts.net/')).includes('unencrypted'));
  check('this Mac over http: no such notice', !(await ask('http://127.0.0.1:3000/')).includes('unencrypted'));
  await t.ctx.close();

  // h. The SSH install: what the app would drop is refused here, and a failure is shown on its tab.
  t = await open(WIDE, '?manual=1');
  await t.native({ type: 'init', servers: [], autoConnect: false, version: '0.1.0' });
  await t.page.click('#tab-remote');
  await t.page.click('#elsewhere summary');
  await t.page.click('#ssh-install');
  check(
    'an empty SSH login is refused on the page',
    (await t.posted('installRemote')).length === 0 &&
      (await t.page.textContent('#status')).includes('user@host') &&
      !(await t.page.isDisabled('#ssh-install'))
  );
  await t.page.fill('#ssh', 'kay@build-box');
  await t.page.click('#ssh-install');
  check('a normal SSH login goes out', (await t.posted('installRemote')).length === 1);
  await t.page.click('#tab-local');
  await t.native({ type: 'installFailed', remote: true, message: 'Could not open Terminal.' });
  check(
    'a failed SSH install is shown on Another machine',
    (await t.page.locator('#form').isVisible()) &&
      (await t.page.textContent('#status')).includes('Could not open Terminal') &&
      !(await t.page.isDisabled('#ssh-install'))
  );
  check('ssh install: no page errors', t.errors.length === 0, t.errors);
  await t.ctx.close();

  // j. A Codeman that is still starting: shown as that, looked at again, and opened if that was asked.
  t = await open(WIDE, '');
  await t.native({ type: 'init', servers: [{ url: 'http://127.0.0.1:3000/' }], autoConnect: true, version: '0.1.0' });
  await t.native({ type: 'probeResult', url: 'http://127.0.0.1:3000/', outcome: { kind: 'refused' }, canStart: true });
  await t.native(localStatus({ state: 'starting', version: null, outcome: { kind: 'refused' } }));
  check(
    'starting: the tab says so and offers no Start',
    (await t.page.textContent('#local-title')).includes('is starting') &&
      !(await t.page.locator('#local-start').isVisible()) &&
      /busy/.test(await t.page.getAttribute('#local-dot', 'class'))
  );
  const looks0 = (await t.posted('localStatus')).length;
  await t.page.waitForTimeout(1250);
  const again = await t.posted('localStatus');
  check(
    'starting: the page looks again by itself, the quick way',
    again.length === looks0 + 1 && again[again.length - 1].quick === true,
    again
  );
  await t.native(localStatus({}));
  check(
    'starting, then up: the connect that was refused is made again',
    (await t.posted('connect')).length === 2 && (await t.posted('connect'))[1].url === 'http://127.0.0.1:3000/'
  );
  await t.native({ type: 'probeResult', url: 'http://127.0.0.1:3000/', outcome: { kind: 'refused' }, canStart: true });
  await t.native(localStatus({ state: 'stopped', version: null, outcome: { kind: 'refused' } }));
  await t.native(localStatus({}));
  check(
    'a server that was stopped, not starting, is never opened by itself',
    (await t.posted('connect')).length === 2 && (await t.page.locator('#local-open').isVisible())
  );
  await t.ctx.close();

  t = await open(WIDE, '?manual=1');
  await t.native({ type: 'init', servers: [], autoConnect: false, version: '0.1.0' });
  await t.native(localStatus({ state: 'starting', version: null, outcome: { kind: 'refused' } }));
  await t.native(localStatus({}));
  check(
    'starting with nobody asking to open: Open is offered, nothing connects',
    (await t.posted('connect')).length === 0 && (await t.page.locator('#local-open').isVisible())
  );
  await t.ctx.close();

  // k. Two spellings of one server are one server: the page guesses the scheme as the app does.
  t = await open(WIDE, '?manual=1');
  await t.native({ type: 'init', servers: [], autoConnect: false, version: '0.1.0' });
  await t.page.click('#tab-remote');
  const sameAfterStart = async (typed, started) => {
    await t.page.fill('#url', typed);
    await t.page.click('#connect');
    await t.native({ type: 'probeResult', url: started, outcome: { kind: 'refused' }, canStart: true });
    const before = (await t.posted('connect')).length;
    await t.page.click('#start');
    await t.native({ type: 'serverStartResult', ok: true, output: '', url: started });
    const sent = (await t.posted('connect')).slice(before);
    await t.native({ type: 'probeResult', url: started, outcome: { kind: 'refused' }, canStart: false });
    return sent.length === 1;
  };
  check(
    'a tailnet name alone is the https server',
    await sameAfterStart('box.tail.ts.net', 'https://box.tail.ts.net/')
  );
  check(
    'a tailnet name with a port is the http server',
    await sameAfterStart('box.tail.ts.net:3000', 'http://box.tail.ts.net:3000/')
  );
  check(
    'a tailnet name with a port is not the https server',
    !(await sameAfterStart('box.tail.ts.net:3000', 'https://box.tail.ts.net:3000/'))
  );
  await t.ctx.close();

  // i. Screen readers: the This Mac result is a live region, Forget buttons are named.
  t = await open(WIDE, '?manual=1');
  await t.native({ type: 'init', servers: [{ url: 'http://build-box:3000/' }], autoConnect: false, version: '0.1.0' });
  check(
    'the This Mac result is announced',
    (await t.page.getAttribute('#local-title >> xpath=..', 'role')) === 'status'
  );
  check(
    'a Forget button is named after its server',
    (await t.page.getAttribute('#recent .chip .x', 'aria-label')) === 'Forget build-box:3000'
  );
  check('the recent servers are a labelled group', (await t.page.getAttribute('#recent', 'role')) === 'group');
  await t.ctx.close();
}

// A WebKit without class static blocks (older than Safari 16.4), which
// Codeman's terminal needs: the page says so and never connects.
async function tooOld(browser: Browser, how: 'setter' | 'syntax') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.name + ': ' + e.message));
  if (how === 'syntax') {
    // The probe script made unparseable at the token an older parser rejects.
    const probe = 'void class { static { window.__codemanStaticBlocks = true; } };';
    if (!html.includes(probe)) throw new Error('probe script not found in connect.html');
    await serveConnect(page, html.replace(probe, 'void class { static @{ window.__codemanStaticBlocks = true; } };'));
  } else {
    // The static block's assignment lands in a setter that drops it, as if it never ran.
    await page.addInitScript(() =>
      Object.defineProperty(window, '__codemanStaticBlocks', {
        get: function () {
          return undefined;
        },
        set: function () {},
        configurable: false,
      })
    );
    await serveConnect(page);
  }
  await page.addInitScript(IPC_STUB);
  const posted = () => page.evaluate(() => window.__posted.filter((m) => m.cmd !== 'localStatus'));
  const native = (msg) => page.evaluate((m) => window.__codemanDesktop.onNative(m), msg);
  const tag = how === 'syntax' ? ' (probe is a SyntaxError)' : ' (static block never ran)';

  await page.goto('http://app.test/index.html');
  check('too old: still posts ready' + tag, JSON.stringify(await posted()) === '[{"cmd":"ready"}]', await posted());
  check(
    'too old: the notice is shown, verbatim' + tag,
    (await page.locator('#webkit').isVisible()) && (await page.textContent('#webkit')) === WEBKIT_NOTICE,
    await page.textContent('#webkit')
  );
  check('too old: Connect disabled at load' + tag, await page.isDisabled('#connect'));
  await native({
    type: 'init',
    servers: [
      { url: 'http://127.0.0.1:3000/', username: 'admin', hasSavedPassword: true },
      { url: 'http://10.0.0.5:3000/' },
    ],
    autoConnect: true,
    startFullscreen: false,
    version: '0.1.0',
  });
  check('too old: init with auto-connect does not connect' + tag, (await posted()).length === 1, await posted());
  await native({
    type: 'localStatus',
    status: {
      url: 'http://127.0.0.1:3000/',
      state: 'notInstalled',
      version: null,
      service: false,
      installed: false,
      installComplete: false,
      outcome: { kind: 'refused' },
    },
  });
  check(
    'too old: This Mac offers Install but it is disabled' + tag,
    (await page.locator('#local-install').isVisible()) && (await page.isDisabled('#local-install'))
  );
  await native({
    type: 'localStatus',
    status: {
      url: 'http://127.0.0.1:3000/',
      state: 'running',
      version: '1.47.0',
      service: true,
      installed: true,
      installComplete: true,
      outcome: { kind: 'ok', version: '1.47.0' },
    },
  });
  check(
    'too old: Open is disabled too' + tag,
    (await page.locator('#local-open').isVisible()) && (await page.isDisabled('#local-open'))
  );
  await page.click('#tab-remote');
  check(
    'too old: Connect still disabled after init, notice still shown' + tag,
    (await page.isDisabled('#connect')) && (await page.locator('#webkit').isVisible())
  );
  check(
    'too old: chips cannot connect, forget still works' + tag,
    await page.evaluate(() =>
      Array.from(document.querySelectorAll('#recent button')).every((b) => b.disabled === !b.classList.contains('x'))
    )
  );
  let n0 = (await posted()).length;
  await page.evaluate(() => {
    document.getElementById('form').requestSubmit();
    const b = document.querySelector('.chip button');
    b.disabled = false;
    b.click();
  });
  await page.focus('#url');
  await page.keyboard.press('Enter');
  check(
    'too old: submit, Enter and a re-enabled chip post nothing' + tag,
    (await posted()).length === n0,
    (await posted()).slice(n0)
  );
  for (const m of [
    { type: 'error', message: 'x' },
    { type: 'probeResult', url: 'http://127.0.0.1:3000/', outcome: { kind: 'maybeHttps' }, canStart: false },
    { type: 'serverStartResult', ok: true, output: '', url: 'http://127.0.0.1:3000/' },
  ]) {
    await native(m);
  }
  check(
    'too old: error, probe and start results keep Connect disabled, offer no Use button and connect nothing' + tag,
    (await page.isDisabled('#connect')) &&
      !(await page.locator('#suggest').isVisible()) &&
      (await page.isDisabled('#suggest')) &&
      (await posted()).length === n0 &&
      (await page.locator('#webkit').isVisible()),
    (await posted()).slice(n0)
  );
  await page.click('#auto');
  await page.click('.chip button.x');
  const p = (await posted()).slice(n0);
  check(
    'too old: preferences and forget still reach the app' + tag,
    p.length === 2 && p[0].cmd === 'setAutoConnect' && p[1].cmd === 'forget',
    p
  );
  if (how === 'syntax') {
    check(
      "too old: the only page error is the probe's SyntaxError" + tag,
      errors.length === 1 && /^SyntaxError/.test(errors[0]),
      errors
    );
  } else {
    check('too old: no page errors' + tag, errors.length === 0, errors);
  }
  await ctx.close();
}

describe('Codeman Desktop connect page', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  const walk = (name: string, steps: (browser: Browser) => Promise<void>) =>
    it(
      name,
      async () => {
        failed.length = 0;
        await steps(browser);
        expect(failed).toEqual([]);
      },
      180_000
    );

  walk('every state of both tabs, from first run to an install', everyState);
  walk('a layout that holds still, and fields too long for the app', layoutAndLimits);
  walk('double clicks, keys, tabs, a starting server and screen readers', clicksKeysAndStates);
  walk('a WebKit too old for Codeman, found by a setter', (b) => tooOld(b, 'setter'));
  walk('a WebKit too old for Codeman, found by a syntax error', (b) => tooOld(b, 'syntax'));
});
