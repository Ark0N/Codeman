/**
 * @fileoverview Security notices: a designed warning card per notice in the HAND-maintained
 * src/web/public/security-notices.json (the first: OpenCode's Console breach, October 2026),
 * or a warning section INSIDE the once-per-release update toast when that toast shows.
 *
 * What is pinned, and why it matters:
 *  - The pure selection (`CodemanSecurityNotices.select`, constants.js), loaded from the
 *    SHIPPED file: a notice naming a CLI shows ONLY when `available[cli] === true` (absent,
 *    unknown and false all mean "not installed": a warning about software you do not have
 *    is noise), a notice with no CLI shows to everyone, dates are inclusive local days
 *    (start of `published` to the END of `expires`), seen ids are skipped, malformed
 *    entries and non-https links are dropped rather than repaired, and zh-CN takes the
 *    entry's own strings field by field.
 *  - The pure surface plan (`CodemanSecurityNotices.plan`): the update toast shows exactly
 *    when checkWhatsNew always showed it, every notice then rides inside it, and otherwise
 *    each notice gets its own card. A notice is never on both surfaces.
 *  - The shipped JSON itself: it parses, ids are unique, links are https, dates are real
 *    days, and every `cli` is a real stock registry id (a typo would silently show the
 *    notice to nobody).
 *  - The wiring (settings-ui.js checkWhatsNew + panels-ui.js cards): fresh installs and
 *    same-version reloads get the card, an existing install's update toast carries the
 *    notice, the update toast WITHOUT a notice is byte-for-byte the toast it was before,
 *    a notice is recorded as seen only on a user action (never on show), storage blocked
 *    shows nothing, the notice text is textContent and left alone by i18n.js, and the
 *    card's own copy is translated.
 *
 * The real modules run inside a JSDOM window (runScripts: 'outside-only'). Port: none.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const PUBLIC = join(process.cwd(), 'src/web/public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');
const CONSTANTS = read('constants.js');
const NOTICES_FILE = JSON.parse(read('security-notices.json')) as { notices: Notice[] };

type Notice = Record<string, unknown>;
type Shown = { id: string; title: string; message: string; label: string; url: string };
type SelectOpts = { available?: Record<string, unknown>; seen?: Iterable<string>; now?: number; lang?: string };
type PlanState = { seenVersion?: string | null; runningVersion: string; notes?: unknown; notices?: unknown[] };
type Plan = { recordVersion: boolean; update: boolean; updateNotices: unknown[]; cards: unknown[] };
type Core = { select: (notices: unknown, opts?: SelectOpts) => Shown[]; plan: (state: PlanState) => Plan };

function loadCore(): Core {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(CONSTANTS, context, { filename: 'constants.js' });
  return (context.window as { CodemanSecurityNotices: Core }).CodemanSecurityNotices;
}

const core = loadCore();

/** Local-time instants, the way the core reads `YYYY-MM-DD` days. */
const at = (y: number, m: number, d: number, h = 12, min = 0, s = 0, ms = 0) =>
  new Date(y, m - 1, d, h, min, s, ms).getTime();
const NOW = at(2026, 10, 20);

const notice = (over: Notice = {}): Notice => ({
  id: 'n1',
  severity: 'warning',
  published: '2026-10-18',
  expires: '2026-12-31',
  message: 'Rotate your keys.',
  link: { label: 'Read more', url: 'https://example.com/notice' },
  ...over,
});

const ids = (shown: Array<{ id: string }>) => shown.map((n) => n.id);

describe('CodemanSecurityNotices.select (pure)', () => {
  describe('a notice naming a CLI', () => {
    const withCli = [notice({ cli: 'somecli' })];

    it('shows when that CLI is installed (strictly true)', () => {
      expect(ids(core.select(withCli, { available: { somecli: true }, now: NOW }))).toEqual(['n1']);
    });

    it('stays hidden when the CLI is not installed', () => {
      expect(core.select(withCli, { available: { somecli: false }, now: NOW })).toEqual([]);
    });

    it('stays hidden when availability is unknown: no entry, no map, or a truthy non-true value', () => {
      expect(core.select(withCli, { available: { other: true }, now: NOW })).toEqual([]);
      expect(core.select(withCli, { now: NOW })).toEqual([]);
      expect(core.select(withCli, { available: undefined, now: NOW })).toEqual([]);
      expect(core.select(withCli, { available: { somecli: 'true' }, now: NOW })).toEqual([]);
      expect(core.select(withCli, { available: { somecli: 1 }, now: NOW })).toEqual([]);
    });

    it('never matches a prototype key as an installed CLI', () => {
      expect(core.select([notice({ cli: 'constructor' })], { available: {}, now: NOW })).toEqual([]);
    });
  });

  it('shows a notice without a CLI to everyone, whatever is installed', () => {
    expect(ids(core.select([notice()], { now: NOW }))).toEqual(['n1']);
    expect(ids(core.select([notice()], { available: { somecli: false }, now: NOW }))).toEqual(['n1']);
  });

  it('returns exactly id, title, message, label and url, trimmed', () => {
    const shown = core.select(
      [
        notice({
          id: ' n1 ',
          title: ' Heads up ',
          message: ' Hi. ',
          link: { label: ' Go ', url: ' https://example.com/x ' },
        }),
      ],
      { now: NOW }
    );
    expect(shown).toEqual([{ id: 'n1', title: 'Heads up', message: 'Hi.', label: 'Go', url: 'https://example.com/x' }]);
  });

  it('gives a notice without a title an empty one', () => {
    expect(core.select([notice()], { now: NOW })[0].title).toBe('');
  });

  describe('dates (inclusive local days)', () => {
    const list = [notice()];

    it('shows from the very start of the published day', () => {
      expect(ids(core.select(list, { now: at(2026, 10, 18, 0, 0, 0, 0) }))).toEqual(['n1']);
      expect(core.select(list, { now: at(2026, 10, 18, 0, 0, 0, 0) - 1 })).toEqual([]);
    });

    it('shows until the very end of the expires day, then never again', () => {
      expect(ids(core.select(list, { now: at(2026, 12, 31, 23, 59, 59, 999) }))).toEqual(['n1']);
      expect(core.select(list, { now: at(2026, 12, 31, 23, 59, 59, 999) + 1 })).toEqual([]);
      expect(core.select(list, { now: at(2027, 6, 1) })).toEqual([]);
    });

    it('shows a one-day notice all of that day', () => {
      const oneDay = [notice({ published: '2026-10-20', expires: '2026-10-20' })];
      expect(ids(core.select(oneDay, { now: at(2026, 10, 20, 0, 0) }))).toEqual(['n1']);
      expect(ids(core.select(oneDay, { now: at(2026, 10, 20, 23, 59, 59, 999) }))).toEqual(['n1']);
    });

    it('falls back to the current time when now is not a finite number', () => {
      const always = [notice({ published: '2000-01-01', expires: '2999-12-31' })];
      expect(ids(core.select(always))).toEqual(['n1']);
      expect(ids(core.select(always, { now: Number.NaN }))).toEqual(['n1']);
    });
  });

  it('skips the ids the user has already closed or followed', () => {
    const list = [notice(), notice({ id: 'n2' })];
    expect(ids(core.select(list, { seen: ['n1'], now: NOW }))).toEqual(['n2']);
    expect(ids(core.select(list, { seen: new Set(['n2']), now: NOW }))).toEqual(['n1']);
    expect(core.select(list, { seen: ['n1', 'n2'], now: NOW })).toEqual([]);
    // A string is not a list of ids (it would iterate as characters).
    expect(ids(core.select(list, { seen: 'n1' as unknown as string[], now: NOW }))).toEqual(['n1', 'n2']);
  });

  it('keeps file order and shows a repeated id once, as its first entry', () => {
    const list = [notice({ id: 'b' }), notice({ id: 'a' }), notice({ id: 'b', message: 'Second.' })];
    const shown = core.select(list, { now: NOW });
    expect(ids(shown)).toEqual(['b', 'a']);
    expect(shown[0].message).toBe('Rotate your keys.');
  });

  describe('malformed entries are skipped, never repaired', () => {
    const cases: Array<[string, Notice | unknown]> = [
      ['no id', notice({ id: undefined })],
      ['a blank id', notice({ id: '  ' })],
      ['a numeric id', notice({ id: 7 })],
      ['no message', notice({ message: undefined })],
      ['a blank message', notice({ message: '' })],
      ['a blank title', notice({ title: ' ' })],
      ['a title that is not a string', notice({ title: 42 })],
      ['no link', notice({ link: undefined })],
      ['a link that is a string', notice({ link: 'https://example.com/' })],
      ['a link without a label', notice({ link: { url: 'https://example.com/' } })],
      ['a link without a url', notice({ link: { label: 'Go' } })],
      ['an http link', notice({ link: { label: 'Go', url: 'http://example.com/notice' } })],
      ['a javascript: link', notice({ link: { label: 'Go', url: 'javascript:alert(1)' } })],
      ['a protocol-relative link', notice({ link: { label: 'Go', url: '//example.com/' } })],
      ['a link with userinfo', notice({ link: { label: 'Go', url: 'https://user@evil.example/' } })],
      ['a link with whitespace inside', notice({ link: { label: 'Go', url: 'https://example.com/a b' } })],
      ['no published date', notice({ published: undefined })],
      ['no expires date', notice({ expires: undefined })],
      ['a month 13', notice({ expires: '2026-13-01' })],
      ['a day that does not exist', notice({ expires: '2026-02-30' })],
      ['a non-ISO date', notice({ published: '18.10.2026' })],
      ['a timestamp, not a day', notice({ published: '2026-10-18T00:00:00Z' })],
      ['a cli that is not a string', notice({ cli: 5 })],
      ['a cli that is not a registry id', notice({ cli: 'Open Code' })],
      ['an array', []],
      ['null', null],
      ['a string', 'notice'],
    ];
    for (const [what, entry] of cases) {
      it(`skips ${what}`, () => {
        // The good entry beside it proves the bad one is skipped, not the whole list.
        expect(ids(core.select([entry, notice({ id: 'ok' })], { available: { somecli: true }, now: NOW }))).toEqual([
          'ok',
        ]);
      });
    }

    it('returns nothing for a notices value that is not an array', () => {
      expect(core.select(undefined, { now: NOW })).toEqual([]);
      expect(core.select({ notices: [notice()] }, { now: NOW })).toEqual([]);
      expect(core.select('[]', { now: NOW })).toEqual([]);
    });
  });

  describe('language', () => {
    const zh = { 'zh-CN': { title: '注意', message: '请更换密钥。', label: '了解更多' } };

    it('takes the zh-CN title, message and label under zh-CN', () => {
      const [shown] = core.select([notice({ title: 'Heads up', i18n: zh })], { lang: 'zh-CN', now: NOW });
      expect(shown).toMatchObject({
        title: '注意',
        message: '请更换密钥。',
        label: '了解更多',
        url: 'https://example.com/notice',
      });
    });

    it('falls back to English field by field when a translation is missing or blank', () => {
      const onlyMessage = { 'zh-CN': { message: '请更换密钥。', label: ' ' } };
      expect(
        core.select([notice({ title: 'Heads up', i18n: onlyMessage })], { lang: 'zh-CN', now: NOW })[0]
      ).toMatchObject({ title: 'Heads up', message: '请更换密钥。', label: 'Read more' });
      expect(core.select([notice()], { lang: 'zh-CN', now: NOW })[0]).toMatchObject({
        message: 'Rotate your keys.',
        label: 'Read more',
      });
      expect(core.select([notice({ i18n: 'nope' })], { lang: 'zh-CN', now: NOW })[0].message).toBe('Rotate your keys.');
    });

    it('stays English in English and in a language it has no strings for', () => {
      expect(core.select([notice({ i18n: zh })], { lang: 'en', now: NOW })[0].message).toBe('Rotate your keys.');
      expect(core.select([notice({ i18n: zh })], { now: NOW })[0].message).toBe('Rotate your keys.');
      expect(core.select([notice({ i18n: zh })], { lang: 'fr', now: NOW })[0].message).toBe('Rotate your keys.');
    });
  });
});

describe('CodemanSecurityNotices.plan (pure): which surface carries each notice', () => {
  const NOTES = { version: '1.43.0', highlights: ['Alpha'] };
  const A = { id: 'a' };
  const B = { id: 'b' };

  it('puts every notice inside the update toast when an existing install sees a new version', () => {
    expect(core.plan({ seenVersion: '1.42.0', runningVersion: '1.43.0', notes: NOTES, notices: [A, B] })).toEqual({
      recordVersion: true,
      update: true,
      updateNotices: [A, B],
      cards: [],
    });
  });

  it('shows the plain update toast when no notice is selected', () => {
    expect(core.plan({ seenVersion: '1.42.0', runningVersion: '1.43.0', notes: NOTES, notices: [] })).toEqual({
      recordVersion: true,
      update: true,
      updateNotices: [],
      cards: [],
    });
  });

  it('gives a fresh install (no seen version) cards and records the version, with no update toast', () => {
    for (const seenVersion of [null, undefined, '']) {
      expect(core.plan({ seenVersion, runningVersion: '1.43.0', notes: NOTES, notices: [A] })).toEqual({
        recordVersion: true,
        update: false,
        updateNotices: [],
        cards: [A],
      });
    }
  });

  it('gives a reload on the same version cards and records nothing', () => {
    expect(core.plan({ seenVersion: '1.43.0', runningVersion: '1.43.0', notes: NOTES, notices: [A] })).toEqual({
      recordVersion: false,
      update: false,
      updateNotices: [],
      cards: [A],
    });
  });

  it('falls back to cards, recording no version, when the notes cannot carry a toast', () => {
    for (const notes of [
      null,
      undefined,
      { version: '1.42.9', highlights: ['Old'] },
      { version: '1.43.0', highlights: [] },
      { version: '1.43.0', highlights: 'Alpha' },
      { version: '1.43.0' },
    ]) {
      expect(core.plan({ seenVersion: '1.42.0', runningVersion: '1.43.0', notes, notices: [A] })).toEqual({
        recordVersion: false,
        update: false,
        updateNotices: [],
        cards: [A],
      });
    }
  });

  it('never shows one notice on both surfaces, and never drops one', () => {
    const notices = [A, B];
    for (const seenVersion of [null, '1.42.0', '1.43.0']) {
      for (const notes of [null, NOTES, { version: '1.43.0', highlights: [] }]) {
        const plan = core.plan({ seenVersion, runningVersion: '1.43.0', notes, notices });
        const all = [...plan.updateNotices, ...plan.cards] as Array<{ id: string }>;
        expect(ids(all).sort(), JSON.stringify({ seenVersion, notes })).toEqual(['a', 'b']);
        expect(plan.updateNotices.length > 0 && plan.cards.length > 0).toBe(false);
      }
    }
  });

  it('tolerates a missing notices list', () => {
    expect(core.plan({ seenVersion: '1.42.0', runningVersion: '1.43.0', notes: NOTES }).updateNotices).toEqual([]);
  });
});

describe('the shipped security-notices.json', () => {
  const notices = NOTICES_FILE.notices;
  const stockIds = new Set(STOCK_CLIS.map((entry) => entry.id as string));
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const realDay = (value: unknown) => {
    if (typeof value !== 'string' || !DAY.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  };
  const nonBlank = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

  it('is a list of notices with unique, stable ids', () => {
    expect(Array.isArray(notices)).toBe(true);
    expect(notices.length).toBeGreaterThan(0);
    const all = notices.map((n) => n.id);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('gives every notice a warning severity, an https link and real dates in order', () => {
    for (const n of notices) {
      expect(n.severity, String(n.id)).toBe('warning');
      expect(nonBlank(n.message), String(n.id)).toBe(true);
      if (n.title !== undefined) expect(nonBlank(n.title), String(n.id)).toBe(true);
      const link = n.link as { label?: unknown; url?: unknown };
      expect(nonBlank(link?.label), String(n.id)).toBe(true);
      expect(typeof link?.url === 'string' && new URL(link.url).protocol, String(n.id)).toBe('https:');
      expect(realDay(n.published), `${String(n.id)} published`).toBe(true);
      expect(realDay(n.expires), `${String(n.id)} expires`).toBe(true);
      expect(String(n.expires) >= String(n.published), String(n.id)).toBe(true);
    }
  });

  it('names only real stock CLI ids, so a typo cannot hide a notice from everyone', () => {
    for (const n of notices) {
      if (n.cli === undefined) continue;
      expect(stockIds.has(n.cli as string), `${String(n.id)}: cli "${String(n.cli)}"`).toBe(true);
    }
  });

  it('translates only into languages the UI has, with every string the English entry has', () => {
    for (const n of notices) {
      if (n.i18n === undefined) continue;
      const langs = n.i18n as Record<string, { title?: unknown; message?: unknown; label?: unknown }>;
      for (const [lang, strings] of Object.entries(langs)) {
        expect(lang, String(n.id)).toBe('zh-CN');
        expect(nonBlank(strings.message), `${String(n.id)} ${lang} message`).toBe(true);
        expect(nonBlank(strings.label), `${String(n.id)} ${lang} label`).toBe(true);
        if (n.title !== undefined) expect(nonBlank(strings.title), `${String(n.id)} ${lang} title`).toBe(true);
      }
    }
  });

  it('passes the shipped selection on its published day for a browser with its CLI', () => {
    // A field the core rejects would make the notice silently show to nobody.
    for (const n of notices) {
      const [y, m, d] = String(n.published).split('-').map(Number);
      const available = typeof n.cli === 'string' ? { [n.cli]: true } : {};
      expect(ids(core.select([n], { available, now: at(y, m, d) })), String(n.id)).toEqual([n.id]);
    }
  });

  it('shows the OpenCode notice, with its title, only to OpenCode users', () => {
    const breach = notices.find((n) => n.id === 'opencode-console-breach-2026-10');
    expect(breach?.cli).toBe('opencode');
    const [shown] = core.select(notices, { available: { opencode: true }, now: NOW });
    expect(shown).toMatchObject({
      id: 'opencode-console-breach-2026-10',
      title: 'OpenCode Console breach: check your API keys',
      label: "Read OpenCode's notice",
      url: 'https://x.com/opencode/status/2111519637049319818',
    });
    expect(core.select(notices, { available: { opencode: true }, now: NOW, lang: 'zh-CN' })[0].title).toBe(
      'OpenCode Console 遭入侵：请检查你的 API 密钥'
    );
    expect(core.select(notices, { available: { opencode: false, claude: true }, now: NOW })).toEqual([]);
    expect(core.select(notices, { available: {}, now: NOW })).toEqual([]);
    expect(core.select(notices, { available: { opencode: true }, now: at(2027, 1, 1) })).toEqual([]);
  });

  it('is fetched by the page and never generated by the release script', () => {
    const pkg = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    expect(pkg).not.toContain('security-notices');
    expect(read('settings-ui.js')).toContain("fetch(CodemanBase.url('/security-notices.json'), { cache: 'no-cache' })");
  });
});

// ─── Wiring: settings-ui.js checkWhatsNew + panels-ui.js notice cards ───

const SEEN_KEY = 'codeman-security-notices-seen';
const VERSION_KEY = 'codeman-whats-new-seen';
const RUNNING = '1.43.0';
const NOTES = { version: RUNNING, highlights: ['Alpha', 'Beta', 'Gamma', 'Delta'] };
const UPDATE_TEXT = 'Codeman updated to v1.43.0: Alpha · Beta · Gamma (+1 more)';
const RELEASE_URL = 'https://github.com/Ark0N/Codeman/releases/tag/codeman%401.43.0';
const DATA = {
  notices: [
    notice({
      id: 'cli-notice',
      cli: 'somecli',
      title: 'Keys may be exposed',
      i18n: { 'zh-CN': { title: '密钥可能泄露', message: '中文提示。', label: '查看' } },
    }),
  ],
};
/** checkWhatsNew's plain update toast exactly as master rendered it before this feature. */
const PLAIN_UPDATE_TOAST =
  '<div class="toast toast-info"><span class="toast-message">Codeman updated to v1.43.0: Alpha · Beta · Gamma (+1 more)</span>' +
  '<button style="margin-left: 12px; padding: 2px 10px; background: rgba(255, 255, 255, 0.15); border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 3px; color: inherit; cursor: pointer; font-size: 12px;">See what\'s new</button>' +
  '<button class="toast-close" aria-label="Dismiss">×</button></div>';

type Reply = { ok: boolean; body?: unknown } | 'throw';
type WiredApp = {
  isSoloWindow?: boolean;
  checkWhatsNew(version: string): Promise<void>;
  showSecurityNotice(notice: Shown, opts?: { onClose?: (reason: string) => void }): { dismiss(): void };
  showUpdateNotice(opts: { text: string; releaseUrl: string; notices: Shown[]; onNoticeSeen?: (id: string) => void }): {
    dismiss(): void;
  };
};

const windows: Array<{ close(): void }> = [];
afterEach(() => {
  for (const win of windows.splice(0)) win.close();
  vi.restoreAllMocks();
});

interface BootOpts {
  available?: Record<string, unknown> | null;
  storage?: 'blocked';
  seenIds?: unknown;
  /** The version this browser recorded; undefined = a fresh install. */
  seenVersion?: string;
  notices?: Reply;
  notes?: Reply;
  base?: string;
  lang?: 'zh-CN';
  i18n?: boolean;
  /** A detached session window (/session/:id), rendered without __codemanCliAvailable. */
  solo?: boolean;
}

/** constants.js, i18n.js (optional), settings-ui.js and panels-ui.js in one JSDOM page. */
function boot(opts: BootOpts = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window &
    typeof globalThis & { eval(src: string): void; __App: { prototype: object }; [key: string]: unknown };
  windows.push(win);
  // The page's own clock, pinned inside the fixtures' date window: JSDOM gives the window its
  // own Date (vi.setSystemTime never reaches it), and on the real clock every test that expects
  // a card would fail once the fixture's notice expired (2027-01-01).
  win.eval(`Date.now = () => ${NOW};`);
  if (opts.seenIds !== undefined) win.localStorage.setItem(SEEN_KEY, JSON.stringify(opts.seenIds));
  if (opts.seenVersion !== undefined) win.localStorage.setItem(VERSION_KEY, opts.seenVersion);
  if (opts.storage === 'blocked') {
    Object.defineProperty(win, 'localStorage', {
      configurable: true,
      get() {
        throw new win.DOMException('blocked', 'SecurityError');
      },
    });
  }
  const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
  win.fetch = (async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    const reply: Reply = url.endsWith('/whats-new.json')
      ? (opts.notes ?? { ok: true, body: NOTES })
      : (opts.notices ?? { ok: true, body: DATA });
    if (reply === 'throw') throw new TypeError('offline');
    return { ok: reply.ok, json: async () => reply.body };
  }) as unknown as typeof fetch;
  const opened: unknown[][] = [];
  win.open = ((...args: unknown[]) => {
    opened.push(args);
    return null;
  }) as typeof win.open;
  if (opts.base) win.__CODEMAN_BASE__ = opts.base;
  if (opts.available !== null) win.__codemanCliAvailable = opts.available ?? { somecli: true };
  if (opts.lang) win.__codemanLanguage = opts.lang;
  win.eval(
    [
      'var CodemanApp = function CodemanApp() {};',
      CONSTANTS,
      opts.i18n ? read('i18n.js') : '',
      read('settings-ui.js'),
      read('panels-ui.js'),
      'window.__App = CodemanApp;',
    ].join('\n')
  );
  if (opts.i18n) (win.CodemanI18n as { start(): void }).start();
  const app = Object.create(win.__App.prototype) as WiredApp;
  if (opts.solo) app.isSoloWindow = true;
  const doc = win.document;
  const cards = () => Array.from(doc.querySelectorAll<HTMLElement>('.security-notice:not(.update-notice)'));
  const updateCards = () => Array.from(doc.querySelectorAll<HTMLElement>('.security-notice.update-notice'));
  const plainToasts = () => Array.from(doc.querySelectorAll<HTMLElement>('.toast'));
  const button = (root: Element, cls: string) => root.querySelector<HTMLButtonElement>(`button.${cls}`)!;
  const text = (root: Element, cls: string) => root.querySelector(`.${cls}`)?.textContent ?? null;
  const seenIds = () => JSON.parse(dom.window.localStorage.getItem(SEEN_KEY) || 'null') as unknown;
  const seenVersion = () => dom.window.localStorage.getItem(VERSION_KEY);
  return {
    dom,
    win,
    doc,
    app,
    fetchCalls,
    opened,
    cards,
    updateCards,
    plainToasts,
    button,
    text,
    seenIds,
    seenVersion,
  };
}

/** i18n.js translates inserted DOM from a MutationObserver: give it a tick. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const afterClose = () => new Promise((resolve) => setTimeout(resolve, 260));

describe('a browser with no update toast this load: the standalone card', () => {
  it('greets a fresh install with the card, records the version, and does not fetch the notes', async () => {
    const { app, fetchCalls, cards, updateCards, plainToasts, text, button, seenIds, seenVersion } = boot();
    await app.checkWhatsNew(RUNNING);
    expect(fetchCalls).toEqual([{ url: '/security-notices.json', init: { cache: 'no-cache' } }]);
    expect(seenVersion()).toBe(RUNNING);
    expect(plainToasts()).toEqual([]);
    expect(updateCards()).toEqual([]);
    const [card, ...rest] = cards();
    expect(rest).toEqual([]);
    expect(text(card, 'security-notice-eyebrow')).toBe('Security notice');
    expect(text(card, 'security-notice-title')).toBe('Keys may be exposed');
    expect(text(card, 'security-notice-body')).toBe('Rotate your keys.');
    expect(button(card, 'security-notice-primary').textContent).toBe('Read more');
    expect(button(card, 'security-notice-quiet').textContent).toBe('Dismiss');
    expect(button(card, 'security-notice-close').getAttribute('aria-label')).toBe('Close');
    // Nothing is recorded just for appearing.
    expect(seenIds()).toBeNull();
  });

  it('shows it on a reload of the same version while it is unseen, and not once it is seen', async () => {
    const unseen = boot({ seenVersion: RUNNING });
    await unseen.app.checkWhatsNew(RUNNING);
    expect(unseen.cards()).toHaveLength(1);
    expect(unseen.fetchCalls.map((c) => c.url)).toEqual(['/security-notices.json']);

    const seen = boot({ seenVersion: RUNNING, seenIds: ['cli-notice'] });
    await seen.app.checkWhatsNew(RUNNING);
    expect(seen.cards()).toEqual([]);
    expect(seen.plainToasts()).toEqual([]);
  });

  it('is an accessible, sticky card in the toast stack, built from text only', async () => {
    const hostile = {
      notices: [
        notice({
          title: '<b>bold</b>',
          message: '<img src=x onerror="alert(1)">',
          link: { label: '<i>Go</i>', url: 'https://example.com/' },
        }),
      ],
    };
    const { win, doc, app, cards, button } = boot({ notices: { ok: true, body: hostile } });
    const timeout = vi.spyOn(win, 'setTimeout');
    await app.checkWhatsNew(RUNNING);
    const [card] = cards();
    expect(card.parentElement?.className).toBe('toast-container');
    expect(card.getAttribute('role')).toBe('alert');
    expect(card.getAttribute('aria-live')).toBe('assertive');
    expect(card.querySelector('.security-notice-icon svg')).not.toBeNull();
    expect(card.querySelector('img, b, i')).toBeNull();
    expect(card.querySelector('.security-notice-body')!.textContent).toBe('<img src=x onerror="alert(1)">');
    for (const btn of card.querySelectorAll('button')) expect(btn.type).toBe('button');
    expect(button(card, 'security-notice-primary').hasAttribute('data-i18n-skip')).toBe(true);
    expect(timeout.mock.calls.filter(([, delay]) => Number(delay) > 0)).toEqual([]);
    expect(doc.querySelectorAll('.toast-container').length).toBe(1);
  });

  for (const [how, cls, reason] of [
    ['the ×', 'security-notice-close', 'close'],
    ['Dismiss', 'security-notice-quiet', 'dismiss'],
  ] as const) {
    it(`records the notice when the user closes it with ${how} (${reason}), and the next load stays quiet`, async () => {
      const first = boot();
      await first.app.checkWhatsNew(RUNNING);
      const card = first.cards()[0];
      first.button(card, cls).click();
      first.button(card, cls).click(); // a double click while it fades
      expect(first.seenIds()).toEqual(['cli-notice']);
      await afterClose();
      expect(first.cards()).toEqual([]);

      const next = boot({ seenVersion: RUNNING, seenIds: ['cli-notice'] });
      await next.app.checkWhatsNew(RUNNING);
      expect(next.cards()).toEqual([]);
    });
  }

  it('reports a close once, however many times the card is clicked while it fades', async () => {
    for (const cls of ['security-notice-close', 'security-notice-quiet', 'security-notice-primary']) {
      const { app, cards, button, opened } = boot();
      const onClose = vi.fn();
      app.showSecurityNotice(
        { id: 'x', title: '', message: 'm', label: 'Go', url: 'https://example.com/' },
        { onClose }
      );
      const card = cards()[0];
      button(card, cls).click();
      button(card, cls).click();
      button(card, 'security-notice-close').click();
      expect(onClose, cls).toHaveBeenCalledTimes(1);
      // A double click on the link opens it once, not twice.
      expect(opened, cls).toHaveLength(cls === 'security-notice-primary' ? 1 : 0);
    }
  });

  it('draws no link button for a link that is not https, whoever calls it', async () => {
    const { app, cards, opened } = boot();
    const onClose = vi.fn();
    app.showSecurityNotice({ id: 'x', title: '', message: 'm', label: 'Go', url: 'javascript:alert(1)' }, { onClose });
    const card = cards()[0];
    expect(card.querySelector('.security-notice-primary')).toBeNull();
    expect(Array.from(card.querySelectorAll('.security-notice-actions button')).map((b) => b.textContent)).toEqual([
      'Dismiss',
    ]);
    expect(opened).toEqual([]);
  });

  it('opens the link with noopener and noreferrer, records the notice and closes the card', async () => {
    const { app, cards, button, opened, seenIds } = boot({ seenIds: ['older-notice'] });
    await app.checkWhatsNew(RUNNING);
    button(cards()[0], 'security-notice-primary').click();
    expect(opened).toEqual([['https://example.com/notice', '_blank', 'noopener,noreferrer']]);
    expect(seenIds()).toEqual(['older-notice', 'cli-notice']);
    await afterClose();
    expect(cards()).toEqual([]);
  });

  it('merges with ids another tab recorded after this page loaded', async () => {
    const { dom, app, cards, button, seenIds } = boot();
    await app.checkWhatsNew(RUNNING);
    dom.window.localStorage.setItem(SEEN_KEY, JSON.stringify(['from-another-tab']));
    button(cards()[0], 'security-notice-close').click();
    expect(seenIds()).toEqual(['from-another-tab', 'cli-notice']);
  });

  it('records nothing when the card is closed by code rather than by the user', async () => {
    const { app } = boot();
    const onClose = vi.fn();
    app
      .showSecurityNotice({ id: 'x', title: '', message: 'm', label: 'Go', url: 'https://example.com/' }, { onClose })
      .dismiss();
    await afterClose();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('takes the card when the notes cannot carry an update toast, and records no version', async () => {
    for (const notes of [
      { ok: false } as Reply,
      'throw' as Reply,
      { ok: true, body: { version: '9.9.9', highlights: ['x'] } },
    ]) {
      const { app, cards, updateCards, plainToasts, seenVersion } = boot({ seenVersion: '1.42.0', notes });
      await app.checkWhatsNew(RUNNING);
      expect(cards(), JSON.stringify(notes)).toHaveLength(1);
      expect(updateCards()).toEqual([]);
      expect(plainToasts()).toEqual([]);
      expect(seenVersion()).toBe('1.42.0');
    }
  });

  it('treats a corrupt seen value as nothing seen', async () => {
    const { dom, app, cards, button, seenIds } = boot();
    dom.window.localStorage.setItem(SEEN_KEY, '{not json');
    await app.checkWhatsNew(RUNNING);
    expect(cards()).toHaveLength(1);
    button(cards()[0], 'security-notice-close').click();
    expect(seenIds()).toEqual(['cli-notice']);
  });
});

describe('an existing install that sees a new version: the notice rides inside the update toast', () => {
  it('shows ONE notification with the release text, the warning section and both buttons', async () => {
    const { win, app, cards, updateCards, plainToasts, text, seenIds, seenVersion } = boot({ seenVersion: '1.42.0' });
    const timeout = vi.spyOn(win, 'setTimeout');
    await app.checkWhatsNew(RUNNING);
    expect(cards()).toEqual([]);
    expect(plainToasts()).toEqual([]);
    const [card, ...rest] = updateCards();
    expect(rest).toEqual([]);
    expect(card.getAttribute('role')).toBe('alert');
    expect(text(card, 'update-notice-text')).toBe(UPDATE_TEXT);
    const section = card.querySelector('.security-notice-section')!;
    expect(section.querySelector('svg')).not.toBeNull();
    expect(text(section, 'security-notice-eyebrow')).toBe('Security notice');
    expect(text(section, 'security-notice-title')).toBe('Keys may be exposed');
    expect(text(section, 'security-notice-body')).toBe('Rotate your keys.');
    const labels = Array.from(card.querySelectorAll('.security-notice-actions button')).map((b) => b.textContent);
    expect(labels).toEqual(['Read more', "See what's new"]);
    // The version is recorded on show, as checkWhatsNew always did; the notice is not.
    expect(seenVersion()).toBe(RUNNING);
    expect(seenIds()).toBeNull();
    // Sticky: it carries a warning.
    expect(timeout.mock.calls.filter(([, delay]) => Number(delay) > 0)).toEqual([]);
  });

  it('records the notice when the user closes it', async () => {
    const { app, updateCards, button, seenIds } = boot({ seenVersion: '1.42.0' });
    await app.checkWhatsNew(RUNNING);
    button(updateCards()[0], 'security-notice-close').click();
    expect(seenIds()).toEqual(['cli-notice']);
    await afterClose();
    expect(updateCards()).toEqual([]);
  });

  it('records the notice and closes when the user follows the notice link', async () => {
    const { app, updateCards, button, opened, seenIds } = boot({ seenVersion: '1.42.0' });
    await app.checkWhatsNew(RUNNING);
    button(updateCards()[0], 'security-notice-primary').click();
    button(updateCards()[0], 'security-notice-primary').click(); // a double click while it fades
    expect(opened).toEqual([['https://example.com/notice', '_blank', 'noopener,noreferrer']]);
    expect(seenIds()).toEqual(['cli-notice']);
    await afterClose();
    expect(updateCards()).toEqual([]);
  });

  it('carries two notices as two sections, and a link records only its own notice', async () => {
    const two = {
      notices: [
        notice({ id: 'first', link: { label: 'First', url: 'https://example.com/1' } }),
        notice({ id: 'second', link: { label: 'Second', url: 'https://example.com/2' } }),
      ],
    };
    const { app, updateCards, opened, seenIds } = boot({ seenVersion: '1.42.0', notices: { ok: true, body: two } });
    await app.checkWhatsNew(RUNNING);
    const [card] = updateCards();
    expect(card.querySelectorAll('.security-notice-section')).toHaveLength(2);
    const labels = Array.from(card.querySelectorAll('.security-notice-actions button')).map((b) => b.textContent);
    expect(labels).toEqual(['First', 'Second', "See what's new"]);
    card.querySelectorAll<HTMLButtonElement>('.security-notice-primary')[1].click();
    expect(opened).toEqual([['https://example.com/2', '_blank', 'noopener,noreferrer']]);
    // The other notice was never answered, so it comes back next load (as a card).
    expect(seenIds()).toEqual(['second']);
  });

  it('opens the release notes from "See what\'s new" and keeps the unanswered warning up', async () => {
    const { app, updateCards, button, opened, seenIds } = boot({ seenVersion: '1.42.0' });
    await app.checkWhatsNew(RUNNING);
    button(updateCards()[0], 'security-notice-secondary').click();
    expect(opened).toEqual([[RELEASE_URL, '_blank', 'noopener,noreferrer']]);
    expect(seenIds()).toBeNull();
    await afterClose();
    expect(updateCards()).toHaveLength(1);
  });

  it('reports each notice once, and opens nothing, once the card is closing', async () => {
    const { app, updateCards, button, opened } = boot();
    const onNoticeSeen = vi.fn();
    const one = { id: 'x', title: '', message: 'm', label: 'Go', url: 'https://example.com/' };
    app.showUpdateNotice({ text: 'Updated', releaseUrl: RELEASE_URL, notices: [one], onNoticeSeen });
    const card = updateCards()[0];
    button(card, 'security-notice-close').click();
    button(card, 'security-notice-close').click();
    button(card, 'security-notice-primary').click();
    button(card, 'security-notice-secondary').click();
    expect(onNoticeSeen.mock.calls).toEqual([['x']]);
    expect(opened).toEqual([]);
  });

  it('keeps the update toast exactly as it was when no notice is selected', async () => {
    for (const variant of [
      { available: { somecli: false } },
      { available: null },
      { seenIds: ['cli-notice'] },
      { notices: { ok: false } as Reply },
      { notices: 'throw' as Reply },
    ] as BootOpts[]) {
      const { win, app, cards, updateCards, plainToasts, opened, seenVersion } = boot({
        seenVersion: '1.42.0',
        ...variant,
      });
      const timeout = vi.spyOn(win, 'setTimeout');
      await app.checkWhatsNew(RUNNING);
      expect(cards(), JSON.stringify(variant)).toEqual([]);
      expect(updateCards()).toEqual([]);
      const toasts = plainToasts();
      expect(toasts.map((t) => t.outerHTML)).toEqual([PLAIN_UPDATE_TOAST]);
      expect(timeout.mock.calls.map(([, delay]) => delay)).toContain(20000);
      expect(seenVersion()).toBe(RUNNING);
      toasts[0].querySelector<HTMLButtonElement>('button:not(.toast-close)')!.click();
      expect(opened).toEqual([[RELEASE_URL, '_blank', 'noopener']]);
    }
  });
});

describe('the gates every surface shares', () => {
  it('shows nothing, and fetches nothing, when storage is blocked', async () => {
    for (const seenVersion of [undefined, '1.42.0']) {
      const { app, fetchCalls, cards, updateCards, plainToasts } = boot({ storage: 'blocked', seenVersion });
      await app.checkWhatsNew(RUNNING);
      expect(fetchCalls).toEqual([]);
      expect([...cards(), ...updateCards(), ...plainToasts()]).toEqual([]);
    }
  });

  it('shows nothing when the CLI is not installed or availability was never injected', async () => {
    for (const available of [{ somecli: false }, {}, null]) {
      const { app, cards, updateCards, seenIds } = boot({ available });
      await app.checkWhatsNew(RUNNING);
      expect([...cards(), ...updateCards()], JSON.stringify(available)).toEqual([]);
      expect(seenIds()).toBeNull();
    }
  });

  it('shows nothing when the notices file cannot be fetched or read', async () => {
    for (const notices of [{ ok: false }, 'throw', { ok: true, body: { notices: 'x' } }] as Reply[]) {
      const { app, cards } = boot({ notices });
      await app.checkWhatsNew(RUNNING);
      expect(cards(), JSON.stringify(notices)).toEqual([]);
    }
  });

  it('checks once per page load, however many times init runs', async () => {
    const { app, fetchCalls, cards } = boot({ seenVersion: RUNNING });
    await app.checkWhatsNew(RUNNING);
    await app.checkWhatsNew(RUNNING);
    expect(fetchCalls).toHaveLength(1);
    expect(cards()).toHaveLength(1);
  });

  it('fetches both files under a reverse-proxy base path, prefixed exactly once', async () => {
    const { app, fetchCalls } = boot({ base: '/codeman', seenVersion: '1.42.0' });
    await app.checkWhatsNew(RUNNING);
    expect(fetchCalls.map((c) => c.url).sort()).toEqual(['/codeman/security-notices.json', '/codeman/whats-new.json']);
  });
});

describe('a detached session window (/session/:id), rendered without CLI availability', () => {
  it('leaves a pending notice and the update toast to the dashboard, recording nothing', async () => {
    for (const seenVersion of ['1.42.0', RUNNING, undefined]) {
      const {
        app,
        cards,
        updateCards,
        plainToasts,
        seenIds,
        seenVersion: version,
      } = boot({
        solo: true,
        available: null,
        seenVersion,
      });
      await app.checkWhatsNew(RUNNING);
      expect([...cards(), ...updateCards(), ...plainToasts()], String(seenVersion)).toEqual([]);
      expect(version()).toBe(seenVersion ?? null);
      expect(seenIds()).toBeNull();
    }
  });

  it('then lets the dashboard carry the notice inside its update toast', async () => {
    const { win, app, updateCards, cards } = boot({ solo: true, available: null, seenVersion: '1.42.0' });
    await app.checkWhatsNew(RUNNING);
    // The dashboard's load: same browser storage, availability injected.
    const dashboard = Object.create(Object.getPrototypeOf(app)) as WiredApp;
    win.__codemanCliAvailable = { somecli: true };
    await dashboard.checkWhatsNew(RUNNING);
    expect(cards()).toEqual([]);
    expect(updateCards()).toHaveLength(1);
  });

  it('shows the plain update toast as before when no notice is pending', async () => {
    for (const variant of [{ seenIds: ['cli-notice'] }, { notices: { ok: false } as Reply }] as BootOpts[]) {
      const { app, plainToasts, cards, seenVersion } = boot({
        solo: true,
        available: null,
        seenVersion: '1.42.0',
        ...variant,
      });
      await app.checkWhatsNew(RUNNING);
      expect(
        plainToasts().map((t) => t.outerHTML),
        JSON.stringify(variant)
      ).toEqual([PLAIN_UPDATE_TOAST]);
      expect(cards()).toEqual([]);
      expect(seenVersion()).toBe(RUNNING);
    }
  });
});

describe('zh-CN', () => {
  it("shows the card in the notice's own Chinese and translates the card's own copy", async () => {
    const { app, cards, text, button } = boot({ lang: 'zh-CN', i18n: true });
    await app.checkWhatsNew(RUNNING);
    await tick();
    const [card] = cards();
    expect(text(card, 'security-notice-eyebrow')).toBe('安全提示');
    expect(text(card, 'security-notice-title')).toBe('密钥可能泄露');
    expect(text(card, 'security-notice-body')).toBe('中文提示。');
    expect(button(card, 'security-notice-primary').textContent).toBe('查看');
    expect(button(card, 'security-notice-quiet').textContent).toBe('忽略');
    expect(button(card, 'security-notice-close').getAttribute('aria-label')).toBe('关闭');
    for (const cls of ['security-notice-title', 'security-notice-body']) {
      expect(card.querySelector(`.${cls}`)!.hasAttribute('data-i18n-skip'), cls).toBe(true);
    }
  });

  it('translates the update text and "See what\'s new" inside the combined toast', async () => {
    const { app, updateCards, text, button } = boot({ lang: 'zh-CN', i18n: true, seenVersion: '1.42.0' });
    await app.checkWhatsNew(RUNNING);
    await tick();
    const [card] = updateCards();
    expect(text(card, 'update-notice-text')).toBe('Codeman 已更新到 v1.43.0：Alpha · Beta · Gamma（另有 1 项）');
    expect(button(card, 'security-notice-secondary').textContent).toBe('查看更新内容');
    expect(text(card, 'security-notice-body')).toBe('中文提示。');
  });

  it('leaves English notice text untranslated even when it matches a dictionary entry', async () => {
    const plain = {
      notices: [notice({ message: 'Settings saved', link: { label: 'Dismiss', url: 'https://example.com/' } })],
    };
    const { app, cards, text, button } = boot({ lang: 'zh-CN', i18n: true, notices: { ok: true, body: plain } });
    await app.checkWhatsNew(RUNNING);
    await tick();
    expect(text(cards()[0], 'security-notice-body')).toBe('Settings saved');
    expect(button(cards()[0], 'security-notice-primary').textContent).toBe('Dismiss');
  });
});

describe('the card styles', () => {
  const css = read('styles.css');
  const block = css.slice(css.indexOf('.security-notice {'), css.indexOf('/* Notification Bell Button */'));

  it('lives beside the toast rules and uses theme tokens, not fixed colours, for its ink', () => {
    expect(css.indexOf('.toast-info {')).toBeLessThan(css.indexOf('.security-notice {'));
    for (const token of ['var(--bg-card)', 'var(--text)', 'var(--text-dim)', 'var(--yellow)', 'var(--red)']) {
      expect(block, token).toContain(token);
    }
    expect(block).not.toMatch(/(?<!rgba\()#[0-9a-f]{3,8}\b/i);
  });

  it('animates opacity and transform only, and nothing under prefers-reduced-motion', () => {
    const rule = block.slice(0, block.indexOf('}'));
    expect(rule).toMatch(/transition: opacity [^;]*, transform [^;]*;/);
    expect(block).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.security-notice \{\s*transform: none;\s*transition: none;/
    );
  });

  it('fills a phone width minus the stack gutters', () => {
    expect(block).toMatch(/@media \(max-width: 599px\) \{\s*\.security-notice \{\s*width: calc\(100vw - 1rem\);/);
  });

  it('caps its height and scrolls inside itself, since the fixed stack cannot scroll', () => {
    const rule = block.slice(0, block.indexOf('}'));
    expect(rule).toContain('max-height: calc(var(--app-height, 100dvh) - var(--header-height) - 1rem);');
    expect(rule).toContain('overflow-y: auto;');
    // A positioned accent bar would scroll away with the content.
    expect(block).not.toContain('.security-notice::before');
  });

  it('darkens the amber ink on the light skins only', () => {
    expect(block).toContain('--notice-ink: var(--yellow);');
    expect(block).toMatch(
      /html:is\(\[data-skin="paper-gray"\], \[data-skin="solarized-light"\], \[data-skin="catppuccin-latte"\], \[data-skin="rose-pine-dawn"\]\) \.security-notice \{\s*--notice-ink: color-mix\(in srgb, var\(--yellow\) 85%, black\);/
    );
  });
});
