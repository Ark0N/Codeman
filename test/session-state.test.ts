/**
 * @fileoverview Tests for session state management utilities
 *
 * Tests session state machine transitions, lifecycle management,
 * and state persistence patterns.
 */

import { describe, it, expect } from 'vitest';

describe('Session State Management', () => {
  describe('Session Mode Validation', () => {
    type SessionMode = 'claude' | 'shell';

    const isValidMode = (mode: unknown): mode is SessionMode => {
      return mode === 'claude' || mode === 'shell';
    };

    it('should accept claude mode', () => {
      expect(isValidMode('claude')).toBe(true);
    });

    it('should accept shell mode', () => {
      expect(isValidMode('shell')).toBe(true);
    });

    it('should reject invalid modes', () => {
      expect(isValidMode('bash')).toBe(false);
      expect(isValidMode('interactive')).toBe(false);
      expect(isValidMode('')).toBe(false);
      expect(isValidMode(null)).toBe(false);
      expect(isValidMode(undefined)).toBe(false);
      expect(isValidMode(123)).toBe(false);
    });
  });

  describe('Session Status Transitions', () => {
    type SessionStatus = 'idle' | 'working' | 'waiting' | 'error' | 'stopped';

    const validTransitions: Record<SessionStatus, SessionStatus[]> = {
      idle: ['working', 'stopped', 'error'],
      working: ['idle', 'waiting', 'stopped', 'error'],
      waiting: ['idle', 'working', 'stopped', 'error'],
      error: ['idle', 'stopped'],
      stopped: [],
    };

    const canTransition = (from: SessionStatus, to: SessionStatus): boolean => {
      return validTransitions[from].includes(to);
    };

    it('should allow idle to working transition', () => {
      expect(canTransition('idle', 'working')).toBe(true);
    });

    it('should allow working to idle transition', () => {
      expect(canTransition('working', 'idle')).toBe(true);
    });

    it('should allow any state to stopped', () => {
      expect(canTransition('idle', 'stopped')).toBe(true);
      expect(canTransition('working', 'stopped')).toBe(true);
      expect(canTransition('waiting', 'stopped')).toBe(true);
      expect(canTransition('error', 'stopped')).toBe(true);
    });

    it('should not allow transitions from stopped', () => {
      expect(canTransition('stopped', 'idle')).toBe(false);
      expect(canTransition('stopped', 'working')).toBe(false);
      expect(canTransition('stopped', 'error')).toBe(false);
    });

    it('should allow error to idle for recovery', () => {
      expect(canTransition('error', 'idle')).toBe(true);
    });
  });

  describe('Session ID Generation', () => {
    const generateSessionId = (): string => {
      return `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    };

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateSessionId());
      }
      expect(ids.size).toBe(100);
    });

    it('should have correct format', () => {
      const id = generateSessionId();
      expect(id.startsWith('session-')).toBe(true);
      expect(id.length).toBeGreaterThan(15);
    });

    it('should contain timestamp component', () => {
      const id = generateSessionId();
      const parts = id.split('-');
      expect(parts.length).toBe(3);
      expect(Number(parts[1])).toBeGreaterThan(0);
    });
  });

  describe('Token Tracking', () => {
    interface TokenState {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      estimatedCost: number;
    }

    const createTokenState = (): TokenState => ({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
    });

    const updateTokens = (
      state: TokenState,
      input: number,
      output: number,
      costPerMillion: number = 3.0
    ): TokenState => ({
      inputTokens: state.inputTokens + input,
      outputTokens: state.outputTokens + output,
      totalTokens: state.totalTokens + input + output,
      estimatedCost: state.estimatedCost + ((input + output) / 1_000_000) * costPerMillion,
    });

    it('should initialize with zeros', () => {
      const state = createTokenState();
      expect(state.inputTokens).toBe(0);
      expect(state.outputTokens).toBe(0);
      expect(state.totalTokens).toBe(0);
      expect(state.estimatedCost).toBe(0);
    });

    it('should accumulate tokens correctly', () => {
      let state = createTokenState();
      state = updateTokens(state, 1000, 500);
      expect(state.inputTokens).toBe(1000);
      expect(state.outputTokens).toBe(500);
      expect(state.totalTokens).toBe(1500);
    });

    it('should calculate cost correctly', () => {
      let state = createTokenState();
      state = updateTokens(state, 1_000_000, 0, 3.0);
      expect(state.estimatedCost).toBe(3.0);
    });

    it('should accumulate multiple updates', () => {
      let state = createTokenState();
      state = updateTokens(state, 1000, 500);
      state = updateTokens(state, 2000, 1000);
      expect(state.inputTokens).toBe(3000);
      expect(state.outputTokens).toBe(1500);
      expect(state.totalTokens).toBe(4500);
    });
  });

  describe('Auto-Compact Thresholds', () => {
    interface AutoCompactConfig {
      enabled: boolean;
      threshold: number;
      prompt?: string;
    }

    const shouldTriggerCompact = (
      totalTokens: number,
      config: AutoCompactConfig
    ): boolean => {
      return config.enabled && totalTokens >= config.threshold;
    };

    it('should trigger when enabled and over threshold', () => {
      const config: AutoCompactConfig = { enabled: true, threshold: 100000 };
      expect(shouldTriggerCompact(110000, config)).toBe(true);
    });

    it('should not trigger when disabled', () => {
      const config: AutoCompactConfig = { enabled: false, threshold: 100000 };
      expect(shouldTriggerCompact(110000, config)).toBe(false);
    });

    it('should not trigger when under threshold', () => {
      const config: AutoCompactConfig = { enabled: true, threshold: 100000 };
      expect(shouldTriggerCompact(90000, config)).toBe(false);
    });

    it('should trigger at exact threshold', () => {
      const config: AutoCompactConfig = { enabled: true, threshold: 100000 };
      expect(shouldTriggerCompact(100000, config)).toBe(true);
    });

    it('should handle various thresholds', () => {
      const thresholds = [50000, 100000, 110000, 140000];
      thresholds.forEach(threshold => {
        const config: AutoCompactConfig = { enabled: true, threshold };
        expect(shouldTriggerCompact(threshold + 1, config)).toBe(true);
        expect(shouldTriggerCompact(threshold - 1, config)).toBe(false);
      });
    });
  });

  describe('Auto-Clear Thresholds', () => {
    interface AutoClearConfig {
      enabled: boolean;
      threshold: number;
    }

    const shouldTriggerClear = (
      totalTokens: number,
      config: AutoClearConfig
    ): boolean => {
      return config.enabled && totalTokens >= config.threshold;
    };

    it('should trigger when enabled and over threshold', () => {
      const config: AutoClearConfig = { enabled: true, threshold: 140000 };
      expect(shouldTriggerClear(150000, config)).toBe(true);
    });

    it('should not trigger when disabled', () => {
      const config: AutoClearConfig = { enabled: false, threshold: 140000 };
      expect(shouldTriggerClear(150000, config)).toBe(false);
    });

    it('should not trigger when under threshold', () => {
      const config: AutoClearConfig = { enabled: true, threshold: 140000 };
      expect(shouldTriggerClear(130000, config)).toBe(false);
    });

    it('should handle edge case at exactly threshold', () => {
      const config: AutoClearConfig = { enabled: true, threshold: 140000 };
      expect(shouldTriggerClear(140000, config)).toBe(true);
    });
  });

  describe('Session Timeout Management', () => {
    interface TimeoutConfig {
      idleTimeoutMs: number;
      activityTimeoutMs: number;
    }

    const defaultTimeouts: TimeoutConfig = {
      idleTimeoutMs: 5000,
      activityTimeoutMs: 2000,
    };

    const isTimedOut = (lastActivity: number, now: number, timeout: number): boolean => {
      return (now - lastActivity) >= timeout;
    };

    it('should detect idle timeout', () => {
      const lastActivity = 1000;
      const now = 6001;
      expect(isTimedOut(lastActivity, now, defaultTimeouts.idleTimeoutMs)).toBe(true);
    });

    it('should not timeout when active', () => {
      const lastActivity = 1000;
      const now = 3000;
      expect(isTimedOut(lastActivity, now, defaultTimeouts.idleTimeoutMs)).toBe(false);
    });

    it('should timeout at exact boundary', () => {
      const lastActivity = 1000;
      const now = 6000;
      expect(isTimedOut(lastActivity, now, defaultTimeouts.idleTimeoutMs)).toBe(true);
    });

    it('should handle activity timeout separately', () => {
      const lastActivity = 1000;
      const now = 3001;
      expect(isTimedOut(lastActivity, now, defaultTimeouts.activityTimeoutMs)).toBe(true);
    });
  });

  describe('Mux Session Environment', () => {
    interface MuxEnv {
      CLAUDEMAN_MUX: string;
      CLAUDEMAN_SESSION_ID: string;
      CLAUDEMAN_MUX_NAME: string;
    }

    const createMuxEnv = (sessionId: string, muxName: string): MuxEnv => ({
      CLAUDEMAN_MUX: '1',
      CLAUDEMAN_SESSION_ID: sessionId,
      CLAUDEMAN_MUX_NAME: muxName,
    });

    const isClaudemanSession = (env: Record<string, string | undefined>): boolean => {
      return env.CLAUDEMAN_MUX === '1';
    };

    it('should create valid mux environment', () => {
      const env = createMuxEnv('session-123', 'claudeman-test');
      expect(env.CLAUDEMAN_MUX).toBe('1');
      expect(env.CLAUDEMAN_SESSION_ID).toBe('session-123');
      expect(env.CLAUDEMAN_MUX_NAME).toBe('claudeman-test');
    });

    it('should detect claudeman session', () => {
      const env = createMuxEnv('session-123', 'claudeman-test');
      expect(isClaudemanSession(env)).toBe(true);
    });

    it('should detect non-claudeman session', () => {
      const env = { CLAUDEMAN_MUX: '0' };
      expect(isClaudemanSession(env)).toBe(false);
    });

    it('should handle missing environment variable', () => {
      const env = {};
      expect(isClaudemanSession(env)).toBe(false);
    });
  });

  describe('PTY Spawn Arguments', () => {
    type OutputFormat = 'stream-json' | 'text';

    const buildClaudeArgs = (
      interactive: boolean,
      outputFormat?: OutputFormat,
      prompt?: string
    ): string[] => {
      const args: string[] = [];

      if (!interactive) {
        args.push('-p');
      }

      args.push('--dangerously-skip-permissions');

      if (outputFormat) {
        args.push('--output-format', outputFormat);
      }

      if (prompt) {
        args.push(prompt);
      }

      return args;
    };

    it('should build interactive args', () => {
      const args = buildClaudeArgs(true);
      expect(args).not.toContain('-p');
      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('should build one-shot args', () => {
      const args = buildClaudeArgs(false, 'stream-json', 'test prompt');
      expect(args).toContain('-p');
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('test prompt');
    });

    it('should include output format when specified', () => {
      const args = buildClaudeArgs(false, 'stream-json');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
    });

    it('should not include output format when not specified', () => {
      const args = buildClaudeArgs(true);
      expect(args).not.toContain('--output-format');
    });

    it('should handle text output format', () => {
      const args = buildClaudeArgs(false, 'text');
      expect(args).toContain('--output-format');
      expect(args).toContain('text');
    });
  });

  describe('Session Cleanup State', () => {
    interface CleanupState {
      buffersCleared: boolean;
      timersCleared: boolean;
      muxKilled: boolean;
      respawnStopped: boolean;
      trackerReset: boolean;
    }

    const createCleanupState = (): CleanupState => ({
      buffersCleared: false,
      timersCleared: false,
      muxKilled: false,
      respawnStopped: false,
      trackerReset: false,
    });

    const isFullyCleaned = (state: CleanupState): boolean => {
      return Object.values(state).every(v => v === true);
    };

    it('should start with nothing cleaned', () => {
      const state = createCleanupState();
      expect(isFullyCleaned(state)).toBe(false);
    });

    it('should detect partial cleanup', () => {
      const state = createCleanupState();
      state.buffersCleared = true;
      state.timersCleared = true;
      expect(isFullyCleaned(state)).toBe(false);
    });

    it('should detect full cleanup', () => {
      const state: CleanupState = {
        buffersCleared: true,
        timersCleared: true,
        muxKilled: true,
        respawnStopped: true,
        trackerReset: true,
      };
      expect(isFullyCleaned(state)).toBe(true);
    });
  });

  describe('Session Limits', () => {
    const MAX_CONCURRENT_SESSIONS = 50;
    const UI_TAB_LIMIT = 20;
    const CLI_DEFAULT_LIMIT = 5;

    const canCreateSession = (currentCount: number, limit: number): boolean => {
      return currentCount < limit;
    };

    it('should allow creation when under web limit', () => {
      expect(canCreateSession(49, MAX_CONCURRENT_SESSIONS)).toBe(true);
    });

    it('should block creation when at web limit', () => {
      expect(canCreateSession(50, MAX_CONCURRENT_SESSIONS)).toBe(false);
    });

    it('should respect UI tab limit', () => {
      expect(canCreateSession(19, UI_TAB_LIMIT)).toBe(true);
      expect(canCreateSession(20, UI_TAB_LIMIT)).toBe(false);
    });

    it('should respect CLI default limit', () => {
      expect(canCreateSession(4, CLI_DEFAULT_LIMIT)).toBe(true);
      expect(canCreateSession(5, CLI_DEFAULT_LIMIT)).toBe(false);
    });

    it('should handle zero sessions', () => {
      expect(canCreateSession(0, MAX_CONCURRENT_SESSIONS)).toBe(true);
      expect(canCreateSession(0, UI_TAB_LIMIT)).toBe(true);
      expect(canCreateSession(0, CLI_DEFAULT_LIMIT)).toBe(true);
    });
  });

  describe('Session Name Formatting', () => {
    const formatSessionName = (name: string, maxLength: number = 20): string => {
      if (name.length <= maxLength) return name;
      return name.substring(0, maxLength - 3) + '...';
    };

    it('should not truncate short names', () => {
      expect(formatSessionName('test')).toBe('test');
    });

    it('should truncate long names', () => {
      const longName = 'this-is-a-very-long-session-name';
      const result = formatSessionName(longName, 20);
      expect(result.length).toBe(20);
      expect(result.endsWith('...')).toBe(true);
    });

    it('should handle exact length', () => {
      const exactName = '12345678901234567890'; // 20 chars
      expect(formatSessionName(exactName, 20)).toBe(exactName);
    });

    it('should handle custom max length', () => {
      const name = 'session-name';
      expect(formatSessionName(name, 10).length).toBe(10);
    });
  });

  describe('Session Statistics', () => {
    interface SessionStats {
      totalCreated: number;
      totalClosed: number;
      currentActive: number;
      averageLifetimeMs: number;
    }

    const calculateStats = (
      lifetimes: number[]
    ): Pick<SessionStats, 'averageLifetimeMs'> => {
      if (lifetimes.length === 0) {
        return { averageLifetimeMs: 0 };
      }
      const sum = lifetimes.reduce((a, b) => a + b, 0);
      return { averageLifetimeMs: Math.round(sum / lifetimes.length) };
    };

    it('should calculate average lifetime', () => {
      const stats = calculateStats([1000, 2000, 3000]);
      expect(stats.averageLifetimeMs).toBe(2000);
    });

    it('should handle empty lifetimes', () => {
      const stats = calculateStats([]);
      expect(stats.averageLifetimeMs).toBe(0);
    });

    it('should handle single lifetime', () => {
      const stats = calculateStats([5000]);
      expect(stats.averageLifetimeMs).toBe(5000);
    });

    it('should round average', () => {
      const stats = calculateStats([1000, 2000, 3500]);
      expect(stats.averageLifetimeMs).toBe(2167);
    });
  });
});

describe('Session Event Handling', () => {
  describe('Event Type Validation', () => {
    const sessionEvents = [
      'session:created',
      'session:started',
      'session:idle',
      'session:working',
      'session:terminal',
      'session:clearTerminal',
      'session:completion',
      'session:autoClear',
      'session:autoCompact',
      'session:deleted',
    ] as const;

    type SessionEvent = typeof sessionEvents[number];

    const isValidSessionEvent = (event: string): event is SessionEvent => {
      return sessionEvents.includes(event as SessionEvent);
    };

    it('should validate session events', () => {
      sessionEvents.forEach(event => {
        expect(isValidSessionEvent(event)).toBe(true);
      });
    });

    it('should reject invalid events', () => {
      expect(isValidSessionEvent('session:unknown')).toBe(false);
      expect(isValidSessionEvent('other:event')).toBe(false);
      expect(isValidSessionEvent('')).toBe(false);
    });
  });

  describe('Event Payload Structure', () => {
    interface TerminalEvent {
      sessionId: string;
      data: string;
      timestamp: number;
    }

    const createTerminalEvent = (
      sessionId: string,
      data: string
    ): TerminalEvent => ({
      sessionId,
      data,
      timestamp: Date.now(),
    });

    it('should create valid terminal event', () => {
      const event = createTerminalEvent('session-123', 'output text');
      expect(event.sessionId).toBe('session-123');
      expect(event.data).toBe('output text');
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('should handle empty data', () => {
      const event = createTerminalEvent('session-123', '');
      expect(event.data).toBe('');
    });

    it('should handle large data', () => {
      const largeData = 'x'.repeat(100000);
      const event = createTerminalEvent('session-123', largeData);
      expect(event.data.length).toBe(100000);
    });
  });

  describe('Event Debouncing', () => {
    const createDebouncer = (delayMs: number) => {
      let lastCall = 0;
      let pendingEvents: string[] = [];

      return {
        add: (event: string) => {
          pendingEvents.push(event);
        },
        shouldFlush: (now: number): boolean => {
          return now - lastCall >= delayMs && pendingEvents.length > 0;
        },
        flush: (now: number): string[] => {
          const events = [...pendingEvents];
          pendingEvents = [];
          lastCall = now;
          return events;
        },
        getPendingCount: () => pendingEvents.length,
      };
    };

    it('should accumulate events', () => {
      const debouncer = createDebouncer(100);
      debouncer.add('event1');
      debouncer.add('event2');
      expect(debouncer.getPendingCount()).toBe(2);
    });

    it('should flush after delay', () => {
      const debouncer = createDebouncer(100);
      debouncer.add('event1');
      debouncer.add('event2');
      expect(debouncer.shouldFlush(100)).toBe(true);
      const events = debouncer.flush(100);
      expect(events).toEqual(['event1', 'event2']);
    });

    it('should clear pending after flush', () => {
      const debouncer = createDebouncer(100);
      debouncer.add('event1');
      debouncer.flush(100);
      expect(debouncer.getPendingCount()).toBe(0);
    });

    it('should not flush when no events pending', () => {
      const debouncer = createDebouncer(100);
      expect(debouncer.shouldFlush(200)).toBe(false);
    });
  });

  describe('Event Batching', () => {
    interface BatchConfig {
      maxSize: number;
      maxDelayMs: number;
    }

    const createBatcher = (config: BatchConfig) => {
      let batch: string[] = [];
      let startTime = 0;

      return {
        add: (item: string, now: number): string[] | null => {
          if (batch.length === 0) {
            startTime = now;
          }
          batch.push(item);

          if (batch.length >= config.maxSize ||
              now - startTime >= config.maxDelayMs) {
            const result = batch;
            batch = [];
            return result;
          }
          return null;
        },
        forceDrain: (): string[] => {
          const result = batch;
          batch = [];
          return result;
        },
        size: () => batch.length,
      };
    };

    it('should batch until max size', () => {
      const batcher = createBatcher({ maxSize: 3, maxDelayMs: 1000 });
      expect(batcher.add('a', 0)).toBeNull();
      expect(batcher.add('b', 0)).toBeNull();
      expect(batcher.add('c', 0)).toEqual(['a', 'b', 'c']);
    });

    it('should batch until max delay', () => {
      const batcher = createBatcher({ maxSize: 10, maxDelayMs: 100 });
      expect(batcher.add('a', 0)).toBeNull();
      expect(batcher.add('b', 50)).toBeNull();
      expect(batcher.add('c', 101)).toEqual(['a', 'b', 'c']);
    });

    it('should force drain', () => {
      const batcher = createBatcher({ maxSize: 10, maxDelayMs: 1000 });
      batcher.add('a', 0);
      batcher.add('b', 0);
      expect(batcher.forceDrain()).toEqual(['a', 'b']);
      expect(batcher.size()).toBe(0);
    });
  });
});

describe('Session JSON Serialization', () => {
  describe('Circular Reference Handling', () => {
    const safeStringify = (obj: unknown): string => {
      const seen = new WeakSet();
      return JSON.stringify(obj, (_key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) {
            return '[Circular]';
          }
          seen.add(value);
        }
        return value;
      });
    };

    it('should handle normal objects', () => {
      const obj = { a: 1, b: 'test' };
      expect(safeStringify(obj)).toBe('{"a":1,"b":"test"}');
    });

    it('should handle nested objects', () => {
      const obj = { a: { b: { c: 1 } } };
      expect(safeStringify(obj)).toBe('{"a":{"b":{"c":1}}}');
    });

    it('should handle circular references', () => {
      const obj: Record<string, unknown> = { a: 1 };
      obj.self = obj;
      const result = safeStringify(obj);
      expect(result).toContain('[Circular]');
    });

    it('should handle null values', () => {
      const obj = { a: null };
      expect(safeStringify(obj)).toBe('{"a":null}');
    });

    it('should handle arrays', () => {
      const arr = [1, 2, 3];
      expect(safeStringify(arr)).toBe('[1,2,3]');
    });
  });

  describe('Date Serialization', () => {
    const serializeDate = (date: Date): string => date.toISOString();

    const parseDate = (str: string): Date => new Date(str);

    it('should serialize date to ISO string', () => {
      const date = new Date('2024-01-15T10:30:00.000Z');
      expect(serializeDate(date)).toBe('2024-01-15T10:30:00.000Z');
    });

    it('should parse ISO string to date', () => {
      const date = parseDate('2024-01-15T10:30:00.000Z');
      expect(date.getUTCFullYear()).toBe(2024);
      expect(date.getUTCMonth()).toBe(0);
      expect(date.getUTCDate()).toBe(15);
    });

    it('should round-trip correctly', () => {
      const original = new Date();
      const serialized = serializeDate(original);
      const parsed = parseDate(serialized);
      expect(parsed.getTime()).toBe(original.getTime());
    });
  });

  describe('Buffer Serialization', () => {
    const serializeBuffer = (buffer: Buffer): string => buffer.toString('base64');

    const parseBuffer = (str: string): Buffer => Buffer.from(str, 'base64');

    it('should serialize buffer to base64', () => {
      const buffer = Buffer.from('hello world');
      const serialized = serializeBuffer(buffer);
      expect(serialized).toBe('aGVsbG8gd29ybGQ=');
    });

    it('should parse base64 to buffer', () => {
      const buffer = parseBuffer('aGVsbG8gd29ybGQ=');
      expect(buffer.toString()).toBe('hello world');
    });

    it('should handle empty buffer', () => {
      const buffer = Buffer.from('');
      const serialized = serializeBuffer(buffer);
      const parsed = parseBuffer(serialized);
      expect(parsed.length).toBe(0);
    });

    it('should handle binary data', () => {
      const buffer = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      const serialized = serializeBuffer(buffer);
      const parsed = parseBuffer(serialized);
      expect(Array.from(parsed)).toEqual([0x00, 0x01, 0x02, 0xff]);
    });
  });
});
