/**
 * @fileoverview Claude's `/resume` title belongs to Claude unless the user chose one.
 *
 * `--name` sets the prompt-box label, the `/resume` picker entry and the terminal
 * title, and a pinned title stops Claude generating its own. Pinning the
 * `w1-myapp` placeholder therefore listed every conversation of a case under the
 * same name in `/resume`. Only a manual name is pinned now (`cliPinnedName`), and
 * a rename reaches the transcript as a `custom-title` row.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { appendClaudeCustomTitle } from '../src/claude-session-title.js';

type RespawnOptionsProbe = { _buildRespawnPaneOptions(): { name?: string; cliName?: string } };

describe('Session.cliPinnedName', () => {
  it('pins nothing for a placeholder, so Claude titles the conversation itself', () => {
    const session = new Session({ workingDir: '/tmp', name: 'w1-demo' });
    expect(session.cliPinnedName).toBeUndefined();
    const options = (session as unknown as RespawnOptionsProbe)._buildRespawnPaneOptions();
    // The tab keeps its name; only the CLI flag is withheld.
    expect(options.name).toBe('w1-demo');
    expect(options.cliName).toBeUndefined();
  });

  it('pins nothing for an auto name, whose cut of the prompt Claude beats', () => {
    const session = new Session({ workingDir: '/tmp', name: 'w1-demo' });
    expect(session.applyAutoName('w1-demo: fix the login redirect')).toBe(true);
    expect(session.cliPinnedName).toBeUndefined();
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
