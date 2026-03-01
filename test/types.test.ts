/**
 * @fileoverview Tests for types module utility functions
 *
 * Tests the helper functions for creating response objects,
 * initial state structures, type guards, and error handling utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  createErrorResponse,
  createInitialRalphTrackerState,
  createInitialRalphSessionState,
  createInitialState,
  ApiErrorCode,
  DEFAULT_CONFIG,
  isError,
  getErrorMessage,
} from '../src/types.js';

describe('types utility functions', () => {
  describe('createErrorResponse', () => {
    it('should create error response with code only', () => {
      const response = createErrorResponse('NOT_FOUND');

      expect(response.success).toBe(false);
      expect(response.errorCode).toBe('NOT_FOUND');
      expect(response.error).toBe('The requested resource was not found');
    });

    it('should create error response with custom details', () => {
      const response = createErrorResponse('INVALID_INPUT', 'Missing required field: name');

      expect(response.success).toBe(false);
      expect(response.errorCode).toBe('INVALID_INPUT');
      expect(response.error).toBe('Missing required field: name');
    });

    it('should handle all error codes', () => {
      const codes = [
        'NOT_FOUND',
        'INVALID_INPUT',
        'SESSION_BUSY',
        'OPERATION_FAILED',
        'ALREADY_EXISTS',
        'INTERNAL_ERROR',
      ] as const;

      for (const code of codes) {
        const response = createErrorResponse(code);
        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(code);
        expect(response.error).toBeDefined();
      }
    });

    it('should prefer details over default message when provided', () => {
      const response = createErrorResponse('NOT_FOUND', 'Custom not found message');
      expect(response.error).toBe('Custom not found message');
    });

    it('should handle whitespace-only details', () => {
      const response = createErrorResponse('INVALID_INPUT', '   ');
      expect(response.error).toBe('   ');
    });

    it('should handle very long error details', () => {
      const longDetails = 'x'.repeat(10000);
      const response = createErrorResponse('INTERNAL_ERROR', longDetails);
      expect(response.error).toBe(longDetails);
      expect(response.error?.length).toBe(10000);
    });

    it('should handle special characters in details', () => {
      const specialDetails = 'Error: <script>alert("xss")</script> & more "quotes"';
      const response = createErrorResponse('OPERATION_FAILED', specialDetails);
      expect(response.error).toBe(specialDetails);
    });

    it('should handle unicode in details', () => {
      const unicodeDetails = 'Error: 日本語 🚀 émojis';
      const response = createErrorResponse('INVALID_INPUT', unicodeDetails);
      expect(response.error).toBe(unicodeDetails);
    });
  });

  describe('createInitialRalphTrackerState', () => {
    it('should create initial Ralph tracker state', () => {
      const state = createInitialRalphTrackerState();

      expect(state.enabled).toBe(false);
      expect(state.active).toBe(false);
      expect(state.cycleCount).toBe(0);
      expect(state.maxIterations).toBeNull();
      expect(state.completionPhrase).toBeNull();
      expect(state.startedAt).toBeNull();
      expect(state.lastActivity).toBeLessThanOrEqual(Date.now());
      expect(state.elapsedHours).toBeNull();
    });

    it('should create fresh instances each time', () => {
      const state1 = createInitialRalphTrackerState();
      const state2 = createInitialRalphTrackerState();

      expect(state1).not.toBe(state2);
      expect(state1).toEqual(state2);
    });

    it('should have correct types for all fields', () => {
      const state = createInitialRalphTrackerState();

      expect(typeof state.enabled).toBe('boolean');
      expect(typeof state.active).toBe('boolean');
      expect(typeof state.cycleCount).toBe('number');
      expect(state.maxIterations === null || typeof state.maxIterations === 'number').toBe(true);
      expect(state.completionPhrase === null || typeof state.completionPhrase === 'string').toBe(true);
      expect(state.startedAt === null || typeof state.startedAt === 'number').toBe(true);
      expect(typeof state.lastActivity).toBe('number');
      expect(state.elapsedHours === null || typeof state.elapsedHours === 'number').toBe(true);
    });
  });

  describe('createInitialRalphSessionState', () => {
    it('should create initial Ralph session state with session ID', () => {
      const state = createInitialRalphSessionState('session-123');

      expect(state.sessionId).toBe('session-123');
      expect(state.loop).toBeDefined();
      expect(state.loop.enabled).toBe(false);
      expect(state.loop.active).toBe(false);
      expect(state.todos).toEqual([]);
      expect(state.lastUpdated).toBeLessThanOrEqual(Date.now());
    });

    it('should handle empty session ID', () => {
      const state = createInitialRalphSessionState('');
      expect(state.sessionId).toBe('');
    });

    it('should handle UUID-style session ID', () => {
      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const state = createInitialRalphSessionState(uuid);
      expect(state.sessionId).toBe(uuid);
    });

    it('should create independent loop state', () => {
      const state1 = createInitialRalphSessionState('session-1');
      const state2 = createInitialRalphSessionState('session-2');

      state1.loop.active = true;
      expect(state2.loop.active).toBe(false);
    });

    it('should create independent todos array', () => {
      const state1 = createInitialRalphSessionState('session-1');
      const state2 = createInitialRalphSessionState('session-2');

      state1.todos.push({ id: 'todo-1', content: 'Test', status: 'pending', detectedAt: Date.now() });
      expect(state2.todos).toHaveLength(0);
    });
  });

  describe('createInitialState', () => {
    it('should create initial app state', () => {
      const state = createInitialState();

      expect(state.sessions).toEqual({});
      expect(state.tasks).toEqual({});
      expect(state.ralphLoop).toBeDefined();
      expect(state.ralphLoop.status).toBe('stopped');
      expect(state.config).toBeDefined();
      expect(state.config.maxConcurrentSessions).toBeGreaterThan(0);
      expect(state.config.pollIntervalMs).toBeGreaterThan(0);
    });

    it('should create state with config from DEFAULT_CONFIG', () => {
      const state = createInitialState();

      // Check that config has required fields
      expect(state.config.maxConcurrentSessions).toBeDefined();
      expect(state.config.pollIntervalMs).toBeDefined();
    });

    it('should have Ralph Loop in stopped state', () => {
      const state = createInitialState();

      expect(state.ralphLoop.status).toBe('stopped');
      expect(state.ralphLoop.startedAt).toBeNull();
      expect(state.ralphLoop.minDurationMs).toBeNull();
      expect(state.ralphLoop.tasksCompleted).toBe(0);
      expect(state.ralphLoop.tasksGenerated).toBe(0);
    });

    it('should create fresh instances each time', () => {
      const state1 = createInitialState();
      const state2 = createInitialState();

      expect(state1).not.toBe(state2);
      state1.sessions['test'] = {} as any;
      expect(state2.sessions['test']).toBeUndefined();
    });

    it('should have all Ralph Loop fields', () => {
      const state = createInitialState();

      expect(state.ralphLoop).toHaveProperty('status');
      expect(state.ralphLoop).toHaveProperty('startedAt');
      expect(state.ralphLoop).toHaveProperty('minDurationMs');
      expect(state.ralphLoop).toHaveProperty('tasksCompleted');
      expect(state.ralphLoop).toHaveProperty('tasksGenerated');
      expect(state.ralphLoop).toHaveProperty('lastCheckAt');
    });

    it('should have all config fields', () => {
      const state = createInitialState();

      expect(state.config).toHaveProperty('pollIntervalMs');
      expect(state.config).toHaveProperty('defaultTimeoutMs');
      expect(state.config).toHaveProperty('maxConcurrentSessions');
      expect(state.config).toHaveProperty('stateFilePath');
      expect(state.config).toHaveProperty('respawn');
      expect(state.config).toHaveProperty('lastUsedCase');
    });

    it('should have all respawn config fields', () => {
      const state = createInitialState();

      expect(state.config.respawn).toHaveProperty('idleTimeoutMs');
      expect(state.config.respawn).toHaveProperty('updatePrompt');
      expect(state.config.respawn).toHaveProperty('interStepDelayMs');
      expect(state.config.respawn).toHaveProperty('enabled');
      expect(state.config.respawn).toHaveProperty('sendClear');
      expect(state.config.respawn).toHaveProperty('sendInit');
    });
  });

  describe('DEFAULT_CONFIG', () => {
    it('should have sensible default poll interval', () => {
      expect(DEFAULT_CONFIG.pollIntervalMs).toBeGreaterThanOrEqual(100);
      expect(DEFAULT_CONFIG.pollIntervalMs).toBeLessThanOrEqual(10000);
    });

    it('should have sensible default timeout', () => {
      expect(DEFAULT_CONFIG.defaultTimeoutMs).toBeGreaterThanOrEqual(60000);
    });

    it('should have sensible max concurrent sessions', () => {
      expect(DEFAULT_CONFIG.maxConcurrentSessions).toBeGreaterThan(0);
      expect(DEFAULT_CONFIG.maxConcurrentSessions).toBeLessThanOrEqual(100);
    });

    it('should have respawn disabled by default', () => {
      expect(DEFAULT_CONFIG.respawn.enabled).toBe(false);
    });

    it('should have valid respawn config', () => {
      expect(DEFAULT_CONFIG.respawn.idleTimeoutMs).toBeGreaterThan(0);
      expect(DEFAULT_CONFIG.respawn.interStepDelayMs).toBeGreaterThan(0);
      expect(typeof DEFAULT_CONFIG.respawn.updatePrompt).toBe('string');
      expect(typeof DEFAULT_CONFIG.respawn.sendClear).toBe('boolean');
      expect(typeof DEFAULT_CONFIG.respawn.sendInit).toBe('boolean');
    });

    it('should have null lastUsedCase initially', () => {
      expect(DEFAULT_CONFIG.lastUsedCase).toBeNull();
    });
  });

  describe('isError', () => {
    it('should return true for Error instances', () => {
      expect(isError(new Error('test'))).toBe(true);
      expect(isError(new TypeError('test'))).toBe(true);
      expect(isError(new RangeError('test'))).toBe(true);
      expect(isError(new SyntaxError('test'))).toBe(true);
    });

    it('should return false for non-Error values', () => {
      expect(isError('error string')).toBe(false);
      expect(isError(123)).toBe(false);
      expect(isError(null)).toBe(false);
      expect(isError(undefined)).toBe(false);
      expect(isError({})).toBe(false);
      expect(isError({ message: 'fake error' })).toBe(false);
    });

    it('should return false for arrays', () => {
      expect(isError([])).toBe(false);
      expect(isError([new Error('test')])).toBe(false);
    });

    it('should return false for functions', () => {
      expect(isError(() => {})).toBe(false);
      expect(isError(Error)).toBe(false);
    });
  });

  describe('getErrorMessage', () => {
    it('should extract message from Error objects', () => {
      expect(getErrorMessage(new Error('test message'))).toBe('test message');
      expect(getErrorMessage(new TypeError('type error'))).toBe('type error');
    });

    it('should return string errors directly', () => {
      expect(getErrorMessage('string error')).toBe('string error');
    });

    it('should extract message from objects with message property', () => {
      expect(getErrorMessage({ message: 'object message' })).toBe('object message');
    });

    it('should return default message for null/undefined', () => {
      expect(getErrorMessage(null)).toBe('An unknown error occurred');
      expect(getErrorMessage(undefined)).toBe('An unknown error occurred');
    });

    it('should return default message for numbers', () => {
      expect(getErrorMessage(42)).toBe('An unknown error occurred');
      expect(getErrorMessage(NaN)).toBe('An unknown error occurred');
    });

    it('should return default message for booleans', () => {
      expect(getErrorMessage(true)).toBe('An unknown error occurred');
      expect(getErrorMessage(false)).toBe('An unknown error occurred');
    });

    it('should return default message for objects without message', () => {
      expect(getErrorMessage({})).toBe('An unknown error occurred');
      expect(getErrorMessage({ error: 'test' })).toBe('An unknown error occurred');
    });

    it('should handle empty string message', () => {
      expect(getErrorMessage(new Error(''))).toBe('');
      expect(getErrorMessage('')).toBe('');
      expect(getErrorMessage({ message: '' })).toBe('');
    });

    it('should handle non-string message property', () => {
      expect(getErrorMessage({ message: 123 })).toBe('123');
      expect(getErrorMessage({ message: null })).toBe('null');
      expect(getErrorMessage({ message: { nested: true } })).toBe('[object Object]');
    });

    it('should handle arrays', () => {
      expect(getErrorMessage([])).toBe('An unknown error occurred');
      expect(getErrorMessage(['error'])).toBe('An unknown error occurred');
    });

    it('should handle symbols', () => {
      expect(getErrorMessage(Symbol('test'))).toBe('An unknown error occurred');
    });
  });

  describe('Type Definitions', () => {
    describe('SessionStatus', () => {
      it('should support all status values', () => {
        const statuses: Array<'idle' | 'busy' | 'stopped' | 'error'> = ['idle', 'busy', 'stopped', 'error'];
        expect(statuses).toHaveLength(4);
      });
    });

    describe('TaskStatus', () => {
      it('should support all status values', () => {
        const statuses: Array<'pending' | 'running' | 'completed' | 'failed'> = ['pending', 'running', 'completed', 'failed'];
        expect(statuses).toHaveLength(4);
      });
    });

    describe('RalphLoopStatus', () => {
      it('should support all status values', () => {
        const statuses: Array<'stopped' | 'running' | 'paused'> = ['stopped', 'running', 'paused'];
        expect(statuses).toHaveLength(3);
      });
    });

    describe('RalphTodoStatus', () => {
      it('should support all status values', () => {
        const statuses: Array<'pending' | 'in_progress' | 'completed'> = ['pending', 'in_progress', 'completed'];
        expect(statuses).toHaveLength(3);
      });
    });
  });

  describe('ApiErrorCode Enum', () => {
    it('should have correct values', () => {
      expect(ApiErrorCode.NOT_FOUND).toBe('NOT_FOUND');
      expect(ApiErrorCode.INVALID_INPUT).toBe('INVALID_INPUT');
      expect(ApiErrorCode.SESSION_BUSY).toBe('SESSION_BUSY');
      expect(ApiErrorCode.OPERATION_FAILED).toBe('OPERATION_FAILED');
      expect(ApiErrorCode.ALREADY_EXISTS).toBe('ALREADY_EXISTS');
      expect(ApiErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    });

    it('should have 6 error codes', () => {
      const codes = Object.values(ApiErrorCode);
      expect(codes).toHaveLength(6);
    });
  });
});
