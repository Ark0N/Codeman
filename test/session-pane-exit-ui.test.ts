/**
 * @fileoverview The exited-agent badge on a session tab (Ark0N/Codeman#446).
 *
 * The server publishes `session.paneExit` when the agent inside a local tmux
 * pane has exited while `remain-on-exit` kept the pane. These cover the three
 * things the browser owns: turning that field into a label, getting the label
 * onto and off a tab, and what colour the tab's status dot ends up once the
 * exit, the alert rules and the rich rail's own rules have all had a say.
 *
 * The incremental render path is the only one a live session ever reaches.
 * Going from live to exited adds and removes no tab, so the full rebuild never
 * runs for it, which is why `applyPaneExitBadge()` is a named function rather
 * than a block inside the render loop.
 *
 * Port: N/A
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

describe('the exited-agent tab label', () => {
  const appJs = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const load = <T>(name: string) => {
    const source = appJs.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))?.[0];
    if (!source) throw new Error(`${name} not found in app.js`);
    return new Function(`${source}\nreturn ${name};`)() as T;
  };
  const paneExitLabel = load<(p: unknown) => string>('paneExitLabel');

  it('renders nothing for an unknown answer, which must never read as alive', () => {
    expect(paneExitLabel(undefined)).toBe('');
    expect(paneExitLabel(null)).toBe('');
  });

  it('names the exit code', () => {
    expect(paneExitLabel({ status: 137, at: 1 })).toBe('exited (137)');
  });

  it('shows a clean exit as 0 rather than hiding it', () => {
    expect(paneExitLabel({ status: 0, at: 1 })).toBe('exited (0)');
  });

  it('names a signal death, which the maintainer wants kept on screen', () => {
    expect(paneExitLabel({ signal: 9, at: 1 })).toBe('exited (signal 9)');
  });

  it('says only "exited" when tmux knew the pane died but not how', () => {
    // Measured on tmux 3.2a: a SIGKILLed pane reports neither status nor signal.
    // Showing that as "exited (0)" would make an unexplained death look clean.
    expect(paneExitLabel({ at: 1 })).toBe('exited');
  });
});

describe('the exited-agent badge in a tab', () => {
  // The incremental render path is the only one a live session reaches: going
  // from live to exited adds and removes no tab, so the full rebuild never runs
  // for it. These drive that path's DOM work against a real tab element.
  const appJs = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const source = [
    appJs.match(/function paneExitLabel\([\s\S]*?\n\}/)?.[0],
    appJs.match(/function paneExitAriaLabel\([\s\S]*?\n\}/)?.[0],
    appJs.match(/function applyPaneExitBadge\([\s\S]*?\n\}/)?.[0],
  ].join('\n');
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const applyPaneExitBadge = new Function('document', `${source}\nreturn applyPaneExitBadge;`)(dom.window.document) as (
    tab: unknown,
    paneExit: unknown
  ) => void;

  const makeTab = () => {
    const tab = dom.window.document.createElement('div');
    tab.className = 'session-tab';
    tab.setAttribute('aria-label', 'w1-case session');
    tab.innerHTML = '<span class="tab-name" data-full-name="w1-case">w1-case</span>';
    return tab;
  };
  const badge = (tab: { querySelector: (s: string) => { textContent: string | null } | null }) =>
    tab.querySelector('.tab-exited-badge');

  it('draws no badge while the answer is unknown', () => {
    const tab = makeTab();
    applyPaneExitBadge(tab, undefined);
    expect(badge(tab)).toBeNull();
  });

  it('adds the badge after the name once the agent exits', () => {
    const tab = makeTab();
    applyPaneExitBadge(tab, { status: 137, at: 1 });
    expect(badge(tab)?.textContent).toBe('exited (137)');
    expect(tab.querySelector('.tab-name')?.nextElementSibling?.className).toBe('tab-exited-badge');
  });

  it('marks the badge data-i18n-skip, like the other generated status text', () => {
    const tab = makeTab();
    applyPaneExitBadge(tab, { status: 0, at: 1 });
    expect(badge(tab)?.hasAttribute('data-i18n-skip')).toBe(true);
  });

  it('hides the badge from assistive technology, like its sibling badges', () => {
    const tab = makeTab();
    applyPaneExitBadge(tab, { status: 0, at: 1 });
    expect(badge(tab)?.getAttribute('aria-hidden')).toBe('true');
  });

  it('carries the exit on the tab accessible name instead, and drops it again', () => {
    // The tab's aria-label overrides its contents, so the badge alone would leave
    // a screen reader announcing an exited tab exactly like a live one.
    const tab = makeTab();
    applyPaneExitBadge(tab, { status: 137, at: 1 });
    expect(tab.getAttribute('aria-label')).toBe('w1-case session, agent exited (137)');
    applyPaneExitBadge(tab, undefined);
    expect(tab.getAttribute('aria-label')).toBe('w1-case session');
  });

  it('builds the full render path accessible name from the same helper', () => {
    expect(appJs).toContain('aria-label="${escapeHtml(paneExitAriaLabel(name, paneExitBadge))}"');
    expect(appJs).toContain('<span class="tab-exited-badge" data-i18n-skip aria-hidden="true">');
  });

  it('updates the text in place rather than stacking a second badge', () => {
    const tab = makeTab();
    applyPaneExitBadge(tab, { status: 0, at: 1 });
    const first = badge(tab);
    applyPaneExitBadge(tab, { status: 137, at: 2 });
    expect(tab.querySelectorAll('.tab-exited-badge')).toHaveLength(1);
    expect(badge(tab)).toBe(first);
    expect(badge(tab)?.textContent).toBe('exited (137)');
  });

  it('marks the tab so the status dot can be quieted', () => {
    // The dot renders from `status`, which stays `idle` or `busy` for an exited
    // pane by design, so the tab carries the exit as a class and CSS does the
    // rest. Without it a green or pulsing dot sits beside the badge.
    const tab = makeTab();
    applyPaneExitBadge(tab, { status: 0, at: 1 });
    expect(tab.classList.contains('tab-agent-exited')).toBe(true);
  });

  it('unmarks the tab when the pane comes back', () => {
    const tab = makeTab();
    applyPaneExitBadge(tab, { status: 0, at: 1 });
    applyPaneExitBadge(tab, undefined);
    expect(tab.classList.contains('tab-agent-exited')).toBe(false);
  });

  it('removes the badge when the pane comes back', () => {
    // The retraction half: a respawned pane must not keep reading "exited".
    const tab = makeTab();
    applyPaneExitBadge(tab, { status: 0, at: 1 });
    applyPaneExitBadge(tab, undefined);
    expect(badge(tab)).toBeNull();
  });

  it('is what the incremental render path calls', () => {
    expect(appJs).toContain('applyPaneExitBadge(tab, session.paneExit)');
  });
});

describe('the rich row pill of an exited session', () => {
  // The detailed sidebar and rail classify rows through `_mobileOverviewState()`,
  // which reads `status` and knows nothing about the exit, so without an override
  // the muted dot sat beside a pill saying "idle".
  const appJs = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const fn = (re: RegExp, name: string) => {
    const m = appJs.match(re)?.[0];
    if (!m) throw new Error(`${name} not found in app.js`);
    return m;
  };
  type Row = { state: string; exited: boolean; pill: string; since: { key: string; at: number } | null };
  const host = new Function(
    `${fn(/function paneExitLabel\([\s\S]*?\n\}/, 'paneExitLabel')}
    return {
      ${fn(/ {2}_sidebarRichPillLabel\(state\) \{[\s\S]*?\n {2}\}/, '_sidebarRichPillLabel')},
      ${fn(/ {2}_sidebarRichRow\(id, session\) \{[\s\S]*?\n {2}\}/, '_sidebarRichRow')},
      _mobileOverviewState(session, hooks) {
        if (hooks && hooks.has('permission_prompt')) return 'needs';
        if (hooks && hooks.has('idle_prompt')) return 'waiting';
        return session.status === 'busy' ? 'working' : 'idle';
      },
      _mobileOverviewSince(state, session) {
        return { key: state, at: session.lastActivityAt };
      },
    };`
  )() as { pendingHooks?: Map<string, Set<string>>; _sidebarRichRow: (id: string, s: unknown) => Row };

  it('says exited, measured from when the exit was observed', () => {
    const row = host._sidebarRichRow('s1', { status: 'idle', lastActivityAt: 5, paneExit: { status: 137, at: 42 } });
    expect(row.state).toBe('idle');
    expect(row.exited).toBe(true);
    expect(row.pill).toBe('exited');
    expect(row.since).toEqual({ key: 'exited', at: 42 });
  });

  it('keeps the classified state for sorting, so the home-screen order is unchanged', () => {
    const row = host._sidebarRichRow('s1', { status: 'busy', lastActivityAt: 5, paneExit: { at: 42 } });
    expect(row.state).toBe('working');
    expect(row.pill).toBe('exited');
  });

  it('lets a pending permission dialog keep its own pill', () => {
    host.pendingHooks = new Map([['s1', new Set(['permission_prompt'])]]);
    try {
      const row = host._sidebarRichRow('s1', { status: 'idle', lastActivityAt: 5, paneExit: { status: 0, at: 42 } });
      expect(row.exited).toBe(false);
      expect(row.pill).toBe('needs you');
    } finally {
      host.pendingHooks = undefined;
    }
  });

  it('reads idle for a live session', () => {
    const row = host._sidebarRichRow('s1', { status: 'idle', lastActivityAt: 5 });
    expect(row.exited).toBe(false);
    expect(row.pill).toBe('idle');
    expect(row.since).toEqual({ key: 'idle', at: 5 });
  });

  it('styles the exited pill on both rich surfaces', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');
    expect(css).toContain('html[data-sidebar-detail="rich"] .session-sidebar .tab-pill--exited');
    expect(css).toContain('.tab-rail .tab-pill--exited');
  });
});

describe('what colour the status dot ends up', () => {
  /*
   * The dot renders from `status`, which stays `idle` or `busy` for an exited
   * pane, so the mute is a CSS rule keyed on the `tab-agent-exited` class. It
   * competes with two other families of rule over the same dot, and this tree
   * has lost that competition before: the alert rules and the rich-rail state
   * rules already exclude each other by hand rather than by cascade.
   *
   * So the cascade is resolved rather than asserted from selector text. Every
   * rule in styles.css that paints `.tab-status` goes into a real document and
   * a real engine answers, which is what makes a rule moved up the file or a
   * selector given one more class fail here.
   *
   * ⚠ In styles.css the rules inside an at-rule are skipped, so the desktop
   * cases describe a wide viewport with motion allowed. mobile.css is loaded
   * separately for the phone cases, and there its @media blocks are FLATTENED
   * rather than skipped, because that file is phone-and-tablet-only and its
   * whole content sits inside them. jsdom reports a custom property
   * unresolved, so the expected values are the `var(--x)` tokens the
   * stylesheets write.
   */
  const readRules = (file: string, flattenMedia: boolean): string[] => {
    const out: string[] = [];
    postcss.parse(readFileSync(resolve(import.meta.dirname, `../src/web/public/${file}`), 'utf8')).walkRules((rule) => {
      if (!rule.selector.includes('.tab-status')) return;
      const parents: string[] = [];
      let insideAtRule = false;
      for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
        if (p.type === 'rule') parents.unshift(p.selector);
        else insideAtRule = true;
      }
      if (insideAtRule && !flattenMedia) return;
      const decls: string[] = [];
      rule.each((node) => {
        if (node.type === 'decl') decls.push(`${node.prop}: ${node.value}${node.important ? ' !important' : ''};`);
      });
      if (decls.length === 0) return;
      const selectors = rule.selectors.map((sel) => (parents.length ? `${parents.join(' ')} ${sel}` : sel));
      out.push(`${selectors.join(',')} { ${decls.join(' ')} }`);
    });
    return out;
  };

  const dotRules = readRules('styles.css', false);
  // index.html loads mobile.css after styles.css, so it goes last here too.
  const phoneRules = [...dotRules, ...readRules('mobile.css', true)];

  /** Paint the dot of one tab and read back what the cascade decided. */
  const dot = (opts: { tab: string; dotState?: string; rail?: boolean; phone?: boolean }) => {
    const railAttrs = opts.rail ? ` data-tab-orientation="vertical" data-tab-rail-detail="rich"` : '';
    const container = opts.rail ? 'tab-rail' : 'session-tabs';
    const rules = opts.phone ? phoneRules : dotRules;
    const dom = new JSDOM(
      `<!DOCTYPE html><html${railAttrs}><head><style>${rules.join('\n')}</style></head><body>` +
        `<div class="${container}"><div class="session-tab ${opts.tab}">` +
        `<span id="dot" class="tab-status ${opts.dotState ?? 'idle'}"></span></div></div></body></html>`
    );
    const style = dom.window.getComputedStyle(dom.window.document.getElementById('dot')!);
    return {
      background: style.background,
      opacity: style.opacity,
      boxShadow: style.boxShadow,
      animation: style.animation,
    };
  };

  it('finds the rules it is meant to be resolving', () => {
    // A selector rename that emptied this list would make every case below pass
    // against a stylesheet with no rules in it.
    expect(dotRules.some((rule) => rule.includes('tab-agent-exited'))).toBe(true);
    expect(dotRules.some((rule) => rule.includes('tab-alert-action'))).toBe(true);
  });

  it('mutes the dot of an exited session', () => {
    expect(dot({ tab: 'tab-agent-exited' })).toMatchObject({ background: 'var(--text-muted)', opacity: '0.5' });
  });

  it('leaves a live session green', () => {
    expect(dot({ tab: '' }).background).toBe('var(--green)');
  });

  it('keeps a pending permission dialog RED on an exited session', () => {
    // The one the maintainer asked for: the exit must not quiet an alert. A
    // board that says two things at once is a board people stop trusting, and
    // between "the agent is gone" and "this session is blocked on you", the
    // one that needs a human wins.
    expect(dot({ tab: 'tab-agent-exited tab-alert-action' }).background).toBe('var(--red)');
  });

  it('keeps a pending idle alert YELLOW on an exited session', () => {
    expect(dot({ tab: 'tab-agent-exited tab-alert-idle' }).background).toBe('var(--yellow)');
  });

  it('mutes a dot the exit caught mid-turn, and stops it pulsing', () => {
    // `.tab-status.busy` animates `pulse`, so muting the colour alone would
    // leave a grey dot breathing as if the agent were still working.
    expect(dot({ tab: 'tab-agent-exited', dotState: 'busy' })).toMatchObject({
      background: 'var(--text-muted)',
      opacity: '0.5',
      animation: 'none',
    });
  });

  it('mutes the dot on a rich tab rail too, halo included', () => {
    // The rail's own state rules are far more specific than the strip's mute
    // (measured: an exited session kept a full green dot AND the working halo),
    // so the mute carries a rail twin that must stay below them in source order.
    expect(dot({ tab: 'tab-agent-exited tab-state-working', dotState: 'busy', rail: true })).toMatchObject({
      background: 'var(--text-muted)',
      opacity: '0.5',
      boxShadow: 'none',
    });
    expect(dot({ tab: 'tab-agent-exited tab-state-idle', rail: true }).background).toBe('var(--text-muted)');
  });

  it('leaves an errored dot red, which is the state that offers a restart', () => {
    // `status: 'error'` is the PTY-exit breaker's value and the browser answers
    // it with a "restart it?" confirm, so it is a needs-you colour by the same
    // argument that protects the two alert classes. Reachable when a restart of
    // a dead pane keeps failing: the breaker trips while the pane stays dead.
    expect(dot({ tab: 'tab-agent-exited', dotState: 'error' }).background).toBe('var(--red)');
  });

  it('mutes the dot on a phone, glow and all', () => {
    // mobile.css enlarges the working dot to 9px and gives it a green glow with
    // !important, and `status` stays `busy` for a pane whose agent died
    // mid-turn — so without a phone-side rule this renders a grey dot wearing a
    // green halo beside a badge reading "exited".
    expect(dot({ tab: 'tab-agent-exited', dotState: 'busy', phone: true })).toMatchObject({
      background: 'var(--text-muted)',
      boxShadow: 'none',
    });
  });

  it('keeps an alert red on a phone as well', () => {
    expect(dot({ tab: 'tab-agent-exited tab-alert-action', dotState: 'busy', phone: true }).background).toBe(
      'var(--red)'
    );
  });

  it('finds the phone rules it is meant to be resolving', () => {
    // Same self-guard as the desktop one: if mobile.css stopped contributing
    // rules, every phone case above would pass against the desktop cascade.
    expect(phoneRules.length).toBeGreaterThan(dotRules.length);
  });

  it('still keeps an alert red on the rich tab rail', () => {
    expect(
      dot({ tab: 'tab-agent-exited tab-alert-action tab-state-working', dotState: 'busy', rail: true }).background
    ).toBe('var(--red)');
  });
});
