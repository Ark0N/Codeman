import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../src/web/public/notification-manager.js', import.meta.url), 'utf8');

type EventPreference = {
  enabled: boolean;
  browser: boolean;
  audio: boolean;
  push: boolean;
};

type NotificationPreferences = {
  enabled: boolean;
  eventTypes: Record<string, EventPreference>;
  _version: number;
};

type Manager = {
  preferences: NotificationPreferences;
  notifications: unknown[];
  getStorageKey: () => string;
  normalizePreferences: (preferences: Record<string, unknown>) => NotificationPreferences;
  notify: (notification: Record<string, unknown>) => void;
  getToastDurationMs: () => number;
  unreadCount: number;
  markAllRead: () => void;
  clearAll: () => void;
};

const openWindows: JSDOM[] = [];

function loadManager(
  saved?: Record<string, unknown>,
  device: { deviceType?: string; handheld?: boolean } = {}
): { dom: JSDOM; manager: Manager } {
  const dom = new JSDOM(
    '<!doctype html><body><span id="notifBadge"></span><div id="notifList"></div><div id="notifEmpty"></div></body>',
    {
      url: 'http://localhost/',
      runScripts: 'outside-only',
    }
  );
  openWindows.push(dom);
  const win = dom.window as unknown as Window &
    typeof globalThis & {
      MobileDetection: {
        getDeviceType: () => string;
        isHandheldDevice?: () => boolean;
      };
      STUCK_THRESHOLD_DEFAULT_MS: number;
      GROUPING_TIMEOUT_MS: number;
      NOTIFICATION_LIST_CAP: number;
      AUTO_CLOSE_NOTIFICATION_MS: number;
      DEFAULT_TOAST_DURATION_MS: number;
      MIN_NOTIFICATION_DURATION_MS: number;
      MAX_NOTIFICATION_DURATION_MS: number;
    };
  win.MobileDetection = {
    getDeviceType: () => device.deviceType ?? 'desktop',
    ...(typeof device.handheld === 'boolean' ? { isHandheldDevice: () => device.handheld === true } : {}),
  };
  win.STUCK_THRESHOLD_DEFAULT_MS = 600_000;
  win.GROUPING_TIMEOUT_MS = 5_000;
  win.NOTIFICATION_LIST_CAP = 100;
  win.AUTO_CLOSE_NOTIFICATION_MS = 8_000;
  win.DEFAULT_TOAST_DURATION_MS = 3_000;
  win.MIN_NOTIFICATION_DURATION_MS = 1_000;
  win.MAX_NOTIFICATION_DURATION_MS = 300_000;
  win.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof requestAnimationFrame;

  if (saved) {
    win.localStorage.setItem('codeman-notification-prefs', JSON.stringify(saved));
  }

  win.eval(`
    window.escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
    ${SOURCE}
    window.__testNotificationManager = NotificationManager;
  `);
  const NotificationManager = (
    win as unknown as {
      __testNotificationManager: new (app: { sessions: Map<unknown, unknown> }) => Manager;
    }
  ).__testNotificationManager;
  const manager = new NotificationManager({ sessions: new Map() }) as Manager;
  return { dom, manager };
}

afterEach(() => {
  for (const dom of openWindows.splice(0)) dom.window.close();
});

describe('notification noise defaults', () => {
  it('keeps response-complete and team lifecycle drawer entries opt-in', () => {
    const { manager } = loadManager();
    expect(manager.preferences.eventTypes.stop.enabled).toBe(false);

    for (const category of ['hook-stop', 'hook-teammate-idle', 'hook-task-completed']) {
      manager.notify({
        urgency: 'info',
        category,
        sessionId: 'session-1',
        sessionName: 'session',
        title: category,
        message: category,
      });
    }

    expect(manager.notifications).toHaveLength(0);
  });

  it('migrates the old drawer-only Stop default but preserves explicit delivery', () => {
    const quietV4 = {
      enabled: true,
      eventTypes: {
        stop: { enabled: true, browser: false, audio: false, push: false },
      },
      _version: 4,
    };
    const { manager: quietManager } = loadManager(quietV4);
    expect(quietManager.preferences.eventTypes.stop.enabled).toBe(false);
    expect(quietManager.preferences._version).toBe(5);

    const browserV4 = {
      enabled: true,
      eventTypes: {
        stop: { enabled: true, browser: true, audio: false, push: false },
      },
      _version: 4,
    };
    const { manager: browserManager } = loadManager(browserV4);
    expect(browserManager.preferences.eventTypes.stop.enabled).toBe(true);
  });

  it('normalizes server-hydrated v4 preferences through the same quiet migration', () => {
    const { manager } = loadManager();
    manager.preferences = manager.normalizePreferences({
      enabled: true,
      eventTypes: {
        stop: { enabled: true, browser: false, audio: false, push: false },
      },
      _version: 4,
    });

    expect(manager.preferences.eventTypes.stop.enabled).toBe(false);
    expect(manager.preferences._version).toBe(5);
  });

  it('keeps mobile notification defaults and storage on an unfolded handheld', () => {
    const { manager } = loadManager(undefined, {
      deviceType: 'desktop',
      handheld: true,
    });

    expect(manager.preferences.enabled).toBe(false);
    expect(manager.getStorageKey()).toBe('codeman-notification-prefs-mobile');
  });
});

describe('notification display time', () => {
  it('defaults to 3s toasts and 8s browser notifications', () => {
    const { manager } = loadManager();
    expect(manager.getToastDurationMs()).toBe(3000);
    expect((manager.preferences as unknown as Record<string, number>).browserAutoCloseMs).toBe(8000);
  });

  it('honours a configured toast time and clamps unusable values', () => {
    const { manager } = loadManager({ toastDurationMs: 15_000 });
    expect(manager.getToastDurationMs()).toBe(15_000);

    const clamp = (value: unknown) =>
      (manager.normalizePreferences({ toastDurationMs: value }) as unknown as Record<string, number>).toastDurationMs;
    expect(clamp(10)).toBe(1000);
    expect(clamp(9_999_999)).toBe(300_000);
    expect(clamp('soon')).toBe(3000);
    expect(clamp(undefined)).toBe(3000);
  });
});
