/**
 * @fileoverview The "Model on this Mac" card of the welcome screen and its App Settings row
 * (src/web/public/local-model-ui.js), driven in JSDOM over the REAL index.html with the real
 * module and a mocked `_api`.
 *
 * What is pinned:
 *  - every state the route can produce: loading, refused (403), failed, not macOS, each `none`
 *    reason, `limited`, `ok`;
 *  - the card stays hidden until the server answered for a Mac, and the Settings row carries
 *    the loading and failure sentences;
 *  - the card and the row show the SAME pick (one builder), the card folds the alternatives;
 *  - every payload string lands as text: an `<img onerror>` in a model, harness or chip name,
 *    or in a slot value of a server sentence, creates no element and runs nothing;
 *  - sizes are printed as sent (decimal GB text), and the word "Recommended" is the server's
 *    to send, never this module's;
 *  - the dismissal is a per-device localStorage key and survives a new app instance;
 *  - one request a minute at most, shared while in flight, and a failed refresh keeps the answer.
 *
 * The payloads here are fixtures typed with `LocalModelStatus` and built from
 * `LOCAL_MODEL_LABELS`, not the output of the route: what the server computes for a given Mac is
 * pinned by test/local-model-recommend.test.ts and test/routes/local-model-routes.test.ts.
 *
 * Port: none.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_MODEL_LABELS, LOCAL_MODEL_NONE_LABELS } from '../src/types.js';
import type {
  Candidate,
  HardwareFacts,
  LocalModelMessage,
  LocalModelStatus,
  NoneReason,
  Recommendation,
} from '../src/types.js';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const INDEX = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
const MODULE = readFileSync(resolve(PUBLIC, 'local-model-ui.js'), 'utf8');
const I18N = readFileSync(resolve(PUBLIC, 'i18n.js'), 'utf8');

const DISMISS_KEY = 'codeman:local-model-dismissed';
const NEXT_STEP = 'Setting this up from Codeman is the next step. It is not built yet.';

type ApiResponse = { ok: boolean; status: number; json(): Promise<unknown> } | null;

interface App {
  _api: ReturnType<typeof vi.fn>;
  loadLocalModel(): Promise<void>;
  renderLocalModel(): void;
  dismissLocalModelCard(): void;
  isLocalModelCardDismissed(): boolean;
}

interface I18nApi {
  configure(options: Record<string, string>): void;
  start(): void;
}

/**
 * The two containers exactly as index.html ships them, lifted out of the real page once. Each
 * test then runs in a small page made of that markup: parsing the whole of index.html for
 * every case would cost the gate half a minute and prove nothing more.
 */
const REAL = new JSDOM(INDEX);
const REAL_DOCUMENT = REAL.window.document;
const CARD_MARKUP = REAL_DOCUMENT.getElementById('localModelCard')?.outerHTML ?? '';
const GROUP_MARKUP = REAL_DOCUMENT.getElementById('localModelGroup')?.outerHTML ?? '';
const PAGE = `<!doctype html><html lang="en"><body>
<div class="welcome-content">${CARD_MARKUP}</div>
<section class="set-section" id="settings-models">${GROUP_MARKUP}</section>
</body></html>`;

const open: JSDOM[] = [];

afterEach(() => {
  for (const dom of open.splice(0)) dom.window.close();
});

afterAll(() => {
  REAL.window.close();
});

/** A response as `_api` hands it over, the server's envelope included. */
function ok(data: unknown): ApiResponse {
  return { ok: true, status: 200, json: async () => ({ success: true, data }) };
}

function refusal(status: number, errorCode: string): ApiResponse {
  return { ok: false, status, json: async () => ({ success: false, error: 'no', errorCode }) };
}

/**
 * The real markup with the real module in it. `CodemanApp` is the only stand-in: app.js defines
 * it as a classic-script global, and the module mixes into its prototype.
 */
function mount(options: { i18n?: boolean; before?: string } = {}) {
  const dom = new JSDOM(PAGE, { runScripts: 'outside-only', url: 'http://localhost/' });
  open.push(dom);
  const context = dom.getInternalVMContext();
  if (options.i18n) vm.runInContext(I18N, context, { filename: 'i18n.js' });
  if (options.before) vm.runInContext(options.before, context);
  vm.runInContext('function CodemanApp() {}', context);
  vm.runInContext(MODULE, context, { filename: 'local-model-ui.js' });
  const document = dom.window.document;
  const newApp = (response?: ApiResponse | (() => Promise<ApiResponse>)) => {
    const app = vm.runInContext('new CodemanApp()', context) as App;
    app._api = vi.fn(async () => (typeof response === 'function' ? response() : (response ?? null)));
    return app;
  };
  return {
    dom,
    document,
    newApp,
    card: document.getElementById('localModelCard')!,
    row: document.getElementById('localModelSettings')!,
    group: document.getElementById('localModelGroup')!,
    i18n: (dom.window as unknown as { CodemanI18n: I18nApi }).CodemanI18n,
  };
}

/** Text of every element with that class under a root, in document order. */
function texts(root: Element, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((el) => el.textContent ?? '');
}

/** Lets a queued MutationObserver callback (a microtask in JSDOM) run. */
const settle = () => new Promise((done) => setTimeout(done, 0));

// ---------- Fixtures (the contract's types) ----------

/** The MacBook of the probe: 48 GB as sold. The candidates below give it an unknown speed, as for a chip in no chips row. */
const HARDWARE: HardwareFacts = {
  platform: 'darwin',
  arch: 'arm64',
  arm64: true,
  translated: false,
  memBytes: 51539607552,
  memGb: '51.5',
  memClassGb: 48,
  chip: 'Apple M5 Pro',
  model: 'Mac17,13',
  macosVersion: '27.2',
  macosMajor: 27,
  wiredLimitMb: 0,
  freeDiskBytes: 912308310016,
  freeDiskGb: '912',
  source: 'sysctl',
};

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    modelId: 'qwen3.8:27b',
    modelLabel: 'Qwen3.8 27B',
    license: 'Apache-2.0',
    paramsB: 27.8,
    context: 131072,
    cli: 'opencode',
    cliLabel: 'OpenCode',
    cliInstalled: true,
    needBytes: 29551160064,
    needGb: '29.6',
    downloadBytes: 17740000000,
    downloadGb: '17.7',
    budgetShare: 0.79,
    fit: 'good',
    fitLabel: LOCAL_MODEL_LABELS.fitGood,
    speed: 'unknown',
    speedLabel: LOCAL_MODEL_LABELS.speedUnknown,
    tested: false,
    ...over,
  };
}

const ALT_SLOW = candidate({
  modelId: 'qwen3.8:27b-q8_0',
  modelLabel: 'Qwen3.8 27B Q8',
  context: 65536,
  needGb: '36.4',
  downloadGb: '30.0',
  budgetShare: 0.97,
  fit: 'tight',
  fitLabel: LOCAL_MODEL_LABELS.fitTight,
  speed: 'slow',
  speedLabel: LOCAL_MODEL_LABELS.speedSlow,
  tokensPerSecond: 5.2,
});

const ALT_FAST = candidate({
  modelId: 'qwen3.6:35b-a3b',
  modelLabel: 'Qwen3.6 35B-A3B',
  needGb: '26.4',
  downloadGb: '22.6',
  budgetShare: 0.7,
  speed: 'ok',
  speedLabel: undefined,
  tokensPerSecond: 41.7,
});

function status(recommendation: Partial<Recommendation>, hardware: Partial<HardwareFacts> = {}): LocalModelStatus {
  return {
    hardware: { ...HARDWARE, ...hardware },
    recommendation: {
      verdict: 'ok',
      headline: { text: LOCAL_MODEL_LABELS.headlineOk },
      notes: [],
      alternatives: [],
      budgetBytes: 37580963840,
      budgetGb: '37.6',
      budgetSource: 'estimated',
      ...recommendation,
    },
    catalogUpdated: '2026-11-06',
  };
}

const OK_STATUS = status({
  notes: [{ text: LOCAL_MODEL_LABELS.noteUntested }],
  pick: candidate(),
  alternatives: [ALT_FAST, ALT_SLOW],
});

const LIMITED_STATUS = status(
  {
    verdict: 'limited',
    headline: { text: LOCAL_MODEL_LABELS.headlineLimited },
    notes: [{ text: LOCAL_MODEL_LABELS.noteUntested }],
    pick: candidate({
      modelId: 'qwen3.5:9b',
      modelLabel: 'Qwen3.5 9B',
      paramsB: 9.7,
      context: 65536,
      needGb: '10.9',
      downloadGb: '6.6',
      budgetShare: 0.87,
      fit: 'tight',
      fitLabel: LOCAL_MODEL_LABELS.fitTight,
      speed: 'ok',
      speedLabel: undefined,
      tokensPerSecond: 11.16,
    }),
    budgetGb: '12.5',
  },
  { memGb: '19.3', memClassGb: 18, chip: 'Apple M4' }
);

/** A `none` answer: no pick, the reason's sentence as headline, its slots in `vars`. */
function none(reason: NoneReason, vars?: Record<string, string>, hardware: Partial<HardwareFacts> = {}) {
  const headline: LocalModelMessage = { text: LOCAL_MODEL_NONE_LABELS[reason], ...(vars ? { vars } : {}) };
  return status({ verdict: 'none', reason, headline, budgetBytes: 0, budgetGb: '0.0' }, hardware);
}

const NONE_CASES: Array<{ reason: Exclude<NoneReason, 'not-macos'>; answer: LocalModelStatus; sentence: string }> = [
  {
    reason: 'intel',
    answer: none('intel', undefined, { arch: 'x64', arm64: false, chip: 'Intel(R) Core(TM) i7-9750H' }),
    sentence: 'This Mac has an Intel processor. Local coding models need Apple silicon.',
  },
  {
    reason: 'memory',
    answer: none('memory', { memory: '8.6' }, { memGb: '8.6', memClassGb: 8 }),
    sentence:
      'This Mac has 8.6 GB of memory. That is too little to run a model that can drive a coding agent, so Codeman recommends none here.',
  },
  {
    reason: 'disk',
    answer: none('disk', { download: '17.7', free: '12.0', missing: '16.4' }, { freeDiskGb: '12.0' }),
    sentence:
      'Not enough free disk space. The smallest model that fits this Mac is a 17.7 GB download and 12.0 GB is free. Free up about 16.4 GB.',
  },
  {
    reason: 'macos',
    answer: none('macos', { version: '13.6', minimum: '14' }, { macosVersion: '13.6', macosMajor: 13 }),
    sentence: 'This Mac runs macOS 13.6. Local models need macOS 14 or newer.',
  },
  {
    reason: 'no-harness',
    answer: none('no-harness'),
    sentence: 'No coding agent that Codeman can connect to a local model is available on this Mac.',
  },
];

// ---------- The page ----------

describe('the markup the module fills', () => {
  it('ships the card hidden on the welcome screen and one read-only group in Settings > Models', () => {
    const card = REAL_DOCUMENT.getElementById('localModelCard')!;
    const row = REAL_DOCUMENT.getElementById('localModelSettings')!;
    const group = REAL_DOCUMENT.getElementById('localModelGroup')!;
    expect(card.hidden).toBe(true);
    expect(card.closest('#welcomeOverlay .welcome-content')).not.toBeNull();
    expect(card.hasAttribute('data-i18n-skip')).toBe(true);
    // A direct child of the column (no wrapper that would hold a margin open while the card is
    // hidden), under the Resume list and above the sessions opened outside Codeman.
    const order = [...REAL_DOCUMENT.querySelector('.welcome-content')!.children].map((el) => el.id || el.className);
    expect(order.indexOf('localModelCard')).toBeGreaterThan(order.indexOf('historySessions'));
    expect(order.indexOf('localModelCard')).toBeLessThan(order.indexOf('welcome-foreign'));
    // The phone overview is a different screen and does not carry the card.
    expect(card.closest('#mobileOverview')).toBeNull();

    expect(group.closest('#appSettingsModal #settings-models')).not.toBeNull();
    // Its own group: the endpoints toggle hides #customModelEndpointsBody, and this answer does not depend on it.
    expect(row.closest('#customModelEndpointsBody')).toBeNull();
    expect(row.closest('#customModelEndpointsGroup')).toBeNull();
    expect(row.closest('.set-row')).not.toBeNull();
    expect(row.hasAttribute('data-i18n-skip')).toBe(true);
    // Read-only: no control of any kind in the group.
    expect(group.querySelectorAll('input, select, button, textarea').length).toBe(0);
    expect(INDEX.split('<script defer src="local-model-ui.js"></script>').length - 1).toBe(1);
  });

  it('is what every other test here runs on', () => {
    const { card, row, group } = mount();
    expect(card.outerHTML).toBe(CARD_MARKUP);
    expect(group.outerHTML).toBe(GROUP_MARKUP);
    expect(row.textContent).toBe('');
  });

  it('is wired into the two places that show it', () => {
    const read = (file: string) => readFileSync(resolve(PUBLIC, file), 'utf8');
    // The welcome screen (not the phone overview branch above it) and App Settings.
    expect(read('terminal-ui.js').split('this.loadLocalModel?.();').length - 1).toBe(1);
    expect(read('settings-ui.js').split('this.loadLocalModel?.();').length - 1).toBe(1);
  });
});

describe('before there is an answer', () => {
  it('keeps the card hidden while the request is in flight, and says so in Settings', async () => {
    const { newApp, card, row } = mount();
    let answer!: (response: ApiResponse) => void;
    const app = newApp(() => new Promise<ApiResponse>((done) => (answer = done)));
    const loading = app.loadLocalModel();
    expect(card.hidden).toBe(true);
    expect(card.textContent).toBe('');
    expect(row.textContent).toBe('Checking this Mac…');
    answer(ok(OK_STATUS));
    await loading;
    expect(card.hidden).toBe(false);
    expect(row.textContent).not.toContain('Checking this Mac…');
  });

  it.each([
    ['the route answers 501', refusal(501, 'OPERATION_FAILED')],
    ['the request never reached the server', null],
    ['the body is not the envelope', { ok: true, status: 200, json: async () => ({ hello: 'world' }) }],
    ['the body is not JSON', { ok: true, status: 200, json: async () => Promise.reject(new Error('bad')) }],
    ['the data carries no recommendation', ok({ hardware: HARDWARE })],
  ] as Array<[string, ApiResponse]>)('shows a failed request only in Settings: %s', async (_name, response) => {
    const { newApp, card, row, group } = mount();
    const app = newApp(response);
    await app.loadLocalModel();
    // Nothing is known about the machine, so the welcome screen gets no card at all.
    expect(card.hidden).toBe(true);
    expect(group.style.display).toBe('');
    expect(row.textContent).toBe('Could not reach the server.');
  });

  it('asks again the next time it is shown after a failure', async () => {
    const { newApp, card, row } = mount();
    const answers: ApiResponse[] = [null, ok(OK_STATUS)];
    const app = newApp(async () => answers.shift() ?? null);
    await app.loadLocalModel();
    expect(row.textContent).toBe('Could not reach the server.');
    await app.loadLocalModel();
    expect(app._api).toHaveBeenCalledTimes(2);
    expect(card.hidden).toBe(false);
    expect(texts(row, '.local-model-headline')).toEqual(['Best fit for this Mac']);
  });
});

describe('a refused request (a non-admin in multi-user mode)', () => {
  it('shows neither the card nor the Settings group, and stops asking', async () => {
    const { newApp, card, row, group } = mount();
    const app = newApp(refusal(403, 'FORBIDDEN'));
    await app.loadLocalModel();
    expect(card.hidden).toBe(true);
    expect(group.style.display).toBe('none');
    expect(row.textContent).toBe('');
    await app.loadLocalModel();
    expect(app._api).toHaveBeenCalledTimes(1);
  });

  it('does not ask at all once the page knows the role, and asks when the role turns out to be admin', async () => {
    const { dom, document, newApp, card, group } = mount();
    const win = dom.window as unknown as { __codemanUser?: { multiUser: boolean; role: string } };
    win.__codemanUser = { multiUser: true, role: 'user' };
    const app = newApp(ok(OK_STATUS));
    await app.loadLocalModel();
    expect(app._api).not.toHaveBeenCalled();
    expect(group.style.display).toBe('none');
    expect(card.hidden).toBe(true);

    win.__codemanUser = { multiUser: true, role: 'admin' };
    document.dispatchEvent(new dom.window.CustomEvent('codeman:me'));
    await vi.waitFor(() => expect(card.hidden).toBe(false));
    expect(app._api).toHaveBeenCalledTimes(1);
    expect(group.style.display).toBe('');
  });
});

describe('a server that is not a Mac', () => {
  it('hides the card and leaves one plain sentence in Settings', async () => {
    const { newApp, card, row, group } = mount();
    const answer = none('not-macos', undefined, {
      platform: 'linux',
      arch: 'x64',
      arm64: undefined,
      chip: 'AMD Ryzen 9 7950X',
      source: 'not-probed',
    });
    await newApp(ok(answer)).loadLocalModel();
    expect(card.hidden).toBe(true);
    expect(card.textContent).toBe('');
    expect(group.style.display).toBe('');
    expect(row.textContent).toBe('Codeman recommends a local model only on a Mac with Apple silicon.');
    // No line listing another machine's parts under a heading that says "this Mac".
    expect(row.querySelector('.local-model-hw')).toBeNull();
  });
});

describe('verdict none on a Mac', () => {
  it.each(NONE_CASES)('says why for $reason, with the numbers the server sent', async ({ answer, sentence }) => {
    const { newApp, card, row } = mount();
    await newApp(ok(answer)).loadLocalModel();
    expect(card.hidden).toBe(false);
    for (const root of [card, row]) {
      expect(texts(root, '.local-model-headline')).toEqual([sentence]);
      expect(texts(root, '.local-model-hw')).toHaveLength(1);
      expect(root.querySelector('.local-model-pick')).toBeNull();
      expect(root.querySelector('.local-model-alts')).toBeNull();
      // Nothing to set up, so no line about setting it up.
      expect(root.textContent).not.toContain(NEXT_STEP);
      expect(root.textContent).not.toContain('Recommended');
    }
  });

  it('covers every reason the contract knows', () => {
    const covered = [...NONE_CASES.map((c) => c.reason), 'not-macos'].sort();
    expect(covered).toEqual(Object.keys(LOCAL_MODEL_NONE_LABELS).sort());
  });
});

describe('verdict ok', () => {
  it('shows the hardware, the headline, the pick with its numbers, the note and the next step', async () => {
    const { newApp, card } = mount();
    await newApp(ok(OK_STATUS)).loadLocalModel();
    expect(card.hidden).toBe(false);
    expect(texts(card, '.local-model-title')).toEqual(['Model on this Mac']);
    expect(texts(card, '.local-model-hw')).toEqual(['Apple M5 Pro, 51.5 GB memory, 912 GB free']);
    expect(texts(card, '.local-model-headline')).toEqual(['Best fit for this Mac']);
    expect(texts(card, '.local-model-note')).toEqual(['Not yet tested by us on a Mac like this.']);

    const pick = card.querySelector('.local-model-pick')!;
    expect(texts(pick, '.local-model-name')).toEqual(['Qwen3.8 27B (qwen3.8:27b) with OpenCode']);
    expect(texts(pick, '.local-model-pill')).toEqual(['Good', 'Speed unknown']);
    expect(texts(pick, '.local-model-line')).toEqual([
      'Context 131,072 tokens · 17.7 GB download · Apache-2.0',
      'Needs about 29.6 GB of the 37.6 GB this Mac can give a model (estimated).',
    ]);
    expect(texts(card, '.local-model-next')).toEqual([NEXT_STEP]);
  });

  it('never says "Recommended" for a pick nobody tested: that word is the server\'s to send', async () => {
    const { newApp, card, row } = mount();
    await newApp(ok(OK_STATUS)).loadLocalModel();
    expect(card.textContent).not.toMatch(/recommend/i);
    expect(row.textContent).not.toMatch(/recommend/i);
    // The module holds no such string of its own (comments aside).
    const code = MODULE.split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/Recommended/);
  });

  it('shows the tested headline only because the server sent it', async () => {
    const { newApp, card } = mount();
    const tested = status({ headline: { text: LOCAL_MODEL_LABELS.headlineTested }, pick: candidate({ tested: true }) });
    await newApp(ok(tested)).loadLocalModel();
    expect(texts(card, '.local-model-headline')).toEqual(['Recommended for this Mac']);
  });

  it('lists the other models that fit with Good, Tight, Slow or Speed unknown', async () => {
    const { newApp, card } = mount();
    await newApp(ok(OK_STATUS)).loadLocalModel();
    const alts = card.querySelector('.local-model-alts')!;
    expect(texts(alts, '.local-model-alts-title')).toEqual(['Other models that fit2']);
    expect(texts(alts, '.local-model-count')).toEqual(['2']);
    const rows = [...alts.querySelectorAll('.local-model-alt')];
    expect(rows.map((row) => texts(row, '.local-model-name')[0])).toEqual([
      'Qwen3.6 35B-A3B (qwen3.6:35b-a3b) with OpenCode',
      'Qwen3.8 27B Q8 (qwen3.8:27b-q8_0) with OpenCode',
    ]);
    // A candidate whose speed is fine carries a fit label only.
    expect(rows.map((row) => texts(row, '.local-model-pill'))).toEqual([['Good'], ['Tight', 'Slow']]);
    expect(rows.map((row) => texts(row, '.local-model-line')[0])).toEqual([
      'Context 131,072 tokens · 26.4 GB of memory · 22.6 GB download',
      'Context 65,536 tokens · 36.4 GB of memory · 30.0 GB download',
    ]);
  });

  it('prints every size exactly as sent, in one unit', async () => {
    const { newApp, card, row } = mount();
    await newApp(ok(OK_STATUS)).loadLocalModel();
    for (const root of [card, row]) {
      const text = root.textContent ?? '';
      expect(text).not.toMatch(/GiB|MiB|\bMB\b|bytes/);
      // Every number in front of the unit is one the payload carries as text.
      const printed = [...text.matchAll(/([\d.,]+) GB/g)].map((m) => m[1]);
      const sent = ['51.5', '912', '37.6', '29.6', '17.7', '26.4', '22.6', '36.4', '30.0'];
      expect(printed.length).toBeGreaterThanOrEqual(sent.length);
      expect(printed.filter((value) => !sent.includes(value))).toEqual([]);
    }
  });

  it('calls a budget that is the wired limit of this Mac a fact, not an estimate', async () => {
    const { newApp, card } = mount();
    const wired = status({ pick: candidate(), budgetSource: 'wired-limit', budgetGb: '40.0' });
    await newApp(ok(wired)).loadLocalModel();
    expect(texts(card, '.local-model-pick .local-model-line')[1]).toBe(
      'Needs about 29.6 GB of the 40.0 GB this Mac can give a model.'
    );
  });

  it('adds the speed, a missing harness and a slow first answer only when the payload says so', async () => {
    const { newApp, card } = mount();
    const pick = candidate({
      speed: 'ok',
      speedLabel: undefined,
      tokensPerSecond: 12.3,
      cliInstalled: false,
      slowFirstTurn: true,
      cliLabel: 'Some Harness',
    });
    await newApp(ok(status({ pick }))).loadLocalModel();
    expect(texts(card, '.local-model-pick .local-model-pill')).toEqual(['Good']);
    expect(texts(card, '.local-model-pick .local-model-line').slice(2)).toEqual([
      'About 12 tokens per second (estimated).',
      'Some Harness is not installed on this Mac yet.',
      'With Some Harness, the first answer can take minutes.',
    ]);
  });

  it('describes the hardware with whatever parts the probe got', async () => {
    const { newApp, card } = mount();
    const cases: Array<[Partial<HardwareFacts>, string]> = [
      [{ freeDiskBytes: undefined, freeDiskGb: undefined }, 'Apple M5 Pro, 51.5 GB memory'],
      [{ chip: undefined }, 'Mac17,13, 51.5 GB memory, 912 GB free'],
      [{ chip: undefined, model: undefined }, '51.5 GB memory, 912 GB free'],
      [{ chip: undefined, model: undefined, freeDiskBytes: undefined, freeDiskGb: undefined }, '51.5 GB memory'],
    ];
    for (const [hardware, line] of cases) {
      await newApp(ok(status({ pick: candidate() }, hardware))).loadLocalModel();
      expect(texts(card, '.local-model-hw')).toEqual([line]);
    }
  });
});

describe('verdict limited', () => {
  it('says what a small model is good for, shows the pick, and never recommends', async () => {
    const { newApp, card, row } = mount();
    await newApp(ok(LIMITED_STATUS)).loadLocalModel();
    expect(card.hidden).toBe(false);
    for (const root of [card, row]) {
      expect(texts(root, '.local-model-headline')).toEqual([
        'This Mac can run a small model. It handles small edits and questions. It does not replace a cloud model.',
      ]);
      expect(texts(root, '.local-model-hw')).toEqual(['Apple M4, 19.3 GB memory, 912 GB free']);
      expect(texts(root, '.local-model-name')).toEqual(['Qwen3.5 9B (qwen3.5:9b) with OpenCode']);
      expect(texts(root, '.local-model-pill')).toEqual(['Tight']);
      expect(texts(root, '.local-model-pick .local-model-line')).toEqual([
        'Context 65,536 tokens · 6.6 GB download · Apache-2.0',
        'Needs about 10.9 GB of the 12.5 GB this Mac can give a model (estimated).',
        'About 11 tokens per second (estimated).',
      ]);
      expect(texts(root, '.local-model-note')).toEqual(['Not yet tested by us on a Mac like this.']);
      expect(texts(root, '.local-model-next')).toEqual([NEXT_STEP]);
      expect(root.textContent).not.toMatch(/recommend/i);
      expect(root.textContent).not.toContain('Best fit');
    }
  });
});

describe('the Settings row', () => {
  it('shows the same answer as the card, with the alternatives open', async () => {
    const { newApp, card, row } = mount();
    await newApp(ok(OK_STATUS)).loadLocalModel();
    for (const part of ['.local-model-hw', '.local-model-headline', '.local-model-pick', '.local-model-note']) {
      expect(texts(row, part)).toEqual(texts(card, part));
      expect(texts(row, part).length).toBeGreaterThan(0);
    }
    expect(texts(row, '.local-model-alt')).toEqual(texts(card, '.local-model-alt'));
    expect(texts(row, '.local-model-next')).toEqual([NEXT_STEP]);
    // The card folds the list behind a native disclosure; Settings scrolls, so it lists them.
    expect(card.querySelector('details.local-model-alts')).not.toBeNull();
    expect((card.querySelector('details') as HTMLDetailsElement).open).toBe(false);
    expect(row.querySelector('details')).toBeNull();
    // The row has no chrome of the card: no title, no Hide.
    expect(row.querySelector('button')).toBeNull();
  });

  it('keeps the alternatives unfolded across a repaint of the card', async () => {
    const { newApp, card } = mount();
    const app = newApp(ok(OK_STATUS));
    await app.loadLocalModel();
    (card.querySelector('details') as HTMLDetailsElement).open = true;
    app.renderLocalModel();
    expect((card.querySelector('details') as HTMLDetailsElement).open).toBe(true);
  });
});

describe('payload text is text', () => {
  const EVIL = '<img src=x onerror="window.__pwned = 1">';

  it('renders markup in a name, a license or a sentence slot as characters, and runs nothing', async () => {
    const { dom, newApp, card, row } = mount();
    const evil = candidate({ modelLabel: EVIL, modelId: `m:${EVIL}`, cliLabel: EVIL, license: EVIL, needGb: EVIL });
    const answer = status(
      {
        // A slot value is server text too.
        headline: { text: LOCAL_MODEL_LABELS.noneMacos, vars: { version: EVIL, minimum: EVIL } },
        notes: [{ text: LOCAL_MODEL_LABELS.noneMemory, vars: { memory: EVIL } }],
        pick: evil,
        alternatives: [evil],
        budgetGb: EVIL,
      },
      { chip: EVIL, memGb: EVIL, freeDiskGb: EVIL }
    );
    await newApp(ok(answer)).loadLocalModel();
    expect(card.hidden).toBe(false);
    for (const root of [card, row]) {
      expect(root.querySelector('img')).toBeNull();
      expect(root.querySelector('script, iframe, a, [onerror]')).toBeNull();
      expect(texts(root, '.local-model-hw')[0]).toBe(`${EVIL}, ${EVIL} GB memory, ${EVIL} GB free`);
      expect(texts(root, '.local-model-headline')[0]).toBe(
        `This Mac runs macOS ${EVIL}. Local models need macOS ${EVIL} or newer.`
      );
      expect(texts(root, '.local-model-name')[0]).toBe(`${EVIL} (m:${EVIL}) with ${EVIL}`);
      expect(texts(root, '.local-model-pick .local-model-line')[0]).toContain(` · ${EVIL}`);
      expect(texts(root, '.local-model-note')[0]).toContain(`This Mac has ${EVIL} GB of memory.`);
    }
    expect((dom.window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('never assigns markup: the module has no innerHTML, outerHTML or insertAdjacentHTML', () => {
    expect(MODULE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it('shows a label the contract does not know as it came, still as text', async () => {
    const { newApp, card } = mount();
    const odd = candidate({ fitLabel: EVIL as Candidate['fitLabel'], speedLabel: undefined });
    await newApp(ok(status({ pick: odd }))).loadLocalModel();
    expect(texts(card, '.local-model-pill')).toEqual([EVIL]);
    expect(card.querySelector('img')).toBeNull();
  });
});

describe('hiding the card', () => {
  it('hides it on this device for good, and leaves the Settings row as the way back', async () => {
    const { dom, newApp, card, row } = mount();
    const app = newApp(ok(OK_STATUS));
    await app.loadLocalModel();
    const hide = card.querySelector('button.local-model-hide') as HTMLButtonElement;
    expect(hide.textContent).toBe('Hide');
    expect(hide.type).toBe('button');
    expect(hide.title).toBe('Hide this card on this device. It stays in App Settings, under Models.');
    hide.click();
    expect(card.hidden).toBe(true);
    expect(card.textContent).toBe('');
    expect(dom.window.localStorage.getItem(DISMISS_KEY)).toBe('1');
    expect(texts(row, '.local-model-name')[0]).toBe('Qwen3.8 27B (qwen3.8:27b) with OpenCode');

    // A reload is a new app instance over the same storage.
    const reloaded = newApp(ok(OK_STATUS));
    expect(reloaded.isLocalModelCardDismissed()).toBe(true);
    await reloaded.loadLocalModel();
    expect(card.hidden).toBe(true);
    expect(texts(row, '.local-model-headline')).toEqual(['Best fit for this Mac']);
  });

  it('shows the card on a device that never hid it', async () => {
    const { dom, newApp, card } = mount();
    expect(dom.window.localStorage.getItem(DISMISS_KEY)).toBeNull();
    await newApp(ok(OK_STATUS)).loadLocalModel();
    expect(card.hidden).toBe(false);
  });

  it('stays hidden for the page load when storage is blocked', async () => {
    const { dom, newApp, card } = mount();
    const storage = dom.window.Storage.prototype;
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const app = newApp(ok(OK_STATUS));
    await app.loadLocalModel();
    expect(card.hidden).toBe(false);
    app.dismissLocalModelCard();
    expect(card.hidden).toBe(true);
    app.renderLocalModel();
    expect(card.hidden).toBe(true);
    vi.restoreAllMocks();
  });

  it('writes nothing to the server: the only request the module ever makes is the GET', async () => {
    const { newApp, card } = mount();
    const app = newApp(ok(OK_STATUS));
    await app.loadLocalModel();
    (card.querySelector('button.local-model-hide') as HTMLButtonElement).click();
    expect(app._api.mock.calls).toEqual([['/api/local-model']]);
  });
});

describe('the request', () => {
  it('goes through the base path when Codeman is mounted under one', async () => {
    const before = "const CodemanBase = { base: '/cm', url: (path) => '/cm' + path };";
    const { newApp } = mount({ before });
    const app = newApp(ok(OK_STATUS));
    await app.loadLocalModel();
    expect(app._api.mock.calls).toEqual([['/cm/api/local-model']]);
  });

  it('is sent once a minute at most, and shared while in flight', async () => {
    const { dom, newApp, card } = mount();
    let now = 1_000_000;
    (dom.window as unknown as { Date: DateConstructor }).Date.now = () => now;
    const app = newApp(ok(OK_STATUS));
    const first = app.loadLocalModel();
    const second = app.loadLocalModel();
    await Promise.all([first, second]);
    expect(app._api).toHaveBeenCalledTimes(1);

    now += 59_000;
    await app.loadLocalModel();
    expect(app._api).toHaveBeenCalledTimes(1);

    now += 2_000;
    await app.loadLocalModel();
    expect(app._api).toHaveBeenCalledTimes(2);
    expect(card.hidden).toBe(false);
  });

  it('keeps the answer on screen when a later refresh fails', async () => {
    const { dom, newApp, card, row } = mount();
    let now = 1_000_000;
    (dom.window as unknown as { Date: DateConstructor }).Date.now = () => now;
    const answers: ApiResponse[] = [ok(OK_STATUS), null];
    const app = newApp(async () => answers.shift() ?? null);
    await app.loadLocalModel();
    now += 61_000;
    await app.loadLocalModel();
    expect(app._api).toHaveBeenCalledTimes(2);
    expect(card.hidden).toBe(false);
    expect(texts(row, '.local-model-headline')).toEqual(['Best fit for this Mac']);
    expect(row.textContent).not.toContain('Could not reach the server.');
  });
});

describe('with the real translator', () => {
  it('renders in Chinese, and follows a language or display-name change without a reload', async () => {
    const { newApp, card, row, i18n } = mount({ i18n: true });
    i18n.start();
    i18n.configure({ language: 'zh-CN' });
    const app = newApp(ok(OK_STATUS));
    await app.loadLocalModel();
    expect(texts(card, '.local-model-headline')).toEqual(['最适合此 Mac 的选择']);
    expect(texts(card, '.local-model-pill')).toEqual(['良好', '速度未知', '良好', '紧张', '较慢']);
    // Names and numbers ride the slots untouched.
    expect(texts(card, '.local-model-name')[0]).toBe('Qwen3.8 27B（qwen3.8:27b），搭配 OpenCode');
    expect(texts(row, '.local-model-hw')).toEqual(['Apple M5 Pro，内存 51.5 GB，可用磁盘空间 912 GB']);

    // Both containers are data-i18n-skip, so the module itself must repaint.
    i18n.configure({ language: 'en' });
    await settle();
    expect(texts(card, '.local-model-headline')).toEqual(['Best fit for this Mac']);
    expect(texts(row, '.local-model-next')).toEqual([NEXT_STEP]);

    i18n.configure({ displayName: 'Acme' });
    await settle();
    expect(texts(card, '.local-model-next')).toEqual([
      'Setting this up from Acme is the next step. It is not built yet.',
    ]);
  });

  it('leaves a slot-shaped piece of a model name alone', async () => {
    const { newApp, card, i18n } = mount({ i18n: true });
    i18n.start();
    const odd = candidate({ modelLabel: 'Model {harness} {name}' });
    await newApp(ok(status({ pick: odd }))).loadLocalModel();
    await settle();
    // The DOM translator would empty `{harness}` and brand `{name}`; the skip attribute keeps it out.
    expect(texts(card, '.local-model-name')[0]).toBe('Model {harness} {name} (qwen3.8:27b) with OpenCode');
  });
});
