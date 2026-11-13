/**
 * @fileoverview The CLI's session name and the opt-in `pinCliSessionName` setting.
 *
 * `--name` sets the prompt-box label, the `/resume` picker entry and the terminal
 * title, and a pinned title stops Claude generating its own. By default only a name
 * the user chose is pinned (`cliPinnedName`); with `pinCliSessionName` on, every tab's
 * name is pinned, placeholder and auto names included, so Claude's own session list
 * matches the tab. The setting is re-read at each spawn and respawn. A rename reaches
 * the transcript as a `custom-title` row.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { appendClaudeCustomTitle } from '../src/claude-session-title.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';

type RespawnOptionsProbe = {
  _buildRespawnPaneOptions(): { name?: string; cliName?: string };
  _buildRespawnPaneOptionsWithResumePin(): Promise<{ name?: string; cliName?: string }>;
};

const probe = (session: Session) => session as unknown as RespawnOptionsProbe;

/** The respawn builder is the path every respawn takes; it re-reads the setting first. */
const cliNameAtRespawn = async (session: Session) =>
  (await probe(session)._buildRespawnPaneOptionsWithResumePin()).cliName;

function writeSettings(settings: Record<string, unknown> | null) {
  if (settings === null) {
    rmSync(SETTINGS_PATH, { force: true });
    return;
  }
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings));
}

describe('Session.cliPinnedName', () => {
  afterEach(() => writeSettings(null));

  describe('pinCliSessionName off (default)', () => {
    it.each([null, {}, { pinCliSessionName: false }])(
      'leaves a placeholder name unpinned (settings: %j)',
      async (settings) => {
        writeSettings(settings);
        const session = new Session({ workingDir: '/tmp', name: 'w1-demo' });
        expect(await cliNameAtRespawn(session)).toBeUndefined();
        expect(session.cliPinnedName).toBeUndefined();
        expect(probe(session)._buildRespawnPaneOptions().name).toBe('w1-demo');
      }
    );

    it('leaves an auto name unpinned', async () => {
      writeSettings({ pinCliSessionName: false });
      const session = new Session({ workingDir: '/tmp', name: 'w1-demo' });
      expect(session.applyAutoName('w1-demo: fix the login redirect')).toBe(true);
      expect(await cliNameAtRespawn(session)).toBeUndefined();
    });

    it('still pins a name the user chose, at creation or by a rename', async () => {
      writeSettings({ pinCliSessionName: false });
      expect(await cliNameAtRespawn(new Session({ workingDir: '/tmp', name: 'msgtest-worker' }))).toBe(
        'msgtest-worker'
      );

      const renamed = new Session({ workingDir: '/tmp', name: 'w1-demo' });
      renamed.name = '登录修复';
      expect(await cliNameAtRespawn(renamed)).toBe('登录修复');
    });
  });

  describe('pinCliSessionName on', () => {
    it('pins the placeholder name, so the CLI session matches the tab', async () => {
      writeSettings({ pinCliSessionName: true });
      const session = new Session({ workingDir: '/tmp', name: 'w1-demo' });
      expect(await cliNameAtRespawn(session)).toBe('w1-demo');
      expect(session.cliPinnedName).toBe('w1-demo');
    });

    it('pins an auto name too, from the next spawn', async () => {
      writeSettings({ pinCliSessionName: true });
      const session = new Session({ workingDir: '/tmp', name: 'w1-demo' });
      expect(session.applyAutoName('w1-demo: fix the login redirect')).toBe(true);
      expect(await cliNameAtRespawn(session)).toBe('w1-demo: fix the login redirect');
    });

    it('pins a name the user chose', async () => {
      writeSettings({ pinCliSessionName: true });
      const renamed = new Session({ workingDir: '/tmp', name: 'w1-demo' });
      renamed.name = '登录修复';
      expect(await cliNameAtRespawn(renamed)).toBe('登录修复');
    });

    it('never pins a blank name', async () => {
      writeSettings({ pinCliSessionName: true });
      expect(await cliNameAtRespawn(new Session({ workingDir: '/tmp', name: '   ' }))).toBeUndefined();
    });
  });

  it('follows the setting on the next respawn of the same session, with no restart', async () => {
    const session = new Session({ workingDir: '/tmp', name: 'w1-demo' });
    writeSettings({ pinCliSessionName: true });
    expect(await cliNameAtRespawn(session)).toBe('w1-demo');
    writeSettings({ pinCliSessionName: false });
    expect(await cliNameAtRespawn(session)).toBeUndefined();
  });
});

describe('appendClaudeCustomTitle', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tempTranscript = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'codeman-claude-title-'));
    dirs.push(dir);
    const path = join(dir, 'conv.jsonl');
    if (content) writeFileSync(path, content);
    return path;
  };

  it('appends one custom-title row after the existing rows', async () => {
    const path = tempTranscript('{"type":"user"}\n');
    expect(await appendClaudeCustomTitle(path, 'conv', '  release notes "v2"  ')).toBe(true);
    const lines = readFileSync(path, 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('{"type":"user"}');
    expect(JSON.parse(lines[1])).toEqual({
      type: 'custom-title',
      customTitle: 'release notes "v2"',
      sessionId: 'conv',
    });
    expect(lines[2]).toBe('');
  });

  it('never creates a transcript that does not exist yet', async () => {
    const path = tempTranscript('');
    expect(await appendClaudeCustomTitle(path, 'conv', 'title')).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it('writes nothing for a blank title', async () => {
    const path = tempTranscript('{"type":"user"}\n');
    expect(await appendClaudeCustomTitle(path, 'conv', '  ')).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('{"type":"user"}\n');
  });
});
