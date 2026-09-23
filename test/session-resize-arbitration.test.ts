import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';

/** Must exceed Session.DESKTOP_CLAIM_IDLE_MS (90s) */
const PAST_IDLE_MS = 91_000;

type ResizeableSessionInternals = {
  ptyProcess: { resize: (cols: number, rows: number) => void };
  _ptyCols: number;
  _ptyRows: number;
};

function attachFakePty(session: Session, cols = 160, rows = 48) {
  const resize = vi.fn();
  const internals = session as unknown as ResizeableSessionInternals;
  internals.ptyProcess = { resize };
  internals._ptyCols = cols;
  internals._ptyRows = rows;
  return resize;
}

describe('Session.ptyGeometry', () => {
  // ⚠️ `resize()` writes `_ptyCols`/`_ptyRows` only when `ptyProcess` is set,
  // and nothing seeds them from the spawn geometry — so the fields hold the
  // constructor defaults of 120x40 for any session whose pane is not running.
  // Reporting those to a client made it adopt a width no process had ever been
  // told, and on anything narrower than 120 columns claim another device owned
  // the pane when none existed (issue #464).
  it('reports nothing for a session that has no pane', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    expect(session.ptyGeometry).toBeNull();
  });

  it('still reports nothing after a resize it could not apply', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    session.resize(45, 20, { viewportType: 'mobile' });
    // The resize was swallowed (no pty to resize), so there is no geometry to
    // report — NOT the 120x40 the fields still hold.
    expect(session.ptyGeometry).toBeNull();
  });

  it('reports the pane geometry once a pane exists, and follows a resize', () => {
    // The contrast, so "always null" would fail this.
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    attachFakePty(session, 160, 48);
    expect(session.ptyGeometry).toEqual({ cols: 160, rows: 48 });

    session.resize(62, 40, { viewportType: 'mobile' });
    expect(session.ptyGeometry).toEqual({ cols: 62, rows: 40 });
  });
});

describe('Session resize arbitration', () => {
  it('lets a mobile-only session shrink below the spawn default (no desktop connected)', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.resize(48, 28, { viewportType: 'mobile' });

    expect(resize).toHaveBeenCalledWith(48, 28);
  });

  it('lets a mobile-only session shrink rows only', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.resize(160, 28, { viewportType: 'mobile' });

    expect(resize).toHaveBeenCalledWith(160, 28);
  });

  it('lets a mobile-only session re-grow after shrinking', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.resize(48, 28, { viewportType: 'mobile' });
    session.resize(80, 36, { viewportType: 'tablet' });

    expect(resize).toHaveBeenNthCalledWith(1, 48, 28);
    expect(resize).toHaveBeenNthCalledWith(2, 80, 36);
  });

  it('ignores mobile resizes while a desktop connection holds a sizing claim', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);
    const desktop = Symbol('desktop-conn');

    session.claimDesktopSizing(desktop);
    session.resize(48, 28, { viewportType: 'mobile' });
    // Grow is ignored too — it would reflow the desktop view just the same.
    session.resize(200, 60, { viewportType: 'tablet' });

    expect(resize).not.toHaveBeenCalled();
  });

  it('always applies desktop resizes, claim or not', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.claimDesktopSizing(Symbol('desktop-conn'));
    session.resize(120, 40, { viewportType: 'desktop' });

    expect(resize).toHaveBeenCalledWith(120, 40);
  });

  it('restores mobile control once the desktop claim is released', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);
    const desktop = Symbol('desktop-conn');

    session.claimDesktopSizing(desktop);
    session.resize(48, 28, { viewportType: 'mobile' });
    expect(resize).not.toHaveBeenCalled();

    session.releaseDesktopSizing(desktop);
    session.resize(48, 28, { viewportType: 'mobile' });
    expect(resize).toHaveBeenCalledWith(48, 28);
  });

  it('keeps ignoring mobile resizes until every desktop claim is released', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);
    const desktopA = Symbol('desktop-a');
    const desktopB = Symbol('desktop-b');

    session.claimDesktopSizing(desktopA);
    session.claimDesktopSizing(desktopB);
    session.releaseDesktopSizing(desktopA);
    session.resize(48, 28, { viewportType: 'mobile' });
    expect(resize).not.toHaveBeenCalled();

    session.releaseDesktopSizing(desktopB);
    session.resize(48, 28, { viewportType: 'mobile' });
    expect(resize).toHaveBeenCalledWith(48, 28);
  });

  it('applies untyped (legacy/API) resizes regardless of claims', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.claimDesktopSizing(Symbol('desktop-conn'));
    session.resize(100, 30);

    expect(resize).toHaveBeenCalledWith(100, 30);
  });

  it('applies forced resizes even when the dimensions did not change', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 120, 40);

    session.resize(120, 40, { force: true });

    expect(resize).toHaveBeenCalledWith(120, 40);
  });

  describe('idle-desktop override (whoever is active wins)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('lets a mobile client take the pane once the desktop claim goes idle', () => {
      vi.useFakeTimers();
      const session = new Session({ workingDir: '/tmp', mode: 'shell' });
      const resize = attachFakePty(session, 160, 48);

      session.claimDesktopSizing(Symbol('desktop-conn'));
      session.resize(48, 28, { viewportType: 'mobile' });
      expect(resize).not.toHaveBeenCalled(); // fresh claim → ignored

      vi.advanceTimersByTime(PAST_IDLE_MS);
      session.resize(48, 28, { viewportType: 'mobile' });
      expect(resize).toHaveBeenCalledWith(48, 28); // idle desktop → applied
    });

    it('keeps blocking mobile while the desktop stays active via typed input', () => {
      vi.useFakeTimers();
      const session = new Session({ workingDir: '/tmp', mode: 'shell' });
      const resize = attachFakePty(session, 160, 48);

      session.claimDesktopSizing(Symbol('desktop-conn'));
      vi.advanceTimersByTime(PAST_IDLE_MS - 10_000);
      session.noteDesktopActivity(); // user typed on desktop
      vi.advanceTimersByTime(20_000); // idle since claim, but not since input

      session.resize(48, 28, { viewportType: 'mobile' });
      expect(resize).not.toHaveBeenCalled();
    });

    it('re-asserts the desktop layout on desktop input after a mobile override', () => {
      vi.useFakeTimers();
      const session = new Session({ workingDir: '/tmp', mode: 'shell' });
      const resize = attachFakePty(session, 160, 48);

      session.resize(208, 45, { viewportType: 'desktop' }); // desktop sizes the pane
      session.claimDesktopSizing(Symbol('desktop-conn'));
      vi.advanceTimersByTime(PAST_IDLE_MS);

      session.resize(48, 28, { viewportType: 'mobile' }); // phone takes over
      expect(resize).toHaveBeenLastCalledWith(48, 28);

      session.noteDesktopActivity(); // desktop user types again
      expect(resize).toHaveBeenLastCalledWith(208, 45); // layout restored
    });

    it('does not re-assert when no mobile override happened', () => {
      const session = new Session({ workingDir: '/tmp', mode: 'shell' });
      const resize = attachFakePty(session, 160, 48);

      session.resize(208, 45, { viewportType: 'desktop' });
      resize.mockClear();
      session.noteDesktopActivity();
      expect(resize).not.toHaveBeenCalled();
    });
  });
});
