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
  model?: string; // Full model name (e.g., "claude-sonnet-4-20250514")
  modelShort?: 'haiku' | 'sonnet' | 'opus'; // Short model identifier
  totalInputTokens?: number; // Running total of input tokens
  totalOutputTokens?: number; // Running total of output tokens
}

export interface SubagentToolCall {
  agentId: string;
  sessionId: string;
  timestamp: string;
  tool: string;
  input: Record<string, unknown>;
  toolUseId?: string; // For linking to tool_result
  fullInput: Record<string, unknown>; // Complete input object (input is truncated for display)
}

export interface SubagentProgress {
  agentId: string;
  sessionId: string;
  timestamp: string;
  progressType: 'query_update' | 'search_results_received' | string;
  query?: string;
  resultCount?: number;
  hookEvent?: string; // e.g., "PostToolUse"
  hookName?: string; // e.g., "PostToolUse:Read"
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
    model?: string; // Model used for this message (e.g., "claude-sonnet-4-20250514")
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
    content: string | Array<{
      type: 'text' | 'tool_use' | 'tool_result';
      text?: string;
      name?: string;
      id?: string; // tool_use_id for tool_use blocks
      tool_use_id?: string; // tool_use_id for tool_result blocks
      input?: Record<string, unknown>;
      content?: string | Array<{ type: string; text?: string }>; // tool_result content
      is_error?: boolean; // For tool_result errors
    }>;
  };
  data?: {
    type: string;
    query?: string;
    resultCount?: number;
    hookEvent?: string; // e.g., "PostToolUse"
    hookName?: string; // e.g., "PostToolUse:Read"
    tool_name?: string; // Tool name for hook events
  };
}

export interface SubagentToolResult {
  agentId: string;
  sessionId: string;
  timestamp: string;
  toolUseId: string;
  tool?: string; // Tool name (looked up from pending)
  preview: string; // First 500 chars of result
  contentLength: number; // Total length of result
  isError: boolean; // Whether result is an error
}

export interface SubagentEvents {
  'subagent:discovered': (info: SubagentInfo) => void;
  'subagent:updated': (info: SubagentInfo) => void;
  'subagent:tool_call': (data: SubagentToolCall) => void;
  'subagent:tool_result': (data: SubagentToolResult) => void;
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
const STALE_COMPLETED_MAX_AGE_MS = 60 * 60 * 1000; // Remove completed agents older than 1 hour
const STALE_IDLE_MAX_AGE_MS = 4 * 60 * 60 * 1000; // Remove idle agents older than 4 hours
const STARTUP_MAX_FILE_AGE_MS = 4 * 60 * 60 * 1000; // Only load files modified in last 4 hours on startup
const MAX_TRACKED_AGENTS = 500; // Maximum agents to track (LRU eviction when exceeded)

// Display/preview length constants
const TEXT_PREVIEW_LENGTH = 200; // Length for text previews in tool results
const USER_TEXT_PREVIEW_LENGTH = 80; // Length for user message previews
const SMART_TITLE_MAX_LENGTH = 45; // Max length for smart title extraction
const MESSAGE_TEXT_LIMIT = 500; // Max length for message text content
const COMMAND_DISPLAY_LENGTH = 60; // Max length for command display
const INPUT_TRUNCATE_LENGTH = 100; // Max length for input value truncation
const FILE_CONTENT_DEBOUNCE_MS = 100; // Debounce delay for file content updates

// ========== SubagentWatcher Class ==========

export class SubagentWatcher extends EventEmitter {
  private filePositions = new Map<string, number>();
  private fileWatchers = new Map<string, FSWatcher>();
  private dirWatchers = new Map<string, FSWatcher>();
  private agentInfo = new Map<string, SubagentInfo>();
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private pollInterval: NodeJS.Timeout | null = null;
  private livenessInterval: NodeJS.Timeout | null = null;
  private _isRunning = false;
  private knownSubagentDirs = new Set<string>();
  // Map of agentId -> Map of toolUseId -> tool name (for linking tool_result to tool_call)
  private pendingToolCalls = new Map<string, Map<string, string>>();

  constructor() {
    super();
  }

  /**
   * Extract short model identifier from full model name
   */
  private extractModelShort(model: string): 'haiku' | 'sonnet' | 'opus' | undefined {
    const lower = model.toLowerCase();
    if (lower.includes('haiku')) return 'haiku';
    if (lower.includes('sonnet')) return 'sonnet';
    if (lower.includes('opus')) return 'opus';
    return undefined;
  }

  // ========== Public API ==========

  /**
   * Start watching for subagent activity
   */
  start(): void {
    if (this._isRunning) return;
    this._isRunning = true;

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
            // Clean up pendingToolCalls for this agent to prevent memory leak
            this.pendingToolCalls.delete(agentId);
            this.emit('subagent:completed', info);
          }
        }
      }
      // Periodically clean up stale completed agents (older than 24 hours)
      this.cleanupStaleAgents();
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
   * Check if the watcher is currently running
   */
  isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Stop watching and clean up all state
   */
  stop(): void {
    this._isRunning = false;

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

    // Clear all state for clean restart
    this.filePositions.clear();
    this.agentInfo.clear();
    this.knownSubagentDirs.clear();
    this.pendingToolCalls.clear();
  }

  /**
   * Clean up stale agents to prevent unbounded memory growth.
   * - Completed agents: removed after STALE_COMPLETED_MAX_AGE_MS (1 hour)
   * - Idle agents: removed after STALE_IDLE_MAX_AGE_MS (4 hours)
   * Also enforces MAX_TRACKED_AGENTS limit with LRU eviction.
   */
  private cleanupStaleAgents(): void {
    const now = Date.now();
    const agentsToDelete: string[] = [];

    for (const [agentId, info] of this.agentInfo) {
      const lastActivity = new Date(info.lastActivityAt).getTime();
      const age = now - lastActivity;

      // Clean up based on status and age
      if (info.status === 'completed' && age > STALE_COMPLETED_MAX_AGE_MS) {
        agentsToDelete.push(agentId);
      } else if (info.status === 'idle' && age > STALE_IDLE_MAX_AGE_MS) {
        agentsToDelete.push(agentId);
      }
    }

    // Enforce max tracked agents limit (LRU eviction)
    const currentCount = this.agentInfo.size - agentsToDelete.length;
    if (currentCount > MAX_TRACKED_AGENTS) {
      // Sort by lastActivityAt (oldest first) and evict oldest completed/idle agents
      const sortedAgents = Array.from(this.agentInfo.entries())
        .filter(([id]) => !agentsToDelete.includes(id))
        .filter(([, info]) => info.status !== 'active') // Keep active agents
        .sort((a, b) => new Date(a[1].lastActivityAt).getTime() - new Date(b[1].lastActivityAt).getTime());

      const toEvict = currentCount - MAX_TRACKED_AGENTS;
      for (let i = 0; i < toEvict && i < sortedAgents.length; i++) {
        agentsToDelete.push(sortedAgents[i][0]);
      }
    }

    // Perform cleanup
    for (const agentId of agentsToDelete) {
      this.removeAgent(agentId);
    }
  }

  /**
   * Remove an agent and all its associated resources.
   */
  private removeAgent(agentId: string): void {
    const info = this.agentInfo.get(agentId);
    if (info) {
      this.agentInfo.delete(agentId);
      this.pendingToolCalls.delete(agentId);
      this.filePositions.delete(info.filePath);
      const watcher = this.fileWatchers.get(info.filePath);
      if (watcher) {
        watcher.close();
        this.fileWatchers.delete(info.filePath);
      }
      const timer = this.idleTimers.get(agentId);
      if (timer) {
        clearTimeout(timer);
        this.idleTimers.delete(agentId);
      }
    }
  }

  /**
   * Manually trigger cleanup of stale agents.
   * Returns number of agents removed.
   */
  cleanupNow(): number {
    const beforeCount = this.agentInfo.size;
    this.cleanupStaleAgents();
    return beforeCount - this.agentInfo.size;
  }

  /**
   * Clear all tracked agents (for manual reset).
   * Returns number of agents cleared.
   */
  clearAll(): number {
    const count = this.agentInfo.size;
    const agentIds = Array.from(this.agentInfo.keys());
    for (const agentId of agentIds) {
      this.removeAgent(agentId);
    }
    return count;
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
   * Update a subagent's description.
   * Used to set the short description from TaskTracker when available.
   */
  updateDescription(agentId: string, description: string): boolean {
    const info = this.agentInfo.get(agentId);
    if (info) {
      info.description = description;
      this.emit('subagent:updated', info);
      return true;
    }
    return false;
  }

  /**
   * Find sessions whose working directory matches a project hash.
   * Returns the project hash for a given working directory.
   */
  getProjectHashForDir(workingDir: string): string {
    return this.getProjectHash(workingDir);
  }

  /**
   * Get internal statistics for memory monitoring.
   * Returns counts of internal Maps and resources.
   */
  getStats(): {
    agentCount: number;
    fileWatcherCount: number;
    dirWatcherCount: number;
    idleTimerCount: number;
    pendingToolCallsCount: number;
    knownDirsCount: number;
    filePositionsCount: number;
  } {
    // Count pending tool calls across all agents
    let pendingToolCallsCount = 0;
    for (const agentCalls of this.pendingToolCalls.values()) {
      pendingToolCallsCount += agentCalls.size;
    }

    return {
      agentCount: this.agentInfo.size,
      fileWatcherCount: this.fileWatchers.size,
      dirWatcherCount: this.dirWatchers.size,
      idleTimerCount: this.idleTimers.size,
      pendingToolCallsCount,
      knownDirsCount: this.knownSubagentDirs.size,
      filePositionsCount: this.filePositions.size,
    };
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
        // Handle both string and array content formats
        if (typeof entry.message.content === 'string') {
          const text = entry.message.content.trim();
          if (text.length > 0) {
            const preview = text.length > TEXT_PREVIEW_LENGTH ? text.substring(0, TEXT_PREVIEW_LENGTH) + '...' : text;
            lines.push(`${this.formatTime(entry.timestamp)} 💬 ${preview.replace(/\n/g, ' ')}`);
          }
        } else {
          for (const content of entry.message.content) {
            if (content.type === 'tool_use' && content.name) {
              lines.push(this.formatToolCall(entry.timestamp, content.name, content.input || {}));
            } else if (content.type === 'text' && content.text) {
              const text = content.text.trim();
              if (text.length > 0) {
                const preview = text.length > TEXT_PREVIEW_LENGTH ? text.substring(0, TEXT_PREVIEW_LENGTH) + '...' : text;
                lines.push(`${this.formatTime(entry.timestamp)} 💬 ${preview.replace(/\n/g, ' ')}`);
              }
            }
          }
        }
      } else if (entry.type === 'user' && entry.message?.content) {
        // Handle both string and array content formats
        if (typeof entry.message.content === 'string') {
          const text = entry.message.content.trim();
          if (text.length < 100 && !text.includes('{')) {
            lines.push(`${this.formatTime(entry.timestamp)} 📥 User: ${text.substring(0, USER_TEXT_PREVIEW_LENGTH)}`);
          }
        } else {
          const firstContent = entry.message.content[0];
          if (firstContent?.type === 'text' && firstContent.text) {
            const text = firstContent.text.trim();
            if (text.length < 100 && !text.includes('{')) {
              lines.push(`${this.formatTime(entry.timestamp)} 📥 User: ${text.substring(0, USER_TEXT_PREVIEW_LENGTH)}`);
            }
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
   * Extract a smart, concise title from a task prompt
   * Aims for ~40-50 chars that convey what the agent is doing
   */
  private extractSmartTitle(text: string): string {
    const MAX_LEN = SMART_TITLE_MAX_LENGTH;

    // Get first line/sentence
    let title = text.split('\n')[0].trim();

    // If already short enough, use it
    if (title.length <= MAX_LEN) {
      return title.replace(/[.!?,\s]+$/, '');
    }

    // Remove common filler phrases to condense
    const fillers = [
      /^(please |i need you to |i want you to |can you |could you )/i,
      / (the|a|an) /gi,
      / (in|at|on|to|for|of|with|from|by) the /gi,
      / (including|related to|regarding|about) /gi,
      /[""]/g,
      / +/g, // multiple spaces to single
    ];

    let condensed = title;
    for (const filler of fillers) {
      condensed = condensed.replace(filler, (match) => {
        // Keep single space for word boundaries
        if (match.trim() === '') return ' ';
        if (/^(the|a|an)$/i.test(match.trim())) return ' ';
        if (/including|related to|regarding|about/i.test(match)) return ': ';
        return ' ';
      });
    }
    condensed = condensed.replace(/ +/g, ' ').trim();

    // If condensed version is short enough, use it
    if (condensed.length <= MAX_LEN) {
      return condensed.replace(/[.!?,:\s]+$/, '');
    }

    // Try to cut at a natural boundary (colon, dash, comma)
    const boundaryMatch = condensed.substring(0, MAX_LEN + 5).match(/^(.{20,}?)[:\-,]/);
    if (boundaryMatch && boundaryMatch[1].length <= MAX_LEN) {
      return boundaryMatch[1].trim();
    }

    // Last resort: truncate at word boundary
    const truncated = condensed.substring(0, MAX_LEN);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 20) {
      return truncated.substring(0, lastSpace).replace(/[.!?,:\s]+$/, '');
    }

    return truncated.replace(/[.!?,:\s]+$/, '');
  }

  /**
   * Extract the short description from the parent session's transcript.
   * This is the most reliable method because it reads the actual Task tool call
   * that spawned this agent, which contains the description parameter.
   *
   * The parent transcript contains:
   * 1. An assistant message with tool_use for Task, containing input.description
   * 2. A progress entry with data.agentId and parentToolUseID linking them
   */
  private extractDescriptionFromParentTranscript(
    projectHash: string,
    sessionId: string,
    agentId: string
  ): string | undefined {
    try {
      // The parent session's transcript is at: ~/.claude/projects/{projectHash}/{sessionId}.jsonl
      const transcriptPath = join(CLAUDE_PROJECTS_DIR, projectHash, `${sessionId}.jsonl`);
      if (!existsSync(transcriptPath)) return undefined;

      const content = readFileSync(transcriptPath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());

      // First pass: Find the progress entry for this agent to get parentToolUseID
      let parentToolUseID: string | undefined;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'progress' && entry.data?.agentId === agentId && entry.parentToolUseID) {
            parentToolUseID = entry.parentToolUseID;
            break;
          }
        } catch {
          // Skip malformed lines
        }
      }

      if (!parentToolUseID) return undefined;

      // Second pass: Find the Task tool_use with this ID and extract description
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'assistant' && entry.message?.content) {
            const content = entry.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block.type === 'tool_use' &&
                  block.id === parentToolUseID &&
                  block.name === 'Task' &&
                  block.input?.description
                ) {
                  return block.input.description;
                }
              }
            }
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Failed to read transcript
    }
    return undefined;
  }

  /**
   * Extract description from agent file by finding first user message
   */
  private extractDescriptionFromFile(filePath: string): string | undefined {
    try {
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());

      for (const line of lines.slice(0, 5)) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.message?.content) {
            let text: string | undefined;
            if (typeof entry.message.content === 'string') {
              text = entry.message.content.trim();
            } else if (Array.isArray(entry.message.content)) {
              const firstContent = entry.message.content[0];
              if (firstContent?.type === 'text' && firstContent.text) {
                text = firstContent.text.trim();
              }
            }
            if (text) {
              return this.extractSmartTitle(text);
            }
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Failed to read file
    }
    return undefined;
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

    // Watch existing files (initial scan - skip old files)
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          this.watchAgentFile(join(dir, file), projectHash, sessionId, true);
        }
      }
    } catch {
      return;
    }

    // Watch for new files with debounce to allow content to be written
    try {
      const watcher = watch(dir, (_eventType, filename) => {
        if (filename?.endsWith('.jsonl')) {
          const filePath = join(dir, filename);
          // Wait 100ms for file content to be written before processing
          // Even if file is empty after debounce, we still watch it - the
          // description retry mechanisms in processEntry and the file change
          // handler will extract description when content arrives
          setTimeout(() => {
            if (existsSync(filePath)) {
              this.watchAgentFile(filePath, projectHash, sessionId);
            }
          }, FILE_CONTENT_DEBOUNCE_MS);
        }
      });

      // Handle watcher errors to prevent unhandled exceptions
      watcher.on('error', (error) => {
        this.emit('subagent:error', error instanceof Error ? error : new Error(String(error)));
        this.dirWatchers.delete(dir);
        this.knownSubagentDirs.delete(dir);
      });

      this.dirWatchers.set(dir, watcher);
    } catch {
      // Watch failed
    }
  }

  /**
   * Watch a specific agent transcript file
   * @param filePath Path to the agent transcript file
   * @param projectHash Claude project hash
   * @param sessionId Claude session ID
   * @param isInitialScan If true, skip files older than STARTUP_MAX_FILE_AGE_MS
   */
  private watchAgentFile(filePath: string, projectHash: string, sessionId: string, isInitialScan: boolean = false): void {
    if (this.fileWatchers.has(filePath)) return;

    const agentId = basename(filePath).replace('agent-', '').replace('.jsonl', '');

    // Initial info - handle race condition where file may be deleted between discovery and stat
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      // File was deleted between discovery and stat - skip this agent
      return;
    }

    // On initial scan, skip old files to avoid loading stale historical data
    if (isInitialScan) {
      const fileAge = Date.now() - stat.mtime.getTime();
      if (fileAge > STARTUP_MAX_FILE_AGE_MS) {
        return; // Skip old files on startup
      }
    }

    // Extract description - prefer reading from parent transcript (most reliable)
    // The parent transcript has the exact Task tool call with description parameter
    let description = this.extractDescriptionFromParentTranscript(projectHash, sessionId, agentId);

    // Fallback: extract a smart title from the subagent's prompt if parent lookup failed
    if (!description) {
      description = this.extractDescriptionFromFile(filePath);
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

            // Retry description extraction if missing (race condition fix)
            if (!existingInfo.description) {
              // First try parent transcript (most reliable)
              let extractedDescription = this.extractDescriptionFromParentTranscript(
                existingInfo.projectHash,
                existingInfo.sessionId,
                agentId
              );
              // Fallback to subagent file
              if (!extractedDescription) {
                extractedDescription = this.extractDescriptionFromFile(filePath);
              }
              if (extractedDescription) {
                existingInfo.description = extractedDescription;
                this.emit('subagent:updated', existingInfo);
              }
            }

            // Reset idle timer
            this.resetIdleTimer(agentId);
          }
        }
      });

      // Handle watcher errors to prevent unhandled exceptions
      watcher.on('error', (error) => {
        this.emit('subagent:error', error instanceof Error ? error : new Error(String(error)), agentId);
        this.fileWatchers.delete(filePath);
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
        const lineBytes = Buffer.byteLength(line, 'utf8') + 1;

        try {
          const entry = JSON.parse(line) as SubagentTranscriptEntry;
          this.processEntry(entry, agentId, sessionId);
          position += lineBytes; // Only advance on successful parse

          // Update entry count
          const info = this.agentInfo.get(agentId);
          if (info) {
            info.entryCount++;
          }
        } catch {
          // Don't advance position - will retry on next change event
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
    const info = this.agentInfo.get(agentId);

    // Extract model from assistant messages (first one sets the model)
    if (info && entry.type === 'assistant' && entry.message?.model && !info.model) {
      info.model = entry.message.model;
      info.modelShort = this.extractModelShort(entry.message.model);
      this.emit('subagent:updated', info);
    }

    // Aggregate token usage from messages
    if (info && entry.message?.usage) {
      if (entry.message.usage.input_tokens) {
        info.totalInputTokens = (info.totalInputTokens || 0) + entry.message.usage.input_tokens;
      }
      if (entry.message.usage.output_tokens) {
        info.totalOutputTokens = (info.totalOutputTokens || 0) + entry.message.usage.output_tokens;
      }
    }

    // Check if this is first user message and description is missing
    if (info && !info.description && entry.type === 'user' && entry.message?.content) {
      // First try parent transcript (most reliable)
      let description = this.extractDescriptionFromParentTranscript(
        info.projectHash,
        info.sessionId,
        agentId
      );
      // Fallback: extract smart title from the prompt content
      if (!description) {
        let text: string | undefined;
        if (typeof entry.message.content === 'string') {
          text = entry.message.content.trim();
        } else if (Array.isArray(entry.message.content)) {
          const firstContent = entry.message.content[0];
          if (firstContent?.type === 'text' && firstContent.text) {
            text = firstContent.text.trim();
          }
        }
        if (text) {
          description = this.extractSmartTitle(text);
        }
      }
      if (description) {
        info.description = description;
        this.emit('subagent:updated', info);
      }
    }

    if (entry.type === 'progress' && entry.data) {
      const progress: SubagentProgress = {
        agentId,
        sessionId,
        timestamp: entry.timestamp,
        progressType: entry.data.type,
        query: entry.data.query,
        resultCount: entry.data.resultCount,
        // Extract hook event info if present
        hookEvent: entry.data.hookEvent,
        hookName: entry.data.hookName || (entry.data.hookEvent && entry.data.tool_name
          ? `${entry.data.hookEvent}:${entry.data.tool_name}`
          : undefined),
      };
      this.emit('subagent:progress', progress);
    } else if (entry.type === 'assistant' && entry.message?.content) {
      // Handle both string and array content formats
      if (typeof entry.message.content === 'string') {
        const text = entry.message.content.trim();
        if (text.length > 0) {
          const message: SubagentMessage = {
            agentId,
            sessionId,
            timestamp: entry.timestamp,
            role: 'assistant',
            text: text.substring(0, MESSAGE_TEXT_LIMIT),
          };
          this.emit('subagent:message', message);
        }
      } else {
        for (const content of entry.message.content) {
          if (content.type === 'tool_use' && content.name) {
            // Store toolUseId for linking to results
            if (content.id) {
              if (!this.pendingToolCalls.has(agentId)) {
                this.pendingToolCalls.set(agentId, new Map());
              }
              this.pendingToolCalls.get(agentId)!.set(content.id, content.name);
            }

            const toolCall: SubagentToolCall = {
              agentId,
              sessionId,
              timestamp: entry.timestamp,
              tool: content.name,
              input: this.getTruncatedInput(content.name, content.input || {}),
              toolUseId: content.id,
              fullInput: content.input || {},
            };
            this.emit('subagent:tool_call', toolCall);

            // Update tool call count
            const agentInfo = this.agentInfo.get(agentId);
            if (agentInfo) {
              agentInfo.toolCallCount++;
            }
          } else if (content.type === 'tool_result' && content.tool_use_id) {
            // Extract tool result
            const resultContent = this.extractToolResultContent(content.content);
            const agentPendingCalls = this.pendingToolCalls.get(agentId);
            const toolName = agentPendingCalls?.get(content.tool_use_id);
            // Delete after lookup to prevent memory leak
            agentPendingCalls?.delete(content.tool_use_id);

            const toolResult: SubagentToolResult = {
              agentId,
              sessionId,
              timestamp: entry.timestamp,
              toolUseId: content.tool_use_id,
              tool: toolName,
              preview: resultContent.substring(0, MESSAGE_TEXT_LIMIT),
              contentLength: resultContent.length,
              isError: content.is_error || false,
            };
            this.emit('subagent:tool_result', toolResult);
          } else if (content.type === 'text' && content.text) {
            const text = content.text.trim();
            if (text.length > 0) {
              const message: SubagentMessage = {
                agentId,
                sessionId,
                timestamp: entry.timestamp,
                role: 'assistant',
                text: text.substring(0, MESSAGE_TEXT_LIMIT), // Limit text length
              };
              this.emit('subagent:message', message);
            }
          }
        }
      }
    } else if (entry.type === 'user' && entry.message?.content) {
      // Handle both string and array content formats - also check for tool_result in user messages
      if (typeof entry.message.content === 'string') {
        const userText = entry.message.content.trim();
        if (userText.length > 0 && userText.length < 500) {
          const message: SubagentMessage = {
            agentId,
            sessionId,
            timestamp: entry.timestamp,
            role: 'user',
            text: userText,
          };
          this.emit('subagent:message', message);
        }
      } else {
        // Check for tool_result blocks in user messages (common pattern)
        for (const content of entry.message.content) {
          if (content.type === 'tool_result' && content.tool_use_id) {
            const resultContent = this.extractToolResultContent(content.content);
            const agentPendingCalls = this.pendingToolCalls.get(agentId);
            const toolName = agentPendingCalls?.get(content.tool_use_id);
            // Delete after lookup to prevent memory leak
            agentPendingCalls?.delete(content.tool_use_id);

            const toolResult: SubagentToolResult = {
              agentId,
              sessionId,
              timestamp: entry.timestamp,
              toolUseId: content.tool_use_id,
              tool: toolName,
              preview: resultContent.substring(0, MESSAGE_TEXT_LIMIT),
              contentLength: resultContent.length,
              isError: content.is_error || false,
            };
            this.emit('subagent:tool_result', toolResult);
          } else if (content.type === 'text' && content.text) {
            const userText = content.text.trim();
            if (userText.length > 0 && userText.length < 500) {
              const message: SubagentMessage = {
                agentId,
                sessionId,
                timestamp: entry.timestamp,
                role: 'user',
                text: userText,
              };
              this.emit('subagent:message', message);
            }
          }
        }
      }
    }
  }

  /**
   * Extract text content from tool_result content field
   */
  private extractToolResultContent(content: string | Array<{ type: string; text?: string }> | undefined): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text)
        .join('\n');
    }
    return '';
  }

  /**
   * Get truncated input for display (keeps primary param, truncates large content)
   */
  private getTruncatedInput(_tool: string, input: Record<string, unknown>): Record<string, unknown> {
    const truncated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string' && value.length > INPUT_TRUNCATE_LENGTH) {
        // Keep short preview of long strings
        truncated[key] = value.substring(0, INPUT_TRUNCATE_LENGTH) + '...';
      } else {
        truncated[key] = value;
      }
    }
    return truncated;
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
      details = cmd.length > COMMAND_DISPLAY_LENGTH ? cmd.substring(0, COMMAND_DISPLAY_LENGTH) + '...' : cmd;
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
