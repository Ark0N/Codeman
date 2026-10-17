/**
 * @fileoverview The CLI's session name is the tab's name.
 *
 * `--name` sets the prompt-box label, the `/resume` picker entry and the terminal
 * title, and a pinned title stops Claude generating its own. Every tab's name is pinned
 * (`cliPinnedName`), placeholder and auto names included, so Claude's own session list
 * matches the tab. A rename reaches the transcript as a `custom-title` row.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { appendClaudeCustomTitle } from '../src/claude-session-title.js';

type RespawnOptionsProbe = { _buildRespawnPaneOptions(): { name?: string; cliName?: string } };

describe('Session.cliPinnedName', () => {
  it('pins the placeholder name, so the CLI session matches the tab', () => {
    const session = new Session({ workingDir: '/tmp', name: 'w1-demo' });
    expect(session.cliPinnedName).toBe('w1-demo');
    const options = (session as unknown as RespawnOptionsProbe)._buildRespawnPaneOptions();
    expect(options.name).toBe('w1-demo');
    expect(options.cliName).toBe('w1-demo');
  });

  it('pins an auto name too, from the next spawn', () => {
    const session = new Session({ workingDir: '/tmp', name: 'w1-demo' });
    expect(session.applyAutoName('w1-demo: fix the login redirect')).toBe(true);
    expect(session.cliPinnedName).toBe('w1-demo: fix the login redirect');
  });

  it('pins a name the user chose, at creation or by a rename', () => {
    expect(new Session({ workingDir: '/tmp', name: 'msgtest-worker' }).cliPinnedName).toBe('msgtest-worker');

    const renamed = new Session({ workingDir: '/tmp', name: 'w1-demo' });
    renamed.name = '登录修复';
    expect(renamed.cliPinnedName).toBe('登录修复');
    expect((renamed as unknown as RespawnOptionsProbe)._buildRespawnPaneOptions().cliName).toBe('登录修复');
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
