/**
 * @fileoverview Subagent Watcher - Real-time monitoring of Claude Code background agents
 *
 * Watches ~/.claude/projects/{project}/{session}/subagents/agent-{id}.jsonl files
 * and emits structured events for tool calls, progress, and messages.
 */

import { EventEmitter } from 'events';
import { watch, statSync, readdirSync, existsSync, readFileSync, FSWatcher } from 'fs';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { join, basename } from 'path';
import { execSync } from 'child_process';

// ========== Types ==========

export interface SubagentInfo {
  agentId: string;
  sessionId: string;
  projectHash: string;
  filePath: string;
  startedAt: string;
  lastActivityAt: string;
  status: 'active' | 'idle' | 'completed';
  toolCallCount: number;
  entryCount: number;
  fileSize: number;
  description?: string; // Task description from first user message
}

export interface SubagentToolCall {
  agentId: string;
  sessionId: string;
  timestamp: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface SubagentProgress {
  agentId: string;
  sessionId: string;
  timestamp: string;
  progressType: 'query_update' | 'search_results_received' | string;
  query?: string;
  resultCount?: number;
}

export interface SubagentMessage {
  agentId: string;
  sessionId: string;
  timestamp: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface SubagentTranscriptEntry {
  type: 'user' | 'assistant' | 'progress';
  timestamp: string;
  agentId: string;
  sessionId: string;
  message?: {
    role: string;
    content: Array<{
      type: 'text' | 'tool_use' | 'tool_result';
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
      content?: string;
    }>;
  };
  data?: {
    type: string;
    query?: string;
    resultCount?: number;
  };
}

export interface SubagentEvents {
  'subagent:discovered': (info: SubagentInfo) => void;
  'subagent:tool_call': (data: SubagentToolCall) => void;
  'subagent:progress': (data: SubagentProgress) => void;
  'subagent:message': (data: SubagentMessage) => void;
  'subagent:completed': (info: SubagentInfo) => void;
  'subagent:error': (error: Error, agentId?: string) => void;
}

// ========== Constants ==========

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude/projects');
const IDLE_TIMEOUT_MS = 30000; // Consider agent idle after 30s of no activity
const POLL_INTERVAL_MS = 1000; // Check for new files every second
const LIVENESS_CHECK_MS = 10000; // Check if subagent processes are still alive every 10s

// ========== SubagentWatcher Class ==========

export class SubagentWatcher extends EventEmitter {
  private filePositions = new Map<string, number>();
  private fileWatchers = new Map<string, FSWatcher>();
  private dirWatchers = new Map<string, FSWatcher>();
  private agentInfo = new Map<string, SubagentInfo>();
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private pollInterval: NodeJS.Timeout | null = null;
  private livenessInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private knownSubagentDirs = new Set<string>();

  constructor() {
    super();
  }

  // ========== Public API ==========

  /**
   * Start watching for subagent activity
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Initial scan
    this.scanForSubagents();

    // Periodic scan for new subagent directories
    this.pollInterval = setInterval(() => {
      this.scanForSubagents();
    }, POLL_INTERVAL_MS);

    // Periodic liveness check for active subagents
    this.startLivenessChecker();
  }

  /**
   * Start periodic liveness checker
   * Detects when subagent processes have exited but status is still active/idle
   */
  private startLivenessChecker(): void {
    if (this.livenessInterval) return;

    this.livenessInterval = setInterval(async () => {
      for (const [agentId, info] of this.agentInfo) {
        if (info.status === 'active' || info.status === 'idle') {
          const alive = await this.checkSubagentAlive(agentId);
          if (!alive) {
            info.status = 'completed';
            this.emit('subagent:completed', info);
          }
        }
      }
    }, LIVENESS_CHECK_MS);
  }

  /**
   * Check if a subagent process is still running
   */
  private async checkSubagentAlive(agentId: string): Promise<boolean> {
    const info = this.agentInfo.get(agentId);
    if (!info) return false;

    // Method 1: Check if the process is still running
    const pid = await this.findSubagentProcess(info.sessionId);
    if (pid !== null) return true;

    // Method 2: Check if the transcript file was recently modified
    // (within the last 60 seconds - gives some buffer for slow operations)
    try {
      const stat = statSync(info.filePath);
      const mtime = stat.mtime.getTime();
      const now = Date.now();
      if (now - mtime < 60000) {
        return true;
      }
    } catch {
      // File doesn't exist or can't be read
    }

    return false;
  }

  /**
   * Stop watching
   */
  stop(): void {
    this.isRunning = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.livenessInterval) {
      clearInterval(this.livenessInterval);
      this.livenessInterval = null;
    }

    for (const watcher of this.fileWatchers.values()) {
      watcher.close();
    }
    this.fileWatchers.clear();

    for (const watcher of this.dirWatchers.values()) {
      watcher.close();
    }
    this.dirWatchers.clear();

    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
  }

  /**
   * Get all known subagents
   */
  getSubagents(): SubagentInfo[] {
    return Array.from(this.agentInfo.values());
  }

  /**
   * Get subagents for a specific Claudeman session
   * Maps Claudeman working directory to Claude's project hash
   */
  getSubagentsForSession(workingDir: string): SubagentInfo[] {
    const projectHash = this.getProjectHash(workingDir);
    return Array.from(this.agentInfo.values()).filter(
      (info) => info.projectHash === projectHash
    );
  }

  /**
   * Get a specific subagent's info
   */
  getSubagent(agentId: string): SubagentInfo | undefined {
    return this.agentInfo.get(agentId);
  }

  /**
   * Get recent subagents (modified within specified minutes)
   */
  getRecentSubagents(minutes: number = 60): SubagentInfo[] {
    const cutoff = Date.now() - minutes * 60 * 1000;
    return Array.from(this.agentInfo.values())
      .filter((info) => new Date(info.lastActivityAt).getTime() > cutoff)
      .sort((a, b) =>
        new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
      );
  }

  /**
   * Kill a subagent by its agent ID
   * Finds the Claude process and sends SIGTERM
   */
  async killSubagent(agentId: string): Promise<boolean> {
    const info = this.agentInfo.get(agentId);
    if (!info) return false;

    // Already completed, nothing to kill
    if (info.status === 'completed') return false;

    try {
      // Find Claude process with matching session ID
      const pid = await this.findSubagentProcess(info.sessionId);
      if (pid) {
        process.kill(pid, 'SIGTERM');
        info.status = 'completed';
        this.emit('subagent:completed', info);
        return true;
      }
    } catch {
      // Process may have already exited
    }

    // Mark as completed even if we couldn't find the process
    info.status = 'completed';
    this.emit('subagent:completed', info);
    return true;
  }

  /**
   * Kill all subagents for a specific Claudeman session working directory
   */
  async killSubagentsForSession(workingDir: string): Promise<void> {
    const subagents = this.getSubagentsForSession(workingDir);
    for (const agent of subagents) {
      if (agent.status === 'active' || agent.status === 'idle') {
        await this.killSubagent(agent.agentId);
      }
    }
  }

  /**
   * Find the process ID of a Claude subagent by its session ID
   * Searches /proc for claude processes with matching session ID in environment
   */
  private async findSubagentProcess(sessionId: string): Promise<number | null> {
    try {
      // Find all claude processes
      const pgrepOutput = execSync('pgrep -f "claude"', { encoding: 'utf8' });
      const pids = pgrepOutput.trim().split('\n').filter(Boolean);

      for (const pidStr of pids) {
        const pid = parseInt(pidStr, 10);
        if (isNaN(pid)) continue;

        try {
          // Check /proc/{pid}/environ for session ID
          const environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
          if (environ.includes(sessionId)) {
            return pid;
          }
        } catch {
          // Can't read this process's environ - skip
        }

        try {
          // Also check /proc/{pid}/cmdline for session ID
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          if (cmdline.includes(sessionId)) {
            return pid;
          }
        } catch {
          // Can't read this process's cmdline - skip
        }
      }
    } catch {
      // pgrep returns non-zero if no matches
    }
    return null;
  }

  /**
   * Get transcript for a subagent (optionally limited to last N entries)
   */
  async getTranscript(agentId: string, limit?: number): Promise<SubagentTranscriptEntry[]> {
    const info = this.agentInfo.get(agentId);
    if (!info) return [];

    const entries: SubagentTranscriptEntry[] = [];

    try {
      const content = readFileSync(info.filePath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as SubagentTranscriptEntry;
          entries.push(entry);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File read error
    }

    if (limit && limit > 0) {
      return entries.slice(-limit);
    }

    return entries;
  }

  /**
   * Format transcript entries for display
   */
  formatTranscript(entries: SubagentTranscriptEntry[]): string[] {
    const lines: string[] = [];

    for (const entry of entries) {
      if (entry.type === 'progress' && entry.data) {
        lines.push(this.formatProgress(entry));
      } else if (entry.type === 'assistant' && entry.message?.content) {
        for (const content of entry.message.content) {
          if (content.type === 'tool_use' && content.name) {
            lines.push(this.formatToolCall(entry.timestamp, content.name, content.input || {}));
          } else if (content.type === 'text' && content.text) {
            const text = content.text.trim();
            if (text.length > 0) {
              const preview = text.length > 200 ? text.substring(0, 200) + '...' : text;
              lines.push(`${this.formatTime(entry.timestamp)} 💬 ${preview.replace(/\n/g, ' ')}`);
            }
          }
        }
      } else if (entry.type === 'user' && entry.message?.content) {
        const firstContent = entry.message.content[0];
        if (firstContent?.type === 'text' && firstContent.text) {
          const text = firstContent.text.trim();
          if (text.length < 100 && !text.includes('{')) {
            lines.push(`${this.formatTime(entry.timestamp)} 📥 User: ${text.substring(0, 80)}`);
          }
        }
      }
    }

    return lines;
  }

  // ========== Private Methods ==========

  /**
   * Convert working directory to Claude's project hash format
   */
  private getProjectHash(workingDir: string): string {
    return workingDir.replace(/\//g, '-');
  }

  /**
   * Scan for all subagent directories
   */
  private scanForSubagents(): void {
    if (!existsSync(CLAUDE_PROJECTS_DIR)) return;

    try {
      const projects = readdirSync(CLAUDE_PROJECTS_DIR);

      for (const project of projects) {
        const projectPath = join(CLAUDE_PROJECTS_DIR, project);

        try {
          const stat = statSync(projectPath);
          if (!stat.isDirectory()) continue;

          const sessions = readdirSync(projectPath);

          for (const session of sessions) {
            const sessionPath = join(projectPath, session);

            try {
              const sessionStat = statSync(sessionPath);
              if (!sessionStat.isDirectory()) continue;

              const subagentDir = join(sessionPath, 'subagents');
              if (existsSync(subagentDir)) {
                this.watchSubagentDir(subagentDir, project, session);
              }
            } catch {
              // Skip inaccessible session directories
            }
          }
        } catch {
          // Skip inaccessible project directories
        }
      }
    } catch (error) {
      this.emit('subagent:error', error as Error);
    }
  }

  /**
   * Watch a subagent directory for new/updated files
   */
  private watchSubagentDir(dir: string, projectHash: string, sessionId: string): void {
    if (this.knownSubagentDirs.has(dir)) return;
    this.knownSubagentDirs.add(dir);

    // Watch existing files
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          this.watchAgentFile(join(dir, file), projectHash, sessionId);
        }
      }
    } catch {
      return;
    }

    // Watch for new files
    try {
      const watcher = watch(dir, (_eventType, filename) => {
        if (filename?.endsWith('.jsonl')) {
          const filePath = join(dir, filename);
          if (existsSync(filePath)) {
            this.watchAgentFile(filePath, projectHash, sessionId);
          }
        }
      });

      this.dirWatchers.set(dir, watcher);
    } catch {
      // Watch failed
    }
  }

  /**
   * Watch a specific agent transcript file
   */
  private watchAgentFile(filePath: string, projectHash: string, sessionId: string): void {
    if (this.fileWatchers.has(filePath)) return;

    const agentId = basename(filePath).replace('agent-', '').replace('.jsonl', '');

    // Initial info
    const stat = statSync(filePath);

    // Extract description from first user message in the JSONL
    // The Task tool passes a "description" (short title) and "prompt" (full task)
    // We want the short description, which may be in the first line or sentence
    let description: string | undefined;
    try {
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());

      // Try each line until we find a user message with text
      for (const line of lines.slice(0, 5)) {
        try {
          const entry = JSON.parse(line) as SubagentTranscriptEntry;
          if (entry.type === 'user' && entry.message?.content) {
            const firstContent = entry.message.content[0];
            if (firstContent?.type === 'text' && firstContent.text) {
              const text = firstContent.text.trim();
              // Extract a useful title: first line, first sentence, or first 80 chars
              // Split on newline first
              const firstLine = text.split('\n')[0].trim();
              // If still long, try to find a sentence boundary
              let title = firstLine;
              if (title.length > 80) {
                // Look for sentence end (. ! ?) within first 100 chars
                const sentenceEnd = title.substring(0, 100).search(/[.!?]/);
                if (sentenceEnd > 10) {
                  title = title.substring(0, sentenceEnd + 1);
                } else {
                  // Truncate at word boundary
                  const truncated = title.substring(0, 80);
                  const lastSpace = truncated.lastIndexOf(' ');
                  title = lastSpace > 40 ? truncated.substring(0, lastSpace) + '...' : truncated + '...';
                }
              }
              description = title;
              break;
            }
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Failed to read description, continue without it
    }

    const info: SubagentInfo = {
      agentId,
      sessionId,
      projectHash,
      filePath,
      startedAt: stat.birthtime.toISOString(),
      lastActivityAt: stat.mtime.toISOString(),
      status: 'active',
      toolCallCount: 0,
      entryCount: 0,
      fileSize: stat.size,
      description,
    };

    this.agentInfo.set(agentId, info);
    this.emit('subagent:discovered', info);

    // Read existing content
    this.tailFile(filePath, agentId, sessionId, 0).then((position) => {
      this.filePositions.set(filePath, position);
    });

    // Watch for changes
    try {
      const watcher = watch(filePath, async (eventType) => {
        if (eventType === 'change') {
          const currentPos = this.filePositions.get(filePath) || 0;
          const newPos = await this.tailFile(filePath, agentId, sessionId, currentPos);
          this.filePositions.set(filePath, newPos);

          // Update info
          const existingInfo = this.agentInfo.get(agentId);
          if (existingInfo) {
            try {
              const newStat = statSync(filePath);
              existingInfo.lastActivityAt = new Date().toISOString();
              existingInfo.fileSize = newStat.size;
              existingInfo.status = 'active';
            } catch {
              // Stat failed
            }

            // Reset idle timer
            this.resetIdleTimer(agentId);
          }
        }
      });

      this.fileWatchers.set(filePath, watcher);
      this.resetIdleTimer(agentId);
    } catch {
      // Watch failed
    }
  }

  /**
   * Tail a file from a specific position
   */
  private async tailFile(
    filePath: string,
    agentId: string,
    sessionId: string,
    fromPosition: number
  ): Promise<number> {
    return new Promise((resolve) => {
      let position = fromPosition;

      const stream = createReadStream(filePath, { start: fromPosition });
      const rl = createInterface({ input: stream });

      rl.on('line', (line) => {
        position += Buffer.byteLength(line, 'utf8') + 1;

        try {
          const entry = JSON.parse(line) as SubagentTranscriptEntry;
          this.processEntry(entry, agentId, sessionId);

          // Update entry count
          const info = this.agentInfo.get(agentId);
          if (info) {
            info.entryCount++;
          }
        } catch {
          // Skip malformed lines
        }
      });

      rl.on('close', () => {
        resolve(position);
      });

      rl.on('error', () => {
        resolve(position);
      });
    });
  }

  /**
   * Process a transcript entry and emit appropriate events
   */
  private processEntry(entry: SubagentTranscriptEntry, agentId: string, sessionId: string): void {
    if (entry.type === 'progress' && entry.data) {
      const progress: SubagentProgress = {
        agentId,
        sessionId,
        timestamp: entry.timestamp,
        progressType: entry.data.type,
        query: entry.data.query,
        resultCount: entry.data.resultCount,
      };
      this.emit('subagent:progress', progress);
    } else if (entry.type === 'assistant' && entry.message?.content) {
      for (const content of entry.message.content) {
        if (content.type === 'tool_use' && content.name) {
          const toolCall: SubagentToolCall = {
            agentId,
            sessionId,
            timestamp: entry.timestamp,
            tool: content.name,
            input: content.input || {},
          };
          this.emit('subagent:tool_call', toolCall);

          // Update tool call count
          const info = this.agentInfo.get(agentId);
          if (info) {
            info.toolCallCount++;
          }
        } else if (content.type === 'text' && content.text) {
          const text = content.text.trim();
          if (text.length > 0) {
            const message: SubagentMessage = {
              agentId,
              sessionId,
              timestamp: entry.timestamp,
              role: 'assistant',
              text: text.substring(0, 500), // Limit text length
            };
            this.emit('subagent:message', message);
          }
        }
      }
    } else if (entry.type === 'user' && entry.message?.content) {
      const firstContent = entry.message.content[0];
      if (firstContent?.type === 'text' && firstContent.text) {
        const text = firstContent.text.trim();
        if (text.length > 0 && text.length < 500) {
          const message: SubagentMessage = {
            agentId,
            sessionId,
            timestamp: entry.timestamp,
            role: 'user',
            text,
          };
          this.emit('subagent:message', message);
        }
      }
    }
  }

  /**
   * Reset idle timer for an agent
   */
  private resetIdleTimer(agentId: string): void {
    const existing = this.idleTimers.get(agentId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      const info = this.agentInfo.get(agentId);
      if (info && info.status === 'active') {
        info.status = 'idle';
      }
    }, IDLE_TIMEOUT_MS);

    this.idleTimers.set(agentId, timer);
  }

  /**
   * Format a tool call for display
   */
  private formatToolCall(timestamp: string, name: string, input: Record<string, unknown>): string {
    const icons: Record<string, string> = {
      WebSearch: '🔍',
      WebFetch: '🌐',
      Read: '📖',
      Write: '📝',
      Edit: '✏️',
      Bash: '💻',
      Glob: '📁',
      Grep: '🔎',
      Task: '🤖',
    };

    const icon = icons[name] || '🔧';
    let details = '';

    if (name === 'WebSearch' && input.query) {
      details = `"${input.query}"`;
    } else if (name === 'WebFetch' && input.url) {
      details = input.url as string;
    } else if (name === 'Read' && input.file_path) {
      details = input.file_path as string;
    } else if ((name === 'Write' || name === 'Edit') && input.file_path) {
      details = input.file_path as string;
    } else if (name === 'Bash' && input.command) {
      const cmd = input.command as string;
      details = cmd.length > 60 ? cmd.substring(0, 60) + '...' : cmd;
    } else if (name === 'Glob' && input.pattern) {
      details = input.pattern as string;
    } else if (name === 'Grep' && input.pattern) {
      details = input.pattern as string;
    } else if (name === 'Task' && input.description) {
      details = input.description as string;
    }

    return `${this.formatTime(timestamp)} ${icon} ${name}: ${details}`;
  }

  /**
   * Format a progress event for display
   */
  private formatProgress(entry: SubagentTranscriptEntry): string {
    const data = entry.data!;
    if (data.type === 'query_update') {
      return `${this.formatTime(entry.timestamp)} ⟳ Searching: "${data.query}"`;
    } else if (data.type === 'search_results_received') {
      return `${this.formatTime(entry.timestamp)} ✓ Got ${data.resultCount} results`;
    }
    return `${this.formatTime(entry.timestamp)} Progress: ${data.type}`;
  }

  /**
   * Format timestamp for display
   */
  private formatTime(timestamp: string): string {
    return new Date(timestamp).toLocaleTimeString();
  }
}

// Export singleton instance
export const subagentWatcher = new SubagentWatcher();
