/**
 * @fileoverview The settings a user puts on a session survive a Codeman restart.
 *
 * `restoreMuxSessions()` (server.ts) rebuilds a Session around a surviving tmux pane from
 * `state.json`, and `reapplyPersistedSessionState()` does the same for a reboot restore. A
 * setting one of them forgets is silently reset on the next persist, which writes `toState()`
 * wholesale. Found live: after a restart a session came back with its name, auto-clear and
 * auto-compact but with its tab colour, pin and image watcher gone.
 *
 * `restoreMuxSessions()` cannot be reached under vitest (see test/session-model-recovery.test.ts),
 * so the wiring is pinned by a source check and the setters it relies on are driven for real.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const server = readFileSync(join(SRC, 'web', 'server.ts'), 'utf-8');

function functionBody(name: string): string {
  const start = server.indexOf(`async ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = server.indexOf('\n  /**', start);
  return server.slice(start, next === -1 ? undefined : next);
}

describe('restoreMuxSessions() hands back every persisted user setting', () => {
  const body = functionBody('restoreMuxSessions');

  it.each([
    ['name', /name:\s*sessionName/],
    ['name source', /nameSource:\s*savedState\?\.nameSource/],
    ['colour', /session\.setColor\(savedState\.color\)/],
    ['pin', /session\.restorePin\(true,\s*savedState\.pinnedAt\)/],
    ['image watcher', /session\.imageWatcherEnabled\s*=\s*savedState\.imageWatcherEnabled/],
    ['flicker filter', /session\.flickerFilterEnabled\s*=\s*savedState\.flickerFilterEnabled/],
    ['auto-clear', /session\.setAutoClear\(/],
    ['auto-compact', /session\.setAutoCompact\(/],
    ['auto-resume', /session\.restoreAutoResume\(/],
    ['nice priority', /session\.setNice\(/],
    ['git fetch', /gitFetchEnabled:\s*savedState\?\.gitFetchEnabled/],
  ])('%s', (_label, pattern) => {
    expect(body).toMatch(pattern);
  });

  it('sets the image-watcher flag before the listeners read it', () => {
    expect(body.indexOf('session.imageWatcherEnabled = savedState.imageWatcherEnabled')).toBeLessThan(
      body.indexOf('await this.setupSessionListeners(session)')
    );
  });

  it('restores everything the reboot-restore path restores', () => {
    const reapply = functionBody('reapplyPersistedSessionState');
    // Each persisted setting that path re-applies must also be re-applied here.
    for (const call of ['setColor(', 'restorePin(', 'imageWatcherEnabled =', 'flickerFilterEnabled =']) {
      expect(reapply, `reapply lacks ${call}`).toContain(call);
      expect(body, `restoreMuxSessions lacks ${call}`).toContain(call);
    }
  });

  it('re-applies the fetch choice only when the case actually chose one', () => {
    // `undefined` is what "follows the app" means here, so a restore that called the setter unconditionally
    // would hand every case the app default as if it had picked it, and the half-choice rows would read wrong.
    const reapply = functionBody('reapplyPersistedSessionState');
    expect(reapply).toMatch(
      /if \(saved\.gitFetchEnabled !== undefined \|\| saved\.gitFetchIntervalSeconds !== undefined\)[\s\S]{0,160}session\.setGitFetchSettings\(saved\.gitFetchEnabled, saved\.gitFetchIntervalSeconds\)/
    );
  });
});

describe('the setters round-trip through toState()', () => {
  it('keeps colour, pin, image watcher and name source', () => {
    const original = new Session({ workingDir: '/tmp', mode: 'shell', name: 'custom name', nameSource: 'manual' });
    original.setColor('red');
    original.setPinned(true);
    original.imageWatcherEnabled = true;
    const state = original.toState();

    const rebuilt = new Session({ workingDir: '/tmp', mode: 'shell', name: state.name, nameSource: state.nameSource });
    rebuilt.setColor(state.color!);
    rebuilt.restorePin(true, state.pinnedAt);
    rebuilt.imageWatcherEnabled = state.imageWatcherEnabled!;
    const after = rebuilt.toState();

    expect(after).toMatchObject({
      name: 'custom name',
      nameSource: 'manual',
      color: 'red',
      pinned: true,
      pinnedAt: state.pinnedAt,
      imageWatcherEnabled: true,
    });
  });

  it('round-trips the fetch choice, and keeps a case that follows the app unchosen', () => {
    const chose = new Session({ workingDir: '/tmp', mode: 'shell' });
    chose.setGitFetchSettings(true, 120);
    const state = chose.toState();
    expect(state).toMatchObject({ gitFetchEnabled: true, gitFetchIntervalSeconds: 120 });

    const rebuilt = new Session({
      workingDir: '/tmp',
      mode: 'shell',
      gitFetchEnabled: state.gitFetchEnabled,
      gitFetchIntervalSeconds: state.gitFetchIntervalSeconds,
    });
    expect(rebuilt.toState()).toMatchObject({ gitFetchEnabled: true, gitFetchIntervalSeconds: 120 });

    // Undefined is the whole meaning of "follows the app": a restore that wrote the app default into the
    // case would make it look like the case had picked it, and the row would stop following.
    const follower = new Session({ workingDir: '/tmp', mode: 'shell' });
    follower.setGitFetchSettings(undefined, undefined);
    expect(follower.toState().gitFetchEnabled).toBeUndefined();
    expect(follower.toState().gitFetchIntervalSeconds).toBeUndefined();
  });
});
