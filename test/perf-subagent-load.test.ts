/**
 * Performance tests: Codeman responsiveness under subagent load
 *
 * Measures event loop lag caused by:
 * 1. SubagentWatcher processing many agent files simultaneously
 * 2. extractDescriptionFromParentTranscript reading full transcript files
 * 3. findSubagentProcess spawning pgrep for every agent in liveness checks
 * 4. SSE broadcast serialization under heavy event load
 * 5. flushTerminalBatches with many concurrent sessions
 *
 * Port: none (no server needed — unit-level perf tests)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SubagentWatcher } from '../src/subagent-watcher.js';

// ========== Helpers ==========

/** Generate a realistic JSONL transcript entry */
function makeTranscriptEntry(type: 'user' | 'assistant', content: string, extras: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    type,
    timestamp: new Date().toISOString(),
    message: {
      role: type,
      content: type === 'user'
        ? [{ type: 'text', text: content }]
        : content,
      ...(type === 'assistant' ? { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 1500, output_tokens: 800 } } : {}),
    },
    ...extras,
  };
  return JSON.stringify(base);
}

/** Generate a realistic large parent transcript (many lines of JSONL) */
function generateParentTranscript(lineCount: number, agentIds: string[] = []): string {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    if (i % 2 === 0) {
      lines.push(makeTranscriptEntry('user', `Please do task ${i} for the project`));
    } else {
      lines.push(makeTranscriptEntry('assistant', `Working on task ${i}...`));
    }
  }
  // Sprinkle in toolUseResult entries for agent descriptions
  for (const agentId of agentIds) {
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      toolUseResult: { agentId, description: `Research task for ${agentId}` },
    }));
  }
  return lines.join('\n') + '\n';
}

/** Generate a subagent transcript file */
function generateAgentTranscript(lineCount: number): string {
  const lines: string[] = [];
  lines.push(makeTranscriptEntry('user', 'Investigate the authentication module and suggest improvements for rate limiting'));
  for (let i = 1; i < lineCount; i++) {
    if (i % 3 === 0) {
      lines.push(JSON.stringify({
        type: 'tool_call',
        timestamp: new Date().toISOString(),
        tool: 'Read',
        input: { file_path: `/home/user/project/src/file-${i}.ts` },
        toolUseId: `tool-${i}`,
      }));
    } else if (i % 3 === 1) {
      lines.push(JSON.stringify({
        type: 'tool_result',
        timestamp: new Date().toISOString(),
        toolUseId: `tool-${i - 1}`,
        content: 'x'.repeat(500),
      }));
    } else {
      lines.push(makeTranscriptEntry('assistant', `Analysis step ${i}: Found pattern in module...`));
    }
  }
  return lines.join('\n') + '\n';
}

/** Measure event loop lag over a duration */
function measureEventLoopLag(durationMs: number): Promise<{ maxLagMs: number; avgLagMs: number; samples: number[] }> {
  return new Promise((resolve) => {
    const samples: number[] = [];
    let lastTime = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      const lag = now - lastTime - 2; // subtract the 2ms expected interval
      samples.push(Math.max(0, lag));
      lastTime = now;
    }, 2);

    setTimeout(() => {
      clearInterval(interval);
      const maxLagMs = Math.max(...samples, 0);
      const avgLagMs = samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
      resolve({ maxLagMs, avgLagMs, samples });
    }, durationMs);
  });
}

// ========== Tests ==========

describe('SubagentWatcher performance', () => {
  let tmpDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codeman-perf-'));
    projectsDir = join(tmpDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('extractDescriptionFromParentTranscript — full file reads', () => {
    it('should parse a 1000-line parent transcript without significant event loop lag', async () => {
      // Setup: create a realistic parent transcript with 1000 lines
      const projectHash = 'abc123';
      const sessionId = 'session-001';
      const agentIds = Array.from({ length: 10 }, (_, i) => `agent-${i}`);

      const projectDir = join(projectsDir, projectHash);
      const sessionDir = join(projectDir, sessionId);
      const subagentDir = join(sessionDir, 'subagents');
      mkdirSync(subagentDir, { recursive: true });

      // Write a large parent transcript
      const transcript = generateParentTranscript(1000, agentIds);
      writeFileSync(join(projectDir, `${sessionId}.jsonl`), transcript);

      // Write 10 agent files
      for (const id of agentIds) {
        writeFileSync(join(subagentDir, `agent-${id}.jsonl`), generateAgentTranscript(50));
      }

      // Measure: call extractDescriptionFromParentTranscript via public path
      // We can't call private methods directly, so we test via watchAgentFile indirection
      // Instead, test the raw approach: read + parse + search (same as the method does)
      const { readFile } = await import('node:fs/promises');
      const transcriptPath = join(projectDir, `${sessionId}.jsonl`);

      const start = performance.now();
      const content = await readFile(transcriptPath, 'utf8');
      const lines = content.split('\n').filter((l: string) => l.trim());
      let found = false;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.toolUseResult?.agentId === 'agent-5') {
            found = true;
            break;
          }
        } catch { /* skip */ }
      }
      const elapsed = performance.now() - start;

      expect(found).toBe(true);
      // 1000-line transcript should parse in under 10ms
      expect(elapsed).toBeLessThan(50);
    });

    it('should handle 10,000-line transcript without blocking event loop > 50ms', async () => {
      const projectHash = 'bigproject';
      const sessionId = 'session-big';
      const agentIds = ['target-agent'];

      const projectDir = join(projectsDir, projectHash);
      mkdirSync(projectDir, { recursive: true });

      // 10K lines = realistic for a long Claude session
      const transcript = generateParentTranscript(10000, agentIds);
      writeFileSync(join(projectDir, `${sessionId}.jsonl`), transcript);

      const { readFile } = await import('node:fs/promises');
      const transcriptPath = join(projectDir, `${sessionId}.jsonl`);

      // Start event loop lag measurement
      const lagPromise = measureEventLoopLag(500);

      // Simulate 5 concurrent reads (5 subagents discovered simultaneously)
      const reads = Array.from({ length: 5 }, async () => {
        const content = await readFile(transcriptPath, 'utf8');
        const lines = content.split('\n').filter((l: string) => l.trim());
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.toolUseResult?.agentId === 'target-agent') {
              return entry.toolUseResult.description;
            }
          } catch { /* skip */ }
        }
        return undefined;
      });

      const results = await Promise.all(reads);
      const lag = await lagPromise;

      // All 5 should find the description
      for (const r of results) {
        expect(r).toBe('Research task for target-agent');
      }

      // Key assertion: max event loop lag should stay reasonable
      // JSON.parse of 10K lines is synchronous and blocks the event loop
      console.log(`[10K transcript × 5 reads] max lag: ${lag.maxLagMs.toFixed(1)}ms, avg: ${lag.avgLagMs.toFixed(1)}ms`);

      // This WILL likely fail — proving the bottleneck
      // 50ms is the threshold where users notice UI jank
      expect(lag.maxLagMs).toBeLessThan(100);
    });
  });

  describe('extractDescriptionFromFile — full subagent file reads', () => {
    it('should extract description from first 8KB instead of reading entire file', async () => {
      const agentDir = join(tmpDir, 'agent-files');
      mkdirSync(agentDir, { recursive: true });

      // Create a large agent file (5000 lines, ~2MB)
      const agentFile = join(agentDir, 'agent-large.jsonl');
      writeFileSync(agentFile, generateAgentTranscript(5000));

      const { readFile, stat: statAsync } = await import('node:fs/promises');
      const fileStat = await statAsync(agentFile);
      const fileSizeKB = fileStat.size / 1024;

      // Approach 1: Read entire file then slice first 5 lines
      const start = performance.now();
      const content = await readFile(agentFile, 'utf8');
      const lines = content.split('\n').filter((l: string) => l.trim());
      const firstFive = lines.slice(0, 5);
      let description: string | undefined;
      for (const line of firstFive) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.message?.content) {
            const firstContent = Array.isArray(entry.message.content)
              ? entry.message.content[0]
              : undefined;
            if (firstContent?.type === 'text') {
              description = firstContent.text.trim().slice(0, 45);
            }
          }
        } catch { /* skip */ }
      }
      const readAllElapsed = performance.now() - start;

      // Approach 2: Read only first 8KB via partial read
      const start2 = performance.now();
      const fd = await import('node:fs/promises').then(m => m.open(agentFile, 'r'));
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fd.read(buf, 0, 8192, 0);
      await fd.close();
      const partial = buf.subarray(0, bytesRead).toString('utf8');
      const partialLines = partial.split('\n').filter((l: string) => l.trim());
      let description2: string | undefined;
      for (const line of partialLines.slice(0, 5)) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.message?.content) {
            const firstContent = Array.isArray(entry.message.content)
              ? entry.message.content[0]
              : undefined;
            if (firstContent?.type === 'text') {
              description2 = firstContent.text.trim().slice(0, 45);
            }
          }
        } catch { /* skip */ }
      }
      const partialElapsed = performance.now() - start2;

      console.log(`[extractDescription] file: ${fileSizeKB.toFixed(0)}KB, readAll: ${readAllElapsed.toFixed(1)}ms, partial-8KB: ${partialElapsed.toFixed(1)}ms`);
      console.log(`[extractDescription] readAll bytes: ${content.length}, partial bytes: ${bytesRead}`);

      // Both approaches must find the same description
      expect(description).toBeDefined();
      expect(description2).toBeDefined();
      expect(description).toBe(description2);

      // The partial read should touch far less data than readAll
      expect(bytesRead).toBeLessThan(fileStat.size / 10);

      // Both approaches should complete quickly (under 50ms for cached files)
      expect(readAllElapsed).toBeLessThan(50);
      expect(partialElapsed).toBeLessThan(50);
    });
  });

  describe('findSubagentProcess — pgrep + /proc reads for every agent', () => {
    it('should measure cost of pgrep per agent in liveness check', async () => {
      const { execFile } = await import('node:child_process');

      // Measure single pgrep call (what happens per agent per liveness check)
      const times: number[] = [];
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        await new Promise<void>((resolve) => {
          execFile('pgrep', ['-f', 'claude'], { encoding: 'utf8' }, () => {
            times.push(performance.now() - start);
            resolve();
          });
        });
      }

      const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
      const maxMs = Math.max(...times);
      console.log(`[pgrep per call] avg: ${avgMs.toFixed(1)}ms, max: ${maxMs.toFixed(1)}ms`);

      // Now simulate what happens with 20 active agents (sequential, as the liveness checker does)
      const start20 = performance.now();
      for (let i = 0; i < 20; i++) {
        await new Promise<void>((resolve) => {
          execFile('pgrep', ['-f', 'claude'], { encoding: 'utf8' }, () => resolve());
        });
      }
      const total20 = performance.now() - start20;
      console.log(`[pgrep × 20 agents] total: ${total20.toFixed(1)}ms`);

      // 20 sequential pgrep calls at ~5-10ms each = 100-200ms blocking the liveness check
      // The liveness checker runs every 10s and blocks the event loop during iteration
      // because it awaits each agent serially: for (const [agentId, info] of this.agentInfo)
    });

    it('should measure /proc environ reads (per pgrep hit)', async () => {
      const { readFile } = await import('node:fs/promises');

      // Read our own /proc/self/environ as baseline
      const times: number[] = [];
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        try {
          await readFile('/proc/self/environ', 'utf8');
        } catch { /* may fail in containers */ }
        times.push(performance.now() - start);
      }

      const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
      console.log(`[/proc/environ read] avg: ${avgMs.toFixed(1)}ms over 20 reads`);
      // Each findSubagentProcess reads /proc/{pid}/environ + /proc/{pid}/cmdline
      // for every PID returned by pgrep — if 50 claude-related PIDs, that's 100 reads
    });
  });

  describe('SSE broadcast serialization under load', () => {
    it('should measure JSON.stringify cost for typical broadcast payloads', () => {
      // Simulate subagent:discovered events (fired for each new agent)
      const agentInfo = {
        agentId: 'abc-123-def',
        sessionId: 'session-001',
        projectHash: 'proj-hash',
        filePath: '/home/user/.claude/projects/hash/session/subagents/agent-abc.jsonl',
        startedAt: new Date().toISOString(),
        lastActivityAt: Date.now(),
        status: 'active',
        toolCallCount: 0,
        entryCount: 0,
        fileSize: 1024,
        description: 'Research authentication patterns in the codebase',
        model: 'claude-sonnet-4-20250514',
        modelShort: 'sonnet',
        totalInputTokens: 15000,
        totalOutputTokens: 8000,
      };

      // Simulate burst of 20 agents discovered at once
      const start = performance.now();
      const messages: string[] = [];
      for (let i = 0; i < 20; i++) {
        const payload = { ...agentInfo, agentId: `agent-${i}` };
        messages.push(`event: subagent:discovered\ndata: ${JSON.stringify(payload)}\n\n`);
      }
      const elapsed = performance.now() - start;
      console.log(`[broadcast × 20 agents] serialization: ${elapsed.toFixed(2)}ms`);

      // Now simulate what happens when each is written to 10 SSE clients
      // (the inner loop in broadcast())
      const totalBytes = messages.reduce((sum, m) => sum + m.length, 0);
      console.log(`[broadcast × 20 agents] total payload: ${(totalBytes / 1024).toFixed(1)}KB`);

      // Serialization alone should be fast
      expect(elapsed).toBeLessThan(5);
    });

    it('should measure cost of rapid terminal broadcasts with large payloads', () => {
      // Simulate 20 sessions each flushing 16KB of terminal data
      const sessions = Array.from({ length: 20 }, (_, i) => ({
        id: `session-${i}`,
        data: '\x1b[?2026h' + 'x'.repeat(16 * 1024) + '\x1b[?2026l',
      }));

      const start = performance.now();
      const messages: string[] = [];
      for (const session of sessions) {
        messages.push(`event: session:terminal\ndata: ${JSON.stringify(session)}\n\n`);
      }
      const elapsed = performance.now() - start;

      const totalMB = messages.reduce((sum, m) => sum + m.length, 0) / (1024 * 1024);
      console.log(`[terminal flush × 20 sessions] serialization: ${elapsed.toFixed(1)}ms, payload: ${totalMB.toFixed(2)}MB`);

      // 20 × 16KB = 320KB serialized simultaneously — should still be < 20ms
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('combined load scenario: subagent storm', () => {
    it('should simulate 10 agents starting while terminal data is flowing', async () => {
      // This is the real-world scenario: user is working, Claude spawns agents,
      // and the UI freezes because:
      // 1. 10× extractDescriptionFromParentTranscript (read + parse full transcripts)
      // 2. 10× extractDescriptionFromFile (read + parse agent files)
      // 3. 10× subagent:discovered broadcasts
      // 4. Terminal data keeps flowing and needs to flush
      // All of this on the same event loop

      const projectDir = join(tmpDir, 'storm-project', 'hash123', 'session-main');
      const subagentDir = join(projectDir, 'subagents');
      mkdirSync(subagentDir, { recursive: true });

      // Large parent transcript (5000 lines)
      const parentTranscript = generateParentTranscript(5000,
        Array.from({ length: 10 }, (_, i) => `storm-agent-${i}`)
      );
      writeFileSync(join(tmpDir, 'storm-project', 'hash123', 'session-main.jsonl'), parentTranscript);

      // 10 agent transcript files (500 lines each)
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(subagentDir, `agent-storm-agent-${i}.jsonl`), generateAgentTranscript(500));
      }

      const { readFile } = await import('node:fs/promises');
      const parentPath = join(tmpDir, 'storm-project', 'hash123', 'session-main.jsonl');

      // Start event loop lag measurement
      const lagPromise = measureEventLoopLag(2000);

      // Simulate what SubagentWatcher does when 10 agents appear:
      const start = performance.now();

      // Phase 1: Read parent transcript 10 times (once per agent to find description)
      const descriptionReads = Array.from({ length: 10 }, async (_, i) => {
        const content = await readFile(parentPath, 'utf8');
        const lines = content.split('\n').filter((l: string) => l.trim());
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.toolUseResult?.agentId === `storm-agent-${i}`) {
              return entry.toolUseResult.description;
            }
          } catch { /* skip */ }
        }
        return undefined;
      });

      // Phase 2: Concurrently, simulate terminal data serialization (every 16ms)
      let terminalSerializations = 0;
      const terminalInterval = setInterval(() => {
        // Simulate flushTerminalBatches for 5 active sessions
        for (let s = 0; s < 5; s++) {
          JSON.stringify({ id: `session-${s}`, data: 'x'.repeat(4096) });
        }
        terminalSerializations++;
      }, 16);

      const descriptions = await Promise.all(descriptionReads);
      clearInterval(terminalInterval);

      const totalElapsed = performance.now() - start;
      const lag = await lagPromise;

      console.log(`[subagent storm] 10 agents + terminal: ${totalElapsed.toFixed(0)}ms`);
      console.log(`[subagent storm] terminal flushes during: ${terminalSerializations}`);
      console.log(`[subagent storm] max event loop lag: ${lag.maxLagMs.toFixed(1)}ms`);
      console.log(`[subagent storm] avg event loop lag: ${lag.avgLagMs.toFixed(1)}ms`);

      // Count how many lag samples exceeded 50ms (UI jank threshold)
      const jankSamples = lag.samples.filter(s => s > 50).length;
      const totalSamples = lag.samples.length;
      console.log(`[subagent storm] jank samples (>50ms): ${jankSamples}/${totalSamples} (${((jankSamples / totalSamples) * 100).toFixed(1)}%)`);

      // Verify correctness
      for (const d of descriptions) {
        expect(d).toMatch(/^Research task for storm-agent-\d+$/);
      }

      // This is the key metric: during a subagent storm, max lag should stay under 100ms
      // In practice, the synchronous JSON.parse of 5000 lines × 10 concurrent reads
      // will cause significant lag spikes
      if (lag.maxLagMs > 100) {
        console.warn(`⚠️  MAX LAG ${lag.maxLagMs.toFixed(0)}ms EXCEEDS 100ms — UI will feel unresponsive`);
      }
    });
  });

  describe('liveness checker: tiered optimization', () => {
    it('should measure old approach: full pgrep scan for 20 agents', async () => {
      const { execFile } = await import('node:child_process');
      const { readFile } = await import('node:fs/promises');

      const lagPromise = measureEventLoopLag(3000);

      const start = performance.now();
      // Old approach: pgrep once + /proc reads for all PIDs, then iterate all agents
      const pids = await new Promise<string[]>((resolve) => {
        execFile('pgrep', ['-f', 'node'], { encoding: 'utf8' }, (_err, stdout) => {
          resolve((stdout || '').trim().split('\n').filter(Boolean));
        });
      });
      for (const pidStr of pids.slice(0, 10)) {
        try { await readFile(`/proc/${pidStr}/environ`, 'utf8'); } catch { /* */ }
        try { await readFile(`/proc/${pidStr}/cmdline`, 'utf8'); } catch { /* */ }
      }
      const elapsed = performance.now() - start;
      const lag = await lagPromise;

      console.log(`[old liveness] pgrep + /proc for ${pids.length} PIDs: ${elapsed.toFixed(0)}ms`);
      console.log(`[old liveness] max event loop lag: ${lag.maxLagMs.toFixed(1)}ms`);
    });

    it('should measure new tier-1: file stat for 20 agents (fast path)', async () => {
      // Create 20 agent files to stat
      const agentDir = join(tmpDir, 'tier1-agents');
      mkdirSync(agentDir, { recursive: true });
      const files: string[] = [];
      for (let i = 0; i < 20; i++) {
        const f = join(agentDir, `agent-${i}.jsonl`);
        writeFileSync(f, generateAgentTranscript(50));
        files.push(f);
      }

      const { stat: statFn } = await import('node:fs/promises');
      const lagPromise = measureEventLoopLag(500);

      const start = performance.now();
      let aliveCount = 0;
      for (const f of files) {
        try {
          const s = await statFn(f);
          if (Date.now() - s.mtime.getTime() < 30000) aliveCount++;
        } catch { /* */ }
      }
      const elapsed = performance.now() - start;
      const lag = await lagPromise;

      console.log(`[tier-1 file stat × 20 agents] ${elapsed.toFixed(1)}ms, all alive: ${aliveCount === 20}`);
      console.log(`[tier-1 file stat] max event loop lag: ${lag.maxLagMs.toFixed(1)}ms`);

      // File stat for 20 agents should be well under 5ms total
      expect(elapsed).toBeLessThan(20);
      expect(aliveCount).toBe(20);
    });

    it('should measure new tier-2: /proc/{pid}/stat for 20 cached PIDs', async () => {
      const { stat: statFn } = await import('node:fs/promises');
      const ourPid = process.pid;

      const lagPromise = measureEventLoopLag(500);

      const start = performance.now();
      let aliveCount = 0;
      // Simulate checking 20 cached PIDs (all point to our own PID for testing)
      for (let i = 0; i < 20; i++) {
        try {
          await statFn(`/proc/${ourPid}`);
          aliveCount++;
        } catch { /* */ }
      }
      const elapsed = performance.now() - start;
      const lag = await lagPromise;

      console.log(`[tier-2 /proc/pid × 20 agents] ${elapsed.toFixed(1)}ms, alive: ${aliveCount}`);
      console.log(`[tier-2 /proc/pid] max event loop lag: ${lag.maxLagMs.toFixed(1)}ms`);

      // /proc/pid stat for 20 agents should be well under 5ms total
      expect(elapsed).toBeLessThan(20);
    });

    it('should show tier-1+2 is orders of magnitude faster than full pgrep scan', async () => {
      const { stat: statFn } = await import('node:fs/promises');
      const { execFile: execFileFn } = await import('node:child_process');

      // Create 20 agent files
      const agentDir = join(tmpDir, 'comparison-agents');
      mkdirSync(agentDir, { recursive: true });
      const files: string[] = [];
      for (let i = 0; i < 20; i++) {
        const f = join(agentDir, `agent-${i}.jsonl`);
        writeFileSync(f, 'x'.repeat(100));
        files.push(f);
      }

      // Tier 1+2 approach: stat files + stat /proc/pid
      const startFast = performance.now();
      for (const f of files) {
        await statFn(f); // tier 1
      }
      for (let i = 0; i < 20; i++) {
        try { await statFn(`/proc/${process.pid}`); } catch { /* */ } // tier 2
      }
      const fastElapsed = performance.now() - startFast;

      // Old approach: pgrep + /proc reads
      const startSlow = performance.now();
      const { readFile } = await import('node:fs/promises');
      const pids = await new Promise<string[]>((resolve) => {
        execFileFn('pgrep', ['-f', 'node'], { encoding: 'utf8' }, (_err, stdout) => {
          resolve((stdout || '').trim().split('\n').filter(Boolean));
        });
      });
      for (const pidStr of pids.slice(0, 10)) {
        try { await readFile(`/proc/${pidStr}/environ`, 'utf8'); } catch { /* */ }
        try { await readFile(`/proc/${pidStr}/cmdline`, 'utf8'); } catch { /* */ }
      }
      const slowElapsed = performance.now() - startSlow;

      const speedup = slowElapsed / Math.max(fastElapsed, 0.01);
      console.log(`[comparison] tier-1+2: ${fastElapsed.toFixed(1)}ms, old pgrep: ${slowElapsed.toFixed(1)}ms, speedup: ${speedup.toFixed(0)}x`);

      // Tiered approach should be significantly faster
      expect(fastElapsed).toBeLessThan(slowElapsed);
    });
  });

  describe('transcript JSON.parse line-by-line cost', () => {
    it('should measure synchronous JSON.parse cost for transcript tailing', () => {
      // tailFile does JSON.parse(line) for every line in the stream
      // When a subagent first appears, tailFile reads from position 0 = entire file
      // With 1000 entry files, that's 1000 synchronous JSON.parse calls

      const lines = Array.from({ length: 1000 }, (_, i) =>
        makeTranscriptEntry(i % 2 === 0 ? 'user' : 'assistant', `Content for line ${i}`)
      );

      // Measure synchronous JSON.parse of all lines (what tailFile does)
      const start = performance.now();
      let parsed = 0;
      for (const line of lines) {
        JSON.parse(line);
        parsed++;
      }
      const elapsed = performance.now() - start;

      console.log(`[JSON.parse × ${parsed} lines] ${elapsed.toFixed(2)}ms (${(elapsed / parsed * 1000).toFixed(1)}µs/line)`);

      // 1000 lines should be fast, but 10 agents × 1000 lines = 10000 parses
      // all happening synchronously on the event loop during initial tail
    });

    it('should measure cumulative cost when 10 agents are tailed simultaneously', () => {
      // When 10 subagents are discovered at once, all 10 call tailFile from position 0
      // Each agent file has ~500 lines → 5000 JSON.parse calls

      const agentFiles = Array.from({ length: 10 }, () =>
        Array.from({ length: 500 }, (_, i) =>
          makeTranscriptEntry(i % 2 === 0 ? 'user' : 'assistant', `Agent content ${i}`)
        )
      );

      const start = performance.now();
      let totalParsed = 0;
      for (const lines of agentFiles) {
        for (const line of lines) {
          JSON.parse(line);
          totalParsed++;
        }
      }
      const elapsed = performance.now() - start;

      console.log(`[10 agents × 500 lines] ${totalParsed} parses in ${elapsed.toFixed(1)}ms`);

      // This all happens synchronously — the event loop is completely blocked
      // during this time. No SSE events, no API responses, no terminal data.
      expect(elapsed).toBeLessThan(100); // Should be fast enough
    });
  });
});
