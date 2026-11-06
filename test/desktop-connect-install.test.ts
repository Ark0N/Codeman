/**
 * @fileoverview The graphical install's screens in the Codeman Desktop connect page.
 *
 * Runs the real packages/desktop/assets/connect.html in jsdom with a fake native side:
 * `window.ipc` records what the page asks the app for, and `onNative` is what the app
 * calls. The Rust side of the same messages is pinned in packages/desktop/src/policy.rs
 * (`ipc_graphical_install_commands`) and src/gui_install.rs, which do not build on Linux
 * CI, so the spelling of every message the page sends is asserted here.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HTML = readFileSync(resolve(import.meta.dirname, '../packages/desktop/assets/connect.html'), 'utf8');

type Sent = { cmd: string; [key: string]: unknown };
type Cli = { id: string; label: string; installed: boolean; installable: boolean; docs: string };

const cli = (id: string, label: string, over: Partial<Cli> = {}): Cli => ({
  id,
  label,
  installed: false,
  installable: true,
  docs: `https://example.org/${id}`,
  ...over,
});

const plan = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  os: 'macos',
  arch: 'arm64',
  blocker: '',
  needs: { node: true, tmux: true, git: false },
  clis: [cli('claude', 'Claude Code'), cli('codex', 'Codex'), cli('deepseek', 'DeepSeek', { installable: false })],
  ...over,
});

const NOT_INSTALLED = {
  url: 'http://127.0.0.1:3000/',
  state: 'notInstalled',
  installed: false,
  installComplete: false,
  installRunning: false,
  installInApp: false,
  elsewhere: [],
  outcome: { kind: 'refused' },
};

let dom: JSDOM | null = null;

function open() {
  const sent: Sent[] = [];
  dom = new JSDOM(HTML, {
    url: 'codemanapp://localhost/index.html',
    runScripts: 'dangerously',
    beforeParse(window) {
      (window as unknown as { ipc: unknown }).ipc = { postMessage: (m: string) => sent.push(JSON.parse(m)) };
    },
  });
  const window = dom.window as unknown as Window & {
    __codemanDesktop: { onNative(m: unknown): void };
  };
  const doc = window.document;
  const $ = (id: string) => doc.getElementById(id) as HTMLElement;
  const input = (id: string) => $(id) as HTMLInputElement;
  const native = (m: unknown) => window.__codemanDesktop.onNative(m);
  const click = (id: string) => $(id).click();
  const visible = (id: string) => {
    const el = $(id);
    if (el.hidden) return false;
    for (let p = el.parentElement; p; p = p.parentElement) if (p.hidden) return false;
    return true;
  };
  const rail = () =>
    Array.from(doc.querySelectorAll('#wiz-rail li')).map((li) => [li.querySelector('span')?.textContent, li.className]);
  const sentOf = (cmd: string) => sent.filter((m) => m.cmd === cmd);
  native({ type: 'init', servers: [], autoConnect: false, startFullscreen: false, version: '0.1.0' });
  native({ type: 'localStatus', status: NOT_INSTALLED });
  return { sent, sentOf, doc, $, input, native, click, visible, rail };
}

/** Open the wizard and answer its first question with `p`. */
function toPlan(p = plan()) {
  const t = open();
  t.click('local-install');
  t.native({ type: 'installPlan', plan: p });
  return t;
}

afterEach(() => {
  dom?.window.close();
  dom = null;
});

describe('starting the graphical install', () => {
  it('asks the app for the installer instead of opening Terminal', () => {
    const t = open();
    t.click('local-install');
    expect(t.sentOf('installPrepare')).toHaveLength(1);
    expect(t.sentOf('installLocal')).toHaveLength(0);
    expect(t.$('wiz-title').textContent).toBe('Looking at this Mac');
    expect(t.visible('wizard')).toBe(true);
  });

  it('hands the whole card to the install', () => {
    const t = open();
    t.click('local-install');
    expect(t.doc.querySelector('.card')?.classList.contains('wizard-on')).toBe(true);
  });

  it('goes back to the tabs from any question', () => {
    const t = toPlan();
    t.click('wiz-back');
    expect(t.visible('wizard')).toBe(false);
    expect(t.doc.querySelector('.card')?.classList.contains('wizard-on')).toBe(false);
  });

  it('offers no way out while preparing, so two prepares never share the folder', () => {
    const t = open();
    t.click('local-install');
    expect(t.visible('wiz-back')).toBe(false);
    expect(t.visible('wiz-next')).toBe(false);
  });

  it('explains a failed download and offers Try again and Terminal', () => {
    const t = open();
    t.click('local-install');
    t.native({ type: 'installPrepareFailed', message: 'Could not download the installer.' });
    expect(t.$('wiz-message').textContent).toBe('Could not download the installer.');
    expect(t.visible('wiz-terminal')).toBe(true);
    t.click('wiz-next');
    expect(t.sentOf('installPrepare')).toHaveLength(2);
  });
});

describe('choosing a coding agent', () => {
  it('asks when this Mac has none, listing what the installer can install, first one chosen', () => {
    const t = toPlan();
    expect(t.$('wiz-title').textContent).toBe('Choose a coding agent');
    const radios = Array.from(t.doc.querySelectorAll<HTMLInputElement>('#wiz-agents input'));
    expect(radios.map((r) => r.value)).toEqual(['claude', 'codex']);
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
  });

  it('does not ask when one is already there, and names it instead', () => {
    const t = toPlan(
      plan({ clis: [cli('claude', 'Claude Code', { installed: true, installable: false }), cli('codex', 'Codex')] })
    );
    expect(t.$('wiz-title').textContent).toBe('Who can reach Codeman?');
    expect(t.$('wiz-summary').textContent).toContain('Uses Claude Code, already on this Mac');
    t.click('wiz-back');
    expect(t.visible('wizard')).toBe(false);
  });

  it('sends no agent then, so the installer never adds one', () => {
    const t = toPlan(
      plan({ clis: [cli('claude', 'Claude Code', { installed: true, installable: false }), cli('codex', 'Codex')] })
    );
    t.click('wiz-next');
    expect(t.sentOf('installStart')[0].aiCli).toBeUndefined();
  });

  it('skips the question when nothing can be installed', () => {
    const t = toPlan(plan({ clis: [cli('deepseek', 'DeepSeek', { installable: false })] }));
    expect(t.$('wiz-title').textContent).toBe('Who can reach Codeman?');
    expect(t.$('wiz-summary').textContent).toContain('No coding agent yet');
  });

  it('installs the one that was picked', () => {
    const t = toPlan();
    const codex = t.doc.querySelector<HTMLInputElement>('#wiz-agents input[value=codex]')!;
    codex.click();
    expect(t.$('wiz-agent-note').textContent).toContain('You sign in to Codex');
    t.click('wiz-next');
    expect(t.$('wiz-summary').textContent).toContain('Installs Codex');
    t.click('wiz-next');
    expect(t.sentOf('installStart')).toEqual([{ cmd: 'installStart', aiCli: 'codex' }]);
  });

  it('Skip for now installs none, and says what that means', () => {
    const t = toPlan();
    t.click('wiz-skip');
    expect(t.$('wiz-summary').textContent).toContain('No coding agent yet');
    t.click('wiz-next');
    expect(t.sentOf('installStart')).toEqual([{ cmd: 'installStart' }]);
  });

  it('Back from the next question returns to the choice, and keeps it', () => {
    const t = toPlan();
    t.doc.querySelector<HTMLInputElement>('#wiz-agents input[value=codex]')!.click();
    t.click('wiz-next');
    t.click('wiz-back');
    expect(t.$('wiz-title').textContent).toBe('Choose a coding agent');
    expect(t.doc.querySelector<HTMLInputElement>('#wiz-agents input:checked')?.value).toBe('codex');
  });

  it('opens an agent docs link through the app, and only https', () => {
    const t = toPlan();
    t.doc.querySelector<HTMLAnchorElement>('#wiz-agent-note a')!.click();
    expect(t.sentOf('openExternal')).toEqual([{ cmd: 'openExternal', url: 'https://example.org/claude' }]);
    const u = toPlan(plan({ clis: [cli('x', 'X', { docs: 'javascript:alert(1)' })] }));
    expect(u.doc.querySelector('#wiz-agent-note a')).toBeNull();
  });

  it('shows a label from the installer as text, never as markup', () => {
    const t = toPlan(plan({ clis: [cli('x', '<img src=x onerror=alert(1)>')] }));
    expect(t.doc.querySelector('#wiz-agents img')).toBeNull();
    expect(t.$('wiz-agents').textContent).toContain('<img');
  });
});

describe('choosing who can reach Codeman', () => {
  const toReach = () => {
    const t = toPlan();
    t.click('wiz-next');
    return t;
  };
  const network = (t: ReturnType<typeof open>) =>
    t.doc.querySelector<HTMLInputElement>('input[name=reach][value=network]')!.click();

  it('is this Mac alone unless changed, with no password', () => {
    const t = toReach();
    expect(t.visible('wiz-password')).toBe(false);
    t.click('wiz-next');
    expect(t.sentOf('installStart')[0].networkPassword).toBeUndefined();
  });

  it('refuses the network without a password', () => {
    const t = toReach();
    network(t);
    expect(t.visible('wiz-password')).toBe(true);
    t.click('wiz-next');
    expect(t.sentOf('installStart')).toHaveLength(0);
    expect(t.$('wiz-message').textContent).toContain('Set a password');
  });

  it('refuses two different passwords', () => {
    const t = toReach();
    network(t);
    t.input('wiz-pw').value = 'one';
    t.input('wiz-pw2').value = 'two';
    t.click('wiz-next');
    expect(t.sentOf('installStart')).toHaveLength(0);
    expect(t.$('wiz-message').textContent).toContain('different');
  });

  it('sends the password once and clears the fields', () => {
    const t = toReach();
    network(t);
    t.input('wiz-pw').value = 's3cret';
    t.input('wiz-pw2').value = 's3cret';
    t.click('wiz-next');
    expect(t.sentOf('installStart')).toEqual([{ cmd: 'installStart', networkPassword: 's3cret', aiCli: 'claude' }]);
    expect(t.input('wiz-pw').value).toBe('');
    expect(t.input('wiz-pw2').value).toBe('');
  });

  it('never sends a password a person typed before going back to this Mac', () => {
    const t = toReach();
    network(t);
    t.input('wiz-pw').value = 's3cret';
    t.input('wiz-pw2').value = 's3cret';
    t.doc.querySelector<HTMLInputElement>('input[name=reach][value=local]')!.click();
    t.click('wiz-next');
    expect(t.sentOf('installStart')[0].networkPassword).toBeUndefined();
  });

  it('keeps the Terminal route, carrying the choice', () => {
    const t = toReach();
    network(t);
    t.click('wiz-terminal');
    expect(t.sentOf('installLocal')).toEqual([{ cmd: 'installLocal', network: true }]);
    expect(t.visible('wizard')).toBe(false);
  });
});

describe('when the no-admin route cannot finish here', () => {
  it('says why and sends the person to Terminal', () => {
    const t = toPlan(plan({ blocker: 'The tmux project’s build needs macOS 15 or newer.' }));
    expect(t.$('wiz-message').textContent).toContain('macOS 15');
    expect(t.$('wiz-next').textContent).toBe('Install in Terminal');
    expect(t.visible('wiz-agent-step')).toBe(false);
    t.click('wiz-next');
    expect(t.sentOf('installLocal')).toHaveLength(1);
    expect(t.sentOf('installStart')).toHaveLength(0);
  });
});

describe('following the install', () => {
  const toRun = (p = plan()) => {
    const t = toPlan(p);
    t.click('wiz-next');
    t.click('wiz-next');
    t.native({ type: 'installRunning', port: 3001 });
    return t;
  };

  it('draws only the phases this install has', () => {
    const noDownloads = toRun(plan({ needs: { node: false, tmux: false, git: false } }));
    expect(noDownloads.rail().map((r) => r[0])).toEqual([
      'Installing Claude Code',
      'Downloading Codeman',
      'Installing packages',
      'Building Codeman',
      'Starting Codeman',
    ]);
    const tmuxOnly = toRun(plan({ needs: { node: false, tmux: true, git: false } }));
    expect(tmuxOnly.rail()[0][0]).toBe('Getting tmux');
  });

  it('moves the rail along as the installer reports, and ignores a phase it does not know', () => {
    const t = toRun();
    t.native({ type: 'installUpdate', phase: 'runtime', log: [] });
    t.native({ type: 'installUpdate', phase: 'packages', log: ['==> Installing dependencies...'] });
    t.native({ type: 'installUpdate', phase: 'somethingnew', log: [] });
    expect(t.rail()).toEqual([
      ['Getting Node.js and tmux', 'done'],
      ['Installing Claude Code', 'done'],
      ['Downloading Codeman', 'done'],
      ['Installing packages', 'now'],
      ['Building Codeman', ''],
      ['Starting Codeman', ''],
    ]);
    expect(t.$('wiz-log').textContent).toContain('Installing dependencies');
    expect(t.$('wiz-clock')).not.toBeNull();
  });

  it('asks the app to cancel, once', () => {
    const t = toRun();
    t.click('wiz-cancel');
    t.click('wiz-cancel');
    expect(t.sentOf('installCancel')).toHaveLength(1);
  });

  it('a cancelled run goes back to the tabs and looks again', () => {
    const t = toRun();
    t.native({ type: 'installFinished', ok: false, cancelled: true, error: null, log: [] });
    expect(t.visible('wizard')).toBe(false);
    expect(t.sentOf('localStatus').length).toBeGreaterThan(0);
  });

  it('a failed run shows the cause on its phase, opens the output and offers Try again', () => {
    const t = toRun();
    t.native({ type: 'installUpdate', phase: 'build', log: [] });
    t.native({
      type: 'installFinished',
      ok: false,
      cancelled: false,
      error: 'Building Codeman failed (exit 1).',
      log: ['npm error'],
    });
    expect(t.$('wiz-title').textContent).toBe('The install stopped');
    expect(t.$('wiz-message').textContent).toBe('Building Codeman failed (exit 1).');
    expect(t.rail().find((r) => r[1] === 'failed')?.[0]).toBe('Building Codeman');
    expect((t.$('wiz-details') as HTMLDetailsElement).open).toBe(true);
    expect(t.$('wiz-log').textContent).toContain('npm error');
    t.click('wiz-next');
    expect(t.sentOf('installPrepare')).toHaveLength(2);
  });

  it('Try again keeps what was chosen', () => {
    const t = toPlan();
    t.doc.querySelector<HTMLInputElement>('#wiz-agents input[value=codex]')!.click();
    t.click('wiz-next');
    t.click('wiz-next');
    t.native({ type: 'installFinished', ok: false, cancelled: false, error: 'x', log: [] });
    t.click('wiz-next');
    t.native({ type: 'installPlan', plan: plan() });
    expect(t.doc.querySelector<HTMLInputElement>('#wiz-agents input:checked')?.value).toBe('codex');
  });

  it('a run with no error text still says something', () => {
    const t = toRun();
    t.native({ type: 'installFinished', ok: false, cancelled: false, error: null, log: [] });
    expect(t.$('wiz-message').textContent).toContain('without saying why');
  });

  it('a start the app refused is shown as a failure', () => {
    const t = toPlan();
    t.click('wiz-next');
    t.click('wiz-next');
    t.native({ type: 'installStartFailed', message: 'Codeman is already being installed.' });
    expect(t.$('wiz-message').textContent).toBe('Codeman is already being installed.');
  });

  it('a finished run opens Codeman at its own port, not at whatever answers on 3000', () => {
    const t = toRun();
    t.native({ type: 'installFinished', ok: true, cancelled: false, error: null, log: [] });
    expect(t.$('wiz-title').textContent).toBe('Starting Codeman');
    expect(t.rail().every((r) => r[1] === 'done')).toBe(true);
    expect(t.sentOf('localStatus').at(-1)?.quick).toBe(true);

    const running = { ...NOT_INSTALLED, state: 'running', version: '1.48.0', installed: true };
    t.native({ type: 'localStatus', status: { ...running, url: 'http://127.0.0.1:3000/' } });
    expect(t.sentOf('connect')).toHaveLength(0);
    t.native({ type: 'localStatus', status: { ...running, url: 'http://127.0.0.1:3001/' } });
    expect(t.sentOf('connect')).toEqual([expect.objectContaining({ url: 'http://127.0.0.1:3001/' })]);
    expect(t.visible('wizard')).toBe(false);
  });
});

describe('an install that was already running', () => {
  it('is picked up from the app, with no question asked', () => {
    const t = open();
    t.native({
      type: 'localStatus',
      status: { ...NOT_INSTALLED, installRunning: true, installInApp: true, installPort: 3002 },
    });
    expect(t.sentOf('installAttach')).toHaveLength(1);
    expect(t.$('wiz-title').textContent).toBe('Installing Codeman');
    expect(t.visible('wiz-cancel')).toBe(true);
  });

  it('asks only once, however many looks arrive', () => {
    const t = open();
    const status = { ...NOT_INSTALLED, installRunning: true, installInApp: true };
    t.native({ type: 'localStatus', status });
    t.native({ type: 'localStatus', status });
    expect(t.sentOf('installAttach')).toHaveLength(1);
  });

  it('draws what the installer reports, since it has no plan', () => {
    const t = open();
    t.native({ type: 'localStatus', status: { ...NOT_INSTALLED, installRunning: true, installInApp: true } });
    t.native({ type: 'installUpdate', phase: 'agent', log: [] });
    t.native({ type: 'installUpdate', phase: 'build', log: [] });
    expect(t.rail().map((r) => r[0])).toContain('Installing a coding agent');
    expect(t.rail().find((r) => r[1] === 'now')?.[0]).toBe('Building Codeman');
  });

  it('never takes a graphical install for one in Terminal', () => {
    const t = open();
    t.native({ type: 'localStatus', status: { ...NOT_INSTALLED, installRunning: true, installInApp: true } });
    expect(t.$('local-title').textContent).not.toContain('Terminal');
    expect(t.visible('local-stop')).toBe(false);
  });

  it('an install still running in Terminal keeps the old wait', () => {
    const t = open();
    t.native({ type: 'localStatus', status: { ...NOT_INSTALLED, installRunning: true, installInApp: false } });
    expect(t.sentOf('installAttach')).toHaveLength(0);
    expect(t.$('local-title').textContent).toContain('Terminal');
  });
});
