// Port: none (pure model + static markup assertions — no browser, no server).
//
// The phone home screen (src/web/public/mobile-overview.js) replaces the welcome
// overlay under 600px. Its grouping logic is the part that can silently go wrong:
// a session blocked on a permission prompt landing in "idle" is exactly the bug
// this surface exists to prevent. buildMobileOverviewModel() is pure for that
// reason, so it can be exercised here against plain objects.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');

/** Minimal fake DOM node — enough surface for mobile-overview.js's programmatic builders. */
function fakeElement(): any {
  const el: any = {
    className: '',
    type: '',
    dataset: {},
    style: {},
    children: [] as any[],
    setAttribute() {},
    appendChild(child: any) {
      el.children.push(child);
      return child;
    },
  };
  return el;
}

function loadOverviewApp(overrides: Record<string, any> = {}) {
  const CodemanApp = function CodemanApp(this: any) {};
  const context = vm.createContext({
    CodemanApp,
    console,
    window: {},
    document: {
      getElementById: () => null,
      createElement: () => fakeElement(),
      createElementNS: () => fakeElement(),
    },
    MobileDetection: { getDeviceType: () => 'mobile' },
  });
  // constants.js first: it installs the row comparator (window.CodemanSessionOrder)
  // that buildMobileOverviewModel() sorts every section with, shared with the
  // desktop rail so the two home screens cannot order the same list differently.
  for (const file of ['constants.js', 'mobile-overview.js']) {
    vm.runInContext(readFileSync(resolve(PUBLIC, file), 'utf8'), context, { filename: file });
  }

  const app = new (CodemanApp as any)();
  app.getSessionName = (session: any) => session.name || session.workingDir?.split('/').pop() || session.id.slice(0, 8);
  app._shortenHomePath = (p: string) => (p || '').replace(/^\/home\/[^/]+\//, '~/');
  app.loadAppSettingsFromStorage = () => ({});
  Object.assign(app, overrides);
  return app;
}

const CASES = [
  { name: 'claudeman', path: '/home/arkon/default/claudeman', location: 'local' },
  { name: 'beta', path: '/home/arkon/codeman-cases/beta', location: 'local' },
  { name: 'boxed', path: '/srv/boxed', location: 'docker' },
];

function session(over: Record<string, any>) {
  return { id: 'x', status: 'idle', mode: 'claude', workingDir: '/home/arkon/default/claudeman', ...over };
}

describe('mobile overview model', () => {
  it('routes a session with a pending permission prompt into NEEDS YOU, not idle', () => {
    const app = loadOverviewApp();
    const model = app.buildMobileOverviewModel({
      sessions: [session({ id: 'a', status: 'idle' })],
      cases: CASES,
      pendingHooks: new Map([['a', new Set(['permission_prompt'])]]),
    });

    expect(model.needsYou.map((r: any) => r.id)).toEqual(['a']);
    expect(model.current).toHaveLength(0);
    expect(model.needsYou[0].state).toBe('needs');
    expect(model.needsYou[0].pill).toBe('needs you');
  });

  it('ranks an action hook above an idle hook above a stale busy status', () => {
    const app = loadOverviewApp();
    const model = app.buildMobileOverviewModel({
      // An idle_prompt hook on a session the server still calls 'busy': the hook
      // is the newer signal, so it must win.
      sessions: [
        session({ id: 'busy-with-idle-hook', status: 'busy' }),
        session({ id: 'elicit', status: 'busy' }),
        session({ id: 'plain-busy', status: 'busy' }),
      ],
      cases: CASES,
      pendingHooks: new Map([
        ['busy-with-idle-hook', new Set(['idle_prompt'])],
        ['elicit', new Set(['elicitation_dialog'])],
      ]),
    });

    expect(model.needsYou.map((r: any) => r.id)).toEqual(['elicit', 'busy-with-idle-hook']);
    expect(model.current.map((r: any) => r.id)).toEqual(['plain-busy']);
  });

  it('buckets busy / idle / stopped / error and labels each pill', () => {
    const app = loadOverviewApp();
    const model = app.buildMobileOverviewModel({
      sessions: [
        session({ id: 'w', status: 'busy' }),
        session({ id: 'i', status: 'idle' }),
        session({ id: 'd', status: 'stopped' }),
        session({ id: 'e', status: 'error' }),
      ],
      cases: CASES,
    });

    // Everything that is not blocked on you shares one "current" section,
    // most demanding first.
    expect(model.current.map((r: any) => [r.id, r.pill])).toEqual([
      ['w', 'working'],
      ['i', 'idle'],
      ['d', 'done'],
    ]);
    expect(model.needsYou.map((r: any) => r.pill)).toEqual(['error']);
    expect(model.sessionCount).toBe(4);
  });

  it('keeps the user tab order as the tiebreak when nothing is stamped', () => {
    const app = loadOverviewApp();
    const model = app.buildMobileOverviewModel({
      sessions: [session({ id: 'first' }), session({ id: 'second' }), session({ id: 'third' })],
      cases: CASES,
      sessionOrder: ['third', 'first', 'second'],
    });

    expect(model.current.map((r: any) => r.id)).toEqual(['third', 'first', 'second']);
  });

  it('sorts running sessions longest-turn-first and quiet ones most-recent-first', () => {
    // A working pane repaints about once a second, so its last-activity stamp
    // is always "now": the running group has to key off the pane's last Enter
    // instead, or every turn ranks as freshly started.
    const app = loadOverviewApp();
    const model = app.buildMobileOverviewModel({
      sessions: [
        session({ id: 'quiet-old', status: 'idle', lastActivityAt: 2_000 }),
        session({ id: 'turn-young', status: 'busy', lastSubmitAt: 9_000, lastActivityAt: 10_000 }),
        session({ id: 'quiet-new', status: 'idle', lastActivityAt: 8_000 }),
        session({ id: 'turn-old', status: 'busy', lastSubmitAt: 1_000, lastActivityAt: 10_000 }),
      ],
      cases: CASES,
      sessionOrder: ['quiet-old', 'turn-young', 'quiet-new', 'turn-old'],
    });

    expect(model.current.map((r: any) => r.id)).toEqual(['turn-old', 'turn-young', 'quiet-new', 'quiet-old']);
  });

  it('puts the longest-blocked session at the top of NEEDS YOU', () => {
    const app = loadOverviewApp();
    const model = app.buildMobileOverviewModel({
      sessions: [
        session({ id: 'just-asked', lastActivityAt: 9_000 }),
        session({ id: 'starving', lastActivityAt: 1_000 }),
      ],
      cases: CASES,
      pendingHooks: new Map([
        ['just-asked', new Set(['permission_prompt'])],
        ['starving', new Set(['permission_prompt'])],
      ]),
    });

    expect(model.needsYou.map((r: any) => r.id)).toEqual(['starving', 'just-asked']);
  });

  it('matches a session started in a subdirectory to its case (longest prefix)', () => {
    const app = loadOverviewApp();
    const model = app.buildMobileOverviewModel({
      sessions: [
        session({ id: 'sub', workingDir: '/home/arkon/default/claudeman/src/web' }),
        session({ id: 'outside', workingDir: '/tmp/scratch' }),
      ],
      cases: [...CASES, { name: 'claudeman-web', path: '/home/arkon/default/claudeman/src/web' }],
    });

    const rows = Object.fromEntries(model.current.map((r: any) => [r.id, r.caseName]));
    expect(rows.sub).toBe('claudeman-web');
    expect(rows.outside).toBe('');
  });

  it('lists past conversations newest first and never repeats a live session', () => {
    const app = loadOverviewApp();
    const model = app.buildMobileOverviewModel({
      sessions: [session({ id: 'live-1' })],
      cases: CASES,
      history: [
        // Same id as the running session: the unified list includes live rows,
        // and showing one in both sections would be a duplicate.
        { sessionId: 'live-1', workingDir: '/home/arkon/default/claudeman', lastActivityAt: 500 },
        {
          sessionId: 'old-a',
          workingDir: '/home/arkon/codeman-cases/beta',
          firstPrompt: 'fix the mobile header',
          claudeSessionId: 'claude-uuid-a',
          lastActivityAt: 100,
        },
        {
          sessionId: 'old-b',
          workingDir: '/home/arkon/default/claudeman',
          name: 'w4-claudeman',
          lastActivityAt: 400,
        },
      ],
    });

    expect(model.past.map((r: any) => r.id)).toEqual(['old-b', 'old-a']);
    expect(model.past[1]).toMatchObject({
      title: 'fix the mobile header',
      caseName: 'beta',
      claudeSessionId: 'claude-uuid-a',
      workingDir: '/home/arkon/codeman-cases/beta',
    });
    // A row with no prompt falls back to its name, so it is never a bare UUID.
    expect(model.past[0].title).toBe('w4-claudeman');
  });

  it('carries resumeId through to the past row so a Codex tap resumes its thread', () => {
    const app = loadOverviewApp();
    const model = app.buildMobileOverviewModel({
      sessions: [],
      cases: CASES,
      history: [
        {
          sessionId: 'rollout-1',
          workingDir: '/home/arkon/codeman-cases/beta',
          firstPrompt: 'port the parser',
          mode: 'codex',
          resumeId: 'codex-thread-id',
          lastActivityAt: 300,
        },
        // A claude row carries none, and must not grow one.
        {
          sessionId: 'claude-1',
          workingDir: '/home/arkon/default/claudeman',
          claudeSessionId: 'claude-uuid-a',
          lastActivityAt: 200,
        },
      ],
    });

    // resumeMobileOverviewSession() reads row.resumeId off exactly this projection and
    // hands it to resumeHistorySession(); an undefined here is a fresh codex session on
    // a thread that already exists, which is the phone-only half of the resume feature.
    expect(model.past[0]).toMatchObject({ mode: 'codex', resumeId: 'codex-thread-id' });
    expect(model.past[1].resumeId).toBeUndefined();
  });

  it('does not title a past row with the transcript reader placeholder', () => {
    const app = loadOverviewApp();
    const model = app.buildMobileOverviewModel({
      sessions: [],
      cases: CASES,
      history: [
        { sessionId: 'blank', workingDir: '/home/arkon/default/claudeman', firstPrompt: '(no content)' },
        { sessionId: 'spaces', workingDir: '/home/arkon/codeman-cases/beta', firstPrompt: '   ' },
      ],
    });

    expect(model.past.map((r: any) => r.title)).toEqual(['claudeman', 'beta']);
  });

  it('accepts the live Map as-is and survives an empty state', () => {
    const app = loadOverviewApp();
    const fromMap = app.buildMobileOverviewModel({
      sessions: new Map([['a', session({ id: 'a' })]]),
      cases: CASES,
    });
    expect(fromMap.current.map((r: any) => r.id)).toEqual(['a']);

    const empty = app.buildMobileOverviewModel({});
    expect(empty).toMatchObject({ needsYou: [], current: [], past: [], sessionCount: 0 });
  });

  it('anchors the "how long" stamp on last activity, and on the last Enter while working', () => {
    const app = loadOverviewApp();
    const now = Date.now();
    const model = app.buildMobileOverviewModel({
      sessions: [
        // A working pane repaints about once a second, so lastActivityAt is
        // always "now" and would report every running turn as 0m. The turn's
        // own start is the last Enter.
        session({
          id: 'w',
          status: 'busy',
          createdAt: now - 7200_000,
          lastActivityAt: now,
          lastSubmitAt: now - 300_000,
        }),
        // A quiet pane prints nothing, so its last byte IS when it went idle.
        session({ id: 'i', status: 'idle', createdAt: now - 7200_000, lastActivityAt: now - 900_000 }),
      ],
      cases: CASES,
    });

    const rows = Object.fromEntries(model.current.map((r: any) => [r.id, r]));
    expect(rows.w.since).toEqual({ key: 'working', at: now - 300_000 });
    expect(rows.i.since).toEqual({ key: 'idle', at: now - 900_000 });
    expect(rows.i.createdAt).toBe(now - 7200_000);
  });

  it('falls back to the sort anchor for a working row with no submit stamp', () => {
    // A session that has never submitted has no turn start to measure from, but
    // `sessionActivityAnchor` still RANKS it by lastActivityAt. The stamp must
    // show that same number rather than nothing: a row sorted by a value it
    // does not display reads as randomly placed.
    const now = Date.now();
    const app = loadOverviewApp();
    const model = app.buildMobileOverviewModel({
      sessions: [session({ id: 'w', status: 'busy', lastActivityAt: now })],
      cases: CASES,
    });
    expect(model.current[0].since).toEqual({ key: 'working', at: now });
    expect(model.current[0].createdAt).toBe(0);
  });

  it('still leaves the stamp off when there is no anchor at all', () => {
    const app = loadOverviewApp();
    const model = app.buildMobileOverviewModel({
      sessions: [session({ id: 'w', status: 'busy' })],
      cases: CASES,
    });
    expect(model.current[0].since).toBeNull();
  });

  it('formats a moment as "ago" and a span as a bare duration', () => {
    const app = loadOverviewApp();
    app.formatRelativeTime = () => '3d ago';
    const now = Date.now();

    expect(app._mobileOverviewStampText(now - 86_400_000, 'ago')).toBe('3d ago');
    expect(app._mobileOverviewStampText(now - 20_000, 'for')).toBe('<1m');
    expect(app._mobileOverviewStampText(now - 12 * 60_000, 'for')).toBe('12m');
    expect(app._mobileOverviewStampText(now - 125 * 60_000, 'for')).toBe('2h 5m');
    expect(app._mobileOverviewStampText(now - 3 * 3600_000, 'for')).toBe('3h');
    expect(app._mobileOverviewStampText(now - 50 * 3600_000, 'for')).toBe('2d 2h');
    // No anchor renders as a dash, never as "56 years ago" off epoch 0.
    expect(app._mobileOverviewStampText(0, 'for')).toBe('—');
    expect(app._mobileOverviewStampText(0, 'ago')).toBe('—');
  });

  it('no longer builds a spaces section', () => {
    const app = loadOverviewApp();
    const model = app.buildMobileOverviewModel({ sessions: [session({ id: 'a' })], cases: CASES });
    expect(model.spaces).toBeUndefined();
  });
});

describe('mobile overview gate', () => {
  it('is phone-width only, off in solo windows, and off when explicitly disabled', () => {
    expect(loadOverviewApp().shouldUseMobileOverview()).toBe(true);
    expect(loadOverviewApp({ isSoloWindow: true }).shouldUseMobileOverview()).toBe(false);
    expect(
      loadOverviewApp({
        loadAppSettingsFromStorage: () => ({ mobileOverviewEnabled: false }),
      }).shouldUseMobileOverview()
    ).toBe(false);
    // An unset value must read as ON: phones that already have saved settings
    // from before this feature existed have no key for it.
    expect(loadOverviewApp({ loadAppSettingsFromStorage: () => ({ skin: 'og' }) }).shouldUseMobileOverview()).toBe(
      true
    );
  });
});

describe('mobile overview wiring', () => {
  const html = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
  const mobileCss = readFileSync(resolve(PUBLIC, 'mobile.css'), 'utf8');
  const moduleSrc = readFileSync(resolve(PUBLIC, 'mobile-overview.js'), 'utf8');

  it('speaks the same status language as the session tabs', () => {
    // A session that is fine reads green on the tabs; anything else here would
    // mean two meanings for one color on the same screen.
    expect(mobileCss).toMatch(/\.mobile-overview-dot--idle\s*\{\s*background:\s*var\(--green\)/);
    expect(mobileCss).toMatch(/\.mobile-overview-dot--working\s*\{[^}]*var\(--green\)[^}]*animation:\s*pulse/);
    // Waiting-for-input blinks yellow, asked-a-question blinks red, same as
    // tab-alert-idle / tab-alert-action.
    expect(mobileCss).toMatch(/\.mobile-overview-row--waiting\s*\{[^}]*animation:\s*mobile-overview-blink-yellow/);
    expect(mobileCss).toMatch(/\.mobile-overview-row--needs\s*\{[^}]*animation:\s*mobile-overview-blink-red/);
    expect(mobileCss).toContain('@keyframes mobile-overview-blink-red');
    expect(mobileCss).toContain('@keyframes mobile-overview-blink-yellow');
    // The alert must survive reduced-motion as a held color, not vanish.
    expect(mobileCss).toMatch(/prefers-reduced-motion[^}]*\}[\s\S]*?\.mobile-overview-row--needs/);
  });

  it('reuses the toolbar Run button classes instead of its own palette', () => {
    // The per-backend gradient lives in styles.css keyed on
    // `.btn-toolbar.btn-run.mode-<backend>` (and light skins override exactly
    // those); carrying the same classes keeps both Run buttons identical.
    expect(moduleSrc).toContain('btn-toolbar btn-run mode-');
    expect(moduleSrc).toContain('btn-toolbar btn-run-gear mode-');
    // The two button rules (not the dropdown below them) must set no color at
    // all, or they would win over the mode gradient.
    const buttonRules = mobileCss.match(/\.mobile-overview-run(-caret)?\s*\{[^}]*\}/g) || [];
    expect(buttonRules.length).toBe(2);
    for (const rule of buttonRules) {
      expect(rule).not.toMatch(/\b(background|color)\s*:/);
    }
  });

  it('ships the container hidden and loads the module', () => {
    expect(html).toMatch(/<div class="mobile-overview" id="mobileOverview" hidden><\/div>/);
    expect(html).toContain('<script defer src="mobile-overview.js"></script>');
  });

  it('never gives .mobile-overview a bare display rule', () => {
    // Desktop does not load mobile.css at all, so the [hidden] attribute is the
    // only thing keeping the overview off desktop. A bare
    // `.mobile-overview { display: … }` rule would beat the UA [hidden] rule.
    const bareDisplay = /\.mobile-overview\s*\{[^}]*display\s*:/;
    expect(bareDisplay.test(mobileCss)).toBe(false);
    expect(mobileCss).toContain('.mobile-overview.visible {');
  });

  it('styles the overview from skin tokens rather than hardcoded colors', () => {
    // Skins re-point the :root tokens, so a hex literal here is a rule that
    // silently stays dark on the four light skins.
    const rules = mobileCss.match(/\.mobile-overview[^{}]*\{[^}]*\}/g) || [];
    expect(rules.length).toBeGreaterThan(10);
    const hardcoded = rules.flatMap((rule) => rule.match(/:\s*#[0-9a-f]{3,8}\b/gi) || []);
    expect(hardcoded).toEqual([]);
  });
});

describe('mobile overview run picker (CLI availability gating)', () => {
  function modeButtons(menu: any): string[] {
    return menu.children.filter((c: any) => c.dataset.moAction === 'run-mode').map((c: any) => c.dataset.moMode);
  }

  // #201 gated the toolbar's #runModeMenu on isCliAvailable(); this phone-only
  // picker (MOBILE_OVERVIEW_RUN_MODES / _buildMobileOverviewRunMenu) is a
  // separate, hardcoded duplicate of that menu rather than a shared render, so
  // it silently offered every backend regardless of what the server reported.
  it('hides run modes the server reports as unavailable, keeps shell always', () => {
    const app = loadOverviewApp({
      runMode: 'claude',
      isCliAvailable: (tool: string) => tool === 'claude',
    });
    const menu = app._buildMobileOverviewRunMenu();
    expect(modeButtons(menu)).toEqual(['claude', 'shell']);
  });

  it('shows every mode when every CLI is available', () => {
    const app = loadOverviewApp({
      runMode: 'claude',
      isCliAvailable: () => true,
    });
    const menu = app._buildMobileOverviewRunMenu();
    expect(modeButtons(menu)).toEqual([
      'claude',
      'opencode',
      'codex',
      'gemini',
      'antigravity',
      'pi',
      'grok',
      'deepseek',
      'omp',
      'shell',
    ]);
  });

  it('gates every mode the picker actually offers', () => {
    // Catches a new backend being added to MOBILE_OVERVIEW_RUN_MODES without
    // being gated — the same class of bug that let this list drift from the
    // toolbar menu's gating in the first place.
    const src = readFileSync(resolve(PUBLIC, 'mobile-overview.js'), 'utf8');
    const modesBlock = src.slice(
      src.indexOf('const MOBILE_OVERVIEW_RUN_MODES'),
      src.indexOf('];', src.indexOf('const MOBILE_OVERVIEW_RUN_MODES')) + 2
    );
    const offered = [...modesBlock.matchAll(/mode: '([^']+)'/g)].map((m) => m[1]);
    expect(offered).toContain('omp');
    const fn = src.slice(src.indexOf('_buildMobileOverviewRunMenu() {'));
    const gate = fn.slice(0, fn.indexOf('const header'));
    expect(gate).toContain('isCliAvailable');
  });
});
