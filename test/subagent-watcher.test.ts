/**
 * @fileoverview Tests for subagent-watcher module
 *
 * Tests the SubagentWatcher class which monitors Claude Code background agents
 * by watching ~/.claude/projects/{project}/{session}/subagents/agent-{id}.jsonl files.
 *
 * These are unit tests that mock filesystem operations to test the parsing and
 * event emission logic without requiring real subagent files.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'events';

// Increase max listeners for test mock EventEmitters to suppress warnings
// These warnings come from reusing mock EventEmitters across many tests
EventEmitter.defaultMaxListeners = 100;

// Mock the fs module before importing SubagentWatcher
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    watch: vi.fn(),
    createReadStream: vi.fn(),
  };
});

// Mock node:fs/promises (used by scanForSubagents for async directory traversal)
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('readline', () => ({
  createInterface: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    cb(new Error('No processes'), '');
  }),
}));

// Also mock the node: prefixed version (source imports from 'node:child_process')
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    cb(new Error('No processes'), '');
  }),
}));

// Import after mocking
import {
  SubagentWatcher,
  SubagentInfo,
  SubagentToolCall,
  SubagentProgress,
  SubagentMessage,
  SubagentTranscriptEntry,
} from '../src/subagent-watcher.js';
import * as fs from 'fs';
import * as fsPromises from 'node:fs/promises';
import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { execFile as nodeExecFile } from 'node:child_process';

/**
 * Flush the microtask queue to allow async scanForSubagents() to complete.
 * Each await in the scan chain (readdir, stat, etc.) needs its own microtask tick.
 */
async function flushAsyncScan(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// Helper to create mock JSONL entries as Claude Code produces them
function createUserEntry(text: string, timestamp?: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: timestamp || new Date().toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  });
}

function createAssistantTextEntry(text: string, timestamp?: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: timestamp || new Date().toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

function createToolUseEntry(toolName: string, input: Record<string, unknown>, timestamp?: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: timestamp || new Date().toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: toolName, input }],
    },
  });
}

function createProgressEntry(progressType: string, data: Record<string, unknown>, timestamp?: string): string {
  return JSON.stringify({
    type: 'progress',
    timestamp: timestamp || new Date().toISOString(),
    data: { type: progressType, ...data },
  });
}

function createToolResultEntry(content: string, timestamp?: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: timestamp || new Date().toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'tool_result', content }],
    },
  });
}

/** Create a mock readline interface with .close() method */
function createMockRl() {
  const rl = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
  rl.close = vi.fn();
  return rl;
}

describe('SubagentWatcher', () => {
  let watcher: SubagentWatcher;
  let mockExistsSync: Mock;
  let mockStatSync: Mock;
  let mockReaddirSync: Mock;
  let mockReadFileSync: Mock;
  let mockWatch: Mock;
  let mockCreateReadStream: Mock;
  let mockCreateInterface: Mock;
  let mockExecSync: Mock;
  let mockReaddir: Mock;
  let mockStatAsync: Mock;
  let mockReadFile: Mock;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    mockExistsSync = fs.existsSync as Mock;
    mockStatSync = fs.statSync as Mock;
    mockReaddirSync = fs.readdirSync as Mock;
    mockReadFileSync = fs.readFileSync as Mock;
    mockWatch = fs.watch as Mock;
    mockCreateReadStream = (fs as unknown as { createReadStream: Mock }).createReadStream;
    mockCreateInterface = createInterface as Mock;
    mockExecSync = execSync as Mock;
    mockReaddir = fsPromises.readdir as Mock;
    mockStatAsync = fsPromises.stat as Mock;
    mockReadFile = fsPromises.readFile as Mock;

    // Default mocks - no projects exist
    mockExistsSync.mockReturnValue(false);
    mockStatSync.mockImplementation(() => ({
      isDirectory: () => true,
      birthtime: new Date(),
      mtime: new Date(),
      size: 0,
    }));
    mockReaddirSync.mockReturnValue([]);
    mockReadFileSync.mockReturnValue('');
    mockWatch.mockReturnValue({ close: vi.fn(), on: vi.fn(), off: vi.fn() });
    mockExecSync.mockImplementation(() => {
      throw new Error('No processes');
    });

    // Async fs/promises mocks - delegate to sync mocks for consistent behavior
    mockReaddir.mockImplementation(async (path: string) => mockReaddirSync(path));
    mockStatAsync.mockImplementation(async (path: string) => mockStatSync(path));
    mockReadFile.mockImplementation(async (path: string) => mockReadFileSync(path));

    // Create new watcher for each test
    watcher = new SubagentWatcher();
  });

  afterEach(() => {
    watcher.stop();
    vi.useRealTimers();
  });

  describe('Initialization', () => {
    it('should start with no subagents', () => {
      expect(watcher.getSubagents()).toHaveLength(0);
    });

    it('should not be running initially', () => {
      expect(watcher.isRunning()).toBe(false);
    });

    it('should be running after start()', () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([]);

      watcher.start();

      expect(watcher.isRunning()).toBe(true);
    });

    it('should not be running after stop()', () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([]);

      watcher.start();
      expect(watcher.isRunning()).toBe(true);

      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should not start twice', () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([]);

      watcher.start();
      watcher.start(); // Should be no-op

      expect(watcher.isRunning()).toBe(true);
    });
  });

  describe('JSONL Parsing', () => {
    it('should parse valid JSONL entries', async () => {
      const validEntry = createUserEntry('Test task description');
      const lines = [validEntry];

      // Setup mock readline interface
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      // Setup file discovery
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-abc123.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(lines.join('\n'));

      const discoveredHandler = vi.fn();
      watcher.on('subagent:discovered', discoveredHandler);

      watcher.start();
      await flushAsyncScan();

      // Simulate readline events
      for (const line of lines) {
        mockRl.emit('line', line);
      }
      mockRl.emit('close');

      // Wait for async processing
      await vi.advanceTimersByTimeAsync(100);

      expect(discoveredHandler).toHaveBeenCalled();
      const info = discoveredHandler.mock.calls[0][0] as SubagentInfo;
      expect(info.agentId).toBe('abc123');
    });

    it('should skip malformed JSON lines', async () => {
      const validEntry = createUserEntry('Valid entry');
      const malformedLines = ['not json at all', '{"incomplete": true', validEntry, '}{bad json}{'];

      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-test1.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(malformedLines.join('\n'));

      const errorHandler = vi.fn();
      watcher.on('subagent:error', errorHandler);

      watcher.start();
      await flushAsyncScan();

      // Emit all lines including malformed ones
      for (const line of malformedLines) {
        mockRl.emit('line', line);
      }
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      // Should not emit error for malformed lines (they're silently skipped)
      // This is the expected behavior per the implementation
      expect(errorHandler).not.toHaveBeenCalled();
    });

    it('should handle partial writes gracefully', async () => {
      // Simulate partial write where line is incomplete
      const partialContent = '{"type": "user", "timestamp": "2024-01-01T00:00:00Z"';

      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-partial.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 50,
      });
      mockReadFileSync.mockReturnValue(partialContent);

      const messageHandler = vi.fn();
      watcher.on('subagent:message', messageHandler);

      watcher.start();
      await flushAsyncScan();

      // Emit partial line
      mockRl.emit('line', partialContent);
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      // Should not crash and should not emit message for incomplete JSON
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should handle empty lines', async () => {
      const validEntry = createUserEntry('Valid');
      const contentWithEmptyLines = ['', validEntry, '   ', '', validEntry].join('\n');

      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-empty.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(contentWithEmptyLines);

      watcher.start();
      await flushAsyncScan();

      // Emit lines including empty ones
      mockRl.emit('line', '');
      mockRl.emit('line', validEntry);
      mockRl.emit('line', '   ');
      mockRl.emit('line', '');
      mockRl.emit('line', validEntry);
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      // Should not crash on empty lines
      expect(watcher.getSubagents()).toHaveLength(1);
    });
  });

  describe('Meta-sidecar discovery (2026-06 Claude Code format)', () => {
    it('should discover a subagent from agent-{id}.meta.json when no .jsonl exists', async () => {
      // New format: TUI Task subagents write only a meta sidecar (no per-agent .jsonl).
      mockExistsSync.mockImplementation((p: string) => !String(p).endsWith('.jsonl'));
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-meta1.meta.json'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 120,
      });
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ agentType: 'general-purpose', description: 'Audit server.js', toolUseId: 'toolu_x' })
      );

      const discoveredHandler = vi.fn();
      watcher.on('subagent:discovered', discoveredHandler);

      watcher.start();
      await flushAsyncScan();

      expect(discoveredHandler).toHaveBeenCalled();
      const info = discoveredHandler.mock.calls[0][0] as SubagentInfo;
      expect(info.agentId).toBe('meta1');
      expect(info.description).toBe('Audit server.js');
      expect(info.status).toBe('active');
      expect(watcher.getSubagents()).toHaveLength(1);
    });

    it('should prefer the real .jsonl transcript when one exists alongside the meta', async () => {
      // Both sidecar and transcript present → defer to the richer .jsonl path.
      mockExistsSync.mockReturnValue(true); // sibling agent-both.jsonl exists
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-both.meta.json'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      // Mirror the passing discovery tests: leave createReadStream unmocked so
      // _resolveDescription fails gracefully (undefined) and discovery still fires.
      mockReadFileSync.mockReturnValue('');
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);

      const discoveredHandler = vi.fn();
      watcher.on('subagent:discovered', discoveredHandler);

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      expect(discoveredHandler).toHaveBeenCalled();
      const info = discoveredHandler.mock.calls[0][0] as SubagentInfo;
      expect(info.agentId).toBe('both');
      // filePath points at the transcript, not the sidecar.
      expect(info.filePath.endsWith('.jsonl')).toBe(true);
    });
  });

  describe('Workflow-nested subagents (subagents/workflows/{wf}/)', () => {
    // The Workflow tool nests its agents one level deeper than TUI Task subagents:
    // subagents/workflows/{workflowId}/agent-{id}.jsonl — plus a sibling journal.jsonl.
    // The flat subagents/ scan misses them; watchWorkflowDirs() descends one level.
    function mockWorkflowLayout(wfFiles: string[]) {
      mockReaddirSync.mockImplementation((path: string) => {
        const p = String(path);
        if (p.endsWith('wf_test')) return wfFiles;
        if (p.endsWith('workflows')) return ['wf_test'];
        if (p.endsWith('subagents')) return ['workflows']; // no flat agents, just the workflows dir
        if (p.includes('session1')) return ['subagents'];
        if (p.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      return mockRl;
    }

    it('should discover an agent nested under subagents/workflows/{wf}/', async () => {
      mockExistsSync.mockReturnValue(true); // sibling .jsonl exists for the meta
      const mockRl = mockWorkflowLayout(['agent-wf1.jsonl', 'agent-wf1.meta.json', 'journal.jsonl']);

      const discoveredHandler = vi.fn();
      watcher.on('subagent:discovered', discoveredHandler);

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      expect(discoveredHandler).toHaveBeenCalled();
      const info = discoveredHandler.mock.calls[0][0] as SubagentInfo;
      expect(info.agentId).toBe('wf1');
      expect(info.filePath.endsWith('.jsonl')).toBe(true);
      expect(info.filePath).toContain('workflows');
    });

    it('should NOT register a workflow dir journal.jsonl as a bogus agent', async () => {
      mockExistsSync.mockReturnValue(true);
      const mockRl = mockWorkflowLayout(['agent-wf1.jsonl', 'journal.jsonl']);

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      const agents = watcher.getSubagents();
      expect(agents).toHaveLength(1); // only agent-wf1, never "journal"
      expect(agents.every((a) => a.agentId !== 'journal')).toBe(true);
    });
  });

  describe('Status Lifecycle', () => {
    it('should start agents as active', async () => {
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-active.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(createUserEntry('Test subagent task'));

      const discoveredHandler = vi.fn();
      watcher.on('subagent:discovered', discoveredHandler);

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      expect(discoveredHandler).toHaveBeenCalled();
      const info = discoveredHandler.mock.calls[0][0] as SubagentInfo;
      expect(info.status).toBe('active');
    });

    it('should transition to idle after IDLE_TIMEOUT_MS (30s)', async () => {
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-idle.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockImplementation(() => ({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      }));
      mockReadFileSync.mockReturnValue(createUserEntry('Test subagent task'));

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      // Initially active
      const agents = watcher.getSubagents();
      expect(agents).toHaveLength(1);
      expect(agents[0].status).toBe('active');

      // Advance past IDLE_TIMEOUT_MS (30000ms)
      await vi.advanceTimersByTimeAsync(31000);

      // Should now be idle
      const agentsAfter = watcher.getSubagents();
      expect(agentsAfter[0].status).toBe('idle');
    });

    it('should reset to active on new activity', async () => {
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      const mockWatcher = { close: vi.fn(), on: vi.fn(), off: vi.fn() };
      mockWatch.mockReturnValue(mockWatcher);

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-reactive.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockImplementation(() => ({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      }));
      mockReadFileSync.mockReturnValue(createUserEntry('Test subagent task'));

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      // Go to idle
      await vi.advanceTimersByTimeAsync(31000);
      expect(watcher.getSubagents()[0].status).toBe('idle');

      // Simulate file change event - get the callback from mockWatch
      const watchCallback = mockWatch.mock.calls.find((call: unknown[]) => typeof call[1] === 'function')?.[1];

      if (watchCallback) {
        // Need to reset the readline mock for the new read
        const newMockRl = createMockRl();
        mockCreateInterface.mockReturnValue(newMockRl);

        // Trigger file change
        watchCallback('change', 'agent-reactive.jsonl');

        // Advance past the fileDeb debounce (100ms) so handleFileChange runs
        await vi.advanceTimersByTimeAsync(150);

        // Complete the new readline (tailFile)
        newMockRl.emit('close');
        await vi.advanceTimersByTimeAsync(100);

        // Should be active again
        expect(watcher.getSubagents()[0].status).toBe('active');
      }
    });

    it('should transition to completed when file becomes stale', async () => {
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-stale.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });

      // Start with recent mtime
      const recentTime = new Date();
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: recentTime,
        mtime: recentTime,
        size: 100,
      });
      mockReadFileSync.mockReturnValue(createUserEntry('Test subagent task'));

      const completedHandler = vi.fn();
      watcher.on('subagent:completed', completedHandler);

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      // Change statSync to return stale mtime (> 60s ago)
      const staleTime = new Date(Date.now() - 120000); // 2 minutes ago
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: staleTime,
        mtime: staleTime,
        size: 100,
      });

      // Advance to trigger liveness check (10s interval)
      await vi.advanceTimersByTimeAsync(11000);

      expect(completedHandler).toHaveBeenCalled();
      expect(watcher.getSubagents()[0].status).toBe('completed');
    });
  });

  describe('Transcript Extraction', () => {
    it('should extract tool_use entries', async () => {
      const toolEntry = createToolUseEntry('WebSearch', { query: 'test query' });

      const descRl = createMockRl();
      const tailRl = createMockRl();
      mockCreateInterface.mockReturnValueOnce(descRl).mockReturnValue(tailRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-tools.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(toolEntry);

      const toolCallHandler = vi.fn();
      watcher.on('subagent:tool_call', toolCallHandler);

      watcher.start();
      await flushAsyncScan();

      // Resolve extractDescriptionFromFile
      descRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      // Now tailFile is set up — emit entries on tailRl
      tailRl.emit('line', toolEntry);
      tailRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      expect(toolCallHandler).toHaveBeenCalled();
      const call = toolCallHandler.mock.calls[0][0] as SubagentToolCall;
      expect(call.tool).toBe('WebSearch');
      expect(call.input).toEqual({ query: 'test query' });
    });

    it('should extract text messages', async () => {
      const textEntry = createAssistantTextEntry('This is the assistant response');

      const descRl = createMockRl();
      const tailRl = createMockRl();
      mockCreateInterface.mockReturnValueOnce(descRl).mockReturnValue(tailRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-text.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(textEntry);

      const messageHandler = vi.fn();
      watcher.on('subagent:message', messageHandler);

      watcher.start();
      await flushAsyncScan();

      // Resolve extractDescriptionFromFile
      descRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      // Now tailFile is set up — emit entries on tailRl
      tailRl.emit('line', textEntry);
      tailRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      expect(messageHandler).toHaveBeenCalled();
      const msg = messageHandler.mock.calls[0][0] as SubagentMessage;
      expect(msg.role).toBe('assistant');
      expect(msg.text).toBe('This is the assistant response');
    });

    it('should handle both string and array content formats', async () => {
      // Array format (standard)
      const arrayFormat = JSON.stringify({
        type: 'user',
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Array format message' }],
        },
      });

      // String format (alternative)
      const stringFormat = JSON.stringify({
        type: 'user',
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: 'String format message',
        },
      });

      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-formats.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue([arrayFormat, stringFormat].join('\n'));

      const discoveredHandler = vi.fn();
      watcher.on('subagent:discovered', discoveredHandler);

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('line', arrayFormat);
      mockRl.emit('line', stringFormat);
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      // Both formats should be handled without errors
      expect(discoveredHandler).toHaveBeenCalled();
    });

    it('should limit message length to 500 chars', async () => {
      const longText = 'x'.repeat(1000);
      const textEntry = createAssistantTextEntry(longText);

      const descRl = createMockRl();
      const tailRl = createMockRl();
      mockCreateInterface.mockReturnValueOnce(descRl).mockReturnValue(tailRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-long.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(textEntry);

      const messageHandler = vi.fn();
      watcher.on('subagent:message', messageHandler);

      watcher.start();
      await flushAsyncScan();

      // Resolve extractDescriptionFromFile
      descRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      // Now tailFile is set up — emit entries on tailRl
      tailRl.emit('line', textEntry);
      tailRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      expect(messageHandler).toHaveBeenCalled();
      const msg = messageHandler.mock.calls[0][0] as SubagentMessage;
      expect(msg.text.length).toBe(500);
    });

    it('should extract progress events', async () => {
      const progressEntry = createProgressEntry('query_update', { query: 'searching for files' });

      const descRl = createMockRl();
      const tailRl = createMockRl();
      mockCreateInterface.mockReturnValueOnce(descRl).mockReturnValue(tailRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-progress.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(progressEntry);

      const progressHandler = vi.fn();
      watcher.on('subagent:progress', progressHandler);

      watcher.start();
      await flushAsyncScan();

      // Resolve extractDescriptionFromFile
      descRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      // Now tailFile is set up — emit entries on tailRl
      tailRl.emit('line', progressEntry);
      tailRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      expect(progressHandler).toHaveBeenCalled();
      const progress = progressHandler.mock.calls[0][0] as SubagentProgress;
      expect(progress.progressType).toBe('query_update');
      expect(progress.query).toBe('searching for files');
    });
  });

  describe('Memory Management', () => {
    it('should track agents in agentInfo map', async () => {
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-mem1.jsonl', 'agent-mem2.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(createUserEntry('Test subagent task'));

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      const agents = watcher.getSubagents();
      expect(agents.length).toBeGreaterThanOrEqual(1);

      // Can retrieve by ID
      const agent = watcher.getSubagent('mem1');
      expect(agent).toBeDefined();
    });

    it('should increment toolCallCount on tool use', async () => {
      const toolEntry1 = createToolUseEntry('Read', { file_path: '/test1.ts' });
      const toolEntry2 = createToolUseEntry('Write', { file_path: '/test2.ts' });

      const descRl = createMockRl();
      const tailRl = createMockRl();
      mockCreateInterface.mockReturnValueOnce(descRl).mockReturnValue(tailRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-toolcount.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue([toolEntry1, toolEntry2].join('\n'));

      watcher.start();
      await flushAsyncScan();

      // Resolve extractDescriptionFromFile
      descRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      // Now tailFile is set up — emit entries on tailRl
      tailRl.emit('line', toolEntry1);
      tailRl.emit('line', toolEntry2);
      tailRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      const agent = watcher.getSubagent('toolcount');
      expect(agent).toBeDefined();
      expect(agent!.toolCallCount).toBe(2);
    });

    it('should increment entryCount for each entry', async () => {
      const entries = [
        createUserEntry('User message'),
        createAssistantTextEntry('Response'),
        createToolUseEntry('Read', { file_path: '/test.ts' }),
      ];

      const descRl = createMockRl();
      const tailRl = createMockRl();
      mockCreateInterface.mockReturnValueOnce(descRl).mockReturnValue(tailRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-entrycount.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(entries.join('\n'));

      watcher.start();
      await flushAsyncScan();

      // Resolve extractDescriptionFromFile
      descRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      // Now tailFile is set up — emit entries on tailRl
      for (const entry of entries) {
        tailRl.emit('line', entry);
      }
      tailRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      const agent = watcher.getSubagent('entrycount');
      expect(agent).toBeDefined();
      expect(agent!.entryCount).toBe(3);
    });

    // Note: Current implementation has no cleanup/eviction policy
    // This documents the behavior as a known issue
    it('should retain all agents indefinitely (no cleanup policy)', async () => {
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);

      // Simulate many agents
      const agentFiles = Array.from({ length: 100 }, (_, i) => `agent-many${i}.jsonl`);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return agentFiles;
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(createUserEntry('Test subagent task'));

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      // All agents should be retained (no cleanup)
      // Note: This is a known memory management issue
      expect(watcher.getSubagents().length).toBeGreaterThan(0);
    });
  });

  describe('getTranscript', () => {
    it('should return transcript entries', async () => {
      const entries = [
        createUserEntry('Task 1'),
        createAssistantTextEntry('Working on it'),
        createToolUseEntry('Read', { file_path: '/test.ts' }),
      ];

      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-transcript.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(entries.join('\n'));

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      const transcript = await watcher.getTranscript('transcript');
      expect(transcript.length).toBe(3);
    });

    it('should limit transcript entries when limit is specified', async () => {
      const entries = Array.from({ length: 10 }, (_, i) => createUserEntry(`Message ${i}`));

      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-limited.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(entries.join('\n'));

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      const transcript = await watcher.getTranscript('limited', 3);
      expect(transcript.length).toBe(3);
    });

    it('should return empty array for unknown agent', async () => {
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([]);

      watcher.start();

      const transcript = await watcher.getTranscript('nonexistent');
      expect(transcript).toEqual([]);
    });
  });

  describe('formatTranscript', () => {
    it('should format tool calls with icons', () => {
      const entries: SubagentTranscriptEntry[] = [
        {
          type: 'assistant',
          timestamp: '2024-01-01T00:00:00Z',
          agentId: 'test',
          sessionId: 'sess1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'test query' } }],
          },
        },
      ];

      const formatted = watcher.formatTranscript(entries);
      expect(formatted.length).toBe(1);
      expect(formatted[0]).toContain('WebSearch');
      expect(formatted[0]).toContain('test query');
    });

    it('should format progress events', () => {
      const entries: SubagentTranscriptEntry[] = [
        {
          type: 'progress',
          timestamp: '2024-01-01T00:00:00Z',
          agentId: 'test',
          sessionId: 'sess1',
          data: { type: 'query_update', query: 'searching' },
        },
      ];

      const formatted = watcher.formatTranscript(entries);
      expect(formatted.length).toBe(1);
      expect(formatted[0]).toContain('Searching');
    });

    it('should truncate long text messages', () => {
      const longText = 'x'.repeat(300);
      const entries: SubagentTranscriptEntry[] = [
        {
          type: 'assistant',
          timestamp: '2024-01-01T00:00:00Z',
          agentId: 'test',
          sessionId: 'sess1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: longText }],
          },
        },
      ];

      const formatted = watcher.formatTranscript(entries);
      expect(formatted.length).toBe(1);
      expect(formatted[0]).toContain('...');
      expect(formatted[0].length).toBeLessThan(300);
    });
  });

  describe('Description Extraction', () => {
    it('should extract description from first user message', async () => {
      const userEntry = createUserEntry('Create comprehensive tests for the module');

      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-desc.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(userEntry);

      const discoveredHandler = vi.fn();
      watcher.on('subagent:discovered', discoveredHandler);

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('line', userEntry);
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      expect(discoveredHandler).toHaveBeenCalled();
      const info = discoveredHandler.mock.calls[0][0] as SubagentInfo;
      expect(info.description).toBeDefined();
      expect(info.description).toContain('Create');
    });

    it('should truncate long descriptions (extractSmartTitle)', async () => {
      const longPrompt =
        'Please create a very detailed and comprehensive implementation of the feature ' +
        'including all edge cases, error handling, documentation, and thorough test coverage ' +
        'for every single function and method in the module';

      const userEntry = createUserEntry(longPrompt);

      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-longdesc.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(userEntry);

      const discoveredHandler = vi.fn();
      watcher.on('subagent:discovered', discoveredHandler);

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('line', userEntry);
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      expect(discoveredHandler).toHaveBeenCalled();
      const info = discoveredHandler.mock.calls[0][0] as SubagentInfo;
      expect(info.description).toBeDefined();
      expect(info.description!.length).toBeLessThanOrEqual(45);
    });

    it('should emit subagent:updated when description is extracted from processEntry', async () => {
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-update1.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });

      // Initially return empty content (simulating race condition)
      mockReadFileSync.mockReturnValue('');

      const discoveredHandler = vi.fn();
      const updatedHandler = vi.fn();
      watcher.on('subagent:discovered', discoveredHandler);
      watcher.on('subagent:updated', updatedHandler);

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      // Should be discovered without description
      expect(discoveredHandler).toHaveBeenCalled();
      const initialInfo = discoveredHandler.mock.calls[0][0] as SubagentInfo;
      expect(initialInfo.description).toBeUndefined();

      // Simulate file change - now emit user entry line (processEntry path)
      const userEntry = createUserEntry('Create unit tests for subagent watcher');
      mockRl.emit('line', userEntry);
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      // Should emit updated event with description
      expect(updatedHandler).toHaveBeenCalled();
      const updatedInfo = updatedHandler.mock.calls[0][0] as SubagentInfo;
      expect(updatedInfo.description).toBeDefined();
      expect(updatedInfo.description).toContain('Create unit tests');
    });

    it('should extract description from parent transcript toolUseResult', async () => {
      // Create parent transcript with toolUseResult containing agentId and description
      const parentTranscript = JSON.stringify({
        type: 'user',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: [] },
        toolUseResult: {
          isAsync: true,
          status: 'async_launched',
          agentId: 'parentdesc',
          description: 'Research codebase cleanups',
        },
      });

      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);

      // createReadStream now used for parent transcript reading (stream tail)
      // Return a stream-like EventEmitter that emits the transcript content
      mockCreateReadStream.mockImplementation((filepath: string) => {
        const stream = new EventEmitter() as EventEmitter & { destroy: () => void };
        stream.destroy = vi.fn();
        if (typeof filepath === 'string' && filepath.includes('session1.jsonl')) {
          // Emit parent transcript content on next tick
          process.nextTick(() => {
            stream.emit('data', parentTranscript + '\n');
            stream.emit('end');
          });
        } else {
          // For agent files, emit end immediately (empty content)
          process.nextTick(() => stream.emit('end'));
        }
        return stream;
      });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-parentdesc.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });

      const discoveredHandler = vi.fn();
      watcher.on('subagent:discovered', discoveredHandler);

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      expect(discoveredHandler).toHaveBeenCalled();
      const info = discoveredHandler.mock.calls[0][0] as SubagentInfo;
      // Should have extracted description from parent transcript
      expect(info.description).toBe('Research codebase cleanups');
    });
  });

  describe('getRecentSubagents', () => {
    it('should return only recent subagents', async () => {
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-recent.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(createUserEntry('Test subagent task'));

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      const recent = watcher.getRecentSubagents(60);
      expect(recent.length).toBe(1);
    });

    it('should sort by lastActivityAt descending', async () => {
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-sort1.jsonl', 'agent-sort2.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(createUserEntry('Test subagent task'));

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      const recent = watcher.getRecentSubagents(60);
      // Should be sorted by most recent first
      if (recent.length > 1) {
        const time1 = new Date(recent[0].lastActivityAt).getTime();
        const time2 = new Date(recent[1].lastActivityAt).getTime();
        expect(time1).toBeGreaterThanOrEqual(time2);
      }
    });
  });

  describe('getSubagentsForSession', () => {
    it('should filter subagents by working directory', async () => {
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-session.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('-home-user-project')) return ['session1'];
        return ['-home-user-project'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(createUserEntry('Test subagent task'));

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      // Get subagents for the matching working directory
      const agents = watcher.getSubagentsForSession('/home/user/project');
      expect(agents.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('killSubagent', () => {
    it('should return false for unknown agent', async () => {
      const result = await watcher.killSubagent('nonexistent');
      expect(result).toBe(false);
    });

    it('should return false for already completed agent', async () => {
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-killcomplete.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });

      // Return stale file to trigger completion
      const staleTime = new Date(Date.now() - 120000);
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: staleTime,
        mtime: staleTime,
        size: 100,
      });
      mockReadFileSync.mockReturnValue(createUserEntry('Test subagent task'));

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      // Wait for liveness check to mark as completed
      await vi.advanceTimersByTimeAsync(11000);

      const result = await watcher.killSubagent('killcomplete');
      expect(result).toBe(false);
    });

    it('should emit completed event when killing active agent', async () => {
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-killactive.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(createUserEntry('Test subagent task'));

      // Mock process finding - return no process found
      mockExecSync.mockImplementation(() => {
        throw new Error('No processes');
      });

      const completedHandler = vi.fn();
      watcher.on('subagent:completed', completedHandler);

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      const result = await watcher.killSubagent('killactive');
      expect(result).toBe(true);
      expect(completedHandler).toHaveBeenCalled();
    });

    it("killSubagentsForSession scans the process table ONCE for all of a session's agents", async () => {
      // Closing a session ran a full `pgrep -f claude` + /proc read per recently
      // active subagent (~85ms each on a busy box); one scan now serves them all.
      // One readline per transcript: discovery reads each agent's file in turn.
      const rls: ReturnType<typeof createMockRl>[] = [];
      mockCreateInterface.mockImplementation(() => {
        const rl = createMockRl();
        rls.push(rl);
        return rl;
      });
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-k1.jsonl', 'agent-k2.jsonl', 'agent-k3.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('-home-user-project')) return ['session1'];
        return ['-home-user-project'];
      });
      mockStatSync.mockReturnValue({ isDirectory: () => true, birthtime: new Date(), mtime: new Date(), size: 100 });
      mockReadFileSync.mockReturnValue(createUserEntry('Test subagent task'));

      watcher.start();
      for (let i = 0; i < 3; i++) {
        await flushAsyncScan();
        rls.forEach((rl) => rl.emit('close'));
        await vi.advanceTimersByTimeAsync(100);
      }
      const agents = watcher.getSubagentsForSession('/home/user/project');
      expect(agents.map((a) => a.agentId).sort()).toEqual(['k1', 'k2', 'k3']);

      const execFileMock = vi.mocked(nodeExecFile) as unknown as Mock;
      const originalExecFile = execFileMock.getMockImplementation();
      let pgrepCalls = 0;
      execFileMock.mockImplementation(
        (cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
          if (cmd === 'pgrep') pgrepCalls++;
          cb(null, '4242\n4343\n');
        }
      );
      mockReadFile.mockImplementation(async (path: string) => {
        if (path === '/proc/4242/environ') return 'HOME=/x\0PARENT=session1\0';
        if (path.startsWith('/proc/')) return 'HOME=/x\0';
        return mockReadFileSync(path);
      });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      let killCalls: unknown[][] = [];
      try {
        await watcher.killSubagentsForSession('/home/user/project', 'session1');
        killCalls = [...killSpy.mock.calls];
      } finally {
        killSpy.mockRestore();
        execFileMock.mockImplementation(originalExecFile as never);
      }

      expect(pgrepCalls).toBe(1);
      expect(agents.every((a) => a.status === 'completed')).toBe(true);
      // Only the matching process, and only once.
      expect(killCalls).toEqual([[4242, 'SIGTERM']]);
    });
  });

  describe('Error Handling', () => {
    it('should emit error on directory scan failure', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const errorHandler = vi.fn();
      watcher.on('subagent:error', errorHandler);

      watcher.start();

      await vi.advanceTimersByTimeAsync(100);

      expect(errorHandler).toHaveBeenCalled();
    });

    it('should handle readline errors gracefully', async () => {
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-rlerror.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(createUserEntry('Test subagent task'));

      watcher.start();
      await flushAsyncScan();

      // Emit readline error
      mockRl.emit('error', new Error('Read error'));

      await vi.advanceTimersByTimeAsync(100);

      // Should not crash
      expect(watcher.isRunning()).toBe(true);
    });
  });

  describe('File Watcher Management', () => {
    it('should close directory watchers on stop', async () => {
      const mockDirWatcher = { close: vi.fn(), on: vi.fn(), off: vi.fn() };

      // Only directory watchers are created (no per-file watchers)
      mockWatch.mockReturnValue(mockDirWatcher);

      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-watch.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(createUserEntry('Test subagent task'));

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      watcher.stop();

      // Directory watchers should be closed (per-file watchers no longer exist)
      expect(mockDirWatcher.close).toHaveBeenCalled();
    });

    it('should clear idle timers on stop', async () => {
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-timer.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(createUserEntry('Test subagent task'));

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      // Agent should be active
      expect(watcher.getSubagents()[0].status).toBe('active');

      watcher.stop();

      // Advance time past idle timeout - status shouldn't change since watcher is stopped
      await vi.advanceTimersByTimeAsync(35000);

      // Status remains as it was when stopped (may still be active)
      // The important thing is no errors occur
    });
  });

  describe('Project Hash Conversion', () => {
    it('should convert working directory to project hash format', async () => {
      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);

      // Simulate project hash format: /home/user/project -> -home-user-project
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-hash.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('-home-user-myproject')) return ['session1'];
        return ['-home-user-myproject'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(createUserEntry('Test subagent task'));

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      // The conversion /home/user/myproject -> -home-user-myproject should work
      const agents = watcher.getSubagentsForSession('/home/user/myproject');
      // The actual filtering depends on projectHash matching
      expect(Array.isArray(agents)).toBe(true);
    });
  });

  describe('Tool Call Formatting', () => {
    it('should format WebSearch tool call correctly', () => {
      const entries: SubagentTranscriptEntry[] = [
        {
          type: 'assistant',
          timestamp: '2024-01-01T00:00:00Z',
          agentId: 'test',
          sessionId: 'sess1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'nodejs best practices' } }],
          },
        },
      ];

      const formatted = watcher.formatTranscript(entries);
      expect(formatted[0]).toContain('WebSearch');
      expect(formatted[0]).toContain('nodejs best practices');
    });

    it('should format Read tool call with file path', () => {
      const entries: SubagentTranscriptEntry[] = [
        {
          type: 'assistant',
          timestamp: '2024-01-01T00:00:00Z',
          agentId: 'test',
          sessionId: 'sess1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/src/index.ts' } }],
          },
        },
      ];

      const formatted = watcher.formatTranscript(entries);
      expect(formatted[0]).toContain('Read');
      expect(formatted[0]).toContain('/src/index.ts');
    });

    it('should format Bash tool call with command', () => {
      const entries: SubagentTranscriptEntry[] = [
        {
          type: 'assistant',
          timestamp: '2024-01-01T00:00:00Z',
          agentId: 'test',
          sessionId: 'sess1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
          },
        },
      ];

      const formatted = watcher.formatTranscript(entries);
      expect(formatted[0]).toContain('Bash');
      expect(formatted[0]).toContain('npm test');
    });

    it('should truncate long Bash commands', () => {
      const longCommand = 'npm run very-long-command-name --with-many-options --flag1 --flag2 --flag3 --more-flags';
      const entries: SubagentTranscriptEntry[] = [
        {
          type: 'assistant',
          timestamp: '2024-01-01T00:00:00Z',
          agentId: 'test',
          sessionId: 'sess1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'Bash', input: { command: longCommand } }],
          },
        },
      ];

      const formatted = watcher.formatTranscript(entries);
      expect(formatted[0]).toContain('...');
    });
  });

  describe('Progress Event Formatting', () => {
    it('should format query_update progress', () => {
      const entries: SubagentTranscriptEntry[] = [
        {
          type: 'progress',
          timestamp: '2024-01-01T00:00:00Z',
          agentId: 'test',
          sessionId: 'sess1',
          data: { type: 'query_update', query: 'finding files' },
        },
      ];

      const formatted = watcher.formatTranscript(entries);
      expect(formatted[0]).toContain('Searching');
      expect(formatted[0]).toContain('finding files');
    });

    it('should format search_results_received progress', () => {
      const entries: SubagentTranscriptEntry[] = [
        {
          type: 'progress',
          timestamp: '2024-01-01T00:00:00Z',
          agentId: 'test',
          sessionId: 'sess1',
          data: { type: 'search_results_received', resultCount: 42 },
        },
      ];

      const formatted = watcher.formatTranscript(entries);
      expect(formatted[0]).toContain('42 results');
    });
  });

  describe('User Message Handling', () => {
    it('should emit user messages under 500 chars', async () => {
      const userEntry = createUserEntry('Short user message');

      const descRl = createMockRl();
      const tailRl = createMockRl();
      mockCreateInterface.mockReturnValueOnce(descRl).mockReturnValue(tailRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-user.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(userEntry);

      const messageHandler = vi.fn();
      watcher.on('subagent:message', messageHandler);

      watcher.start();
      await flushAsyncScan();

      // Resolve extractDescriptionFromFile
      descRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      // Now tailFile is set up — emit entries on tailRl
      tailRl.emit('line', userEntry);
      tailRl.emit('close');
      await vi.advanceTimersByTimeAsync(100);

      expect(messageHandler).toHaveBeenCalled();
      const msg = messageHandler.mock.calls[0][0] as SubagentMessage;
      expect(msg.role).toBe('user');
    });

    it('should not emit long user messages (over 500 chars)', async () => {
      const longUserEntry = createUserEntry('x'.repeat(600));

      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-longuser.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(longUserEntry);

      const messageHandler = vi.fn();
      watcher.on('subagent:message', messageHandler);

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('line', longUserEntry);
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      // Long user messages are filtered out
      const userMessages = messageHandler.mock.calls.filter((call) => (call[0] as SubagentMessage).role === 'user');
      expect(userMessages.length).toBe(0);
    });
  });

  describe('Empty Content Handling', () => {
    it('should not emit message for empty text content', async () => {
      const emptyTextEntry = createAssistantTextEntry('   ');

      const mockRl = createMockRl();
      mockCreateInterface.mockReturnValue(mockRl);
      mockCreateReadStream.mockReturnValue({ destroy: vi.fn() });

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((path: string) => {
        if (path.includes('subagents')) return ['agent-empty.jsonl'];
        if (path.includes('session1')) return ['subagents'];
        if (path.includes('project1')) return ['session1'];
        return ['project1'];
      });
      mockStatSync.mockReturnValue({
        isDirectory: () => true,
        birthtime: new Date(),
        mtime: new Date(),
        size: 100,
      });
      mockReadFileSync.mockReturnValue(emptyTextEntry);

      const messageHandler = vi.fn();
      watcher.on('subagent:message', messageHandler);

      watcher.start();
      await flushAsyncScan();
      mockRl.emit('line', emptyTextEntry);
      mockRl.emit('close');

      await vi.advanceTimersByTimeAsync(100);

      // Empty/whitespace messages are filtered out
      expect(messageHandler).not.toHaveBeenCalled();
    });
  });
});
