/**
 * @fileoverview "Run a model on this Mac": the welcome button, the chooser window and the App
 * Settings row (src/web/public/local-model-ui.js), driven in JSDOM over the REAL markup of
 * index.html with the real module and a mocked `_api`.
 *
 * What is pinned:
 *  - the markup: one button in the welcome launchers (no card), one modal after App Settings,
 *    one row with a button in Settings > Models;
 *  - when anything shows: hidden while the first request is in flight, for a refusal (403
 *    FORBIDDEN, and only that 403), for a failed request (Settings alone says so) and for a
 *    server that is not a Mac;
 *  - every screen of the window: the chooser with five models, a tight fit, confirm, progress,
 *    paused, a failure with each helpful action, installed (running and stopped), the Remove
 *    question, and no recommendation;
 *  - the radio group: roles, one tab stop, arrow keys, Home and End, the focus following;
 *  - the memory bar's value following the selection;
 *  - the consent: the install request carries the server's own total for the row that was on
 *    screen, and a 409 `size-changed` shows the new total and sends that one next;
 *  - the poll: once a second while the window is open, never after it closes, and a tick that
 *    moved only the download leaves the buttons in place;
 *  - the models on this Mac: the list with its sizes, the state of each row, "Use" (a switch
 *    with no confirm screen), "Delete" (asked once, in the row), "Add a model" (the chooser,
 *    where a row that is on this Mac already is switched to), the way back from a stopped job,
 *    and what an earlier Remove left on disk;
 *  - every payload string lands as text: an `<img onerror>` in a model, agent or chip name, an
 *    error's detail, a session name, a folder or a command creates no element;
 *  - a button exists only for an action the server lists.
 *
 * The payloads are fixtures typed with the contract's types and built from its label
 * constants, not the output of the route: what the server computes is pinned by
 * test/local-model-recommend.test.ts and test/routes/local-model-routes.test.ts.
 *
 * Port: none.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOCAL_MODEL_ERROR_LABELS,
  LOCAL_MODEL_ERROR_NEXT,
  LOCAL_MODEL_INSTALL_LABELS,
  LOCAL_MODEL_LABELS,
  LOCAL_MODEL_NONE_LABELS,
  LOCAL_MODEL_TAG_LABELS,
} from '../src/types.js';
import type {
  Candidate,
  CandidateHarness,
  HardwareFacts,
  LocalModelConflict,
  LocalModelErrorCode,
  LocalModelHarnessRow,
  LocalModelInstallView,
  LocalModelLibraryRow,
  LocalModelMessage,
  LocalModelStatus,
  NoneReason,
  Recommendation,
} from '../src/types.js';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const INDEX = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
const MODULE = readFileSync(resolve(PUBLIC, 'local-model-ui.js'), 'utf8');
const I18N = readFileSync(resolve(PUBLIC, 'i18n.js'), 'utf8');
const STYLES = readFileSync(resolve(PUBLIC, 'styles.css'), 'utf8');
const MOBILE = readFileSync(resolve(PUBLIC, 'mobile.css'), 'utf8');

type ApiResponse = { ok: boolean; status: number; json(): Promise<unknown> } | null;
type ApiOptions = { method?: string; body?: unknown };
type ApiHandler = (path: string, options: ApiOptions) => ApiResponse | Promise<ApiResponse>;

interface App {
  _api: ReturnType<typeof vi.fn>;
  loadLocalModel(options?: { force?: boolean }): Promise<void>;
  renderLocalModel(): void;
  openLocalModelWindow(): void;
  closeLocalModelWindow(): void;
  isLocalModelWindowOpen(): boolean;
  startLocalModelSession(cli?: string): Promise<void>;
  loadAppSettingsFromServer?: () => Promise<void>;
  loadCliListForSettings?: () => Promise<void>;
  selectCustomModelEntry?: (cli: string, endpointId: string) => Promise<void>;
  closeAppSettings?: () => void;
}

interface I18nApi {
  configure(options: Record<string, string>): void;
  start(): void;
}

/**
 * The three pieces of markup exactly as index.html ships them, lifted out of the real page
 * once. Each test then runs in a small page made of that markup: parsing the whole of
 * index.html for every case would cost the gate minutes and prove nothing more.
 */
const REAL = new JSDOM(INDEX);
const REAL_DOCUMENT = REAL.window.document;
const BUTTON_MARKUP = REAL_DOCUMENT.getElementById('welcomeLocalModelBtn')?.outerHTML ?? '';
const GROUP_MARKUP = REAL_DOCUMENT.getElementById('localModelGroup')?.outerHTML ?? '';
const MODAL_MARKUP = REAL_DOCUMENT.getElementById('localModelModal')?.outerHTML ?? '';
const PAGE = `<!doctype html><html lang="en"><body>
<div class="welcome-actions"><div id="welcomeCliActions"></div>${BUTTON_MARKUP}</div>
<div class="modal" id="appSettingsModal"><section class="set-section" id="settings-models">${GROUP_MARKUP}</section></div>
${MODAL_MARKUP}
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

/** A 409 of an install verb: the error envelope plus the conflict as `data`. */
function conflict(data: LocalModelConflict): ApiResponse {
  return {
    ok: false,
    status: 409,
    json: async () => ({ success: false, error: data.message.text, errorCode: 'CONFLICT', data }),
  };
}

/**
 * The real markup with the real module in it. `CodemanApp` is the only stand-in: app.js defines
 * it as a classic-script global, and the module mixes into its prototype. Timers are a queue the
 * test runs by hand (`tick`), so the once-a-second poll is counted, never waited for.
 */
function mount(options: { i18n?: boolean; visible?: boolean } = {}) {
  const dom = new JSDOM(PAGE, {
    runScripts: 'outside-only',
    url: 'http://localhost/',
    pretendToBeVisual: options.visible !== false,
  });
  open.push(dom);
  const context = dom.getInternalVMContext();
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextTimer = 1;
  const win = dom.window as unknown as {
    setTimeout: (fn: () => void, ms: number) => number;
    clearTimeout: (id: number) => void;
    CodemanI18n: I18nApi;
    __codemanUser?: { multiUser: boolean; role: string };
  };
  win.setTimeout = (fn, ms) => {
    timers.push({ id: nextTimer, fn, ms });
    return nextTimer++;
  };
  win.clearTimeout = (id) => {
    const at = timers.findIndex((timer) => timer.id === id);
    if (at >= 0) timers.splice(at, 1);
  };
  if (options.i18n) vm.runInContext(I18N, context, { filename: 'i18n.js' });
  vm.runInContext('function CodemanApp() {}', context);
  vm.runInContext(MODULE, context, { filename: 'local-model-ui.js' });
  const document = dom.window.document;
  const newApp = (handler?: ApiResponse | ApiHandler) => {
    const app = vm.runInContext('new CodemanApp()', context) as App;
    app._api = vi.fn(async (path: string, opts: ApiOptions = {}) =>
      typeof handler === 'function' ? handler(path, opts) : (handler ?? null)
    );
    return app;
  };
  return {
    dom,
    win,
    document,
    newApp,
    timers,
    /** Run every timer that is due now (the poll re-arms itself, so one call is one tick). */
    tick: async () => {
      for (const timer of timers.splice(0)) timer.fn();
      await settle();
    },
    button: document.getElementById('welcomeLocalModelBtn')!,
    row: document.getElementById('localModelSettings')!,
    rowButton: document.getElementById('localModelSettingsOpen')!,
    group: document.getElementById('localModelGroup')!,
    modal: document.getElementById('localModelModal')!,
    body: document.getElementById('localModelWindowBody')!,
    /** The body and the foot together: where a screen's controls are. */
    frame: document.querySelector('#localModelModal .local-model-window')!,
    foot: document.getElementById('localModelWindowFoot')!,
  };
}

type Mounted = ReturnType<typeof mount>;

/** Text of every element matching a selector under a root, in document order. */
function texts(root: ParentNode, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((el) => el.textContent ?? '');
}

/** The frame the buttons live in: the window's body AND its foot (the buttons are in the foot). */
function frameOf(body: Element): Element {
  return body.closest('.local-model-window') ?? body;
}

/** The window's buttons, by their label. */
function buttons(body: Element): string[] {
  return texts(frameOf(body), '.lm-buttons button');
}

function press(body: Element, label: string) {
  const found = [...frameOf(body).querySelectorAll<HTMLButtonElement>('.lm-buttons button')].find(
    (el) => el.textContent === label
  );
  expect(found, `no button "${label}" among ${JSON.stringify(buttons(body))}`).toBeTruthy();
  found!.click();
}

/** Lets queued promise callbacks and MutationObserver callbacks run. */
const settle = () => new Promise((done) => setTimeout(done, 0));

/** The calls that were not the GET, as `[method, path, body]`. */
function verbs(app: App): Array<[string, string, unknown]> {
  return app._api.mock.calls
    .filter(([, opts]) => opts && (opts as ApiOptions).method && (opts as ApiOptions).method !== 'GET')
    .map(([path, opts]) => [(opts as ApiOptions).method as string, path as string, (opts as ApiOptions).body]);
}

const gets = (app: App) => app._api.mock.calls.filter(([, opts]) => !(opts as ApiOptions | undefined)?.method).length;

// ---------- Fixtures (the contract's types) ----------

/** The MacBook of the measurements: 48 GB as sold. */
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
  freeDiskBytes: 897000000000,
  freeDiskGb: '897',
  source: 'sysctl',
};

const RUNTIME_BYTES = 185971671;

const OPENCODE: CandidateHarness = {
  cli: 'opencode',
  cliLabel: 'OpenCode',
  installed: false,
  installCommand: 'curl -fsSL https://opencode.ai/install | bash',
};
const CLAUDE: CandidateHarness = { cli: 'claude', cliLabel: 'Claude Code', installed: true, slowFirstTurn: true };

function candidate(over: Partial<Candidate> = {}): Candidate {
  const row: Candidate = {
    modelId: 'qwen3.6:35b-a3b',
    modelLabel: 'Qwen3.6 35B-A3B',
    license: 'Apache-2.0',
    paramsB: 35,
    context: 131072,
    cli: 'opencode',
    cliLabel: 'OpenCode',
    cliInstalled: false,
    needBytes: 35955462956,
    needGb: '36.0',
    downloadBytes: 23105798956,
    downloadGb: '23.1',
    budgetShare: 0.957,
    fit: 'tight',
    fitLabel: LOCAL_MODEL_LABELS.fitTight,
    speed: 'ok',
    tokensPerSecond: 67.7,
    tested: true,
    needSource: 'measured',
    tag: { kind: 'tested', label: LOCAL_MODEL_TAG_LABELS.tested },
    harnesses: [OPENCODE, CLAUDE],
    installBytes: 23105798956 + RUNTIME_BYTES,
    installGb: '23.3',
    ...over,
  };
  return row;
}

const PICK = candidate();
const ALT_SLOW = candidate({
  modelId: 'qwen3.8:27b',
  modelLabel: 'Qwen3.8 27B',
  paramsB: 27.8,
  needGb: '30.6',
  downloadBytes: 17741871939,
  downloadGb: '17.7',
  budgetShare: 0.814,
  fit: 'good',
  fitLabel: LOCAL_MODEL_LABELS.fitGood,
  speed: 'slow',
  speedLabel: LOCAL_MODEL_LABELS.speedSlow,
  tokensPerSecond: 9.1,
  tested: false,
  needSource: 'estimated',
  tag: { kind: 'slow', label: LOCAL_MODEL_TAG_LABELS.slow },
  harnesses: [OPENCODE],
  installBytes: 17741871939 + RUNTIME_BYTES,
  installGb: '17.9',
});
const ALT_UNKNOWN = candidate({
  modelId: 'gpt-oss:20b',
  modelLabel: 'GPT-OSS 20B',
  paramsB: 20,
  needGb: '26.6',
  downloadBytes: 13793441427,
  downloadGb: '13.8',
  budgetShare: 0.709,
  fit: 'good',
  fitLabel: LOCAL_MODEL_LABELS.fitGood,
  speed: 'unknown',
  speedLabel: LOCAL_MODEL_LABELS.speedUnknown,
  tokensPerSecond: undefined,
  tested: false,
  needSource: 'estimated',
  tag: undefined,
  installBytes: 13793441427 + RUNTIME_BYTES,
  installGb: '14.0',
});
const ALT_SMALL_Q8 = candidate({
  modelId: 'qwen3.5:9b-q8_0',
  modelLabel: 'Qwen3.5 9B (Q8)',
  paramsB: 9,
  context: 65536,
  needGb: '20.9',
  downloadBytes: 10449217949,
  downloadGb: '10.4',
  budgetShare: 0.555,
  fit: 'good',
  fitLabel: LOCAL_MODEL_LABELS.fitGood,
  tokensPerSecond: 17.8,
  tested: false,
  needSource: 'estimated',
  tag: { kind: 'small', label: LOCAL_MODEL_TAG_LABELS.small },
  installBytes: 10449217949 + RUNTIME_BYTES,
  installGb: '10.6',
});
const ALT_SMALL = candidate({
  modelId: 'qwen3.5:9b',
  modelLabel: 'Qwen3.5 9B',
  paramsB: 9,
  context: 65536,
  needGb: '17.0',
  downloadBytes: 6550825373,
  downloadGb: '6.6',
  budgetShare: 0.452,
  fit: 'good',
  fitLabel: LOCAL_MODEL_LABELS.fitGood,
  tokensPerSecond: 28.6,
  tested: false,
  needSource: 'estimated',
  tag: { kind: 'small', label: LOCAL_MODEL_TAG_LABELS.small },
  installBytes: 6550825373 + RUNTIME_BYTES,
  installGb: '6.7',
});

const RUNTIME_MISSING = {
  version: '0.40.15',
  installed: false,
  downloadBytes: RUNTIME_BYTES,
  downloadGb: '0.2',
  unpackedGb: '0.6',
};
const RUNTIME_THERE = { version: '0.40.15', installed: true, downloadBytes: 0, downloadGb: '0.0', unpackedGb: '0.6' };
const FOLDER = '/Users/sam/.codeman/local-model';

function install(over: Partial<LocalModelInstallView> = {}): LocalModelInstallView {
  return {
    state: 'idle',
    running: false,
    developerTools: 'present',
    runtime: RUNTIME_MISSING,
    folder: FOLDER,
    library: [],
    harnesses: [],
    actions: ['install'],
    ...over,
  };
}

/** The installed model as the row of the library it is: in use, checked, with nothing to do on it. */
const QWEN_ROW: LocalModelLibraryRow = {
  id: 'qwen3.6:35b-a3b',
  label: 'Qwen3.6 35B-A3B',
  context: 131072,
  sizeBytes: 23105798956,
  sizeGb: '23.1',
  active: true,
  verified: true,
  status: 'ready',
  actions: [],
};
const STORE_ONE = { bytes: 23105798956, gb: '23.1' };

/** The members a job carries from `installing` on. */
const JOB: Partial<LocalModelInstallView> = {
  model: { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B' },
  cli: 'opencode',
  cliLabel: 'OpenCode',
  context: 131072,
  port: 11435,
  steps: ['runtime', 'model', 'verify', 'agent', 'connect'],
  runtime: RUNTIME_THERE,
};

function status(
  recommendation: Partial<Recommendation> = {},
  installOver: Partial<LocalModelInstallView> = {},
  hardware: Partial<HardwareFacts> = {}
): LocalModelStatus {
  return {
    hardware: { ...HARDWARE, ...hardware },
    recommendation: {
      verdict: 'ok',
      headline: { text: LOCAL_MODEL_LABELS.headlineTested },
      notes: [],
      pick: PICK,
      alternatives: [ALT_SLOW, ALT_UNKNOWN, ALT_SMALL_Q8, ALT_SMALL],
      budgetBytes: 37580963840,
      budgetGb: '37.6',
      budgetSource: 'estimated',
      ...recommendation,
    },
    catalogUpdated: '2026-11-06',
    install: install(installOver),
  };
}

const IDLE = status();

const PROGRESS = {
  completedBytes: 6238565718,
  totalBytes: 23105798956,
  completedGb: '6.2',
  totalGb: '23.1',
  bytesPerSecond: 58000000,
  mbPerSecond: '58',
  secondsLeft: 291,
};

const INSTALLING = status({}, { ...JOB, state: 'installing', step: 'model', actions: ['cancel'], progress: PROGRESS });
const PAUSED = status(
  {},
  {
    ...JOB,
    state: 'paused',
    step: 'model',
    actions: ['resume', 'install', 'remove'],
    progress: { completedBytes: 6238565718, totalBytes: 23105798956, completedGb: '6.2', totalGb: '23.1' },
  }
);
const INSTALLED = status(
  { budgetBytes: 40157944217, budgetGb: '40.2', budgetSource: 'measured' },
  {
    ...JOB,
    state: 'installed',
    running: true,
    endpointId: 'local-ollama',
    loaded: { context: 131072, memoryBytes: 26300000000, memoryGb: '26.3', onGpu: true },
    library: [QWEN_ROW],
    store: STORE_ONE,
    actions: ['start-session', 'stop', 'install', 'remove'],
  }
);
const STOPPED = status(
  {},
  {
    ...JOB,
    state: 'installed',
    running: false,
    endpointId: 'local-ollama',
    loaded: { context: 131072, memoryBytes: 26300000000, memoryGb: '26.3', onGpu: true },
    library: [QWEN_ROW],
    store: STORE_ONE,
    actions: ['start', 'install', 'remove'],
  }
);

/** A stopped job with one error code, its sentence and its helpful action from the contract's tables. */
function failed(code: LocalModelErrorCode, vars: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return status(
    {},
    {
      ...JOB,
      state: 'failed',
      step: 'verify',
      actions: ['resume', 'install', 'remove'],
      error: {
        code,
        message: { text: LOCAL_MODEL_ERROR_LABELS[code], ...(Object.keys(vars).length ? { vars } : {}) },
        next: LOCAL_MODEL_ERROR_NEXT[code],
        ...extra,
      },
    }
  );
}

/** A `none` answer: no pick, the reason's sentence as headline, its slots in `vars`. */
function none(reason: NoneReason, vars?: Record<string, string>, hardware: Partial<HardwareFacts> = {}) {
  const headline: LocalModelMessage = { text: LOCAL_MODEL_NONE_LABELS[reason], ...(vars ? { vars } : {}) };
  return status(
    { verdict: 'none', reason, headline, pick: undefined, alternatives: [], budgetBytes: 0, budgetGb: '0.0' },
    { actions: [] },
    hardware
  );
}

/**
 * Load an answer and open the window on it. The GET answers with the current status, and a verb
 * that succeeds moves that status the way the server does: its answer is the `install` object
 * every later GET carries.
 */
async function opened(page: Mounted, first: LocalModelStatus, verb?: ApiHandler) {
  let current = first;
  const app = page.newApp(async (path, opts) => {
    if (!opts.method || opts.method === 'GET') return ok(current);
    const answer = verb ? await verb(path, opts) : null;
    if (answer?.ok) {
      const body = (await answer.json()) as { data?: LocalModelInstallView };
      if (body.data && typeof body.data.state === 'string') current = { ...current, install: body.data };
    }
    return answer;
  });
  await app.loadLocalModel();
  app.openLocalModelWindow();
  await settle();
  return {
    app,
    /** What the server answers from now on. */
    serve: (next: LocalModelStatus) => {
      current = next;
    },
  };
}

// ---------- The page ----------

describe('the markup the module fills', () => {
  it('ships one hidden button above the welcome launchers, and no card', () => {
    const button = REAL_DOCUMENT.getElementById('welcomeLocalModelBtn')!;
    expect(button.hidden).toBe(true);
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    // The chip family of the launchers, and never inside the slot renderWelcomeCliActions empties.
    expect(button.classList.contains('welcome-chip')).toBe(true);
    expect(button.parentElement?.classList.contains('welcome-actions')).toBe(true);
    expect(button.closest('#welcomeCliActions')).toBeNull();
    const order = [...button.parentElement!.children].map((el) => el.id);
    // First on the start screen: the owner wants it above Run Claude Code.
    expect(order.indexOf('welcomeLocalModelBtn')).toBe(0);
    expect(order.indexOf('welcomeLocalModelBtn')).toBeLessThan(order.indexOf('welcomeCliActions'));
    expect(button.getAttribute('onclick')).toBe('app.openLocalModelWindow()');
    expect(button.hasAttribute('data-i18n-skip')).toBe(true);
    // The read-only card of the first version is gone, with its styles.
    expect(REAL_DOCUMENT.getElementById('localModelCard')).toBeNull();
    for (const css of [STYLES, MOBILE]) expect(css).not.toContain('.local-model-card');
    // The phone overview is a different screen and does not carry the button.
    expect(button.closest('#mobileOverview')).toBeNull();
    // `.welcome-chip` is inline-flex: without this rule `hidden` would not hide it.
    expect(STYLES).toMatch(/\.welcome-local-model\[hidden\]\s*\{\s*display:\s*none;/);
  });

  it('ships the window as a dialog in App Settings chrome, after App Settings', () => {
    const modal = REAL_DOCUMENT.getElementById('localModelModal')!;
    expect(modal.classList.contains('modal')).toBe(true);
    expect(modal.classList.contains('active')).toBe(false);
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(modal.getAttribute('aria-labelledby')).toBe('localModelModalTitle');
    expect(REAL_DOCUMENT.getElementById('localModelModalTitle')!.textContent).toBe('Run a model on this Mac');
    expect(modal.querySelector('.modal-backdrop')!.getAttribute('onclick')).toBe('app.closeLocalModelWindow()');
    expect(modal.querySelector('.modal-header .modal-close')!.getAttribute('onclick')).toBe(
      'app.closeLocalModelWindow()'
    );
    const body = REAL_DOCUMENT.getElementById('localModelWindowBody')!;
    expect(body.hasAttribute('data-i18n-skip')).toBe(true);
    expect(body.textContent).toBe('');
    // Later in the document than App Settings, so it stacks above it when opened from there.
    const settings = REAL_DOCUMENT.getElementById('appSettingsModal')!;
    expect(settings.compareDocumentPosition(modal) & REAL.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('ships one row with a button in Settings > Models', () => {
    const row = REAL_DOCUMENT.getElementById('localModelSettings')!;
    const group = REAL_DOCUMENT.getElementById('localModelGroup')!;
    expect(group.closest('#appSettingsModal #settings-models')).not.toBeNull();
    // Its own group: the endpoints toggle hides #customModelEndpointsBody, and this does not depend on it.
    expect(row.closest('#customModelEndpointsBody')).toBeNull();
    expect(row.closest('.set-row')).not.toBeNull();
    expect(row.hasAttribute('data-i18n-skip')).toBe(true);
    const controls = [...group.querySelectorAll('input, select, button, textarea')];
    expect(controls.map((el) => el.id)).toEqual(['localModelSettingsOpen']);
    expect(controls[0].getAttribute('onclick')).toBe('app.openLocalModelWindow()');
    expect(group.querySelector('.set-group-hint')!.textContent).not.toMatch(/read-only/i);
    expect(INDEX.split('<script defer src="local-model-ui.js"></script>').length - 1).toBe(1);
  });

  it('is what every other test here runs on', () => {
    const { button, group, modal } = mount();
    expect(button.outerHTML).toBe(BUTTON_MARKUP);
    expect(group.outerHTML).toBe(GROUP_MARKUP);
    expect(modal.outerHTML).toBe(MODAL_MARKUP);
  });

  it('is wired into the places that show it, and Escape closes the window alone', () => {
    const read = (file: string) => readFileSync(resolve(PUBLIC, file), 'utf8');
    // The welcome screen (not the phone overview branch above it) and App Settings.
    expect(read('terminal-ui.js').split('this.loadLocalModel?.();').length - 1).toBe(1);
    expect(read('settings-ui.js').split('this.loadLocalModel?.();').length - 1).toBe(1);
    // The window can sit on App Settings: its Escape is claimed before every panel is closed.
    const app = read('app.js');
    const claim = app.indexOf('if (this.isLocalModelWindowOpen?.()) {');
    expect(claim).toBeGreaterThan(-1);
    expect(app.slice(claim, claim + 120)).toContain('this.closeLocalModelWindow();\n          return;');
    expect(claim).toBeLessThan(app.indexOf('this.closeAllPanels();', claim));
  });
});

describe('before there is an answer', () => {
  it('keeps the button and the Settings group hidden while the first request is in flight', async () => {
    const { newApp, button, row, group } = mount();
    let answer!: (response: ApiResponse) => void;
    const app = newApp(() => new Promise<ApiResponse>((done) => (answer = done)));
    const loading = app.loadLocalModel();
    expect(button.hidden).toBe(true);
    // Nothing says yet that the server is a Mac, so no group titled "Model on this Mac".
    expect(group.style.display).toBe('none');
    expect(row.textContent).toBe('');
    answer(ok(IDLE));
    await loading;
    expect(button.hidden).toBe(false);
    expect(group.style.display).toBe('');
    expect(texts(row, '.set-row-label')).toEqual(['No model installed']);
  });

  it.each([
    ['the route answers 501', refusal(501, 'OPERATION_FAILED')],
    ['the request never reached the server', null],
    ['the body is not the envelope', { ok: true, status: 200, json: async () => ({ hello: 'world' }) }],
    ['the body is not JSON', { ok: true, status: 200, json: async () => Promise.reject(new Error('bad')) }],
    ['the data carries no recommendation', ok({ hardware: HARDWARE })],
  ] as Array<[string, ApiResponse]>)('shows a failed request only in Settings: %s', async (_name, response) => {
    const { newApp, button, row, rowButton, group } = mount();
    const app = newApp(response);
    await app.loadLocalModel();
    // Nothing is known about the machine, so the welcome screen gets no button, and the row no way in.
    expect(button.hidden).toBe(true);
    expect(group.style.display).toBe('');
    expect(row.textContent).toBe('Could not reach the server.');
    expect(rowButton.hidden).toBe(true);
    app.openLocalModelWindow();
    expect(app.isLocalModelWindowOpen()).toBe(true);
  });

  it('asks again the next time it is shown after a failure, and keeps an answer while it is refreshed', async () => {
    const { win, newApp, button, row } = mount();
    let now = 1_000_000;
    (win as unknown as { Date: DateConstructor }).Date.now = () => now;
    const answers: ApiResponse[] = [null, ok(IDLE), null];
    const app = newApp(async () => answers.shift() ?? null);
    await app.loadLocalModel();
    expect(row.textContent).toBe('Could not reach the server.');
    await app.loadLocalModel();
    expect(app._api).toHaveBeenCalledTimes(2);
    expect(button.hidden).toBe(false);
    // Fresh for a minute: no request. Then a failed refresh keeps the answer on screen.
    await app.loadLocalModel();
    expect(app._api).toHaveBeenCalledTimes(2);
    now += 61_000;
    await app.loadLocalModel();
    expect(app._api).toHaveBeenCalledTimes(3);
    expect(button.hidden).toBe(false);
    expect(texts(row, '.set-row-label')).toEqual(['No model installed']);
  });
});

describe('a refused request (a non-admin in multi-user mode)', () => {
  it('shows neither the button nor the Settings group, opens no window, and stops asking', async () => {
    const { newApp, button, row, group, modal } = mount();
    const app = newApp(refusal(403, 'FORBIDDEN'));
    await app.loadLocalModel();
    expect(button.hidden).toBe(true);
    expect(group.style.display).toBe('none');
    expect(row.textContent).toBe('');
    await app.loadLocalModel();
    expect(app._api).toHaveBeenCalledTimes(1);
    app.openLocalModelWindow();
    expect(modal.classList.contains('active')).toBe(false);
  });

  it('does not ask at all when the page already knows the user is not an admin', async () => {
    const { win, newApp, button, group } = mount();
    win.__codemanUser = { multiUser: true, role: 'user' };
    const app = newApp(ok(IDLE));
    await app.loadLocalModel();
    expect(app._api).not.toHaveBeenCalled();
    expect(button.hidden).toBe(true);
    expect(group.style.display).toBe('none');
  });

  it('does not take another 403 for a refusal: an admin who must change the password is asked again', async () => {
    // The auth layer answers 403 PASSWORD_CHANGE_REQUIRED for every /api route until the
    // password is changed, and the dialog that changes it closes without a reload.
    const { dom, win, document, newApp, button, row, group } = mount();
    win.__codemanUser = { multiUser: true, role: 'admin' };
    const answers: ApiResponse[] = [refusal(403, 'PASSWORD_CHANGE_REQUIRED'), ok(IDLE)];
    const app = newApp(async () => answers.shift() ?? null);
    await app.loadLocalModel();
    expect(button.hidden).toBe(true);
    // A failed request, not a refusal: the group stays, with the failure sentence.
    expect(group.style.display).toBe('');
    expect(row.textContent).toBe('Could not reach the server.');
    // The password was changed: admin-ui.js announces the user again.
    document.dispatchEvent(new dom.window.CustomEvent('codeman:me'));
    await vi.waitFor(() => expect(button.hidden).toBe(false));
    expect(app._api).toHaveBeenCalledTimes(2);
  });

  it('closes an open window when the routes start refusing', async () => {
    const page = mount();
    const { app } = await opened(page, IDLE);
    expect(page.modal.classList.contains('active')).toBe(true);
    app._api.mockImplementation(async () => refusal(403, 'FORBIDDEN'));
    await app.loadLocalModel({ force: true });
    expect(page.modal.classList.contains('active')).toBe(false);
    expect(page.button.hidden).toBe(true);
  });
});

describe('a server that is not a Mac', () => {
  it('shows no button and no Settings group', async () => {
    const { newApp, button, row, group, modal } = mount();
    const app = newApp(ok(none('not-macos', undefined, { platform: 'linux', arch: 'x64', chip: 'AMD EPYC' })));
    await app.loadLocalModel();
    expect(button.hidden).toBe(true);
    expect(group.style.display).toBe('none');
    expect(row.textContent).toBe('');
    expect(modal.classList.contains('active')).toBe(false);
  });
});

describe('the welcome button', () => {
  it('offers to run a local model until one is installed, then names it', async () => {
    const { newApp, button, document } = mount();
    let current = IDLE;
    const app = newApp(() => ok(current));
    await app.loadLocalModel();
    expect(button.hidden).toBe(false);
    expect(document.getElementById('welcomeLocalModelLabel')!.textContent).toBe('Run a local model');
    // The icon of the markup stays: only the label is written.
    expect(button.querySelector('svg')).not.toBeNull();
    for (const busy of [INSTALLING, PAUSED, failed('load-failed', { model: 'Qwen3.6 35B-A3B' })]) {
      current = busy;
      await app.loadLocalModel({ force: true });
      expect(button.textContent!.trim()).toBe('Run a local model');
    }
    current = INSTALLED;
    await app.loadLocalModel({ force: true });
    expect(button.textContent!.trim()).toBe('Local model');
    current = STOPPED;
    await app.loadLocalModel({ force: true });
    expect(button.textContent!.trim()).toBe('Local model');
  });

  it('shows on a Mac that can run no model too: the window says why', async () => {
    const { newApp, button } = mount();
    const app = newApp(ok(none('memory', { memory: '8' }, { memClassGb: 8, memGb: '8.6', chip: 'Apple M2' })));
    await app.loadLocalModel();
    expect(button.hidden).toBe(false);
    expect(button.textContent!.trim()).toBe('Run a local model');
  });

  it('opens the window, and the window gives the focus back when it closes', async () => {
    const page = mount();
    const app = page.newApp(ok(IDLE));
    await app.loadLocalModel();
    page.button.focus();
    app.openLocalModelWindow();
    expect(page.modal.classList.contains('active')).toBe(true);
    expect(app.isLocalModelWindowOpen()).toBe(true);
    // The focus lands on the selected model, inside the dialog.
    expect(page.document.activeElement?.getAttribute('role')).toBe('radio');
    app.closeLocalModelWindow();
    expect(page.modal.classList.contains('active')).toBe(false);
    expect(page.document.activeElement).toBe(page.button);
    // Escape and the backdrop call it whether or not the window is open.
    app.closeLocalModelWindow();
    expect(app.isLocalModelWindowOpen()).toBe(false);
  });
});

describe('the App Settings row', () => {
  it.each([
    ['nothing installed', IDLE, 'No model installed', 'Apple M5 Pro, 48 GB memory, 897 GB free', 'Choose a model'],
    ['an install running', INSTALLING, 'Installing Qwen3.6 35B-A3B', 'Apple M5 Pro, 48 GB memory, 897 GB free', 'Open'],
    ['a paused install', PAUSED, 'The install of Qwen3.6 35B-A3B is paused', undefined, 'Open'],
    [
      'a stopped install',
      failed('load-failed', { model: 'Qwen3.6 35B-A3B' }),
      'The install of Qwen3.6 35B-A3B stopped',
      undefined,
      'Open',
    ],
    ['a running model', INSTALLED, 'Qwen3.6 35B-A3B is running', undefined, 'Open'],
    ['a stopped model', STOPPED, 'Qwen3.6 35B-A3B is installed and stopped', undefined, 'Open'],
  ] as Array<[string, LocalModelStatus, string, string | undefined, string]>)(
    'says where things stand in a few words: %s',
    async (_name, answer, label, detail, action) => {
      const { newApp, row, rowButton, group } = mount();
      const app = newApp(ok(answer));
      await app.loadLocalModel();
      expect(group.style.display).toBe('');
      expect(texts(row, '.set-row-label')).toEqual([label]);
      if (detail) expect(texts(row, '.set-row-desc')).toEqual([detail]);
      expect(rowButton.hidden).toBe(false);
      expect(rowButton.textContent).toBe(action);
    }
  );

  it('gives the reason when no model fits, and still opens the window', async () => {
    const page = mount();
    const app = page.newApp(ok(none('memory', { memory: '8' }, { memClassGb: 8, memGb: '8.6', chip: 'Apple M2' })));
    await app.loadLocalModel();
    expect(texts(page.row, '.set-row-label')).toEqual(['No model installed']);
    expect(texts(page.row, '.set-row-desc')).toEqual([
      'With 8 GB of memory, this Mac cannot run a model that can drive a coding agent.',
    ]);
    expect(page.rowButton.textContent).toBe('Open');
    app.openLocalModelWindow();
    expect(page.body.dataset.screen).toBe('none');
  });
});

// ---------- The chooser ----------

describe('the chooser', () => {
  it('opens with the hardware line, the memory bar and the five models, the pick selected', async () => {
    const page = mount();
    await opened(page, IDLE);
    const { body } = page;
    expect(body.dataset.screen).toBe('choose');
    expect(texts(body, '.lm-hw')).toEqual(['Apple M5 Pro, 48 GB memory, 897 GB free']);
    // An estimate, in whole GB: "about 36 of 38", never "36.0 of 37.6".
    expect(texts(body, '.lm-figure')).toEqual(['About 36 of 38 GB of memory']);

    const group = body.querySelector('[role="radiogroup"]')!;
    const label = page.document.getElementById(group.getAttribute('aria-labelledby')!)!;
    // The server's word for a pick it has run on a Mac like this one labels the list.
    expect(label.textContent).toBe('Recommended for this Mac');
    const rows = [...group.querySelectorAll('[role="radio"]')];
    expect(rows.map((row) => row.querySelector('.lm-model-name')!.textContent)).toEqual([
      'Qwen3.6 35B-A3B',
      'Qwen3.8 27B',
      'GPT-OSS 20B',
      'Qwen3.5 9B (Q8)',
      'Qwen3.5 9B',
    ]);
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    // The order can be read off the Download column: the pick, then the others largest first.
    expect(rows.map((row) => row.querySelector('.lm-model-size')!.textContent)).toEqual([
      '23.1 GB',
      '17.7 GB',
      '13.8 GB',
      '10.4 GB',
      '6.6 GB',
    ]);
    // One tab stop: the selected row.
    expect(rows.map((row) => row.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1']);
    // One line a row: name, one tag, speed, download size.
    expect(rows.map((row) => row.querySelector('.lm-model-tag')!.textContent)).toEqual([
      'Tested on a Mac like this',
      'Slow',
      '',
      'Small model',
      'Small model',
    ]);
    // A measured speed is stated, an estimate says "about", and a missing one says so.
    expect(texts(group, '.lm-model-speed')).toEqual([
      '68 tokens/s',
      'about 9.1 tokens/s',
      'speed not known',
      'about 18 tokens/s',
      'about 29 tokens/s',
    ]);
    expect(texts(group, '.lm-model-size')).toEqual(['23.1 GB', '17.7 GB', '13.8 GB', '10.4 GB', '6.6 GB']);
    expect(texts(body, '.lm-caption span')).toEqual(['Recommended for this Mac', 'Speed', 'Download']);
    expect(texts(frameOf(body), '.lm-foot-note')).toEqual([
      'No account and no API key. The model runs only on this Mac.',
    ]);
    expect(buttons(body)).toEqual(['Install on this Mac']);
  });

  it('gives the accent to the pick and to a tested row only', async () => {
    const page = mount();
    const best = candidate({ tested: false, tag: { kind: 'best', label: LOCAL_MODEL_TAG_LABELS.best } });
    const tight = candidate({
      modelId: 'gpt-oss:20b',
      modelLabel: 'GPT-OSS 20B',
      tested: false,
      tag: { kind: 'tight', label: LOCAL_MODEL_TAG_LABELS.tight },
    });
    await opened(
      page,
      status({
        headline: { text: LOCAL_MODEL_LABELS.headlineOk },
        pick: best,
        alternatives: [tight, ALT_SLOW, ALT_SMALL],
      })
    );
    const tags = [...page.body.querySelectorAll('.lm-tag')];
    expect(tags.map((tag) => tag.textContent)).toEqual(['Best fit', 'Tight', 'Slow', 'Small model']);
    expect(tags.map((tag) => tag.classList.contains('lm-tag-accent'))).toEqual([true, false, false, false]);
    // "Best fit for this Mac" would only repeat the tag: the list is labelled by what it holds.
    expect(texts(page.body, '.lm-caption-label')).toEqual(['Models that fit this Mac']);
    expect(page.body.textContent).not.toContain('Recommended');
    expect(page.body.textContent).not.toContain('Best fit for this Mac');
  });

  it('says "estimated" once while the budget is a formula, and not once it is measured', async () => {
    const page = mount();
    const { app, serve } = await opened(page, IDLE);
    expect(texts(page.body, '.lm-figure-aside')).toEqual(['estimated']);
    for (const budgetSource of ['measured', 'wired-limit'] as const) {
      serve(status({ budgetBytes: 40157944217, budgetGb: '40.2', budgetSource }));
      await app.loadLocalModel({ force: true });
      expect(texts(page.body, '.lm-figure')).toEqual(['About 36 of 40 GB of memory']);
      expect(texts(page.body, '.lm-figure-aside')).toEqual([]);
      expect(page.body.textContent).not.toContain('estimated');
    }
  });

  it('puts the small-model caveat above the list and the notes under it', async () => {
    const page = mount();
    await opened(
      page,
      status({
        verdict: 'limited',
        headline: { text: LOCAL_MODEL_LABELS.headlineLimited },
        notes: [
          { text: LOCAL_MODEL_LABELS.noteDiskDropped, vars: { model: 'Qwen3.6 35B-A3B', missing: '0.4' } },
          { text: LOCAL_MODEL_LABELS.noteUntested },
        ],
        pick: ALT_SMALL,
        alternatives: [],
      })
    );
    expect(texts(page.body, '.lm-lead')).toEqual([LOCAL_MODEL_LABELS.headlineLimited]);
    expect(texts(page.body, '.lm-caption-label')).toEqual(['Models that fit this Mac']);
    expect(texts(page.body, '.lm-notes .lm-aside')).toEqual([
      'Qwen3.6 35B-A3B fits the memory of this Mac too, but its download needs about 0.4 GB more free disk space.',
      'Codeman has not run this on a Mac like this yet.',
    ]);
  });

  it('offers only the coding agents the server lists for the selected model', async () => {
    const page = mount();
    await opened(page, IDLE);
    const { body } = page;
    const select = () => body.querySelector<HTMLSelectElement>('select.lm-select')!;
    expect(texts(body, '.lm-runs-label')).toEqual(['Runs with']);
    expect(body.querySelector('.lm-runs-label')!.getAttribute('for')).toBe(select().id);
    expect([...select().options].map((option) => option.textContent)).toEqual(['OpenCode', 'Claude Code']);
    expect(select().selectedOptions[0].textContent).toBe('OpenCode');
    expect(texts(body, '.lm-runs-hint')).toEqual(['Not on this Mac yet. Codeman installs it for you.']);
    // No value in the page is a CLI id: the choice is a position in the server's list.
    expect([...select().options].map((option) => option.value)).toEqual(['0', '1']);

    select().value = '1';
    select().dispatchEvent(new page.dom.window.Event('change'));
    expect(select().selectedOptions[0].textContent).toBe('Claude Code');
    expect(texts(body, '.lm-runs-hint')).toEqual(['The first answer can take minutes.']);

    // The agent stays when the next row offers it too, and falls back to that row's first when not.
    (body.querySelectorAll<HTMLElement>('[role="radio"]')[2] as HTMLElement).click();
    expect(select().selectedOptions[0].textContent).toBe('Claude Code');
    (body.querySelectorAll<HTMLElement>('[role="radio"]')[1] as HTMLElement).click();
    expect([...select().options].map((option) => option.textContent)).toEqual(['OpenCode']);
  });

  it('reads a payload without the agent list as the one agent of the flat fields', async () => {
    const page = mount();
    const flat = { ...PICK, harnesses: undefined, cliInstalled: true } as unknown as Candidate;
    await opened(page, status({ pick: flat, alternatives: [] }));
    const select = page.body.querySelector<HTMLSelectElement>('select.lm-select')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(['OpenCode']);
    expect(texts(page.body, '.lm-runs-hint')).toEqual([]);
  });

  it('has a button only when the server accepts an install', async () => {
    const page = mount();
    const { app, serve } = await opened(page, status({}, { actions: [] }));
    expect(page.body.dataset.screen).toBe('choose');
    expect(buttons(page.body)).toEqual([]);
    // A server that sends no `install` object yet: the chooser, and nothing to press.
    const older = { ...IDLE } as Partial<LocalModelStatus>;
    delete older.install;
    serve(older as LocalModelStatus);
    await app.loadLocalModel({ force: true });
    expect(page.body.querySelectorAll('[role="radio"]')).toHaveLength(5);
    expect(buttons(page.body)).toEqual([]);
  });
});

describe('the radio group at the keyboard', () => {
  const key = (page: Mounted, name: string) => {
    const event = new page.dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    page.document.activeElement!.dispatchEvent(event);
    return event;
  };
  const checked = (page: Mounted) =>
    page.body.querySelector('[role="radio"][aria-checked="true"] .lm-model-name')!.textContent;

  it('moves the selection with the arrow keys, Home and End, and the focus follows', async () => {
    const page = mount();
    await opened(page, IDLE);
    expect(checked(page)).toBe('Qwen3.6 35B-A3B');
    const walk: Array<[string, string]> = [
      ['ArrowDown', 'Qwen3.8 27B'],
      ['ArrowRight', 'GPT-OSS 20B'],
      ['ArrowUp', 'Qwen3.8 27B'],
      ['ArrowLeft', 'Qwen3.6 35B-A3B'],
      // The ends wrap.
      ['ArrowUp', 'Qwen3.5 9B'],
      ['ArrowDown', 'Qwen3.6 35B-A3B'],
      ['End', 'Qwen3.5 9B'],
      ['Home', 'Qwen3.6 35B-A3B'],
    ];
    for (const [name, model] of walk) {
      const event = key(page, name);
      expect(event.defaultPrevented, name).toBe(true);
      expect(checked(page), name).toBe(model);
      // The focus is on the selected row, which is the group's one tab stop.
      const active = page.document.activeElement!;
      expect(active.getAttribute('aria-checked'), name).toBe('true');
      expect(active.getAttribute('tabindex'), name).toBe('0');
      expect(page.body.querySelectorAll('[role="radio"][tabindex="0"]'), name).toHaveLength(1);
    }
  });

  it('leaves every other key to the page', async () => {
    const page = mount();
    await opened(page, IDLE);
    for (const name of ['Tab', 'a', 'Escape', 'PageDown']) {
      expect(key(page, name).defaultPrevented, name).toBe(false);
      expect(checked(page)).toBe('Qwen3.6 35B-A3B');
    }
  });

  it('selects a row on a click, and keeps the selection across the poll', async () => {
    const page = mount();
    const { app } = await opened(page, IDLE);
    page.body.querySelectorAll<HTMLElement>('[role="radio"]')[3].click();
    expect(checked(page)).toBe('Qwen3.5 9B (Q8)');
    const row = page.body.querySelector('[role="radio"][aria-checked="true"]');
    await page.tick();
    await app.loadLocalModel({ force: true });
    expect(checked(page)).toBe('Qwen3.5 9B (Q8)');
    // The same answer again repaints nothing: the very same element is still there.
    expect(page.body.querySelector('[role="radio"][aria-checked="true"]')).toBe(row);
  });
});

describe('the memory bar', () => {
  const meter = (page: Mounted) => page.body.querySelector('.lm-bar')!;
  const fill = (page: Mounted) => page.body.querySelector<HTMLElement>('.lm-bar-fill')!;

  it('is filled to what the selected model needs, and follows the selection', async () => {
    const page = mount();
    await opened(page, IDLE);
    expect(meter(page).getAttribute('role')).toBe('meter');
    expect(meter(page).getAttribute('aria-valuemin')).toBe('0');
    expect(meter(page).getAttribute('aria-valuemax')).toBe('100');
    // The pick is a tight fit: the bar is nearly full.
    expect(meter(page).getAttribute('aria-valuenow')).toBe('96');
    expect(fill(page).style.width).toBe('96%');
    expect(meter(page).getAttribute('aria-label')).toBe(
      'The selected model needs 96% of the memory this Mac can give a model'
    );

    const expected: Array<[number, string, string]> = [
      [1, '81', 'About 31 of 38 GB of memory'],
      [4, '45', 'About 17 of 38 GB of memory'],
      [0, '96', 'About 36 of 38 GB of memory'],
    ];
    for (const [index, percent, figure] of expected) {
      page.body.querySelectorAll<HTMLElement>('[role="radio"]')[index].click();
      expect(meter(page).getAttribute('aria-valuenow')).toBe(percent);
      expect(fill(page).style.width).toBe(`${percent}%`);
      expect(texts(page.body, '.lm-figure')).toEqual([figure]);
    }
  });

  it('splits the bar into what the model takes, and names each part with its size', async () => {
    const page = mount();
    const memory = { modelBytes: 26_105_798_956, contextBytes: 4_849_664_000, peakBytes: 5_000_000_000 };
    await opened(
      page,
      status({
        pick: candidate({ memory, fit: 'tight', budgetShare: 0.957, context: 131072 }),
        alternatives: [],
        budgetBytes: 37_580_963_840,
      })
    );
    const fills = [...page.body.querySelectorAll<HTMLElement>('.lm-bar .lm-bar-fill')];
    expect(fills.map((el) => el.dataset.kind)).toEqual(['memory-model', 'memory-context', 'memory-peak']);
    expect(fills.map((el) => el.style.width)).toEqual(['69.5%', '12.9%', '13.3%']);
    // The meter still says the whole share, for a screen reader.
    expect(page.body.querySelector('.lm-bar')!.getAttribute('aria-valuenow')).toBe('96');
    expect(texts(page.body, '.lm-legend-name')).toEqual([
      'The model',
      'Context, 131,072 tokens',
      'Brief peaks',
      'Stays free',
    ]);
    expect(texts(page.body, '.lm-legend-size')).toEqual(['26 GB', '5 GB', '5 GB', '2 GB']);
    expect(texts(page.body, '.lm-fit')).toEqual(['Tight fit']);
    expect(page.body.querySelector('.lm-fit')!.classList.contains('lm-fit-tight')).toBe(true);
  });

  it('gives every row a size tile and a speed gauge scaled to the fastest row', async () => {
    const page = mount();
    await opened(
      page,
      status({
        pick: candidate({ paramsB: 35, tokensPerSecond: 80, speed: 'ok' }),
        alternatives: [
          candidate({ modelId: 'b:1', modelLabel: 'B', paramsB: 27.8, tokensPerSecond: 8, speed: 'slow' }),
          candidate({ modelId: 'c:1', modelLabel: 'C', paramsB: 9, tokensPerSecond: undefined, speed: 'unknown' }),
        ],
      })
    );
    expect(texts(page.body, '.lm-tile')).toEqual(['35B', '27B', '9B']);
    const tiles = [...page.body.querySelectorAll('.lm-tile')];
    expect(tiles.map((el) => el.className)).toEqual([
      'lm-tile lm-tile-large',
      'lm-tile lm-tile-mid',
      'lm-tile lm-tile-small',
    ]);
    const gauges = [...page.body.querySelectorAll('.lm-gauge')];
    expect(gauges.map((el) => el.className)).toEqual([
      'lm-gauge lm-gauge-ok',
      'lm-gauge lm-gauge-slow',
      'lm-gauge lm-gauge-unknown',
    ]);
    expect(gauges[0].querySelector<HTMLElement>('.lm-gauge-fill')!.style.width).toBe('100%');
    expect(gauges[1].querySelector<HTMLElement>('.lm-gauge-fill')!.style.width).toBe('10%');
    expect(gauges[2].querySelector('.lm-gauge-fill')).toBeNull();
  });

  it('never runs past its track', async () => {
    const page = mount();
    await opened(page, status({ pick: candidate({ budgetShare: 1.2 }), alternatives: [] }));
    expect(meter(page).getAttribute('aria-valuenow')).toBe('100');
    expect(fill(page).style.width).toBe('100%');
  });

  it('moves on a width transition, without a glow, and stands still when motion is not wanted', () => {
    const bar = STYLES.match(/\.lm-bar-fill \{[^}]*\}/)![0];
    expect(bar).toContain('transition: width');
    expect(bar).not.toMatch(/box-shadow|animation/);
    expect(STYLES).toMatch(/\.lm-bar \{[^}]*height: 12px;[^}]*border-radius: 999px;/);
    expect(STYLES).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.lm-bar-fill,[^}]*transition: none;/);
  });
});

// ---------- Confirm and the consent ----------

describe('the confirm screen', () => {
  it('collapses the list to the chosen row and says what is downloaded, and where it goes', async () => {
    const page = mount();
    await opened(page, status({}, { developerTools: 'missing' }));
    press(page.body, 'Install on this Mac');
    const { body } = page;
    expect(body.dataset.screen).toBe('confirm');
    // Nothing was sent: this is the question.
    expect(body.querySelectorAll('[role="radio"]')).toHaveLength(0);
    // The table is the screen: the chosen row first, the runtime, the missing coding agent
    // with its installer's literal command, and the total.
    expect(texts(body, '.lm-heading')).toEqual(['What will be downloaded']);
    expect(texts(body, '.lm-size-name')).toEqual(['Qwen3.6 35B-A3B', 'Ollama 0.40.15', 'OpenCode', 'Total']);
    expect(texts(body, '.lm-size-note')).toEqual([
      'At 131,072 tokens of context, with OpenCode',
      'The program that runs the model',
      'Not on this Mac yet. Its own installer fetches it with this command:',
    ]);
    expect(texts(body, '.lm-size-gb')).toEqual(['23.1 GB', '0.2 GB', '23.3 GB']);
    expect(body.querySelector('.lm-size-total .lm-size-gb')!.textContent).toBe('23.3 GB');
    expect(texts(body, '.lm-command')).toEqual(['curl -fsSL https://opencode.ai/install | bash']);
    // Where it goes, in one line; the developer tools sentence as the one aside.
    expect(texts(body, '.lm-path')).toEqual([FOLDER]);
    expect(texts(body, '.lm-aside')).toEqual([LOCAL_MODEL_INSTALL_LABELS.developerToolsMissing]);
    // The promise sits beside the buttons.
    expect(texts(frameOf(body), '.lm-foot-note')).toEqual(['No administrator password.']);
    expect(buttons(body)).toEqual(['Back', 'Download and install']);
  });

  it('leaves out what does not apply: an installed runtime, an installed agent, a Mac with developer tools', async () => {
    const page = mount();
    const pick = candidate({ installBytes: 23105798956, installGb: '23.1', harnesses: [CLAUDE] });
    await opened(page, status({ pick, alternatives: [] }, { runtime: RUNTIME_THERE, developerTools: 'present' }));
    press(page.body, 'Install on this Mac');
    expect(texts(page.body, '.lm-size-name')).toEqual(['Qwen3.6 35B-A3B', 'Total']);
    expect(texts(page.body, '.lm-command')).toEqual([]);
    expect(texts(page.body, '.lm-path')).toEqual([FOLDER]);
    expect(page.body.textContent).not.toContain('developer tools');
    expect(page.body.textContent).not.toContain('installer');
  });

  it.each(['unknown', 'present'] as const)('says nothing about developer tools when they are %s', async (tools) => {
    const page = mount();
    await opened(page, status({}, { developerTools: tools }));
    press(page.body, 'Install on this Mac');
    expect(page.body.textContent).not.toContain('git');
  });

  it('goes back to the chooser with the selection kept', async () => {
    const page = mount();
    await opened(page, IDLE);
    page.body.querySelectorAll<HTMLElement>('[role="radio"]')[1].click();
    press(page.body, 'Install on this Mac');
    expect(texts(page.body, '.lm-size-name')[0]).toBe('Qwen3.8 27B');
    press(page.body, 'Back');
    expect(page.body.dataset.screen).toBe('choose');
    expect(page.body.querySelector('[aria-checked="true"] .lm-model-name')!.textContent).toBe('Qwen3.8 27B');
  });
});

describe('the consent', () => {
  it('sends the row that was on screen with the total that was on screen', async () => {
    const page = mount();
    const { app } = await opened(page, IDLE, () => ok(INSTALLING.install));
    press(page.body, 'Install on this Mac');
    expect(verbs(app)).toEqual([]);
    press(page.body, 'Download and install');
    await settle();
    expect(verbs(app)).toEqual([
      [
        'POST',
        '/api/local-model/install',
        {
          modelId: 'qwen3.6:35b-a3b',
          cli: 'opencode',
          context: 131072,
          acknowledgedBytes: 23105798956 + RUNTIME_BYTES,
        },
      ],
    ]);
    // The answer is the install after the verb: the window shows the download at once.
    expect(page.body.dataset.screen).toBe('progress');
  });

  it('sends the other row and the other agent when those were chosen', async () => {
    const page = mount();
    const { app } = await opened(page, IDLE, () => ok(INSTALLING.install));
    page.body.querySelectorAll<HTMLElement>('[role="radio"]')[3].click();
    const select = page.body.querySelector<HTMLSelectElement>('select.lm-select')!;
    select.value = '1';
    select.dispatchEvent(new page.dom.window.Event('change'));
    press(page.body, 'Install on this Mac');
    expect(texts(page.body, '.lm-size-total .lm-size-gb')).toEqual(['10.6 GB']);
    press(page.body, 'Download and install');
    await settle();
    expect(verbs(app)[0][2]).toEqual({
      modelId: 'qwen3.5:9b-q8_0',
      cli: 'claude',
      context: 65536,
      acknowledgedBytes: 10449217949 + RUNTIME_BYTES,
    });
  });

  it('reads a row without its own total as the model plus the runtime download', async () => {
    const page = mount();
    const bare = { ...PICK, installBytes: undefined, installGb: undefined } as unknown as Candidate;
    const { app } = await opened(page, status({ pick: bare, alternatives: [] }), () => ok(INSTALLING.install));
    press(page.body, 'Install on this Mac');
    // No total the server formatted, so none is printed: bytes are never turned into a size here.
    expect(texts(page.body, '.lm-size-name')).toEqual(['Qwen3.6 35B-A3B', 'Ollama 0.40.15', 'OpenCode']);
    expect(page.body.querySelector('.lm-size-total')).toBeNull();
    press(page.body, 'Download and install');
    await settle();
    expect((verbs(app)[0][2] as { acknowledgedBytes: number }).acknowledgedBytes).toBe(23105798956 + RUNTIME_BYTES);
  });

  it('shows the new total after a 409 size-changed, and sends that one next', async () => {
    const page = mount();
    const answers: ApiResponse[] = [
      conflict({
        reason: 'size-changed',
        message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictSizeChanged, vars: { size: '23.9' } },
        expectedBytes: 23900000000,
        expectedGb: '23.9',
      }),
      ok(INSTALLING.install),
    ];
    const { app } = await opened(page, IDLE, () => answers.shift() ?? null);
    press(page.body, 'Install on this Mac');
    press(page.body, 'Download and install');
    await settle();
    // Still the question, now with the server's sentence and its total.
    expect(page.body.dataset.screen).toBe('confirm');
    const notice = page.body.querySelector('.lm-notice')!;
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toBe('The download is 23.9 GB now. Check the sizes and confirm again.');
    expect(texts(page.body, '.lm-size-total .lm-size-gb')).toEqual(['23.9 GB']);
    press(page.body, 'Download and install');
    await settle();
    expect(verbs(app).map((verb) => (verb[2] as { acknowledgedBytes: number }).acknowledgedBytes)).toEqual([
      23105798956 + RUNTIME_BYTES,
      23900000000,
    ]);
    expect(page.body.dataset.screen).toBe('progress');
  });

  it('forgets a refused total when the person goes back and picks again', async () => {
    const page = mount();
    const { app } = await opened(page, IDLE, () =>
      conflict({
        reason: 'size-changed',
        message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictSizeChanged, vars: { size: '23.9' } },
        expectedBytes: 23900000000,
        expectedGb: '23.9',
      })
    );
    press(page.body, 'Install on this Mac');
    press(page.body, 'Download and install');
    await settle();
    press(page.body, 'Back');
    expect(page.body.querySelector('.lm-notice')).toBeNull();
    page.body.querySelectorAll<HTMLElement>('[role="radio"]')[4].click();
    press(page.body, 'Install on this Mac');
    expect(texts(page.body, '.lm-size-total .lm-size-gb')).toEqual(['6.7 GB']);
    press(page.body, 'Download and install');
    await settle();
    expect((verbs(app)[1][2] as { acknowledgedBytes: number }).acknowledgedBytes).toBe(6550825373 + RUNTIME_BYTES);
  });

  it('follows the server when a job is already running', async () => {
    const page = mount();
    const { serve } = await opened(page, IDLE, () =>
      conflict({ reason: 'job-running', message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictJobRunning } })
    );
    press(page.body, 'Install on this Mac');
    serve(INSTALLING);
    press(page.body, 'Download and install');
    await settle();
    await settle();
    expect(page.body.dataset.screen).toBe('progress');
    expect(texts(page.body, '.lm-notice-text')).toEqual(['An install is already running.']);
  });

  it('says so when the request did not reach the server, and when the server did not take it', async () => {
    const page = mount();
    const answers: ApiResponse[] = [
      null,
      {
        ok: false,
        status: 400,
        json: async () => ({ success: false, error: 'not a model <b>offered</b>', errorCode: 'INVALID_INPUT' }),
      },
    ];
    await opened(page, IDLE, () => answers.shift() ?? null);
    press(page.body, 'Install on this Mac');
    press(page.body, 'Download and install');
    await settle();
    expect(page.body.dataset.screen).toBe('confirm');
    expect(texts(page.body, '.lm-notice-text')).toEqual(['Could not reach the server.']);
    press(page.body, 'Download and install');
    await settle();
    expect(texts(page.body, '.lm-notice-text')).toEqual(['The server did not accept that.']);
    // The server's own words, as text.
    expect(texts(page.body, '.lm-notice-detail')).toEqual(['not a model <b>offered</b>']);
    expect(page.body.querySelector('.lm-notice b')).toBeNull();
  });

  it('does not let a read that was already on its way undo what a verb answered', async () => {
    const page = mount();
    let stale!: (response: ApiResponse) => void;
    const { app } = await opened(page, IDLE, () => ok(INSTALLING.install));
    press(page.body, 'Install on this Mac');
    // A poll is in flight with the old answer when the install is sent.
    app._api.mockImplementationOnce(() => new Promise<ApiResponse>((done) => (stale = done)));
    await page.tick();
    press(page.body, 'Download and install');
    await settle();
    expect(page.body.dataset.screen).toBe('progress');
    // Every later read hangs, so what the old answer does to the screen can be seen.
    const before = gets(app);
    app._api.mockImplementation(() => new Promise<ApiResponse>(() => {}));
    stale(ok(IDLE));
    await settle();
    await settle();
    // The older answer is dropped, and a new read was sent after it.
    expect(page.body.dataset.screen).toBe('progress');
    expect(gets(app)).toBe(before + 1);
  });

  it('sends one request for two quick clicks', async () => {
    const page = mount();
    let answer!: (response: ApiResponse) => void;
    const { app } = await opened(page, IDLE, () => new Promise<ApiResponse>((done) => (answer = done)));
    press(page.body, 'Install on this Mac');
    press(page.body, 'Download and install');
    // While the request is in flight every button waits.
    expect([...page.frame.querySelectorAll<HTMLButtonElement>('.lm-buttons button')].map((el) => el.disabled)).toEqual([
      true,
      true,
    ]);
    page.frame.querySelectorAll<HTMLButtonElement>('.lm-buttons button')[1].click();
    answer(ok(INSTALLING.install));
    await settle();
    expect(verbs(app)).toHaveLength(1);
  });
});

// ---------- Progress ----------

describe('the progress screen', () => {
  it('replaces the memory bar with the download bar and lists the steps, the current one marked', async () => {
    const page = mount();
    await opened(page, INSTALLING);
    const { body } = page;
    expect(body.dataset.screen).toBe('progress');
    expect(texts(body, '.lm-title')).toEqual(['Installing Qwen3.6 35B-A3B']);
    expect(texts(body, '.lm-figure')).toEqual(['6.2 of 23.1 GB']);
    expect(texts(body, '.lm-figure-aside')).toEqual(['58 MB per second, about 5 minutes left']);
    const bar = body.querySelector('.lm-bar')!;
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('27');
    expect(body.querySelector<HTMLElement>('.lm-bar-fill')!.style.width).toBe('27%');
    expect(body.querySelector('[role="meter"]')).toBeNull();

    const steps = [...body.querySelectorAll('ol.lm-steps > li')];
    expect(steps.map((step) => step.textContent)).toEqual([
      'Getting the runtime',
      'Downloading the model',
      'Loading and checking',
      'Installing OpenCode',
      'Connecting',
    ]);
    expect(steps.map((step) => step.className.replace('lm-step', '').trim())).toEqual([
      'lm-step-done',
      'lm-step-now',
      '',
      '',
      '',
    ]);
    expect(steps.map((step) => step.getAttribute('aria-current'))).toEqual([null, 'step', null, null, null]);
    expect(texts(body, '.lm-aside')).toEqual([
      'You can close this window. The download continues while Codeman is running.',
    ]);
    expect(buttons(body)).toEqual(['Cancel']);
  });

  it('leaves the agent step out of a job whose coding agent is installed', async () => {
    const page = mount();
    await opened(
      page,
      status(
        {},
        {
          ...JOB,
          state: 'installing',
          step: 'runtime',
          steps: ['runtime', 'model', 'verify', 'connect'],
          actions: ['cancel'],
        }
      )
    );
    expect(texts(page.body, 'ol.lm-steps > li')).toEqual([
      'Getting the runtime',
      'Downloading the model',
      'Loading and checking',
      'Connecting',
    ]);
  });

  it.each([
    [undefined, '58 MB per second'],
    [0, '58 MB per second, less than a minute left'],
    [59, '58 MB per second, less than a minute left'],
    [60, '58 MB per second, about 1 minute left'],
    [149, '58 MB per second, about 2 minutes left'],
    [3599, '58 MB per second, about 60 minutes left'],
    [3600, '58 MB per second, about 1 hour left'],
    [9000, '58 MB per second, about 3 hours left'],
  ] as Array<[number | undefined, string]>)('words the time left: %s seconds', async (secondsLeft, aside) => {
    const page = mount();
    await opened(page, status({}, { ...INSTALLING.install, progress: { ...PROGRESS, secondsLeft } }));
    expect(texts(page.body, '.lm-figure-aside')).toEqual([aside]);
  });

  it('the bar is the model download alone: at the start while the runtime is fetched, gone once the model is in', async () => {
    const page = mount();
    const { app, serve } = await opened(
      page,
      status({}, { ...JOB, state: 'installing', step: 'runtime', actions: ['cancel'], runtime: RUNTIME_MISSING })
    );
    // Nothing of the model has arrived: the size that is coming, from the row it was chosen on.
    expect(texts(page.body, '.lm-figure')).toEqual(['0 of 23.1 GB']);
    expect(page.body.querySelector('.lm-bar')!.getAttribute('aria-valuenow')).toBe('0');
    expect(texts(page.body, '.lm-aside')).toEqual([
      'You can close this window. The download continues while Codeman is running.',
    ]);
    // The steps after the download have no bar and no second headline: the list says where it stands.
    for (const [step, label] of [
      ['verify', 'Loading and checking'],
      ['agent', 'Installing OpenCode'],
      ['connect', 'Connecting'],
    ] as const) {
      serve(status({}, { ...JOB, state: 'installing', step, actions: ['cancel'] }));
      await app.loadLocalModel({ force: true });
      expect(page.body.querySelector('.lm-meter')).toBeNull();
      expect(texts(page.body, '.lm-figure')).toEqual([]);
      expect(texts(page.body, '.lm-title')).toEqual(['Installing Qwen3.6 35B-A3B']);
      expect(texts(page.body, '.lm-step-now')).toEqual([label]);
      expect(texts(page.body, '.lm-aside')).toEqual([
        'You can close this window. The install continues while Codeman is running.',
      ]);
    }
  });

  it('cancels with one request', async () => {
    const page = mount();
    const { app } = await opened(page, INSTALLING, () => ok(PAUSED.install));
    press(page.body, 'Cancel');
    await settle();
    expect(verbs(app)).toEqual([['POST', '/api/local-model/cancel', undefined]]);
    expect(page.body.dataset.screen).toBe('paused');
  });

  it('moves only the bar when a tick moved only the download: the button is not swapped under a click', async () => {
    const page = mount();
    const { app, serve } = await opened(page, INSTALLING);
    const cancel = page.frame.querySelector('.lm-buttons button');
    const steps = page.body.querySelector('ol.lm-steps');
    serve(
      status(
        {},
        {
          ...INSTALLING.install,
          progress: { ...PROGRESS, completedBytes: 11552899478, completedGb: '11.6', secondsLeft: 199 },
        }
      )
    );
    await app.loadLocalModel({ force: true });
    expect(texts(page.body, '.lm-figure')).toEqual(['11.6 of 23.1 GB']);
    expect(texts(page.body, '.lm-figure-aside')).toEqual(['58 MB per second, about 3 minutes left']);
    expect(page.body.querySelector('.lm-bar')!.getAttribute('aria-valuenow')).toBe('50');
    expect(page.body.querySelector<HTMLElement>('.lm-bar-fill')!.style.width).toBe('50%');
    expect(page.body.querySelectorAll('.lm-meter')).toHaveLength(1);
    expect(page.frame.querySelector('.lm-buttons button')).toBe(cancel);
    expect(page.body.querySelector('ol.lm-steps')).toBe(steps);
    // A new step is a new picture.
    serve(status({}, { ...JOB, state: 'installing', step: 'verify', actions: ['cancel'] }));
    await app.loadLocalModel({ force: true });
    expect(page.body.querySelector('ol.lm-steps')).not.toBe(steps);
    expect(texts(page.body, '.lm-step-now')).toEqual(['Loading and checking']);
  });
});

describe('a paused install', () => {
  it('shows where it stopped and continues only on a click', async () => {
    const page = mount();
    const { app } = await opened(page, PAUSED, () => ok(INSTALLING.install));
    const { body } = page;
    expect(body.dataset.screen).toBe('paused');
    expect(texts(body, '.lm-title')).toEqual(['The install of Qwen3.6 35B-A3B is paused']);
    expect(texts(body, '.lm-figure')).toEqual(['6.2 of 23.1 GB']);
    // No speed and no time left on a download that is not running.
    expect(texts(body, '.lm-figure-aside')).toEqual([]);
    expect(texts(body, '.lm-step-stopped')).toEqual(['Downloading the model']);
    expect(texts(body, '.lm-aside')).toEqual(['The download waits until you continue.']);
    expect(buttons(body)).toEqual(['Remove', 'Choose another model', 'Continue']);
    expect(verbs(app)).toEqual([]);
    press(body, 'Continue');
    await settle();
    expect(verbs(app)).toEqual([['POST', '/api/local-model/resume', {}]]);
    expect(body.dataset.screen).toBe('progress');
  });

  it('lets the person pick another model, and come back', async () => {
    const page = mount();
    const { app } = await opened(page, PAUSED, () => ok(INSTALLING.install));
    press(page.body, 'Choose another model');
    expect(page.body.dataset.screen).toBe('choose');
    expect(buttons(page.body)).toEqual(['Back', 'Install on this Mac']);
    press(page.body, 'Back');
    expect(page.body.dataset.screen).toBe('paused');
    press(page.body, 'Choose another model');
    page.body.querySelectorAll<HTMLElement>('[role="radio"]')[4].click();
    press(page.body, 'Install on this Mac');
    press(page.body, 'Download and install');
    await settle();
    // A new install replaces the paused job.
    expect(verbs(app)[0].slice(0, 2)).toEqual(['POST', '/api/local-model/install']);
    expect((verbs(app)[0][2] as { modelId: string }).modelId).toBe('qwen3.5:9b');
  });
});

// ---------- Failures ----------

describe('a failure', () => {
  it("says what happened in the server's sentence, and offers the one action that helps", async () => {
    const page = mount();
    const { app } = await opened(
      page,
      failed('load-failed', { model: 'Qwen3.6 35B-A3B' }, { detail: 'runner exited with status 2' }),
      () => ok(INSTALLING.install)
    );
    const { body } = page;
    expect(body.dataset.screen).toBe('failed');
    expect(texts(body, '.lm-title')).toEqual(['Qwen3.6 35B-A3B did not load on this Mac.']);
    // The raw detail is folded away, and is text.
    const details = body.querySelector('details.lm-details')!;
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(details.querySelector('summary')!.textContent).toBe('Details');
    expect(details.querySelector('pre')!.textContent).toBe('runner exited with status 2');
    expect(texts(body, '.lm-step-stopped')).toEqual(['Loading and checking']);
    expect(buttons(body)).toEqual(['Remove', 'Try again']);
    press(body, 'Try again');
    await settle();
    expect(verbs(app)).toEqual([['POST', '/api/local-model/resume', {}]]);
  });

  it('never shows a bare word in place of the sentence', async () => {
    for (const code of Object.keys(LOCAL_MODEL_ERROR_LABELS) as LocalModelErrorCode[]) {
      const page = mount();
      const vars = { model: 'M', port: '11435', actual: '4096', wanted: '131072', cli: 'OpenCode', id: 'local-ollama' };
      await opened(page, failed(code, vars));
      // The headline is the FIRST sentence; what follows is read in the body size.
      const title = texts(page.body, '.lm-error .lm-title')[0];
      const rest = texts(page.body, '.lm-error .lm-lead').join(' ');
      const whole = [title, rest].filter(Boolean).join(' ');
      expect(whole.length, code).toBeGreaterThan(20);
      expect(title, code).toMatch(/[.!?]$/);
      expect(title.replace(/[^.!?]/g, '').length, code).toBeLessThanOrEqual(2);
      expect(whole, code).not.toMatch(/[{}]/);
      expect(whole, code).not.toMatch(/sorry|apolog/i);
      page.dom.window.close();
    }
  });

  it('answers a port that is taken with another port', async () => {
    const page = mount();
    const { app } = await opened(page, failed('port-in-use', { port: '11435' }), () => ok(INSTALLING.install));
    expect(texts(page.body, '.lm-title')).toEqual(['Port 11435 is in use by another program.']);
    expect(buttons(page.body)).toEqual(['Remove', 'Use another port']);
    press(page.body, 'Use another port');
    await settle();
    expect(verbs(app)).toEqual([['POST', '/api/local-model/resume', { newPort: true }]]);
  });

  it('offers the next model by name, and opens the chooser on it', async () => {
    const page = mount();
    const { app } = await opened(
      page,
      failed(
        'no-tool-call',
        { model: 'Qwen3.6 35B-A3B' },
        { nextModel: { modelId: 'qwen3.8:27b', modelLabel: 'Qwen3.8 27B' } }
      )
    );
    expect(texts(page.body, '.lm-title')).toEqual([
      'Qwen3.6 35B-A3B loaded but did not call a tool, so a coding agent cannot work with it.',
    ]);
    expect(buttons(page.body)).toEqual(['Remove', 'Try Qwen3.8 27B']);
    press(page.body, 'Try Qwen3.8 27B');
    expect(page.body.dataset.screen).toBe('choose');
    expect(page.body.querySelector('[aria-checked="true"] .lm-model-name')!.textContent).toBe('Qwen3.8 27B');
    // The person still confirms its sizes: nothing was sent.
    expect(verbs(app)).toEqual([]);
  });

  it('offers the chooser when the server names no next model, and nothing when none is left', async () => {
    const page = mount();
    const { app, serve } = await opened(page, failed('does-not-fit', { model: 'Qwen3.6 35B-A3B' }));
    expect(buttons(page.body)).toEqual(['Remove', 'Choose another model']);
    // A model the list no longer holds is not offered by name.
    serve(
      failed('does-not-fit', { model: 'Qwen3.6 35B-A3B' }, { nextModel: { modelId: 'gone:1b', modelLabel: 'Gone 1B' } })
    );
    await app.loadLocalModel({ force: true });
    expect(buttons(page.body)).toEqual(['Remove', 'Choose another model']);
    const empty = failed('does-not-fit', { model: 'Qwen3.6 35B-A3B' });
    empty.recommendation = none('memory', { memory: '48' }).recommendation;
    serve(empty);
    await app.loadLocalModel({ force: true });
    expect(buttons(page.body)).toEqual(['Remove']);
  });

  it('shows a button only for an action the server accepts right now', async () => {
    const page = mount();
    const answer = failed('load-failed', { model: 'Qwen3.6 35B-A3B' });
    answer.install.actions = [];
    await opened(page, answer);
    expect(texts(page.body, '.lm-title')).toEqual(['Qwen3.6 35B-A3B did not load on this Mac.']);
    expect(buttons(page.body)).toEqual([]);
  });
});

// ---------- Installed ----------

describe('an installed model', () => {
  it('says it is ready, with the measured facts in one line', async () => {
    const page = mount();
    await opened(page, INSTALLED);
    const { body } = page;
    expect(body.dataset.screen).toBe('installed');
    expect(texts(body, '.lm-title')).toEqual(['Qwen3.6 35B-A3B is ready on this Mac.']);
    expect(texts(body, '.lm-state-text')).toEqual(['Running']);
    expect(body.querySelector('.lm-dot')!.classList.contains('lm-dot-on')).toBe(true);
    // What it takes now, and what it can take, in the words of the chooser's legend: the
    // row's own estimate, so the two figures are never read as a contradiction.
    expect(texts(body, '.lm-aside')).toEqual([
      'Runs with OpenCode. Context 131,072 tokens. Takes 26.3 GB of memory now, and up to about 36 GB at its peak, with all of the context in use. All of it is on the GPU.',
      // Under the list of models: what the downloads take on disk.
      'Downloaded models use 23.1 GB on this Mac.',
    ]);
    expect(buttons(body)).toEqual(['Remove', 'Stop', 'Start a session']);
    // One main action.
    expect(frameOf(body).querySelectorAll('.lm-buttons .wt-btn-primary')).toHaveLength(1);
    expect(frameOf(body).querySelector('.lm-buttons .wt-btn-primary')!.textContent).toBe('Start a session');
  });

  it('says the one honest sentence about git and Python only on a Mac without developer tools', async () => {
    const page = mount();
    const { app, serve } = await opened(page, INSTALLED);
    expect(page.body.textContent).not.toContain('developer tools');
    serve(status({}, { ...INSTALLED.install, developerTools: 'missing' }));
    await app.loadLocalModel({ force: true });
    expect(texts(page.body, '.lm-aside')).toContain(
      'Coding agents use git and Python. This Mac has no developer tools yet, so macOS will offer to install them the first time an agent needs one.'
    );
  });

  it('stops and starts the runtime, and Start is the main action of a stopped model', async () => {
    const page = mount();
    const answers = [ok(STOPPED.install), ok(INSTALLED.install)];
    const { app } = await opened(page, INSTALLED, () => answers.shift() ?? null);
    press(page.body, 'Stop');
    await settle();
    expect(texts(page.body, '.lm-title')).toEqual(['Qwen3.6 35B-A3B is installed on this Mac.']);
    expect(texts(page.body, '.lm-state-text')).toEqual(['Stopped']);
    expect(page.body.querySelector('.lm-dot')!.classList.contains('lm-dot-on')).toBe(false);
    expect(buttons(page.body)).toEqual(['Remove', 'Start']);
    expect(page.frame.querySelector('.lm-buttons .wt-btn-primary')!.textContent).toBe('Start');
    press(page.body, 'Start');
    await settle();
    expect(verbs(app)).toEqual([
      ['POST', '/api/local-model/runtime', { action: 'stop' }],
      ['POST', '/api/local-model/runtime', { action: 'start' }],
    ]);
    expect(buttons(page.body)).toEqual(['Remove', 'Stop', 'Start a session']);
  });

  it.each([
    [
      'runtime-stopped' as const,
      {},
      ['start', 'remove'] as const,
      'The runtime keeps stopping, so Codeman no longer restarts it.',
      ['Remove', 'Start'],
      { action: 'start' },
    ],
    [
      'port-in-use' as const,
      { port: '11435' },
      ['start', 'remove'] as const,
      'Port 11435 is in use by another program.',
      ['Remove', 'Use another port'],
      { action: 'start', newPort: true },
    ],
  ])('shows what blocks a session and its one action: %s', async (code, vars, actions, sentence, labels, body) => {
    const page = mount();
    const answer = status(
      {},
      {
        ...STOPPED.install,
        actions: [...actions],
        error: {
          code,
          message: { text: LOCAL_MODEL_ERROR_LABELS[code], ...(Object.keys(vars).length ? { vars } : {}) },
          next: LOCAL_MODEL_ERROR_NEXT[code],
        },
      }
    );
    const { app } = await opened(page, answer, () => ok(INSTALLED.install));
    expect(texts(page.body, '.lm-error .lm-title')).toEqual([sentence]);
    expect(buttons(page.body)).toEqual(labels);
    expect(page.frame.querySelectorAll('.lm-buttons .wt-btn-primary')).toHaveLength(1);
    press(page.body, labels[1]);
    await settle();
    expect(verbs(app)).toEqual([['POST', '/api/local-model/runtime', body]]);
  });

  it('offers only the removal when the model changed since it was installed', async () => {
    const page = mount();
    const answer = status(
      {},
      {
        ...INSTALLED.install,
        actions: ['stop', 'remove'],
        error: {
          code: 'model-changed',
          message: { text: LOCAL_MODEL_ERROR_LABELS['model-changed'] },
          next: LOCAL_MODEL_ERROR_NEXT['model-changed'],
        },
      }
    );
    await opened(page, answer);
    // The sentence is the headline (not "is ready"), its second sentence in the body size.
    expect(texts(page.body, '.lm-title')).toEqual(['The model on this Mac changed since it was installed.']);
    expect(texts(page.body, '.lm-error .lm-lead')).toEqual(['Remove it and install it again.']);
    // The dot is not green: a session cannot be started. The state line names the model.
    expect(page.body.querySelector('.lm-dot')!.classList.contains('lm-dot-on')).toBe(false);
    expect(texts(page.body, '.lm-state-text')).toEqual(['Qwen3.6 35B-A3B, Running']);
    // No session can start, so that button is not there. Remove never takes the accent.
    expect(buttons(page.body)).toEqual(['Stop', 'Remove']);
    expect(page.frame.querySelectorAll('.lm-buttons .wt-btn-primary')).toHaveLength(0);
    press(page.body, 'Remove');
    expect(texts(page.frame, '.lm-remove .lm-lead')).toEqual(['Remove the local model from this Mac?']);
    // In its question the removal is red.
    expect(page.frame.querySelector('.lm-remove .wt-btn-danger')!.textContent).toBe('Remove');
  });

  it('starts a session on the saved connection with the agent of the install, after refreshing the page', async () => {
    const page = mount();
    const { app } = await opened(page, INSTALLED);
    const order: string[] = [];
    app.loadAppSettingsFromServer = vi.fn(async () => void order.push('settings'));
    app.loadCliListForSettings = vi.fn(async () => void order.push('clis'));
    app.selectCustomModelEntry = vi.fn(async () => void order.push('launch'));
    app.closeAppSettings = vi.fn();
    press(page.body, 'Start a session');
    await settle();
    // The settings flag and the agent's availability are read again before the launcher runs.
    expect(order).toEqual(['settings', 'clis', 'launch']);
    // Both values are the payload's.
    expect(app.selectCustomModelEntry).toHaveBeenCalledWith('opencode', 'local-ollama');
    expect(app.isLocalModelWindowOpen()).toBe(false);
    expect(page.modal.classList.contains('active')).toBe(false);
    // App Settings was not open: it is left alone.
    expect(app.closeAppSettings).not.toHaveBeenCalled();
  });

  it('closes App Settings too when the window was opened from there', async () => {
    const page = mount();
    const { app } = await opened(page, INSTALLED);
    page.document.getElementById('appSettingsModal')!.classList.add('active');
    app.selectCustomModelEntry = vi.fn(async () => undefined);
    app.closeAppSettings = vi.fn();
    press(page.body, 'Start a session');
    await settle();
    expect(app.closeAppSettings).toHaveBeenCalledTimes(1);
    expect(app.selectCustomModelEntry).toHaveBeenCalledWith('opencode', 'local-ollama');
  });
});

describe('Remove', () => {
  it('asks first, and deletes the downloaded model too unless the person keeps it', async () => {
    const page = mount();
    const { app } = await opened(page, INSTALLED, () => ok(install()));
    press(page.body, 'Remove');
    // The question, in place of the buttons. Nothing was sent.
    expect(verbs(app)).toEqual([]);
    const question = page.frame.querySelector('.lm-remove')!;
    expect(texts(question, '.lm-lead')).toEqual(['Remove the local model from this Mac?']);
    expect(texts(question, '.lm-check span')).toEqual(['Also delete the downloaded model']);
    expect(texts(question, '.lm-aside')).toEqual(['The coding agent stays installed.']);
    expect(question.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    expect(buttons(page.body)).toEqual(['Cancel', 'Remove']);
    press(page.body, 'Remove');
    await settle();
    expect(verbs(app)).toEqual([['DELETE', '/api/local-model', { removeModel: true }]]);
  });

  it('keeps the model when the box is cleared, and Cancel sends nothing', async () => {
    const page = mount();
    const { app } = await opened(page, INSTALLED, () => ok(install()));
    press(page.body, 'Remove');
    press(page.body, 'Cancel');
    expect(page.frame.querySelector('.lm-remove')).toBeNull();
    expect(buttons(page.body)).toEqual(['Remove', 'Stop', 'Start a session']);
    press(page.body, 'Remove');
    const box = page.frame.querySelector<HTMLInputElement>('.lm-remove input[type="checkbox"]')!;
    box.checked = false;
    box.dispatchEvent(new page.dom.window.Event('change'));
    press(page.body, 'Remove');
    await settle();
    expect(verbs(app)).toEqual([['DELETE', '/api/local-model', { removeModel: false }]]);
  });

  it('goes back to the chooser once the model is gone', async () => {
    const page = mount();
    const { serve } = await opened(page, INSTALLED, () => ok(install()));
    serve(IDLE);
    press(page.body, 'Remove');
    press(page.body, 'Remove');
    await settle();
    await settle();
    expect(page.body.dataset.screen).toBe('choose');
    expect(page.button.textContent!.trim()).toBe('Run a local model');
  });

  it("names the sessions that still use the model, in the server's sentence", async () => {
    const page = mount();
    await opened(page, INSTALLED, () =>
      conflict({
        reason: 'sessions-open',
        message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictSessionsOpen, vars: { sessions: 'w1-app, w2-site' } },
        sessions: ['w1-app', 'w2-site'],
      })
    );
    press(page.body, 'Remove');
    press(page.body, 'Remove');
    await settle();
    expect(page.body.dataset.screen).toBe('installed');
    expect(texts(page.frame, '.lm-notice-text')).toEqual([
      'Sessions are still using this model: w1-app, w2-site. Close them first.',
    ]);
    // Still the question: the person can close the sessions and press Remove again.
    expect(buttons(page.body)).toEqual(['Cancel', 'Remove']);
  });

  it('removes a paused or stopped install the same way', async () => {
    for (const answer of [PAUSED, failed('load-failed', { model: 'Qwen3.6 35B-A3B' })]) {
      const page = mount();
      const { app } = await opened(page, answer, () => ok(install()));
      press(page.body, 'Remove');
      expect(texts(page.frame, '.lm-remove .lm-lead')).toEqual(['Remove the local model from this Mac?']);
      press(page.body, 'Remove');
      await settle();
      expect(verbs(app)).toEqual([['DELETE', '/api/local-model', { removeModel: true }]]);
      page.dom.window.close();
    }
  });
});

// ---------- No recommendation ----------

describe('no recommendation', () => {
  it.each([
    [
      'intel',
      none('intel', undefined, { arch: 'x64', arm64: false, chip: 'Intel(R) Core(TM) i7-9750H', memClassGb: 16 }),
      'Intel(R) Core(TM) i7-9750H, 16 GB memory, 897 GB free',
      'Local coding models need Apple silicon, and this Mac has an Intel processor.',
    ],
    [
      'memory',
      none('memory', { memory: '8' }, { memGb: '8.6', memClassGb: 8, chip: 'Apple M2', freeDiskGb: '41.3' }),
      'Apple M2, 8 GB memory, 41.3 GB free',
      'With 8 GB of memory, this Mac cannot run a model that can drive a coding agent.',
    ],
    [
      'disk',
      none('disk', { missing: '5.3' }, { freeDiskGb: '12.0' }),
      'Apple M5 Pro, 48 GB memory, 12.0 GB free',
      'Free up about 5.3 GB of disk space to install the smallest model that fits this Mac.',
    ],
  ] as Array<[string, LocalModelStatus, string, string]>)(
    'opens with the hardware line, the reason and no button except Close: %s',
    async (_reason, answer, hardware, sentence) => {
      const page = mount();
      const { app } = await opened(page, answer);
      expect(page.body.dataset.screen).toBe('none');
      expect(texts(page.body, '.lm-hw')).toEqual([hardware]);
      expect(texts(page.body, '.lm-reason')).toEqual([sentence]);
      expect(page.body.querySelector('[role="radiogroup"]')).toBeNull();
      expect(page.body.querySelector('.lm-bar')).toBeNull();
      expect(buttons(page.body)).toEqual(['Close']);
      press(page.body, 'Close');
      expect(app.isLocalModelWindowOpen()).toBe(false);
    }
  );

  it('leaves an unknown memory size out of the hardware line', async () => {
    const page = mount();
    const answer = none('memory', undefined, { memBytes: 0, memGb: '0.0', memClassGb: 0 });
    answer.recommendation.headline = { text: LOCAL_MODEL_LABELS.noneMemoryUnknown };
    await opened(page, answer);
    expect(texts(page.body, '.lm-hw')).toEqual(['Apple M5 Pro']);
    expect(page.body.textContent).not.toMatch(/\b0(\.0)? GB/);
  });
});

// ---------- The poll ----------

describe('the poll', () => {
  it('asks once a second while the window is open, and stops when it closes', async () => {
    const page = mount();
    const app = page.newApp(() => ok(INSTALLING));
    await app.loadLocalModel();
    expect(gets(app)).toBe(1);
    // Closed: no timer at all, however long the welcome screen stays up.
    expect(page.timers).toHaveLength(0);

    app.openLocalModelWindow();
    await settle();
    // Opening asks at once (the minute-old answer is not good enough for a download).
    expect(gets(app)).toBe(2);
    expect(page.timers.map((timer) => timer.ms)).toEqual([1000]);
    for (let second = 1; second <= 3; second++) {
      await page.tick();
      expect(gets(app)).toBe(2 + second);
      expect(page.timers.map((timer) => timer.ms)).toEqual([1000]);
    }

    app.closeLocalModelWindow();
    expect(page.timers).toHaveLength(0);
    await page.tick();
    await page.tick();
    expect(gets(app)).toBe(5);

    // Reopened: it asks again.
    app.openLocalModelWindow();
    await settle();
    await page.tick();
    expect(gets(app)).toBe(7);
    app.closeLocalModelWindow();
  });

  it('does not re-arm a tick that was already running when the window closed', async () => {
    const page = mount();
    let answer: ((response: ApiResponse) => void) | null = null;
    const app = page.newApp(() => ok(IDLE));
    await app.loadLocalModel();
    app.openLocalModelWindow();
    await settle();
    app._api.mockImplementation(() => new Promise<ApiResponse>((done) => (answer = done)));
    const due = page.timers.splice(0);
    for (const timer of due) timer.fn();
    app.closeLocalModelWindow();
    answer!(ok(IDLE));
    await settle();
    expect(page.timers).toHaveLength(0);
  });

  it('keeps its place and asks nothing while the tab is in the background', async () => {
    const page = mount({ visible: false });
    expect(page.document.hidden).toBe(true);
    const app = page.newApp(() => ok(INSTALLING));
    await app.loadLocalModel();
    app.openLocalModelWindow();
    await settle();
    const before = gets(app);
    await page.tick();
    await page.tick();
    expect(gets(app)).toBe(before);
    expect(page.timers).toHaveLength(1);
    app.closeLocalModelWindow();
  });

  it('follows the install from the download to the end without a click', async () => {
    const page = mount();
    const { app, serve } = await opened(page, INSTALLING);
    expect(page.body.dataset.screen).toBe('progress');
    serve(INSTALLED);
    await page.tick();
    expect(page.body.dataset.screen).toBe('installed');
    // The screen that ends an install has one button. Stop and Remove are for the window
    // opened later.
    expect(buttons(page.body)).toEqual(['Start a session']);
    // The focus goes to the main action of the new screen, inside the dialog.
    expect(page.document.activeElement?.textContent).toBe('Start a session');
    // Opened again, the same model has its Stop and Remove.
    app.closeLocalModelWindow();
    app.openLocalModelWindow();
    expect(buttons(page.body)).toEqual(['Remove', 'Stop', 'Start a session']);
  });
});

// ---------- Text only ----------

describe('what the server sends is shown as text', () => {
  const HOSTILE = '<img src=x onerror="window.__pwned=1">';
  const clean = (page: Mounted) => {
    expect(page.document.querySelectorAll('img, script, iframe')).toHaveLength(0);
    expect((page.win as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  };

  it('in the chooser and on the confirm screen', async () => {
    const page = mount();
    const hostile = candidate({
      modelId: 'evil:1b',
      modelLabel: `Model ${HOSTILE}`,
      harnesses: [{ cli: 'x', cliLabel: `Agent ${HOSTILE}`, installed: false, installCommand: `run ${HOSTILE}` }],
    });
    await opened(
      page,
      status(
        {
          pick: hostile,
          alternatives: [],
          notes: [{ text: LOCAL_MODEL_LABELS.noteDiskDropped, vars: { model: HOSTILE, missing: '1' } }],
        },
        { folder: `/tmp/${HOSTILE}` },
        { chip: `Chip ${HOSTILE}` }
      )
    );
    clean(page);
    expect(texts(page.body, '.lm-hw')[0]).toContain(HOSTILE);
    expect(texts(page.body, '.lm-model-name')).toEqual([`Model ${HOSTILE}`]);
    expect(page.body.querySelector('option')!.textContent).toBe(`Agent ${HOSTILE}`);
    expect(texts(page.body, '.lm-notes .lm-aside')[0]).toContain(HOSTILE);
    press(page.body, 'Install on this Mac');
    clean(page);
    expect(texts(page.body, '.lm-command')).toEqual([`run ${HOSTILE}`]);
    expect(texts(page.body, '.lm-path')).toEqual([`/tmp/${HOSTILE}`]);
    expect(texts(page.body, '.lm-size-name')).toContain(`Agent ${HOSTILE}`);
    // The row and the button on the welcome screen too.
    expect(page.row.textContent).toContain(HOSTILE);
    clean(page);
  });

  it('in a job, an error and its detail, a refusal and the installed screen', async () => {
    const page = mount();
    const job = { ...JOB, model: { id: 'evil:1b', label: `Model ${HOSTILE}` }, cliLabel: `Agent ${HOSTILE}` };
    const { app, serve } = await opened(
      page,
      status({}, { ...job, state: 'installing', step: 'agent', actions: ['cancel'] }),
      () =>
        conflict({
          reason: 'sessions-open',
          message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictSessionsOpen, vars: { sessions: HOSTILE } },
          sessions: [HOSTILE],
        })
    );
    expect(texts(page.body, '.lm-title')).toEqual([`Installing Model ${HOSTILE}`]);
    expect(texts(page.body, '.lm-step-now')).toEqual([`Installing Agent ${HOSTILE}`]);
    clean(page);

    serve(
      status(
        {},
        {
          ...job,
          state: 'failed',
          step: 'agent',
          actions: ['resume', 'remove'],
          error: {
            code: 'harness-failed',
            message: { text: LOCAL_MODEL_ERROR_LABELS['harness-failed'], vars: { cli: HOSTILE } },
            next: 'retry',
            detail: `installer said ${HOSTILE}`,
          },
        }
      )
    );
    await app.loadLocalModel({ force: true });
    expect(texts(page.body, '.lm-title')).toEqual([`${HOSTILE} could not be installed.`]);
    expect(page.body.querySelector('.lm-detail-text')!.textContent).toBe(`installer said ${HOSTILE}`);
    clean(page);

    serve(status({}, { ...INSTALLED.install, ...job }));
    await app.loadLocalModel({ force: true });
    expect(texts(page.body, '.lm-title')).toEqual([`Model ${HOSTILE} is ready on this Mac.`]);
    press(page.body, 'Remove');
    press(page.body, 'Remove');
    await settle();
    expect(texts(page.frame, '.lm-notice-text')[0]).toContain(HOSTILE);
    expect(page.row.textContent).toContain(HOSTILE);
    clean(page);
  });

  it('because the module writes nothing as markup', () => {
    const code = MODULE.split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

// ---------- Languages, rules ----------

describe('in another language', () => {
  it('repaints the button, the row and the open window when the language changes', async () => {
    const page = mount({ i18n: true });
    page.win.CodemanI18n.start();
    await opened(page, IDLE);
    expect(buttons(page.body)).toEqual(['Install on this Mac']);
    page.win.CodemanI18n.configure({ language: 'zh-CN' });
    await settle();
    expect(buttons(page.body)).toEqual(['安装到此 Mac']);
    expect(page.button.textContent!.trim()).toBe('运行本地模型');
    expect(texts(page.row, '.set-row-label')).toEqual(['尚未安装模型']);
    expect(texts(page.body, '.lm-figure')).toEqual(['约需 36 GB 内存，共 38 GB 可用']);
    // Names are someone else's text and stay as sent; the server's tag is translated.
    expect(texts(page.body, '.lm-model-name')[0]).toBe('Qwen3.6 35B-A3B');
    expect(texts(page.body, '.lm-tag')[0]).toBe('已在同类 Mac 上测试');
    // The static title is the page translator's.
    expect(page.document.getElementById('localModelModalTitle')!.textContent).toBe('在此 Mac 上运行模型');
    page.win.CodemanI18n.configure({ language: 'en' });
    await settle();
    expect(buttons(page.body)).toEqual(['Install on this Mac']);
  });
});

describe('a repaint of everything', () => {
  it('reaches a progress screen whole when the language changes, not its bar alone', async () => {
    const page = mount({ i18n: true });
    page.win.CodemanI18n.start();
    await opened(page, INSTALLING);
    expect(texts(page.body, '.lm-title')).toEqual(['Installing Qwen3.6 35B-A3B']);
    page.win.CodemanI18n.configure({ language: 'zh-CN' });
    await settle();
    // Title, figure, steps, note and button: every word of the screen, not the bar's line only.
    expect(texts(page.body, '.lm-title')).toEqual(['正在安装 Qwen3.6 35B-A3B']);
    expect(texts(page.body, '.lm-figure')).toEqual(['已下载 6.2 GB，共 23.1 GB']);
    expect(texts(page.body, '.lm-figure-aside')).toEqual(['每秒 58 MB，剩余约 5 分钟']);
    expect(texts(page.body, 'ol.lm-steps > li')).toEqual([
      '获取运行时',
      '下载模型',
      '加载并检查',
      '安装 OpenCode',
      '正在连接',
    ]);
    expect(buttons(page.body)).toEqual(['取消']);
    expect(page.body.textContent).not.toMatch(/Installing|Cancel|You can close/);
    page.win.CodemanI18n.configure({ language: 'en' });
    await settle();
    expect(buttons(page.body)).toEqual(['Cancel']);
    expect(texts(page.body, 'ol.lm-steps > li')[0]).toBe('Getting the runtime');
  });

  it('follows a display name that changed while a download is on screen', async () => {
    const page = mount({ i18n: true });
    page.win.CodemanI18n.start();
    await opened(page, INSTALLING);
    page.win.CodemanI18n.configure({ language: 'en', displayName: 'Acme' });
    await settle();
    expect(texts(page.body, '.lm-aside')).toEqual([
      'You can close this window. The download continues while Acme is running.',
    ]);
  });

  it('paints the whole screen again when the window is reopened on the same download', async () => {
    const page = mount();
    const { app } = await opened(page, INSTALLING);
    app.closeLocalModelWindow();
    // Whatever the closed window still holds is not trusted: here, a title something else wrote.
    page.body.querySelector('.lm-title')!.textContent = 'stale';
    app.openLocalModelWindow();
    await settle();
    expect(texts(page.body, '.lm-title')).toEqual(['Installing Qwen3.6 35B-A3B']);
    expect(buttons(page.body)).toEqual(['Cancel']);
  });
});

describe('the module keeps to its rules', () => {
  /** U+2192, U+00B7, U+2013 and U+2014, built from their code points so this file holds none of them. */
  const ORNAMENT = new RegExp(`[${String.fromCharCode(0x2192, 0x00b7, 0x2013, 0x2014)}]`);
  const code = MODULE.split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  it('never says "Recommended" by itself: that headline is the server\'s to send', () => {
    expect(code).not.toMatch(/recommended/i);
  });

  it("prints the developer tools sentence in the contract's exact words", () => {
    expect(code).toContain(`'${LOCAL_MODEL_INSTALL_LABELS.developerToolsMissing}'`);
  });

  it('uses the words of the reader: no VRAM, no endpoint, no harness, no context window', () => {
    const strings = [...MODULE.matchAll(/localModelT\(\s*'([^']+)'/g)].map((match) => match[1]);
    expect(strings.length).toBeGreaterThan(60);
    for (const text of strings) {
      expect(text, text).not.toMatch(/VRAM|endpoint|harness|context window/i);
      // No arrow on a button, no middle dot between facts, no long dash.
      expect(text, text).not.toMatch(ORNAMENT);
    }
  });

  it('asks the routes of the contract, under the base path', async () => {
    const page = mount();
    const context = page.dom.getInternalVMContext();
    vm.runInContext('var CodemanBase = { url: (path) => "/codeman" + path };', context);
    const { app } = await opened(page, INSTALLING, () => ok(PAUSED.install));
    press(page.body, 'Cancel');
    await settle();
    expect(app._api.mock.calls[0][0]).toBe('/codeman/api/local-model');
    expect(verbs(app)).toEqual([['POST', '/codeman/api/local-model/cancel', undefined]]);
  });
});

// ---------- After the review: the order of the rows, the words of a tight pick, a refusal's sentence, a start that failed ----------

describe('the rows of the chooser are ordered by a column the reader can see', () => {
  it('the pick first, then the other models by download size, largest first, whatever order the server sent', async () => {
    const page = mount();
    // The server's own order of the alternatives is its ranking, which no column shows.
    await opened(page, status({ alternatives: [ALT_SMALL_Q8, ALT_SMALL, ALT_UNKNOWN, ALT_SLOW] }));
    const rows = [...page.body.querySelectorAll('[role="radio"]')];
    expect(rows.map((row) => row.querySelector('.lm-model-name')!.textContent)).toEqual([
      'Qwen3.6 35B-A3B',
      'Qwen3.8 27B',
      'GPT-OSS 20B',
      'Qwen3.5 9B (Q8)',
      'Qwen3.5 9B',
    ]);
    expect(rows.map((row) => row.querySelector('.lm-model-size')!.textContent)).toEqual([
      '23.1 GB',
      '17.7 GB',
      '13.8 GB',
      '10.4 GB',
      '6.6 GB',
    ]);
    // The arrow keys walk the drawn order.
    const group = page.body.querySelector('[role="radiogroup"]')!;
    group.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(page.body.querySelector('[aria-checked="true"] .lm-model-name')!.textContent).toBe('Qwen3.8 27B');
  });

  it('a pick that only just fits says so in its tag, in the accent like every tag of the pick', async () => {
    const page = mount();
    const tightPick = candidate({
      tested: false,
      tag: { kind: 'best-tight', label: LOCAL_MODEL_TAG_LABELS['best-tight'] },
    });
    await opened(page, status({ pick: tightPick, alternatives: [ALT_SMALL] }));
    const tag = page.body.querySelector('[aria-checked="true"] .lm-tag')!;
    expect(tag.textContent).toBe('Best fit, tight');
    expect(tag.classList.contains('lm-tag-accent')).toBe(true);
    expect(page.body.querySelector('.lm-bar')!.getAttribute('aria-valuenow')).toBe('96');
  });
});

describe('a refusal the server names', () => {
  it('is printed from its sentence and slots, not from the English error text', async () => {
    const page = mount({ i18n: true });
    const { app } = await opened(page, IDLE, () => ({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        error: 'OpenCode is not installed and cannot be installed from here.',
        errorCode: 'INVALID_INPUT',
        data: { message: { text: LOCAL_MODEL_INSTALL_LABELS.refusedAgentNotInstallable, vars: { cli: 'OpenCode' } } },
      }),
    }));
    page.win.CodemanI18n.configure({ language: 'zh-CN' });
    await settle();
    press(page.body, '安装到此 Mac');
    press(page.body, '下载并安装');
    await settle();
    expect(texts(page.body, '.lm-notice-text')).toEqual(['OpenCode 尚未安装，也无法从这里安装。']);
    expect(page.body.textContent).not.toContain('cannot be installed from here');
    app.closeLocalModelWindow();
  });
});

describe('an installed model whose runtime did not start', () => {
  it('says what the runtime said as the headline, keeps the dot grey, and Start tries again', async () => {
    const page = mount();
    const answer = status(
      {},
      {
        ...INSTALLED.install,
        running: false,
        actions: ['start', 'remove'],
        error: {
          code: 'runtime-start-failed',
          message: { text: LOCAL_MODEL_ERROR_LABELS['runtime-start-failed'] },
          // The server adapts the next step to the state: Start, not "try again".
          next: 'start',
          detail: 'spawn ENOENT',
        },
      }
    );
    const { app } = await opened(page, answer, () => ok(INSTALLED.install));
    expect(texts(page.body, '.lm-title')).toEqual(['The runtime did not start on this Mac.']);
    expect(page.body.querySelector('.lm-dot')!.classList.contains('lm-dot-on')).toBe(false);
    expect(page.body.querySelector('.lm-detail-text')!.textContent).toBe('spawn ENOENT');
    expect(buttons(page.body)).toEqual(['Remove', 'Start']);
    expect(page.frame.querySelector('.lm-buttons .wt-btn-primary')!.textContent).toBe('Start');
    press(page.body, 'Start');
    await settle();
    expect(verbs(app)).toEqual([['POST', '/api/local-model/runtime', { action: 'start' }]]);
  });
});

// ---------- The models on this Mac ----------

const GPT_ROW: LocalModelLibraryRow = {
  id: 'gpt-oss:20b',
  label: 'GPT-OSS 20B',
  context: 65536,
  sizeBytes: 13793441427,
  sizeGb: '13.8',
  active: false,
  verified: true,
  status: 'ready',
  actions: ['use', 'delete'],
};
const STORE_TWO = { bytes: 36899240383, gb: '36.9' };

/** Two models on this Mac, the Qwen one in use and running. */
const TWO = status(
  { budgetBytes: 40157944217, budgetGb: '40.2', budgetSource: 'measured' },
  {
    ...INSTALLED.install,
    library: [QWEN_ROW, GPT_ROW],
    store: STORE_TWO,
    actions: ['start-session', 'stop', 'install', 'use', 'delete-model', 'remove'],
  }
);

/** The buttons of the rows of the list (not the buttons of the screen), by their label. */
const rowButtons = (page: Mounted) => texts(page.body, '.lm-lib-row .lm-lib-actions:not(.lm-lib-actions-away) button');

function pressIn(page: Mounted, selector: string, label: string) {
  const found = [...page.frame.querySelectorAll<HTMLButtonElement>(`${selector} button`)].find(
    (el) => el.textContent === label
  );
  expect(found, `no button "${label}" in ${selector}`).toBeTruthy();
  found!.click();
}

describe('the models on this Mac', () => {
  it('lists the one installed model with its context, its state and its size on disk, and offers another', async () => {
    const page = mount();
    await opened(page, INSTALLED);
    const { body } = page;
    expect(texts(body, '.lm-lib-caption-label')).toEqual(['Models on this Mac']);
    expect(texts(body, '.lm-lib-caption-size')).toEqual(['On disk']);
    expect(texts(body, '.lm-lib-label')).toEqual(['Qwen3.6 35B-A3B']);
    expect(texts(body, '.lm-lib-meta')).toEqual(['131,072 tokens']);
    expect(texts(body, '.lm-lib-tag .lm-tag')).toEqual(['In use']);
    expect(texts(body, '.lm-lib-size')).toEqual(['23.1 GB']);
    // The model in use wears the selected look, and nothing can be done ON it here.
    expect(body.querySelector('.lm-lib-row')!.classList.contains('lm-lib-row-on')).toBe(true);
    expect(rowButtons(page)).toEqual([]);
    expect(texts(body, '.lm-lib-foot button')).toEqual(['Add a model']);
    // A real list for assistive technology, named by its caption.
    const list = body.querySelector('.lm-lib-list')!;
    expect(list.getAttribute('role')).toBe('list');
    expect(list.getAttribute('aria-labelledby')).toBe('localModelLibraryLabel');
    expect(body.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    // The screen scrolls from its top: it is no short screen any more.
    expect(body.dataset.long).toBe('true');
    // The buttons of the screen are what they were.
    expect(buttons(body)).toEqual(['Remove', 'Stop', 'Start a session']);
  });

  it('two models: the one in use first, the other with Use and Delete, and what both take on disk', async () => {
    const page = mount();
    await opened(page, TWO);
    const { body } = page;
    expect(texts(body, '.lm-lib-label')).toEqual(['Qwen3.6 35B-A3B', 'GPT-OSS 20B']);
    expect(texts(body, '.lm-lib-meta')).toEqual(['131,072 tokens', '65,536 tokens']);
    expect(texts(body, '.lm-lib-tag .lm-tag')).toEqual(['In use', 'Ready']);
    expect(texts(body, '.lm-lib-size')).toEqual(['23.1 GB', '13.8 GB']);
    expect(rowButtons(page)).toEqual(['Use', 'Delete']);
    // A short label on screen, the model's name for a screen reader.
    const [use, remove] = [...body.querySelectorAll('.lm-lib-row .lm-lib-actions button')];
    expect(use.getAttribute('aria-label')).toBe('Use GPT-OSS 20B');
    expect(remove.getAttribute('aria-label')).toBe('Delete GPT-OSS 20B');
    // Quiet buttons: the screen keeps its one main action, and nothing here is red yet.
    expect(body.querySelectorAll('.lm-library .wt-btn-primary, .lm-library .wt-btn-danger')).toHaveLength(0);
    expect(texts(body, '.lm-lib-notes .lm-aside')).toEqual(['Downloaded models use 36.9 GB on this Mac.']);
  });

  it('a row has a button only for an action the server lists for THAT row', async () => {
    const page = mount();
    const rows: LocalModelLibraryRow[] = [
      QWEN_ROW,
      { ...GPT_ROW, actions: ['use'] },
      { ...GPT_ROW, id: 'a:1b', label: 'A', status: 'changed', actions: ['delete'] },
      { ...GPT_ROW, id: 'b:1b', label: 'B', status: 'missing', actions: ['delete'] },
      { ...GPT_ROW, id: 'c:1b', label: 'C', context: undefined, verified: false, status: 'unverified', actions: [] },
      { id: 'd:1b', label: 'D', active: false, verified: false, status: 'unverified', actions: ['delete'] },
    ];
    await opened(page, status({}, { ...TWO.install, library: rows }));
    const perRow = [...page.body.querySelectorAll('.lm-lib-row')].map((row) => [
      row.querySelector('.lm-lib-label')!.textContent,
      row.querySelector('.lm-tag')!.textContent,
      texts(row, '.lm-lib-actions button').join('+'),
    ]);
    expect(perRow).toEqual([
      ['Qwen3.6 35B-A3B', 'In use', ''],
      ['GPT-OSS 20B', 'Ready', 'Use'],
      ['A', 'Changed', 'Delete'],
      ['B', 'Missing', 'Delete'],
      ['C', 'Not checked', ''],
      ['D', 'Not checked', 'Delete'],
    ]);
    // A row without a context or a size prints neither: no "undefined", no empty unit.
    const last = [...page.body.querySelectorAll('.lm-lib-row')].at(-1)!;
    expect(last.querySelector('.lm-lib-meta')).toBeNull();
    expect(last.querySelector('.lm-lib-size')!.textContent).toBe('');
    expect(page.body.textContent).not.toContain('undefined');
    // Each state has a colour of its own.
    expect([...page.body.querySelectorAll('.lm-lib-tag .lm-tag')].map((tag) => tag.className)).toEqual([
      'lm-tag lm-tag-inuse',
      'lm-tag lm-tag-ready',
      'lm-tag lm-tag-changed',
      'lm-tag lm-tag-missing',
      'lm-tag lm-tag-unverified',
      'lm-tag lm-tag-unverified',
    ]);
  });

  it('Use switches at once: no confirm screen, and the screen says a switch is running', async () => {
    const page = mount();
    const switching: LocalModelInstallView = {
      ...TWO.install,
      state: 'installing',
      step: 'verify',
      steps: ['verify', 'connect'],
      model: { id: 'gpt-oss:20b', label: 'GPT-OSS 20B' },
      context: 65536,
      library: [
        { ...QWEN_ROW, active: false },
        { ...GPT_ROW, actions: [] },
      ],
      actions: ['cancel'],
    };
    const { app } = await opened(page, TWO, () => ok(switching));
    pressIn(page, '.lm-lib-row', 'Use');
    await settle();
    expect(verbs(app)).toEqual([['POST', '/api/local-model/use', { modelId: 'gpt-oss:20b' }]]);
    expect(page.body.dataset.screen).toBe('progress');
    expect(texts(page.body, '.lm-title')).toEqual(['Switching to GPT-OSS 20B']);
    // Nothing is downloaded: no download bar, and the two steps of a switch.
    expect(page.body.querySelector('.lm-meter')).toBeNull();
    expect(texts(page.body, '.lm-step-label')).toEqual(['Loading and checking', 'Connecting']);
    expect(texts(page.body, '.lm-aside')).toEqual([
      'You can close this window. The switch continues while Codeman is running.',
    ]);
    expect(buttons(page.body)).toEqual(['Cancel']);
  });

  it('a switch that is refused keeps the screen and prints the server sentence with the session names', async () => {
    const page = mount();
    const { app } = await opened(page, TWO, () =>
      conflict({
        reason: 'sessions-open',
        message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictSessionsOpen, vars: { sessions: 'w1-app, w2-api' } },
        sessions: ['w1-app', 'w2-api'],
      })
    );
    pressIn(page, '.lm-lib-row', 'Use');
    await settle();
    expect(page.body.dataset.screen).toBe('installed');
    expect(texts(page.body, '.lm-notice-text')).toEqual([
      'Sessions are still using this model: w1-app, w2-api. Close them first.',
    ]);
    expect(verbs(app)).toHaveLength(1);
    expect(rowButtons(page)).toEqual(['Use', 'Delete']);
  });

  it('Delete asks once, in the row, and sends nothing until the red button is pressed', async () => {
    const page = mount();
    const after: LocalModelInstallView = {
      ...TWO.install,
      library: [QWEN_ROW],
      store: STORE_ONE,
      actions: ['start-session', 'stop', 'install', 'remove'],
    };
    const { app } = await opened(page, TWO, () => ok(after));
    pressIn(page, '.lm-lib-row', 'Delete');
    await settle();
    expect(verbs(app)).toEqual([]);
    const ask = page.body.querySelector('.lm-lib-ask')!;
    expect(texts(ask, '.lm-lead')).toEqual(['Delete GPT-OSS 20B from this Mac?']);
    expect(texts(ask, '.lm-aside')).toEqual(['This frees 13.8 GB.']);
    expect(texts(ask, 'button')).toEqual(['Cancel', 'Delete']);
    // Red only here, in its own question.
    expect(page.frame.querySelectorAll('.wt-btn-danger')).toHaveLength(1);
    expect(ask.querySelector('.wt-btn-danger')!.textContent).toBe('Delete');
    // The question sits right under the row it is about. That row's own buttons keep their
    // room (the sizes must not jump) and are out of reach: unseen, disabled, hidden from a reader.
    const asked = ask.previousElementSibling!;
    expect(asked.querySelector('.lm-lib-label')!.textContent).toBe('GPT-OSS 20B');
    expect(rowButtons(page)).toEqual([]);
    const away = asked.querySelector('.lm-lib-actions')!;
    expect(away.classList.contains('lm-lib-actions-away')).toBe(true);
    expect(away.getAttribute('aria-hidden')).toBe('true');
    expect([...away.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
    // The focus is on the safe answer.
    expect((page.document.activeElement as HTMLElement).textContent).toBe('Cancel');

    pressIn(page, '.lm-lib-ask', 'Cancel');
    await settle();
    expect(page.body.querySelector('.lm-lib-ask')).toBeNull();
    expect(rowButtons(page)).toEqual(['Use', 'Delete']);
    expect(verbs(app)).toEqual([]);
    // Back on the button that asked.
    expect((page.document.activeElement as HTMLElement).dataset.lmKey).toBe('delete:gpt-oss:20b');

    pressIn(page, '.lm-lib-row', 'Delete');
    await settle();
    pressIn(page, '.lm-lib-ask', 'Delete');
    await settle();
    expect(verbs(app)).toEqual([['DELETE', '/api/local-model/models', { modelId: 'gpt-oss:20b' }]]);
    expect(texts(page.body, '.lm-lib-label')).toEqual(['Qwen3.6 35B-A3B']);
    expect(page.body.querySelector('.lm-lib-ask')).toBeNull();
    expect(texts(page.body, '.lm-lib-notes .lm-aside')).toEqual(['Downloaded models use 23.1 GB on this Mac.']);
  });

  it('a delete the server refuses leaves the row and prints why', async () => {
    const page = mount();
    await opened(page, TWO, () =>
      conflict({
        reason: 'model-active',
        message: { text: LOCAL_MODEL_INSTALL_LABELS.conflictModelActive, vars: { model: 'GPT-OSS 20B' } },
      })
    );
    pressIn(page, '.lm-lib-row', 'Delete');
    await settle();
    pressIn(page, '.lm-lib-ask', 'Delete');
    await settle();
    expect(texts(page.body, '.lm-notice-text')).toEqual([
      'GPT-OSS 20B is the model in use. Switch to another model first, or remove the local model.',
    ]);
    expect(texts(page.body, '.lm-lib-label')).toEqual(['Qwen3.6 35B-A3B', 'GPT-OSS 20B']);
  });

  it('the Delete question of a row and the Remove question are never open together', async () => {
    const page = mount();
    await opened(page, TWO);
    pressIn(page, '.lm-lib-row', 'Delete');
    await settle();
    expect(page.body.querySelector('.lm-lib-ask')).not.toBeNull();
    press(page.body, 'Remove');
    await settle();
    expect(page.frame.querySelector('.lm-remove')).not.toBeNull();
    expect(page.frame.querySelector('.lm-lib-ask')).toBeNull();
  });

  it('with the runtime stopped a row offers no delete, and one line says how to get it', async () => {
    const page = mount();
    const stopped = status(
      {},
      {
        ...STOPPED.install,
        library: [QWEN_ROW, { ...GPT_ROW, actions: ['use'] }],
        store: STORE_TWO,
        actions: ['start', 'install', 'use', 'remove'],
      }
    );
    await opened(page, stopped);
    expect(rowButtons(page)).toEqual(['Use']);
    expect(texts(page.body, '.lm-lib-notes .lm-aside')).toEqual([
      'Downloaded models use 36.9 GB on this Mac.',
      'Press Start to delete a single model.',
    ]);
    // With one model there is no single model to delete, so the line is not there.
    const one = mount();
    await opened(one, STOPPED);
    expect(one.body.textContent).not.toContain('Press Start to delete');
  });

  it('the screen that ends an install says one thing: no list, one button', async () => {
    const page = mount();
    const { app, serve } = await opened(page, INSTALLING);
    serve(TWO);
    await app.loadLocalModel({ force: true });
    expect(page.body.dataset.screen).toBe('installed');
    expect(page.body.querySelector('.lm-library')).toBeNull();
    expect(page.body.dataset.long).toBe('false');
    expect(buttons(page.body)).toEqual(['Start a session']);
  });

  // Seen on a Mac: Use, then the list was gone, and deleting the other model meant closing the
  // window and opening it again.
  it('a switch that ends in the open window comes back to the list, the other model in use', async () => {
    const page = mount();
    const switching = status(
      {},
      {
        ...TWO.install,
        state: 'installing',
        step: 'verify',
        steps: ['verify', 'connect'],
        model: { id: 'gpt-oss:20b', label: 'GPT-OSS 20B' },
        library: [
          { ...QWEN_ROW, active: false },
          { ...GPT_ROW, actions: [] },
        ],
        actions: ['cancel'],
      }
    );
    const switched = status(
      {},
      {
        ...TWO.install,
        model: { id: 'gpt-oss:20b', label: 'GPT-OSS 20B' },
        library: [
          { ...GPT_ROW, active: true, actions: [] },
          { ...QWEN_ROW, active: false, actions: ['use', 'delete'] },
        ],
      }
    );
    const { app, serve } = await opened(page, switching);
    expect(page.body.dataset.screen).toBe('progress');
    serve(switched);
    await app.loadLocalModel({ force: true });
    expect(page.body.dataset.screen).toBe('installed');
    expect(texts(page.body, '.lm-lib-label')).toEqual(['GPT-OSS 20B', 'Qwen3.6 35B-A3B']);
    expect(texts(page.body, '.lm-lib-tag .lm-tag')).toEqual(['In use', 'Ready']);
    expect(rowButtons(page)).toEqual(['Use', 'Delete']);
    // The whole installed screen, not the one-button screen that ends an install.
    expect(buttons(page.body)).toEqual(['Remove', 'Stop', 'Start a session']);
    expect(texts(page.body, '.lm-lib-foot button')).toEqual(['Add a model']);
  });

  it('"Add a model" opens the chooser on an installed model, and Back returns to it', async () => {
    const page = mount();
    const { app } = await opened(page, TWO);
    pressIn(page, '.lm-lib-foot', 'Add a model');
    await settle();
    expect(page.body.dataset.screen).toBe('choose');
    expect(page.body.querySelectorAll('[role="radio"]').length).toBeGreaterThan(1);
    expect(buttons(page.body)).toEqual(['Back', 'Install on this Mac']);
    press(page.body, 'Back');
    await settle();
    expect(page.body.dataset.screen).toBe('installed');
    expect(verbs(app)).toEqual([]);
    // No button without the server offering an install (no row fits, or it is not listed).
    const none = mount();
    await opened(none, status({}, { ...TWO.install, actions: ['start-session', 'stop', 'remove'] }));
    expect(texts(none.body, '.lm-lib-foot button')).toEqual([]);
  });

  it('in the chooser a model that is on this Mac says so, and is switched to without a download', async () => {
    const page = mount();
    const answer = status(
      {
        pick: { ...PICK, library: 'active' },
        alternatives: [{ ...ALT_SLOW, library: 'ready' }, ALT_SMALL],
      },
      TWO.install
    );
    const { app } = await opened(page, answer, () => ok({ ...TWO.install, state: 'installing', step: 'verify' }));
    pressIn(page, '.lm-lib-foot', 'Add a model');
    await settle();
    const rows = [...page.body.querySelectorAll('.lm-model')];
    const tagsOf = (row: Element) => texts(row, '.lm-tag');
    // The model in use: its own tag beside the server's, and nothing to do with it here.
    expect(tagsOf(rows[0])).toContain('In use');
    const primary = () => page.frame.querySelector<HTMLButtonElement>('.lm-buttons .wt-btn-primary')!;
    expect(primary().textContent).toBe('In use');
    expect(primary().disabled).toBe(true);

    // A model that is on this Mac and checked: one click switches to it.
    const ready = rows.find((row) => tagsOf(row).includes('On this Mac'))!;
    expect(ready).toBeTruthy();
    (ready as HTMLElement).click();
    await settle();
    expect(primary().textContent).toBe('Use this model');
    expect(primary().disabled).toBe(false);
    primary().click();
    await settle();
    expect(verbs(app)).toEqual([['POST', '/api/local-model/use', { modelId: ALT_SLOW.modelId }]]);
    // No confirm screen was shown on the way.
    expect(page.body.dataset.screen).toBe('progress');
  });

  it('in the chooser a model that is not on this Mac is installed the usual way, with its sizes confirmed', async () => {
    const page = mount();
    const answer = status({ pick: { ...PICK, library: 'active' }, alternatives: [ALT_SMALL] }, TWO.install);
    const { app } = await opened(page, answer, () => ok({ ...TWO.install, state: 'installing', step: 'model' }));
    pressIn(page, '.lm-lib-foot', 'Add a model');
    await settle();
    const other = [...page.body.querySelectorAll<HTMLElement>('.lm-model')].find(
      (row) => row.dataset.modelId === ALT_SMALL.modelId
    )!;
    other.click();
    await settle();
    press(page.body, 'Install on this Mac');
    await settle();
    expect(page.body.dataset.screen).toBe('confirm');
    press(page.body, 'Download and install');
    await settle();
    expect(verbs(app)).toEqual([
      [
        'POST',
        '/api/local-model/install',
        {
          modelId: ALT_SMALL.modelId,
          cli: ALT_SMALL.harnesses[0].cli,
          context: ALT_SMALL.context,
          acknowledgedBytes: ALT_SMALL.installBytes,
        },
      ],
    ]);
  });

  it('a job that stopped beside a checked model shows the way back to that model', async () => {
    const back: LocalModelLibraryRow = { ...QWEN_ROW, active: false, actions: ['use', 'delete'] };
    for (const first of [
      status(
        {},
        { ...PAUSED.install, library: [back], actions: ['resume', 'install', 'use', 'delete-model', 'remove'] }
      ),
      status(
        {},
        {
          ...failed('no-tool-call', { model: 'GPT-OSS 20B' }).install,
          library: [back],
          actions: ['resume', 'install', 'use', 'delete-model', 'remove'],
        }
      ),
    ]) {
      const page = mount();
      const { app } = await opened(page, first, () => ok({ ...TWO.install, state: 'installing', step: 'verify' }));
      expect(texts(page.body, '.lm-lib-label')).toEqual(['Qwen3.6 35B-A3B']);
      expect(texts(page.body, '.lm-lib-tag .lm-tag')).toEqual(['Ready']);
      expect(rowButtons(page)).toEqual(['Use', 'Delete']);
      // No "Add a model" here: the job's own buttons offer another model.
      expect(texts(page.body, '.lm-lib-foot button')).toEqual([]);
      pressIn(page, '.lm-lib-row', 'Use');
      await settle();
      expect(verbs(app)).toEqual([['POST', '/api/local-model/use', { modelId: 'qwen3.6:35b-a3b' }]]);
    }
  });

  it('a first job that stopped has nothing to go back to, and shows no list', async () => {
    const page = mount();
    // Its own model is on disk and checked, with nothing offered on it: Resume goes on with it.
    await opened(page, status({}, { ...PAUSED.install, library: [{ ...QWEN_ROW, active: false }] }));
    expect(page.body.querySelector('.lm-library')).toBeNull();
    expect(page.body.dataset.long).toBe('false');
    const stopped = mount();
    await opened(stopped, failed('load-failed', { model: 'Qwen3.6 35B-A3B' }));
    expect(stopped.body.querySelector('.lm-library')).toBeNull();
  });

  it('a paused switch says so, and waits', async () => {
    const page = mount();
    await opened(
      page,
      status({}, { ...PAUSED.install, step: 'verify', steps: ['verify', 'connect'], progress: undefined })
    );
    expect(texts(page.body, '.lm-title')).toEqual(['The switch to Qwen3.6 35B-A3B is paused']);
    expect(texts(page.body, '.lm-aside')).toEqual(['The switch waits until you continue.']);
    expect(page.body.querySelector('.lm-meter')).toBeNull();
  });

  it('the App Settings row names a switch as a switch', async () => {
    const page = mount();
    const job = { ...JOB, steps: ['verify', 'connect'] as LocalModelInstallView['steps'], step: 'verify' as const };
    for (const [state, text] of [
      ['installing', 'Switching to Qwen3.6 35B-A3B'],
      ['paused', 'The switch to Qwen3.6 35B-A3B is paused'],
      ['failed', 'The switch to Qwen3.6 35B-A3B stopped'],
    ] as const) {
      const app = page.newApp(ok(status({}, { ...job, state, actions: [] })));
      await app.loadLocalModel({ force: true });
      expect(texts(page.row, '.set-row-label')).toEqual([text]);
    }
  });
});

// ---------- The coding agents of an installed model ----------

/** The agents the server lists for the installed model: two that can be started, one to install, one that needs a setup. */
const AGENTS: LocalModelHarnessRow[] = [
  { cli: 'opencode', cliLabel: 'OpenCode', default: true, status: 'ready', readyMark: '┃', actions: ['start-session'] },
  {
    cli: 'claude',
    cliLabel: 'Claude Code',
    default: false,
    status: 'ready',
    slowFirstTurn: true,
    actions: ['start-session'],
  },
  {
    cli: 'pi',
    cliLabel: 'Pi',
    default: false,
    status: 'installable',
    installCommand: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
    actions: ['install'],
  },
  { cli: 'deepseek', cliLabel: 'DeepSeek', default: false, status: 'setup-needed', readyMark: '❯', actions: [] },
];

const withAgents = (rows: LocalModelHarnessRow[], over: Partial<LocalModelInstallView> = {}) =>
  status(
    {},
    { ...INSTALLED.install, harnesses: rows, actions: [...INSTALLED.install.actions, 'install-agent'], ...over }
  );

const WITH_AGENTS = withAgents(AGENTS);

describe('the coding agents of an installed model', () => {
  const chips = (page: Mounted) => texts(page.body, '.lm-agent').map((text) => text.trim());
  const chosen = (page: Mounted) =>
    page.body.querySelector('.lm-agent[aria-checked="true"] .lm-agent-name')?.textContent ?? null;
  const pick = (page: Mounted, label: string) => {
    const chip = [...page.body.querySelectorAll<HTMLButtonElement>('.lm-agent')].find(
      (el) => el.querySelector('.lm-agent-name')!.textContent === label
    );
    expect(chip, `no agent "${label}"`).toBeTruthy();
    chip!.click();
  };
  const launcher = (app: App) => {
    app.loadAppSettingsFromServer = vi.fn(async () => undefined);
    app.loadCliListForSettings = vi.fn(async () => undefined);
    app.selectCustomModelEntry = vi.fn(async () => undefined);
    return app.selectCustomModelEntry;
  };

  it('is one radio group: a chip per agent in the server order, the default selected, a tag on what is not there', async () => {
    const page = mount();
    await opened(page, WITH_AGENTS);
    const group = page.body.querySelector('.lm-agent-list')!;
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(page.document.getElementById(group.getAttribute('aria-labelledby')!)!.textContent).toBe(
      'Start a session with'
    );
    expect(texts(page.body, '.lm-agent-name')).toEqual(['OpenCode', 'Claude Code', 'Pi', 'DeepSeek']);
    expect(chips(page)).toEqual(['OpenCode', 'Claude Code', 'PiNot installed', 'DeepSeekNeeds setup']);
    expect(chosen(page)).toBe('OpenCode');
    // One tab stop for the group.
    expect([...page.body.querySelectorAll<HTMLElement>('.lm-agent')].map((el) => el.tabIndex)).toEqual([0, -1, -1, -1]);
    // The chips say which agent, so the facts line no longer does.
    expect(page.body.textContent).not.toContain('Runs with');
    expect(buttons(page.body)).toEqual(['Remove', 'Stop', 'Start a session']);
    expect(frameOf(page.body).querySelectorAll('.lm-buttons .wt-btn-primary')).toHaveLength(1);
  });

  it('starts the session with the selected agent, and this device remembers the agent it started', async () => {
    const page = mount();
    const { app } = await opened(page, WITH_AGENTS);
    const launch = launcher(app);
    pick(page, 'Claude Code');
    expect(chosen(page)).toBe('Claude Code');
    // What the catalogue says about its first answer.
    expect(texts(page.body, '.lm-agent-about .lm-aside')).toEqual(['The first answer can take minutes.']);
    expect(verbs(app)).toEqual([]);
    // Looking at a chip is not a choice yet.
    expect(page.dom.window.localStorage.getItem('codeman-local-model-agent')).toBeNull();
    press(page.body, 'Start a session');
    await settle();
    expect(launch).toHaveBeenCalledWith('claude', 'local-ollama');

    // The window opened again later: the agent last started stands, not the default.
    expect(page.dom.window.localStorage.getItem('codeman-local-model-agent')).toBe('claude');
    const again = page.newApp(ok(WITH_AGENTS));
    await again.loadLocalModel();
    again.openLocalModelWindow();
    await settle();
    expect(chosen(page)).toBe('Claude Code');
  });

  it('a chip that was only looked at never hides Start a session when the window is opened again', async () => {
    const page = mount();
    const { app } = await opened(page, WITH_AGENTS);
    pick(page, 'DeepSeek');
    expect(buttons(page.body)).toEqual(['Remove', 'Stop']);
    app.closeLocalModelWindow();
    app.openLocalModelWindow();
    await settle();
    // Back on the default agent, with the main action in reach.
    expect(chosen(page)).toBe('OpenCode');
    expect(buttons(page.body)).toEqual(['Remove', 'Stop', 'Start a session']);

    // And an agent that was started once and has since been uninstalled does not win either.
    page.dom.window.localStorage.setItem('codeman-local-model-agent', 'pi');
    app.closeLocalModelWindow();
    app.openLocalModelWindow();
    await settle();
    expect(chosen(page)).toBe('OpenCode');
    expect(buttons(page.body)).toEqual(['Remove', 'Stop', 'Start a session']);
  });

  it('a remembered agent the server no longer lists falls back to the default', async () => {
    const page = mount();
    page.dom.window.localStorage.setItem('codeman-local-model-agent', 'gone');
    const { app } = await opened(page, WITH_AGENTS);
    expect(chosen(page)).toBe('OpenCode');
    const launch = launcher(app);
    press(page.body, 'Start a session');
    await settle();
    expect(launch).toHaveBeenCalledWith('opencode', 'local-ollama');
  });

  it('an agent that is not on this Mac: its literal command, and the main button installs it', async () => {
    const page = mount();
    const installing = AGENTS.map((row) =>
      row.cli === 'pi' ? { ...row, status: 'installing' as const, actions: [] } : row
    );
    const { app, serve } = await opened(page, WITH_AGENTS, () =>
      ok(withAgents(installing, { actions: INSTALLED.install.actions }).install)
    );
    pick(page, 'Pi');
    expect(texts(page.body, '.lm-agent-about .lm-aside')).toEqual([
      'Pi is not on this Mac yet. Codeman installs it with this command:',
    ]);
    // The command the click consents to, as text, exactly as the server sent it.
    expect(texts(page.body, '.lm-agent-about .lm-command')).toEqual([
      'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
    ]);
    expect(buttons(page.body)).toEqual(['Remove', 'Stop', 'Install Pi']);
    expect(frameOf(page.body).querySelector('.lm-buttons .wt-btn-primary')!.textContent).toBe('Install Pi');

    press(page.body, 'Install Pi');
    await settle();
    // The id goes out as data; the command is the server's own and is never sent.
    expect(verbs(app)).toEqual([['POST', '/api/local-model/agent', { cli: 'pi' }]]);
    expect(chips(page)).toContain('PiInstalling');
    expect(texts(page.body, '.lm-agent-about .lm-aside')).toEqual([
      'Installing Pi. You can start a session with another agent meanwhile.',
    ]);
    const main = frameOf(page.body).querySelector<HTMLButtonElement>('.lm-buttons .wt-btn-primary')!;
    expect([main.textContent, main.disabled]).toEqual(['Installing Pi', true]);
    // The model is as it was: still installed, still running.
    expect(page.body.dataset.screen).toBe('installed');
    expect(texts(page.body, '.lm-state-text')).toEqual(['Running']);

    // The installer landed: the next poll says so, and the same chip now starts a session.
    serve(
      withAgents(
        AGENTS.map((row) =>
          row.cli === 'pi'
            ? {
                cli: 'pi',
                cliLabel: 'Pi',
                default: false,
                status: 'ready' as const,
                actions: ['start-session' as const],
              }
            : row
        )
      )
    );
    await page.tick();
    expect(chips(page)).toContain('Pi');
    expect(chosen(page)).toBe('Pi');
    expect(buttons(page.body)).toEqual(['Remove', 'Stop', 'Start a session']);
    const launch = launcher(app);
    press(page.body, 'Start a session');
    await settle();
    expect(launch).toHaveBeenCalledWith('pi', 'local-ollama');
  });

  it('while an agent installs, a session with another agent can be started', async () => {
    const page = mount();
    const rows = AGENTS.map((row) => (row.cli === 'pi' ? { ...row, status: 'installing' as const, actions: [] } : row));
    const { app } = await opened(page, withAgents(rows, { actions: INSTALLED.install.actions }));
    expect(chosen(page)).toBe('OpenCode');
    const launch = launcher(app);
    press(page.body, 'Start a session');
    await settle();
    expect(launch).toHaveBeenCalledWith('opencode', 'local-ollama');
  });

  it('a failed install: the server sentence on the chip that failed, the installer words folded away, and try again', async () => {
    const page = mount();
    const rows = AGENTS.map((row) =>
      row.cli === 'pi'
        ? {
            ...row,
            error: {
              message: { text: LOCAL_MODEL_INSTALL_LABELS.errHarnessFailed, vars: { cli: 'Pi' } },
              detail: 'npm ERR! <b>network</b> request failed',
            },
          }
        : row
    );
    await opened(page, withAgents(rows));
    // Not shown under another agent.
    expect(page.body.querySelector('.lm-agent-about .lm-notice')).toBeNull();
    pick(page, 'Pi');
    expect(texts(page.body, '.lm-agent-about .lm-notice-text')).toEqual(['Pi could not be installed.']);
    const detail = page.body.querySelector('.lm-agent-about .lm-detail-text')!;
    // Someone else's text: shown as text, never as markup.
    expect(detail.textContent).toBe('npm ERR! <b>network</b> request failed');
    expect(detail.querySelector('b')).toBeNull();
    expect(buttons(page.body)).toEqual(['Remove', 'Stop', 'Install Pi']);
    // The model itself has no error: the headline still says ready.
    expect(texts(page.body, '.lm-title')).toEqual(['Qwen3.6 35B-A3B is ready on this Mac.']);
  });

  it('an agent that needs a setup of its own says where, and has nothing to press', async () => {
    const page = mount();
    const { app } = await opened(page, WITH_AGENTS);
    pick(page, 'DeepSeek');
    expect(texts(page.body, '.lm-agent-about .lm-aside')).toEqual([
      'DeepSeek needs a setup of its own. Set it up from the Run menu, then start a session with it here.',
    ]);
    expect(buttons(page.body)).toEqual(['Remove', 'Stop']);
    expect(verbs(app)).toEqual([]);
  });

  it('with no agent that can be started the main button installs the default one', async () => {
    const page = mount();
    const rows: LocalModelHarnessRow[] = [
      {
        cli: 'opencode',
        cliLabel: 'OpenCode',
        default: true,
        status: 'installable',
        installCommand: 'curl -fsSL https://opencode.ai/install | bash',
        actions: ['install'],
      },
    ];
    await opened(page, withAgents(rows, { actions: ['stop', 'install', 'install-agent', 'remove'] }));
    expect(buttons(page.body)).toEqual(['Remove', 'Stop', 'Install OpenCode']);
    expect(texts(page.body, '.lm-command')).toEqual(['curl -fsSL https://opencode.ai/install | bash']);
  });

  it('a stopped model: Start stays the one main button, and an agent can still be installed', async () => {
    const page = mount();
    const rows = AGENTS.map((row) => (row.status === 'ready' ? { ...row, actions: [] } : row));
    const { app } = await opened(
      page,
      withAgents(rows, { running: false, actions: ['start', 'install', 'install-agent', 'remove'] }),
      () => ok(withAgents(rows, { running: false, actions: ['start', 'install', 'remove'] }).install)
    );
    expect(buttons(page.body)).toEqual(['Remove', 'Start']);
    pick(page, 'Pi');
    expect(buttons(page.body)).toEqual(['Remove', 'Start', 'Install Pi']);
    const primary = frameOf(page.body).querySelectorAll('.lm-buttons .wt-btn-primary');
    expect([...primary].map((el) => el.textContent)).toEqual(['Start']);
    press(page.body, 'Install Pi');
    await settle();
    expect(verbs(app)).toEqual([['POST', '/api/local-model/agent', { cli: 'pi' }]]);
  });

  it('moves the selection with the arrow keys, Home and End, and the focus follows', async () => {
    const page = mount();
    await opened(page, WITH_AGENTS);
    page.body.querySelector<HTMLElement>('.lm-agent[aria-checked="true"]')!.focus();
    const key = (name: string) => {
      const event = new page.dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
      page.document.activeElement!.dispatchEvent(event);
      return event;
    };
    const walk: Array<[string, string]> = [
      ['ArrowRight', 'Claude Code'],
      ['ArrowDown', 'Pi'],
      ['ArrowLeft', 'Claude Code'],
      ['ArrowUp', 'OpenCode'],
      // The ends wrap.
      ['ArrowLeft', 'DeepSeek'],
      ['ArrowRight', 'OpenCode'],
      ['End', 'DeepSeek'],
      ['Home', 'OpenCode'],
    ];
    for (const [name, agent] of walk) {
      const event = key(name);
      expect(event.defaultPrevented, name).toBe(true);
      expect(chosen(page), name).toBe(agent);
      const active = page.document.activeElement!;
      expect(active.classList.contains('lm-agent'), name).toBe(true);
      expect(active.getAttribute('aria-checked'), name).toBe('true');
    }
    // Any other key is left alone.
    expect(key('a').defaultPrevented).toBe(false);
  });

  it('is not on the screen that ends an install, and not while something blocks every session', async () => {
    const page = mount();
    const { app, serve } = await opened(page, INSTALLING);
    serve(WITH_AGENTS);
    await page.tick();
    // The install just finished in this window: one thing to do.
    expect(page.body.querySelector('.lm-agents')).toBeNull();
    expect(buttons(page.body)).toEqual(['Start a session']);
    const launch = launcher(app);
    press(page.body, 'Start a session');
    await settle();
    // The agent that was chosen for the install: the server's default.
    expect(launch).toHaveBeenCalledWith('opencode', 'local-ollama');

    const blocked = mount();
    await opened(
      blocked,
      withAgents(
        AGENTS.map((row) => ({ ...row, actions: row.actions.filter((action) => action !== 'start-session') })),
        {
          actions: ['stop', 'install', 'remove'],
          error: {
            code: 'model-changed',
            message: { text: LOCAL_MODEL_INSTALL_LABELS.errModelChanged },
            next: 'remove',
          },
        }
      )
    );
    expect(blocked.body.querySelector('.lm-agents')).toBeNull();
    expect(buttons(blocked.body)).not.toContain('Start a session');
  });

  it('an agent name is text of someone else: shown as text', async () => {
    const page = mount();
    const rows = AGENTS.map((row) =>
      row.cli === 'pi'
        ? { ...row, cliLabel: '<img src=x onerror=alert(1)>', installCommand: '<script>x</script>' }
        : row
    );
    await opened(page, withAgents(rows));
    pick(page, '<img src=x onerror=alert(1)>');
    expect(page.body.querySelector('.lm-agents img, .lm-agents script')).toBeNull();
    expect(texts(page.body, '.lm-command')).toEqual(['<script>x</script>']);
    expect(buttons(page.body)).toContain('Install <img src=x onerror=alert(1)>');
  });

  it('in Chinese: the label, the tags, the line and the button', async () => {
    const page = mount({ i18n: true });
    page.win.CodemanI18n.start();
    page.win.CodemanI18n.configure({ language: 'zh-CN' });
    await opened(page, WITH_AGENTS);
    expect(texts(page.body, '.lm-agents-label')).toEqual(['开始会话时使用']);
    expect(texts(page.body, '.lm-agent .lm-tag')).toEqual(['未安装', '需要设置']);
    pick(page, 'Pi');
    expect(texts(page.body, '.lm-agent-about .lm-aside')).toEqual([
      '此 Mac 上尚未安装 Pi。Codeman 会用下面这条命令安装它：',
    ]);
    expect(buttons(page.body)).toContain('安装 Pi');
  });

  it('a server that lists no agents (an older one): the one agent of the install, as before', async () => {
    const page = mount();
    const { app } = await opened(page, INSTALLED);
    expect(page.body.querySelector('.lm-agents')).toBeNull();
    expect(page.body.textContent).toContain('Runs with OpenCode.');
    const launch = launcher(app);
    press(page.body, 'Start a session');
    await settle();
    expect(launch).toHaveBeenCalledWith('opencode', 'local-ollama');
  });
});

describe('what an earlier Remove left on disk', () => {
  const LEFT = status({}, { store: STORE_ONE, actions: ['install', 'remove'] });

  it('the chooser says what the downloads still take, and deletes them after one question', async () => {
    const page = mount();
    const { app } = await opened(page, LEFT, () => ok(install({ store: { bytes: 0, gb: '0.0' } })));
    expect(texts(page.body, '.lm-leftovers .lm-aside')).toEqual([
      'Models from an earlier install still use 23.1 GB on this Mac.',
    ]);
    pressIn(page, '.lm-leftovers', 'Delete them');
    await settle();
    expect(verbs(app)).toEqual([]);
    expect(texts(page.body, '.lm-leftovers .lm-lead')).toEqual(['Delete the downloaded models from this Mac?']);
    expect(texts(page.body, '.lm-leftovers .lm-lib-ask .lm-aside')).toEqual(['This frees 23.1 GB.']);
    expect(page.body.querySelector('.lm-leftovers .wt-btn-danger')!.textContent).toBe('Delete');
    pressIn(page, '.lm-leftovers', 'Cancel');
    await settle();
    expect(texts(page.body, '.lm-leftovers button')).toEqual(['Delete them']);
    pressIn(page, '.lm-leftovers', 'Delete them');
    await settle();
    pressIn(page, '.lm-leftovers', 'Delete');
    await settle();
    expect(verbs(app)).toEqual([['DELETE', '/api/local-model', { removeModel: true }]]);
    expect(page.body.querySelector('.lm-leftovers')).toBeNull();
    // Still the chooser: installing is what this screen is for.
    expect(page.body.dataset.screen).toBe('choose');
    expect(buttons(page.body)).toEqual(['Install on this Mac']);
  });

  it('is not there without something on disk, or without the server offering the removal', async () => {
    for (const first of [
      IDLE,
      status({}, { store: { bytes: 0, gb: '0.0' }, actions: ['install', 'remove'] }),
      status({}, { store: STORE_ONE, actions: ['install'] }),
    ]) {
      const page = mount();
      await opened(page, first);
      expect(page.body.querySelector('.lm-leftovers')).toBeNull();
    }
  });

  it('shows on a Mac no model fits too: the space can still be freed', async () => {
    const page = mount();
    const answer = none('memory');
    await opened(page, { ...answer, install: install({ store: STORE_ONE, actions: ['remove'] }) });
    expect(page.body.dataset.screen).toBe('none');
    expect(texts(page.body, '.lm-leftovers .lm-aside')).toEqual([
      'Models from an earlier install still use 23.1 GB on this Mac.',
    ]);
  });
});

describe('the models on this Mac: text of someone else, another language, an unchanged answer', () => {
  it('a model name is text, in the row, in its question and in the labels of its buttons', async () => {
    const HOSTILE = '<img src=x onerror="window.__pwned=1">';
    const page = mount();
    const rows: LocalModelLibraryRow[] = [QWEN_ROW, { ...GPT_ROW, id: `evil:1b`, label: `Model ${HOSTILE}` }];
    await opened(page, status({}, { ...TWO.install, library: rows, folder: `/tmp/${HOSTILE}` }));
    pressIn(page, '.lm-lib-row', 'Delete');
    await settle();
    expect(page.document.querySelectorAll('img, script, iframe')).toHaveLength(0);
    expect((page.win as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(texts(page.body, '.lm-lib-ask .lm-lead')).toEqual([`Delete Model ${HOSTILE} from this Mac?`]);
  });

  it('is translated when the language changes, the names staying as sent', async () => {
    const page = mount({ i18n: true });
    page.win.CodemanI18n.start();
    await opened(page, TWO);
    page.win.CodemanI18n.configure({ language: 'zh-CN' });
    await settle();
    expect(texts(page.body, '.lm-lib-caption-label')).toEqual(['此 Mac 上的模型']);
    expect(texts(page.body, '.lm-lib-tag .lm-tag')).toEqual(['使用中', '就绪']);
    expect(rowButtons(page)).toEqual(['使用', '删除']);
    expect(texts(page.body, '.lm-lib-label')).toEqual(['Qwen3.6 35B-A3B', 'GPT-OSS 20B']);
    expect(texts(page.body, '.lm-lib-notes .lm-aside')).toEqual(['已下载的模型在此 Mac 上占用 36.9 GB。']);
    expect(texts(page.body, '.lm-lib-foot button')).toEqual(['添加模型']);
  });

  it('a poll that changes nothing leaves the rows and their buttons in place', async () => {
    const page = mount();
    await opened(page, TWO);
    const before = page.body.querySelector('.lm-lib-row .lm-lib-actions button');
    await page.tick();
    await page.tick();
    expect(page.body.querySelector('.lm-lib-row .lm-lib-actions button')).toBe(before);
  });

  it('the focus stays on the row button it was on when the list is repainted', async () => {
    const page = mount();
    const { app, serve } = await opened(page, TWO);
    const remove = [...page.body.querySelectorAll<HTMLButtonElement>('.lm-lib-row .lm-lib-actions button')][1];
    remove.focus();
    serve(status({}, { ...TWO.install, store: { bytes: 36899240384, gb: '36.9' }, port: 11436 }));
    await app.loadLocalModel({ force: true });
    const active = page.document.activeElement as HTMLElement;
    expect(active.textContent).toBe('Delete');
    expect(active.dataset.lmKey).toBe('delete:gpt-oss:20b');
    expect(active).not.toBe(remove);
  });
});
