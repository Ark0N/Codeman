/**
 * @fileoverview The graphical install's screens in the Codeman Desktop connect page, and the This
 * Mac tab's rows for the Codeman servers the app found on this Mac.
 *
 * Runs the real packages/desktop/assets/connect.html in jsdom with a fake native side:
 * `window.ipc` records what the page asks the app for, and `onNative` is what the app
 * calls. The Rust side of the same messages is pinned in packages/desktop/src/policy.rs
 * (`ipc_graphical_install_commands`), src/gui_install.rs and src/setup.rs (the `found` list:
 * `a_found_server_row_says_what_answered`), which do not build on Linux CI, so the spelling of
 * every message the page sends, and of what it reads, is asserted here.
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
  found: [],
  outcome: { kind: 'refused' },
};

let dom: JSDOM | null = null;

/** `first`: what the app says to a page that just loaded, with no look at this Mac yet. */
function open(first?: Record<string, unknown>) {
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
  native({ type: 'init', servers: [], autoConnect: false, startFullscreen: false, version: '0.1.0', ...first });
  if (!first) native({ type: 'localStatus', status: NOT_INSTALLED });
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

describe('adding a coding agent to a Mac that has Codeman', () => {
  const RUNNING = { ...NOT_INSTALLED, state: 'running', version: '1.50.0', installed: true, installComplete: true };
  const STOPPED = { ...NOT_INSTALLED, state: 'stopped', installed: true, installComplete: true };
  const AGENTS = {
    clis: [
      cli('claude', 'Claude Code', { installed: true, installable: false }),
      cli('codex', 'Codex'),
      cli('copilot', 'GitHub Copilot'),
      cli('deepseek', 'DeepSeek', { installable: false }),
    ],
  };

  function chooser(status: Record<string, unknown> = RUNNING, over: Record<string, unknown> = AGENTS) {
    const t = open();
    t.native({ type: 'localStatus', status });
    t.click('local-agents');
    t.native({ type: 'installPlan', plan: plan({ needs: { node: false, tmux: false, git: false }, ...over }) });
    return t;
  }

  function installing(status: Record<string, unknown> = RUNNING) {
    const t = chooser(status);
    t.click('wiz-next');
    t.native({ type: 'installUpdate', phase: 'agent', log: ['Installing Codex...'] });
    return t;
  }

  it('is offered whenever Codeman is here, and never when it is not', () => {
    const t = open();
    t.native({ type: 'localStatus', status: NOT_INSTALLED });
    expect(t.visible('local-agents')).toBe(false);
    for (const status of [
      RUNNING,
      STOPPED,
      { ...RUNNING, state: 'needsLogin' },
      {
        ...RUNNING,
        state: 'runningElsewhere',
        found: [{ url: 'https://127.0.0.1:4000/', version: null, state: 'certificate', isDefault: false }],
      },
    ]) {
      t.native({ type: 'localStatus', status });
      expect(t.visible('local-agents'), String(status.state)).toBe(true);
    }
  });

  it('is not offered while an install in Terminal still runs', () => {
    const t = open();
    t.native({ type: 'localStatus', status: { ...STOPPED, installRunning: true } });
    expect(t.visible('local-agents')).toBe(false);
  });

  it('asks the app for the agent route, never the install route', () => {
    const t = open();
    t.native({ type: 'localStatus', status: RUNNING });
    t.click('local-agents');
    expect(t.sentOf('agentPrepare')).toHaveLength(1);
    expect(t.sentOf('installPrepare')).toHaveLength(0);
    expect(t.$('wiz-title').textContent).toBe('Looking at this Mac');
    expect(t.visible('wiz-back')).toBe(false); // A second prepare would clear the first one's folder.
  });

  it('lists what can be added first, what is here after it, and leaves out the rest', () => {
    const t = chooser();
    expect(t.$('wiz-title').textContent).toBe('Add a coding agent');
    const rows = [...t.$('wiz-agents').querySelectorAll('label')];
    expect(rows.map((r) => r.querySelector('b')?.textContent)).toEqual(['Codex', 'GitHub Copilot', 'Claude Code']);
    const inputs = rows.map((r) => r.querySelector('input') as HTMLInputElement);
    expect(inputs.map((i) => i.disabled)).toEqual([false, false, true]);
    expect(rows[2].textContent).toContain('Installed');
    expect(inputs[0].checked).toBe(true);
  });

  it('asks nothing about Codeman, whatever the installer says about installing it', () => {
    const t = chooser(RUNNING, { ...AGENTS, blocker: 'macOS is too old for the tmux download.' });
    expect(t.$('wiz-title').textContent).toBe('Add a coding agent');
    expect(t.visible('wiz-reach-step')).toBe(false);
    expect(t.visible('wiz-skip')).toBe(false);
    expect(t.visible('wiz-terminal')).toBe(false);
  });

  it('sends the one agent chosen, and names it on the button', () => {
    const t = chooser();
    expect(t.$('wiz-next').textContent).toBe('Install Codex');
    const copilot = t.$('wiz-agents').querySelector('input[value=copilot]') as HTMLInputElement;
    copilot.click();
    expect(t.$('wiz-next').textContent).toBe('Install GitHub Copilot');
    t.click('wiz-next');
    expect(t.sentOf('agentStart')).toEqual([{ cmd: 'agentStart', aiCli: 'copilot' }]);
    expect(t.sentOf('installStart')).toHaveLength(0);
    expect(t.$('wiz-title').textContent).toBe('Installing GitHub Copilot');
  });

  it('draws one row, for that agent', () => {
    const t = installing();
    expect(t.rail()).toEqual([['Installing Codex', 'now']]);
    expect(t.visible('wiz-cancel')).toBe(true);
  });

  it('ends on what happened, and opens Codeman only when asked', () => {
    const t = installing();
    t.native({ type: 'installFinished', ok: true, cancelled: false, error: null, log: [] });
    expect(t.$('wiz-title').textContent).toBe('Codex is installed');
    expect(t.$('wiz-lead').textContent).toContain('reload it, or give it a few minutes');
    expect(t.rail()).toEqual([['Installing Codex', 'done']]);
    expect(t.sentOf('localStatus').length).toBeGreaterThan(0);
    expect(t.sentOf('connect')).toHaveLength(0);
    t.native({ type: 'localStatus', status: RUNNING });
    expect(t.$('wiz-title').textContent).toBe('Codex is installed');
    expect(t.$('wiz-next').textContent).toBe('Open Codeman');
    expect(t.$('wiz-back').textContent).toBe('Done');
    t.click('wiz-next');
    expect(t.sentOf('connect')).toEqual([expect.objectContaining({ url: RUNNING.url })]);
    expect(t.visible('wizard')).toBe(false);
  });

  it('has nothing to open when Codeman is stopped, and Done goes back to This Mac', () => {
    const t = installing(STOPPED);
    t.native({ type: 'installFinished', ok: true, cancelled: false, error: null, log: [] });
    t.native({ type: 'localStatus', status: STOPPED });
    expect(t.visible('wiz-next')).toBe(false);
    t.click('wiz-back');
    expect(t.visible('wizard')).toBe(false);
    expect(t.visible('local-start')).toBe(true);
    expect(t.visible('local-agents')).toBe(true);
  });

  it('offers another only when there is another, and asks the installer again', () => {
    const t = installing();
    t.native({ type: 'installFinished', ok: true, cancelled: false, error: null, log: [] });
    expect(t.$('wiz-skip').textContent).toBe('Add another');
    t.click('wiz-skip');
    expect(t.sentOf('agentPrepare')).toHaveLength(2);
    expect(t.$('wiz-title').textContent).toBe('Looking at this Mac');

    const last = chooser(RUNNING, { clis: [cli('codex', 'Codex')] });
    last.click('wiz-next');
    last.native({ type: 'installFinished', ok: true, cancelled: false, error: null, log: [] });
    expect(last.visible('wiz-skip')).toBe(false);
  });

  it('says so when there is nothing left to add', () => {
    const t = chooser(RUNNING, { clis: [cli('claude', 'Claude Code', { installed: true, installable: false })] });
    expect(t.$('wiz-lead').textContent).toContain('already on this Mac');
    expect(t.visible('wiz-next')).toBe(false);
    expect(t.visible('wiz-back')).toBe(true);
    t.click('wiz-back');
    expect(t.visible('wizard')).toBe(false);
  });

  it('a failure shows the reason, and Try again asks again with the same choice', () => {
    const t = chooser();
    (t.$('wiz-agents').querySelector('input[value=copilot]') as HTMLInputElement).click();
    t.click('wiz-next');
    t.native({
      type: 'installFinished',
      ok: false,
      cancelled: false,
      error: 'GitHub Copilot did not install.',
      log: ['npm ERR! nope'],
    });
    expect(t.$('wiz-title').textContent).toBe('The install stopped');
    expect(t.$('wiz-message').textContent).toBe('GitHub Copilot did not install.');
    expect(t.$('wiz-log').textContent).toContain('npm ERR! nope');
    expect(t.visible('wiz-terminal')).toBe(false);
    expect(t.visible('wiz-back')).toBe(true);
    t.click('wiz-next');
    expect(t.sentOf('agentPrepare')).toHaveLength(2);
    t.native({ type: 'installPlan', plan: plan(AGENTS) });
    expect(t.$('wiz-next').textContent).toBe('Install GitHub Copilot');
  });

  it('a list it could not get says so, with no Terminal route to Codeman', () => {
    const t = open();
    t.native({ type: 'localStatus', status: RUNNING });
    t.click('local-agents');
    t.native({ type: 'installPrepareFailed', message: 'No network.' });
    expect(t.$('wiz-title').textContent).toBe('Could not get the list of coding agents');
    expect(t.$('wiz-message').textContent).toBe('No network.');
    expect(t.visible('wiz-terminal')).toBe(false);
    t.click('wiz-next');
    expect(t.sentOf('agentPrepare')).toHaveLength(2);
  });

  it('Cancel goes through the same command and leaves This Mac as it was', () => {
    const t = installing();
    t.click('wiz-cancel');
    expect(t.sentOf('installCancel')).toHaveLength(1);
    t.native({ type: 'installFinished', ok: false, cancelled: true, error: null, log: [] });
    expect(t.visible('wizard')).toBe(false);
    expect(t.$('status-text').textContent).toContain('Stopped installing Codex.');
  });

  it('is picked up after the app was reopened, as an agent run and never as an install', () => {
    const t = open();
    t.native({ type: 'localStatus', status: { ...RUNNING, agentInstallInApp: true } });
    expect(t.sentOf('agentAttach')).toHaveLength(1);
    expect(t.sentOf('installAttach')).toHaveLength(0);
    expect(t.$('wiz-title').textContent).toBe('Installing a coding agent');
    t.native({ type: 'installUpdate', phase: 'agent', log: [] });
    expect(t.rail()).toEqual([['Installing a coding agent', 'now']]);
    t.native({ type: 'installFinished', ok: true, cancelled: false, error: null, log: [] });
    expect(t.$('wiz-title').textContent).toBe('The coding agent is installed');
  });
});

describe('the menu item that adds a coding agent', () => {
  const RUNNING = { ...NOT_INSTALLED, state: 'running', version: '1.50.0', installed: true, installComplete: true };

  it('opens the chooser on a page that is up', () => {
    const t = open();
    t.native({ type: 'localStatus', status: RUNNING });
    t.native({ type: 'addAgent' });
    expect(t.sentOf('agentPrepare')).toHaveLength(1);
  });

  it('waits for the first look when it left a Codeman page to get here', () => {
    const t = open({ servers: [{ url: 'http://example.org:3000/' }], addAgent: true });
    expect(t.sentOf('agentPrepare')).toHaveLength(0);
    t.native({ type: 'localStatus', status: RUNNING });
    expect(t.sentOf('agentPrepare')).toHaveLength(1);
    expect(t.$('tab-local').getAttribute('aria-selected')).toBe('true');
  });

  it('leaves a Mac without Codeman on This Mac, with Install', () => {
    const t = open({ addAgent: true });
    t.native({ type: 'localStatus', status: NOT_INSTALLED });
    expect(t.sentOf('agentPrepare')).toHaveLength(0);
    expect(t.visible('wizard')).toBe(false);
    expect(t.visible('local-install')).toBe(true);
  });

  it('never replaces a run on screen', () => {
    const t = open();
    t.native({ type: 'localStatus', status: { ...RUNNING, agentInstallInApp: true } });
    t.native({ type: 'addAgent' });
    expect(t.sentOf('agentPrepare')).toHaveLength(0);
  });
});

describe('after Skip for now', () => {
  function skipped() {
    const t = open();
    t.native({ type: 'localStatus', status: NOT_INSTALLED });
    t.click('local-install');
    t.native({ type: 'installPlan', plan: plan() });
    t.click('wiz-skip');
    t.click('wiz-next');
    t.native({ type: 'installFinished', ok: true, cancelled: false, error: null, log: [] });
    t.native({
      type: 'localStatus',
      status: { ...NOT_INSTALLED, state: 'running', installed: true, version: '1.50.0' },
    });
    return t;
  }

  it('stops at Codeman being ready instead of opening it with nothing to run', () => {
    const t = skipped();
    expect(t.$('wiz-title').textContent).toBe('Codeman is ready');
    expect(t.$('wiz-lead').textContent).toContain('no coding agent');
    expect(t.sentOf('connect')).toHaveLength(0);
  });

  it('Open Codeman opens it anyway', () => {
    const t = skipped();
    t.click('wiz-next');
    expect(t.sentOf('connect')).toHaveLength(1);
  });

  it('Add a coding agent goes to the chooser', () => {
    const t = skipped();
    expect(t.$('wiz-skip').textContent).toBe('Add a coding agent');
    t.click('wiz-skip');
    expect(t.sentOf('agentPrepare')).toHaveLength(1);
  });

  it('an install that got an agent still opens Codeman by itself', () => {
    const t = open();
    t.native({ type: 'localStatus', status: NOT_INSTALLED });
    t.click('local-install');
    t.native({ type: 'installPlan', plan: plan() });
    t.click('wiz-next');
    t.click('wiz-next');
    t.native({ type: 'installFinished', ok: true, cancelled: false, error: null, log: [] });
    t.native({
      type: 'localStatus',
      status: { ...NOT_INSTALLED, state: 'running', installed: true, version: '1.50.0' },
    });
    expect(t.sentOf('connect')).toHaveLength(1);
  });
});

describe('Codeman servers found on this Mac', () => {
  type Found = { url: string; version: string | null; state: string; isDefault: boolean };
  const found = (url: string, state = 'running', version: string | null = '1.49.0'): Found => ({
    url,
    version: state === 'running' ? version : null,
    state,
    isDefault: false,
  });
  const ELSEWHERE = {
    ...NOT_INSTALLED,
    state: 'runningElsewhere',
    installed: true,
    installComplete: true,
    found: [found('http://127.0.0.1:4000/'), found('http://192.168.1.5:5000/cm/', 'needsLogin')],
  };
  const RUNNING = {
    ...NOT_INSTALLED,
    state: 'running',
    version: '1.49.0',
    installed: true,
    installComplete: true,
    outcome: { kind: 'ok', version: '1.49.0' },
    found: [{ ...found('http://127.0.0.1:3000/'), isDefault: true }],
  };

  function at(status: Record<string, unknown>, first?: Record<string, unknown>) {
    const t = open(first ?? { servers: [] });
    t.native({ type: 'localStatus', status });
    const rows = (list: string) =>
      Array.from(t.$(list).querySelectorAll('.found')).map((row) => ({
        address: row.querySelector('b')?.textContent,
        note: row.querySelector('small')?.textContent ?? '',
        button: row.querySelector('button'),
      }));
    return { ...t, rows };
  }

  it('recommends the server that runs at another address, a row each, with no trip to the other tab', () => {
    const t = at(ELSEWHERE);
    expect(t.$('local-title').textContent).toBe('Codeman is already running on this Mac.');
    expect(t.$('local-detail').textContent).toBe('');
    const rows = t.rows('local-found');
    expect(rows.map((r) => [r.address, r.note])).toEqual([
      ['http://127.0.0.1:4000/', 'version 1.49.0'],
      ['http://192.168.1.5:5000/cm/', 'Asks for a login.'],
    ]);
    expect(rows.map((r) => r.button?.textContent)).toEqual(['Connect', 'Connect']);
    // The first row the app can open is the tab's main action.
    expect(rows.map((r) => r.button?.className)).toEqual(['primary', 'secondary']);
    expect(rows[0].button?.getAttribute('aria-label')).toBe('Connect to http://127.0.0.1:4000/');
    expect(t.visible('local-found-note')).toBe(true);
    expect(t.$('local-found-note').textContent).toBe('Starting another server here would take over its sessions.');
    expect(t.$('pane-local').textContent).not.toContain('Another machine');
    expect(t.visible('local-check')).toBe(true);
    for (const id of ['local-open', 'local-start', 'local-install', 'local-also']) {
      expect(t.visible(id), id).toBe(false);
    }
    expect(t.$('local-dot').className).toBe('dot ok');
    // Finding a server connects to nothing by itself.
    expect(t.sentOf('connect')).toHaveLength(0);
  });

  it('Connect is the connect of an address typed under Another machine', () => {
    const t = at(ELSEWHERE);
    t.rows('local-found')[1].button!.click();
    expect(t.sentOf('connect')).toEqual([{ cmd: 'connect', url: 'http://192.168.1.5:5000/cm/', remember: true }]);
    expect(t.input('url').value).toBe('http://192.168.1.5:5000/cm/');
    expect(t.$('status-text').textContent).toContain('Connecting to http://192.168.1.5:5000/cm/');
    // One request at a time, as everywhere on the page.
    expect(t.rows('local-found').every((r) => r.button!.disabled)).toBe(true);
    t.rows('local-found')[0].button!.click();
    expect(t.sentOf('connect')).toHaveLength(1);
  });

  it('uses the login saved for that server, and never the one of the server shown before', () => {
    const servers = [
      { url: 'https://box.ts.net/', username: 'other', hasSavedPassword: true },
      { url: 'http://127.0.0.1:4000/', username: 'kay', hasSavedPassword: true },
    ];
    const t = at(ELSEWHERE, { servers });
    t.click('tab-local');
    t.rows('local-found')[0].button!.click();
    expect(t.sentOf('connect')).toEqual([
      { cmd: 'connect', url: 'http://127.0.0.1:4000/', remember: true, username: 'kay' },
    ]);
    const u = at(ELSEWHERE, { servers: servers.slice(0, 1) });
    u.click('tab-local');
    u.rows('local-found')[0].button!.click();
    expect(u.sentOf('connect')).toEqual([{ cmd: 'connect', url: 'http://127.0.0.1:4000/', remember: true }]);
  });

  it('a server that asks for a login gets the login fields, as any connect does', () => {
    const t = at(ELSEWHERE);
    t.rows('local-found')[1].button!.click();
    t.native({
      type: 'probeResult',
      url: 'http://192.168.1.5:5000/cm/',
      outcome: { kind: 'needsLogin' },
      canStart: false,
    });
    expect(t.$('tab-remote').getAttribute('aria-selected')).toBe('true');
    expect(t.visible('login')).toBe(true);
    expect(t.input('url').value).toBe('http://192.168.1.5:5000/cm/');
  });

  it('says why instead of offering Connect for a server the app cannot open', () => {
    const t = at({
      ...ELSEWHERE,
      found: [
        found('https://127.0.0.1:4000/', 'certificate'),
        found('https://192.168.1.5:4100/', 'certificate'),
        found('http://[::1]:5000/', 'unreachable'),
        found('http://127.0.0.1:6000/'),
      ],
    });
    const rows = t.rows('local-found');
    expect(rows.map((r) => !!r.button)).toEqual([false, false, false, true]);
    // The wording of a stopped Codeman that is set up with HTTPS.
    const https =
      'It is set up with HTTPS (codeman web --https), whose self-signed certificate this app refuses. Run it without --https to open it here.';
    expect(rows.slice(0, 2).map((r) => r.note)).toEqual([https, https]);
    expect(rows[2].note).toBe('It does not answer at this address.');
    const stopped = at({ ...NOT_INSTALLED, state: 'stopped', installed: true, url: 'https://127.0.0.1:3000/' });
    expect(stopped.$('local-detail').textContent).toBe(https);
    // The first one it can open is still the main action.
    expect(rows[3].button?.className).toBe('primary');
    expect(t.$('local-dot').className).toBe('dot ok');
  });

  it('with no server it can open, offers no Connect and keeps Check again', () => {
    const t = at({ ...ELSEWHERE, found: [found('https://127.0.0.1:4000/', 'certificate')] });
    expect(t.$('pane-local').querySelectorAll('.found button')).toHaveLength(0);
    expect(t.$('local-dot').className).toBe('dot warn');
    expect(t.visible('local-found-note')).toBe(true);
    expect(t.visible('local-check')).toBe(true);
    t.click('local-check');
    expect(t.sentOf('localStatus').at(-1)).toEqual({ cmd: 'localStatus', quick: false, deep: true });
  });

  it('a server process with no address to try still says what to do', () => {
    const t = at({ ...ELSEWHERE, found: [] });
    expect(t.$('local-title').textContent).toBe('Codeman is already running on this Mac.');
    expect(t.$('local-detail').textContent).toContain('could not find the address it listens at');
    expect(t.$('local-detail').textContent).toContain('take over its sessions');
    expect(t.visible('local-found')).toBe(false);
    expect(t.visible('local-found-note')).toBe(false);
    // A status from before the list existed reads the same.
    const old = at({ ...ELSEWHERE, found: undefined });
    expect(old.$('local-detail').textContent).toContain('could not find the address it listens at');
  });

  it('keeps Open for the Codeman that answers, and lists the others under it', () => {
    const t = at({
      ...RUNNING,
      found: [
        ...RUNNING.found,
        found('http://127.0.0.1:5000/', 'running', '1.50.0-beta'),
        found('https://127.0.0.1:6000/', 'certificate'),
      ],
    });
    expect(t.$('local-title').textContent).toBe('Codeman is running on this Mac.');
    expect(t.$('local-detail').textContent).toBe('http://127.0.0.1:3000/  ·  version 1.49.0');
    expect(t.visible('local-open')).toBe(true);
    expect(t.visible('local-also')).toBe(true);
    expect(t.$('local-also-head').textContent).toBe('Also running on this Mac');
    const rows = t.rows('local-also-list');
    // Not the one the first line is about.
    expect(rows.map((r) => [r.address, r.note.slice(0, 19)])).toEqual([
      ['http://127.0.0.1:5000/', 'version 1.50.0-beta'],
      ['https://127.0.0.1:6000/', 'It is set up with H'],
    ]);
    // Open stays the main action: a row's Connect is never the primary one here.
    expect(rows.map((r) => r.button?.className)).toEqual(['secondary', undefined]);
    expect(t.visible('local-found')).toBe(false);
    expect(t.visible('local-found-note')).toBe(false);
    rows[0].button!.click();
    expect(t.sentOf('connect')).toEqual([{ cmd: 'connect', url: 'http://127.0.0.1:5000/', remember: true }]);
  });

  it('lists them beside a Codeman that asks for a login, and beside something else on its port', () => {
    const other = found('http://127.0.0.1:5000/');
    const login = at({ ...RUNNING, state: 'needsLogin', outcome: { kind: 'needsLogin' }, found: [other] });
    expect(login.visible('local-open')).toBe(true);
    expect(login.rows('local-also-list').map((r) => r.address)).toEqual(['http://127.0.0.1:5000/']);

    const taken = { ...RUNNING, state: 'other', version: null, outcome: { kind: 'notCodeman', status: 404 } };
    const t = at({ ...taken, found: [other] });
    expect(t.$('local-title').textContent).toBe('Something else answers at http://127.0.0.1:3000/');
    expect(t.$('local-detail').textContent).toContain('or connect to the Codeman listed below.');
    expect(t.rows('local-also-list').map((r) => r.button?.textContent)).toEqual(['Connect']);
    // With nothing to connect to, the old pointer stays.
    const none = at({ ...taken, found: [] });
    expect(none.$('local-detail').textContent).toContain('under Another machine');
    expect(none.visible('local-also')).toBe(false);
  });

  it('shows no list when this Mac runs only the Codeman the tab is about', () => {
    const t = at(RUNNING);
    expect(t.visible('local-also')).toBe(false);
    expect(t.$('pane-local').querySelectorAll('.found')).toHaveLength(0);
    // The rows of an earlier look go when the next one finds none.
    t.native({ type: 'localStatus', status: ELSEWHERE });
    expect(t.rows('local-found')).toHaveLength(2);
    t.native({ type: 'localStatus', status: { ...NOT_INSTALLED, state: 'stopped', installed: true } });
    expect(t.$('pane-local').querySelectorAll('.found')).toHaveLength(0);
    expect(t.visible('local-found')).toBe(false);
    expect(t.visible('local-found-note')).toBe(false);
  });

  it('shows what the app found as text, never as markup', () => {
    const hostile = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
    const t = at({
      ...ELSEWHERE,
      found: [{ url: hostile, version: '<b onclick=alert(3)>9</b>', state: 'running', isDefault: false }],
    });
    const rows = t.rows('local-found');
    expect(t.$('pane-local').querySelector('img, script, small b')).toBeNull();
    expect(rows[0].address).toBe(hostile);
    expect(rows[0].note).toBe('version <b onclick=alert(3)>9</b>');
    expect(rows[0].button?.title).toBe('Connect to ' + hostile);
    // The app gets it as it is, and refuses what is not an address (policy::normalize_server_url).
    rows[0].button!.click();
    expect(t.sentOf('connect')).toEqual([{ cmd: 'connect', url: hostile, remember: true }]);
  });

  it('holds a found address to the length the app accepts (MAX_URL_LEN in policy.rs)', () => {
    const long = 'http://127.0.0.1:4000/' + 'a'.repeat(4096);
    const t = at({ ...ELSEWHERE, found: [found(long)] });
    t.rows('local-found')[0].button!.click();
    expect(t.sentOf('connect')).toHaveLength(0);
    expect(t.$('status-text').textContent).toContain('too long');
  });

  it('looks again when the server it connected to refuses, and opens nothing by itself', () => {
    const t = at(ELSEWHERE);
    const looks = t.sentOf('localStatus').length;
    t.rows('local-found')[0].button!.click();
    t.native({ type: 'probeResult', url: 'http://127.0.0.1:4000/', outcome: { kind: 'refused' }, canStart: true });
    expect(t.$('tab-local').getAttribute('aria-selected')).toBe('true');
    expect(t.$('status-text').textContent).toContain('Nothing is answering at this address.');
    expect(t.sentOf('localStatus')).toHaveLength(looks + 1);
    // A server that then turns out to be starting is shown, not opened: the
    // one that comes up may not be the one this row was about.
    t.native({ type: 'localStatus', status: { ...ELSEWHERE, state: 'starting', found: [] } });
    t.native({ type: 'localStatus', status: RUNNING });
    expect(t.sentOf('connect')).toHaveLength(1);
    expect(t.visible('local-open')).toBe(true);
  });

  it('still opens the Codeman of the first line once it is up, after Open was refused', () => {
    const t = at(RUNNING);
    t.click('local-open');
    t.native({ type: 'probeResult', url: RUNNING.url, outcome: { kind: 'refused' }, canStart: true });
    t.native({ type: 'localStatus', status: { ...RUNNING, state: 'starting', found: [] } });
    t.native({ type: 'localStatus', status: RUNNING });
    expect(t.sentOf('connect').map((m) => m.url)).toEqual([RUNNING.url, RUNNING.url]);
  });
});
