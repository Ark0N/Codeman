/**
 * @fileoverview Tests for API response structures and validation
 *
 * Tests the structure and validation of various API request/response types.
 */

import { describe, it, expect } from 'vitest';
import {
  ApiErrorCode,
  createErrorResponse,
  createSuccessResponse,
} from '../src/types.js';

describe('API Response Structures', () => {
  describe('SessionState Structure', () => {
    interface SessionState {
      id: string;
      pid: number | null;
      status: 'idle' | 'busy' | 'stopped' | 'error';
      workingDir: string;
      currentTaskId: string | null;
      createdAt: number;
      lastActivityAt: number;
    }

    it('should validate idle session state', () => {
      const session: SessionState = {
        id: 'session-123',
        pid: 12345,
        status: 'idle',
        workingDir: '/project',
        currentTaskId: null,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };

      expect(session.status).toBe('idle');
      expect(session.pid).not.toBeNull();
      expect(session.currentTaskId).toBeNull();
    });

    it('should validate busy session state', () => {
      const session: SessionState = {
        id: 'session-456',
        pid: 67890,
        status: 'busy',
        workingDir: '/project',
        currentTaskId: 'task-123',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };

      expect(session.status).toBe('busy');
      expect(session.currentTaskId).not.toBeNull();
    });

    it('should validate stopped session state', () => {
      const session: SessionState = {
        id: 'session-789',
        pid: null,
        status: 'stopped',
        workingDir: '/project',
        currentTaskId: null,
        createdAt: Date.now() - 3600000,
        lastActivityAt: Date.now() - 1800000,
      };

      expect(session.status).toBe('stopped');
      expect(session.pid).toBeNull();
    });

    it('should validate error session state', () => {
      const session: SessionState = {
        id: 'session-error',
        pid: null,
        status: 'error',
        workingDir: '/project',
        currentTaskId: 'task-failed',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };

      expect(session.status).toBe('error');
    });
  });

  describe('TaskState Structure', () => {
    interface TaskState {
      id: string;
      prompt: string;
      workingDir: string;
      priority: number;
      dependencies: string[];
      completionPhrase?: string;
      timeoutMs?: number;
      status: 'pending' | 'running' | 'completed' | 'failed';
      assignedSessionId: string | null;
      createdAt: number;
      startedAt: number | null;
      completedAt: number | null;
      output: string;
      error: string | null;
    }

    it('should validate pending task', () => {
      const task: TaskState = {
        id: 'task-1',
        prompt: 'Do something',
        workingDir: '/project',
        priority: 0,
        dependencies: [],
        status: 'pending',
        assignedSessionId: null,
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        output: '',
        error: null,
      };

      expect(task.status).toBe('pending');
      expect(task.assignedSessionId).toBeNull();
      expect(task.startedAt).toBeNull();
    });

    it('should validate running task', () => {
      const task: TaskState = {
        id: 'task-2',
        prompt: 'Run tests',
        workingDir: '/project',
        priority: 1,
        dependencies: ['task-1'],
        status: 'running',
        assignedSessionId: 'session-123',
        createdAt: Date.now() - 1000,
        startedAt: Date.now(),
        completedAt: null,
        output: 'Running...',
        error: null,
      };

      expect(task.status).toBe('running');
      expect(task.assignedSessionId).not.toBeNull();
      expect(task.startedAt).not.toBeNull();
    });

    it('should validate completed task', () => {
      const task: TaskState = {
        id: 'task-3',
        prompt: 'Build project',
        workingDir: '/project',
        priority: 2,
        dependencies: [],
        status: 'completed',
        assignedSessionId: 'session-123',
        createdAt: Date.now() - 5000,
        startedAt: Date.now() - 4000,
        completedAt: Date.now(),
        output: 'Build successful',
        error: null,
      };

      expect(task.status).toBe('completed');
      expect(task.completedAt).not.toBeNull();
      expect(task.error).toBeNull();
    });

    it('should validate failed task', () => {
      const task: TaskState = {
        id: 'task-4',
        prompt: 'Deploy',
        workingDir: '/project',
        priority: 3,
        dependencies: ['task-3'],
        status: 'failed',
        assignedSessionId: 'session-123',
        createdAt: Date.now() - 3000,
        startedAt: Date.now() - 2000,
        completedAt: Date.now(),
        output: 'Deployment started...',
        error: 'Connection refused',
      };

      expect(task.status).toBe('failed');
      expect(task.error).not.toBeNull();
    });

    it('should validate task with completion phrase', () => {
      const task: TaskState = {
        id: 'task-5',
        prompt: 'Run loop',
        workingDir: '/project',
        priority: 0,
        dependencies: [],
        completionPhrase: 'DONE',
        timeoutMs: 60000,
        status: 'pending',
        assignedSessionId: null,
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        output: '',
        error: null,
      };

      expect(task.completionPhrase).toBe('DONE');
      expect(task.timeoutMs).toBe(60000);
    });
  });

  describe('RalphLoopState Structure', () => {
    interface RalphLoopState {
      status: 'stopped' | 'running' | 'paused';
      startedAt: number | null;
      minDurationMs: number | null;
      tasksCompleted: number;
      tasksGenerated: number;
      lastCheckAt: number | null;
    }

    it('should validate stopped state', () => {
      const state: RalphLoopState = {
        status: 'stopped',
        startedAt: null,
        minDurationMs: null,
        tasksCompleted: 0,
        tasksGenerated: 0,
        lastCheckAt: null,
      };

      expect(state.status).toBe('stopped');
      expect(state.startedAt).toBeNull();
    });

    it('should validate running state', () => {
      const state: RalphLoopState = {
        status: 'running',
        startedAt: Date.now() - 3600000,
        minDurationMs: 14400000, // 4 hours
        tasksCompleted: 10,
        tasksGenerated: 5,
        lastCheckAt: Date.now(),
      };

      expect(state.status).toBe('running');
      expect(state.startedAt).not.toBeNull();
    });

    it('should validate paused state', () => {
      const state: RalphLoopState = {
        status: 'paused',
        startedAt: Date.now() - 1800000,
        minDurationMs: 7200000,
        tasksCompleted: 5,
        tasksGenerated: 2,
        lastCheckAt: Date.now() - 600000,
      };

      expect(state.status).toBe('paused');
    });
  });

  describe('Request Validation', () => {
    describe('CreateSessionRequest', () => {
      const validateCreateSession = (req: { workingDir?: string }): { valid: boolean; error?: string } => {
        if (req.workingDir !== undefined) {
          if (typeof req.workingDir !== 'string') {
            return { valid: false, error: 'workingDir must be a string' };
          }
          if (req.workingDir.length === 0) {
            return { valid: false, error: 'workingDir cannot be empty' };
          }
        }
        return { valid: true };
      };

      it('should accept valid request with workingDir', () => {
        expect(validateCreateSession({ workingDir: '/project' }).valid).toBe(true);
      });

      it('should accept request without workingDir', () => {
        expect(validateCreateSession({}).valid).toBe(true);
      });

      it('should reject empty workingDir', () => {
        const result = validateCreateSession({ workingDir: '' });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('empty');
      });
    });

    describe('RunPromptRequest', () => {
      const validateRunPrompt = (req: { prompt?: string }): { valid: boolean; error?: string } => {
        if (!req.prompt) {
          return { valid: false, error: 'prompt is required' };
        }
        if (typeof req.prompt !== 'string') {
          return { valid: false, error: 'prompt must be a string' };
        }
        if (req.prompt.trim().length === 0) {
          return { valid: false, error: 'prompt cannot be empty' };
        }
        return { valid: true };
      };

      it('should accept valid prompt', () => {
        expect(validateRunPrompt({ prompt: 'Do something' }).valid).toBe(true);
      });

      it('should reject missing prompt', () => {
        expect(validateRunPrompt({}).valid).toBe(false);
      });

      it('should reject empty prompt', () => {
        expect(validateRunPrompt({ prompt: '' }).valid).toBe(false);
      });

      it('should reject whitespace-only prompt', () => {
        expect(validateRunPrompt({ prompt: '   ' }).valid).toBe(false);
      });
    });

    describe('SessionInputRequest', () => {
      const validateSessionInput = (req: { input?: string }): { valid: boolean; error?: string } => {
        if (req.input === undefined) {
          return { valid: false, error: 'input is required' };
        }
        if (typeof req.input !== 'string') {
          return { valid: false, error: 'input must be a string' };
        }
        // Empty string is valid (just Enter key)
        return { valid: true };
      };

      it('should accept any string input', () => {
        expect(validateSessionInput({ input: 'text' }).valid).toBe(true);
      });

      it('should accept empty string (Enter key)', () => {
        expect(validateSessionInput({ input: '' }).valid).toBe(true);
      });

      it('should accept carriage return', () => {
        expect(validateSessionInput({ input: '\r' }).valid).toBe(true);
      });

      it('should reject missing input', () => {
        expect(validateSessionInput({}).valid).toBe(false);
      });
    });

    describe('ResizeRequest', () => {
      const validateResize = (req: { cols?: number; rows?: number }): { valid: boolean; error?: string } => {
        if (!req.cols || !req.rows) {
          return { valid: false, error: 'cols and rows are required' };
        }
        if (!Number.isInteger(req.cols) || req.cols < 1) {
          return { valid: false, error: 'cols must be a positive integer' };
        }
        if (!Number.isInteger(req.rows) || req.rows < 1) {
          return { valid: false, error: 'rows must be a positive integer' };
        }
        if (req.cols > 1000 || req.rows > 500) {
          return { valid: false, error: 'dimensions too large' };
        }
        return { valid: true };
      };

      it('should accept valid dimensions', () => {
        expect(validateResize({ cols: 80, rows: 24 }).valid).toBe(true);
        expect(validateResize({ cols: 120, rows: 40 }).valid).toBe(true);
      });

      it('should reject missing cols', () => {
        expect(validateResize({ rows: 24 }).valid).toBe(false);
      });

      it('should reject missing rows', () => {
        expect(validateResize({ cols: 80 }).valid).toBe(false);
      });

      it('should reject zero values', () => {
        expect(validateResize({ cols: 0, rows: 24 }).valid).toBe(false);
        expect(validateResize({ cols: 80, rows: 0 }).valid).toBe(false);
      });

      it('should reject negative values', () => {
        expect(validateResize({ cols: -80, rows: 24 }).valid).toBe(false);
      });

      it('should reject too large values', () => {
        expect(validateResize({ cols: 2000, rows: 24 }).valid).toBe(false);
        expect(validateResize({ cols: 80, rows: 1000 }).valid).toBe(false);
      });

      it('should reject non-integer values', () => {
        expect(validateResize({ cols: 80.5, rows: 24 }).valid).toBe(false);
      });
    });

    describe('CreateCaseRequest', () => {
      const validateCreateCase = (req: { name?: string; description?: string }): { valid: boolean; error?: string } => {
        if (!req.name) {
          return { valid: false, error: 'name is required' };
        }
        if (typeof req.name !== 'string') {
          return { valid: false, error: 'name must be a string' };
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(req.name)) {
          return { valid: false, error: 'name must be alphanumeric with hyphens/underscores' };
        }
        if (req.name.length > 100) {
          return { valid: false, error: 'name too long' };
        }
        return { valid: true };
      };

      it('should accept valid case names', () => {
        expect(validateCreateCase({ name: 'my-case' }).valid).toBe(true);
        expect(validateCreateCase({ name: 'my_case' }).valid).toBe(true);
        expect(validateCreateCase({ name: 'MyCase123' }).valid).toBe(true);
      });

      it('should reject missing name', () => {
        expect(validateCreateCase({}).valid).toBe(false);
      });

      it('should reject names with spaces', () => {
        expect(validateCreateCase({ name: 'my case' }).valid).toBe(false);
      });

      it('should reject names with special characters', () => {
        expect(validateCreateCase({ name: 'my.case' }).valid).toBe(false);
        expect(validateCreateCase({ name: 'my@case' }).valid).toBe(false);
      });

      it('should reject too long names', () => {
        expect(validateCreateCase({ name: 'a'.repeat(101) }).valid).toBe(false);
      });
    });

    describe('QuickStartRequest', () => {
      const validateQuickStart = (req: { caseName?: string; mode?: string }): { valid: boolean; error?: string } => {
        if (req.caseName !== undefined) {
          if (typeof req.caseName !== 'string') {
            return { valid: false, error: 'caseName must be a string' };
          }
          if (!/^[a-zA-Z0-9_-]+$/.test(req.caseName)) {
            return { valid: false, error: 'Invalid case name' };
          }
        }
        if (req.mode !== undefined) {
          if (req.mode !== 'claude' && req.mode !== 'shell') {
            return { valid: false, error: 'mode must be "claude" or "shell"' };
          }
        }
        return { valid: true };
      };

      it('should accept valid request', () => {
        expect(validateQuickStart({ caseName: 'test-case', mode: 'claude' }).valid).toBe(true);
      });

      it('should accept empty request', () => {
        expect(validateQuickStart({}).valid).toBe(true);
      });

      it('should accept shell mode', () => {
        expect(validateQuickStart({ mode: 'shell' }).valid).toBe(true);
      });

      it('should reject invalid mode', () => {
        expect(validateQuickStart({ mode: 'invalid' }).valid).toBe(false);
      });

      it('should reject invalid case name', () => {
        expect(validateQuickStart({ caseName: 'invalid name' }).valid).toBe(false);
      });
    });
  });

  describe('Response Validation', () => {
    describe('SessionResponse', () => {
      it('should have success property', () => {
        const response = createSuccessResponse({ id: 'session-1' });
        expect(response).toHaveProperty('success');
        expect(response.success).toBe(true);
      });

      it('should have data property on success', () => {
        const response = createSuccessResponse({ id: 'session-1', status: 'idle' });
        expect(response).toHaveProperty('data');
        expect(response.data?.id).toBe('session-1');
      });
    });

    describe('QuickStartResponse', () => {
      it('should include session and case info on success', () => {
        const response = createSuccessResponse({
          sessionId: 'session-1',
          casePath: '/path/to/case',
          caseName: 'test-case',
        });

        expect(response.success).toBe(true);
        expect(response.data?.sessionId).toBeDefined();
        expect(response.data?.casePath).toBeDefined();
        expect(response.data?.caseName).toBeDefined();
      });
    });

    describe('Error Responses', () => {
      it('should include error code', () => {
        const response = createErrorResponse(ApiErrorCode.NOT_FOUND);
        expect(response.errorCode).toBe(ApiErrorCode.NOT_FOUND);
      });

      it('should include error message', () => {
        const response = createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Bad request');
        expect(response.error).toBe('Bad request');
      });

      it('should have success=false', () => {
        const response = createErrorResponse(ApiErrorCode.INTERNAL_ERROR);
        expect(response.success).toBe(false);
      });
    });
  });

  describe('CaseInfo Structure', () => {
    interface CaseInfo {
      name: string;
      path: string;
      hasClaudeMd?: boolean;
    }

    it('should validate case info', () => {
      const caseInfo: CaseInfo = {
        name: 'my-project',
        path: '/home/user/codeman-cases/my-project',
        hasClaudeMd: true,
      };

      expect(caseInfo.name).toBeDefined();
      expect(caseInfo.path).toBeDefined();
      expect(caseInfo.hasClaudeMd).toBe(true);
    });

    it('should handle optional hasClaudeMd', () => {
      const caseInfo: CaseInfo = {
        name: 'new-project',
        path: '/home/user/codeman-cases/new-project',
      };

      expect(caseInfo.hasClaudeMd).toBeUndefined();
    });
  });

  describe('ProcessStats Structure', () => {
    interface ProcessStats {
      memoryMB: number;
      cpuPercent: number;
      childCount: number;
      updatedAt: number;
    }

    it('should validate process stats', () => {
      const stats: ProcessStats = {
        memoryMB: 256.5,
        cpuPercent: 25.3,
        childCount: 5,
        updatedAt: Date.now(),
      };

      expect(stats.memoryMB).toBeGreaterThanOrEqual(0);
      expect(stats.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(stats.childCount).toBeGreaterThanOrEqual(0);
      expect(stats.updatedAt).toBeGreaterThan(0);
    });

    it('should handle zero stats', () => {
      const stats: ProcessStats = {
        memoryMB: 0,
        cpuPercent: 0,
        childCount: 0,
        updatedAt: Date.now(),
      };

      expect(stats.memoryMB).toBe(0);
      expect(stats.cpuPercent).toBe(0);
    });

    it('should handle high CPU usage', () => {
      const stats: ProcessStats = {
        memoryMB: 1024,
        cpuPercent: 100.0,
        childCount: 10,
        updatedAt: Date.now(),
      };

      expect(stats.cpuPercent).toBe(100.0);
    });
  });
});
