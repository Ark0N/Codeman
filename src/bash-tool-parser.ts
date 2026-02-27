/**
 * @fileoverview Bash Tool Parser - Detects active Bash tool commands with file paths
 *
 * This module parses terminal output from Claude Code sessions to detect:
 * - Bash tool invocations (● Bash(command) pattern)
 * - File paths within commands (for tail, cat, head, grep, watch, less)
 * - Tool completion (✓ or ✗ status)
 *
 * When a file-viewing command is detected, emits events with clickable paths
 * that can be used to open live log viewer windows.
 *
 * @module bash-tool-parser
 */

import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { ActiveBashTool } from './types.js';

// ========== Configuration Constants ==========

/**
 * Maximum number of active tools to track per session.
 * Older tools are removed when this limit is reached.
 */
const MAX_ACTIVE_TOOLS = 20;

/**
 * Debounce interval for event emissions (milliseconds).
 * Prevents UI jitter from rapid consecutive updates.
 */
const EVENT_DEBOUNCE_MS = 50;

/**
 * Maximum line buffer size to prevent unbounded growth from long lines.
 */
const MAX_LINE_BUFFER_SIZE = 64 * 1024;

// ========== Pre-compiled Regex Patterns ==========

/**
 * Matches Bash tool invocation line from Claude Code output.
 * Pattern: ● Bash(command) or ● Bash(command) timeout: 5m 0s
 * The tool name can appear with or without the bullet point.
 *
 * Capture groups:
 * - 1: The command being executed
 * - 2: Optional timeout string
 */
const BASH_TOOL_START_PATTERN = /(?:^|\s)●?\s*Bash\((.+?)\)(?:\s+timeout:\s*([^\n]+))?/;

/**
 * Matches tool completion indicators.
 * ✓ indicates success, ✗ indicates failure.
 */
const TOOL_COMPLETION_PATTERN = /(?:✓|✗)\s+Bash/;

/**
 * Commands that view/stream file content (worth tracking for live viewing).
 * These are the commands where clicking to open a log viewer makes sense.
 */
const FILE_VIEWER_COMMANDS = /^(?:tail|cat|head|less|grep|watch|multitail)\s+/;

/**
 * Alternative: Commands with -f flag (follow mode) are especially interesting
 */
const FOLLOW_MODE_PATTERN = /\s-[A-Za-z]*f[A-Za-z]*\s|\s--follow\s/;

/**
 * Extracts file paths from a command string.
 * Matches paths starting with / or ~ followed by path characters.
 * Excludes common non-path patterns like flags.
 *
 * Note: This is a simpler approach - we run it on each command string
 * rather than trying to match globally.
 */
const FILE_PATH_PATTERN = /(?:^|\s|['"]|=)([/~][^\s'"<>|;&\n]+)/g;

/**
 * Pattern to detect paths that are likely not real files (flags, etc.)
 */
const INVALID_PATH_PATTERN = /^[/~]-|\/dev\/null$/;

/**
 * Pattern to detect command suggestions in plain text output.
 * Matches lines like "tail -f /path/to/file" without the ● Bash() wrapper.
 * This catches commands Claude mentions but doesn't execute.
 */
const TEXT_COMMAND_PATTERN =
  /^\s*(tail|cat|head|less|grep|watch|multitail)\s+(?:-[^\s]+\s+)*([/~][^\s'"<>|;&\n]+)/;

/**
 * Pattern to detect log file paths mentioned in text (even without commands).
 * Matches paths ending in .log, .txt, .out, or in common log directories.
 */
const LOG_FILE_MENTION_PATTERN =
  /([/~][^\s'"<>|;&\n]*(?:\.log|\.txt|\.out|\/log\/[^\s'"<>|;&\n]+))/g;

// ========== Event Interfaces ==========

/**
 * Events emitted by BashToolParser.
 */
export interface BashToolParserEvents {
  /** New Bash tool with file paths started */
  toolStart: [tool: ActiveBashTool];
  /** Bash tool completed */
  toolEnd: [tool: ActiveBashTool];
  /** Active tools list updated */
  toolsUpdate: [tools: ActiveBashTool[]];
}

/**
 * Configuration options for BashToolParser.
 */
export interface BashToolParserConfig {
  /** Session ID this parser belongs to */
  sessionId: string;
  /** Whether the parser is enabled (default: true) */
  enabled?: boolean;
  /** Working directory for resolving relative paths */
  workingDir?: string;
}

// ========== BashToolParser Class ==========

/**
 * Parses Claude Code terminal output to detect Bash tool commands with file paths.
 * Emits events when file-viewing commands are detected, allowing the UI to
 * display clickable paths for opening live log viewers.
 *
 * @example
 * ```typescript
 * const parser = new BashToolParser({ sessionId: 'abc123' });
 * parser.on('toolStart', (tool) => {
 *   console.log(`New tool: ${tool.command}`);
 *   console.log(`File paths: ${tool.filePaths.join(', ')}`);
 * });
 * parser.processTerminalData(terminalOutput);
 * ```
 */
export class BashToolParser extends EventEmitter<BashToolParserEvents> {
  private _sessionId: string;
  private _enabled: boolean;
  private _activeTools: Map<string, ActiveBashTool> = new Map();
  private _lineBuffer: string = '';
  private _lastToolId: string | null = null;
  private _workingDir: string;
  private _homeDir: string;

  // Track auto-remove timers for cleanup
  private _autoRemoveTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  // Flag to prevent operations after destroy
  private _destroyed: boolean = false;

  // Debouncing
  private _pendingUpdate: boolean = false;
  private _updateTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: BashToolParserConfig) {
    super();
    this._sessionId = config.sessionId;
    this._enabled = config.enabled ?? true;
    this._workingDir = config.workingDir || process.cwd();
    this._homeDir = process.env.HOME || '/home/user';
  }

  // ========== Public Accessors ==========

  /** Whether the parser is currently enabled */
  get enabled(): boolean {
    return this._enabled;
  }

  /** Session ID this parser belongs to */
  get sessionId(): string {
    return this._sessionId;
  }

  /** Currently active tools */
  get activeTools(): ActiveBashTool[] {
    return Array.from(this._activeTools.values());
  }

  /** Current working directory used for path resolution */
  get workingDir(): string {
    return this._workingDir;
  }

  // ========== Path Normalization ==========

  /**
   * Normalize a file path to its canonical form.
   * - Expands ~ to home directory
   * - Resolves relative paths against working directory
   * - Normalizes . and .. components
   * - Removes trailing slashes
   */
  normalizePath(path: string): string {
    if (!path) return '';

    let normalized = path.trim();

    // Expand ~ to home directory
    if (normalized.startsWith('~/')) {
      normalized = this._homeDir + normalized.slice(1);
    } else if (normalized === '~') {
      normalized = this._homeDir;
    }

    // If not absolute, resolve against working directory
    if (!normalized.startsWith('/')) {
      normalized = this._workingDir + '/' + normalized;
    }

    // Normalize path components (resolve . and ..)
    const parts = normalized.split('/');
    const stack: string[] = [];

    for (const part of parts) {
      if (part === '' || part === '.') {
        continue;
      } else if (part === '..') {
        if (stack.length > 1) {
          stack.pop();
        }
      } else {
        stack.push(part);
      }
    }

    return '/' + stack.join('/');
  }

  /**
   * Extract just the filename from a path.
   */
  private getFilename(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1] || '';
  }

  /**
   * Check if a path is a "shallow root path" - an absolute path with only one
   * component after root (e.g., /test.txt, /file.log).
   * These are often typos where the user meant a relative path.
   */
  private isShallowRootPath(path: string): boolean {
    if (!path.startsWith('/')) return false;
    const parts = path.split('/').filter((p) => p !== '');
    return parts.length === 1;
  }

  /**
   * Check if a path is inside (or is) the working directory.
   */
  isPathInWorkingDir(path: string): boolean {
    const normalized = this.normalizePath(path);
    return normalized.startsWith(this._workingDir + '/') || normalized === this._workingDir;
  }

  /**
   * Smart path equivalence check.
   * Two paths are considered equivalent if:
   * 1. They normalize to the same path (standard case)
   * 2. One is a "shallow root path" (e.g., /test.txt) and the other is the
   *    same filename inside the working directory - the shallow root path
   *    is likely a typo and they probably meant the same file.
   */
  pathsAreEquivalent(path1: string, path2: string): boolean {
    const norm1 = this.normalizePath(path1);
    const norm2 = this.normalizePath(path2);

    // Standard check: exact normalized match
    if (norm1 === norm2) return true;

    // Smart check: shallow root path vs working dir path with same filename
    const file1 = this.getFilename(norm1);
    const file2 = this.getFilename(norm2);

    if (file1 !== file2) return false; // Different filenames, can't be equivalent

    const shallow1 = this.isShallowRootPath(path1);
    const shallow2 = this.isShallowRootPath(path2);
    const inWorkDir1 = this.isPathInWorkingDir(norm1);
    const inWorkDir2 = this.isPathInWorkingDir(norm2);

    // If one is shallow root (e.g., /test.txt) and other is in working dir
    // with same filename, treat as equivalent (user likely made a typo)
    if (shallow1 && inWorkDir2) return true;
    if (shallow2 && inWorkDir1) return true;

    return false;
  }

  /**
   * Given multiple paths, deduplicate and return the "best" paths.
   * Uses smart equivalence checking:
   * - Standard normalization for relative vs absolute paths
   * - Detects likely typos (e.g., /file.txt when workingDir/file.txt exists)
   * - Prefers paths inside the working directory
   * - Prefers longer, more explicit paths
   */
  deduplicatePaths(paths: string[]): string[] {
    if (paths.length <= 1) return paths;

    const result: string[] = [];
    const seenNormalized = new Set<string>();

    // Sort paths: prefer paths in working dir first, then by length (longer first)
    const sortedPaths = [...paths].sort((a, b) => {
      const aInWorkDir = this.isPathInWorkingDir(a);
      const bInWorkDir = this.isPathInWorkingDir(b);
      if (aInWorkDir && !bInWorkDir) return -1;
      if (bInWorkDir && !aInWorkDir) return 1;
      return b.length - a.length; // Longer paths first
    });

    for (const path of sortedPaths) {
      const normalized = this.normalizePath(path);

      // Check if we've already seen an equivalent path
      let isDuplicate = false;
      for (const existing of result) {
        if (this.pathsAreEquivalent(path, existing)) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate && !seenNormalized.has(normalized)) {
        result.push(path);
        seenNormalized.add(normalized);
      }
    }

    return result;
  }

  // ========== Public Methods ==========

  /**
   * Update the working directory (e.g., when session changes directory).
   */
  setWorkingDir(workingDir: string): void {
    this._workingDir = workingDir;
  }

  /**
   * Check if a file path is already being tracked by an active tool.
   * Uses path normalization to detect equivalent paths.
   * For example, "/test.txt" and "/home/user/test.txt" when workingDir
   * is "/home/user" would NOT be considered equivalent (different files),
   * but "test.txt" and "/home/user/test.txt" WOULD be (same file).
   */
  isFilePathTracked(filePath: string): boolean {
    const normalizedNew = this.normalizePath(filePath);

    return Array.from(this._activeTools.values()).some((t) => {
      if (t.status !== 'running') return false;

      return t.filePaths.some((existingPath) => {
        const normalizedExisting = this.normalizePath(existingPath);
        return normalizedExisting === normalizedNew;
      });
    });
  }

  /**
   * Get all tracked paths (normalized) for debugging.
   */
  getTrackedPaths(): { raw: string; normalized: string }[] {
    const paths: { raw: string; normalized: string }[] = [];
    for (const tool of this._activeTools.values()) {
      if (tool.status === 'running') {
        for (const path of tool.filePaths) {
          paths.push({ raw: path, normalized: this.normalizePath(path) });
        }
      }
    }
    return paths;
  }

  /**
   * Enables the parser.
   */
  enable(): void {
    this._enabled = true;
  }

  /**
   * Disables the parser.
   */
  disable(): void {
    this._enabled = false;
  }

  /**
   * Resets the parser state, clearing all tracked tools.
   */
  reset(): void {
    this._activeTools.clear();
    this._lineBuffer = '';
    this._lastToolId = null;
    this.emitUpdate();
  }

  /**
   * Process terminal data to detect Bash tool patterns.
   * Call this with each chunk of PTY output.
   *
   * @param data - Raw terminal data (may include ANSI codes)
   */
  processTerminalData(data: string): void {
    if (!this._enabled || this._destroyed) return;

    // Append to line buffer (raw data — lines will be stripped individually in processLine)
    this._lineBuffer += data;

    // Prevent unbounded growth
    if (this._lineBuffer.length > MAX_LINE_BUFFER_SIZE) {
      const trimPoint = this._lineBuffer.lastIndexOf('\n', MAX_LINE_BUFFER_SIZE / 2);
      this._lineBuffer =
        trimPoint > 0
          ? this._lineBuffer.slice(trimPoint + 1)
          : this._lineBuffer.slice(-MAX_LINE_BUFFER_SIZE / 2);
    }

    // Process complete lines
    const lines = this._lineBuffer.split('\n');

    // Keep the last incomplete line in buffer
    this._lineBuffer = lines.pop() || '';

    for (const line of lines) {
      this.processLine(line);
    }
  }

  /**
   * Process pre-stripped terminal data (ANSI codes already removed).
   * Use this when the caller has already stripped ANSI to avoid redundant regex work.
   */
  processCleanData(data: string): void {
    if (!this._enabled || this._destroyed) return;

    this._lineBuffer += data;

    if (this._lineBuffer.length > MAX_LINE_BUFFER_SIZE) {
      const trimPoint = this._lineBuffer.lastIndexOf('\n', MAX_LINE_BUFFER_SIZE / 2);
      this._lineBuffer =
        trimPoint > 0
          ? this._lineBuffer.slice(trimPoint + 1)
          : this._lineBuffer.slice(-MAX_LINE_BUFFER_SIZE / 2);
    }

    const lines = this._lineBuffer.split('\n');
    this._lineBuffer = lines.pop() || '';

    for (const line of lines) {
      this.processCleanLine(line);
    }
  }

  // ========== Private Methods ==========

  /**
   * Process a single line of terminal output (raw — will strip ANSI).
   */
  private processLine(line: string): void {
    const cleanLine = this.stripAnsi(line);
    this.processCleanLine(cleanLine);
  }

  /**
   * Process a single pre-stripped line of terminal output.
   */
  private processCleanLine(cleanLine: string): void {
    // Check for tool start
    const startMatch = cleanLine.match(BASH_TOOL_START_PATTERN);
    if (startMatch) {
      const command = startMatch[1];
      const timeout = startMatch[2]?.trim();

      // Check if this is a file-viewing command
      if (this.isFileViewerCommand(command)) {
        const filePaths = this.extractFilePaths(command);

        // Skip if any file path is already tracked (cross-pattern dedup)
        if (filePaths.some((fp) => this.isFilePathTracked(fp))) {
          return;
        }

        if (filePaths.length > 0) {
          const tool: ActiveBashTool = {
            id: uuidv4(),
            command,
            filePaths,
            timeout,
            startedAt: Date.now(),
            status: 'running',
            sessionId: this._sessionId,
          };

          // Enforce max tools limit
          if (this._activeTools.size >= MAX_ACTIVE_TOOLS) {
            // Remove oldest tool
            const oldest = Array.from(this._activeTools.entries()).sort(
              (a, b) => a[1].startedAt - b[1].startedAt
            )[0];
            if (oldest) {
              this._activeTools.delete(oldest[0]);
            }
          }

          this._activeTools.set(tool.id, tool);
          this._lastToolId = tool.id;

          this.emit('toolStart', tool);
          this.scheduleUpdate();
        }
      }
      return;
    }

    // Check for tool completion
    if (TOOL_COMPLETION_PATTERN.test(cleanLine) && this._lastToolId) {
      const tool = this._activeTools.get(this._lastToolId);
      if (tool && tool.status === 'running') {
        tool.status = 'completed';
        this.emit('toolEnd', tool);
        this.scheduleUpdate();

        // Remove completed tool after a short delay to allow UI to show completion
        const timer = setTimeout(() => {
          this._autoRemoveTimers.delete(timer);
          if (this._destroyed) return;
          this._activeTools.delete(tool.id);
          this.scheduleUpdate();
        }, 2000);
        this._autoRemoveTimers.add(timer);
      }
      this._lastToolId = null;
      return;
    }

    // Fallback: Check for command suggestions in plain text (e.g., "tail -f /tmp/file.log")
    const textCmdMatch = cleanLine.match(TEXT_COMMAND_PATTERN);
    if (textCmdMatch) {
      const filePath = textCmdMatch[2];

      // Create a suggestion tool (marked as 'suggestion' status)
      const tool: ActiveBashTool = {
        id: uuidv4(),
        command: cleanLine.trim(),
        filePaths: [filePath],
        timeout: undefined,
        startedAt: Date.now(),
        status: 'running', // Shows as clickable
        sessionId: this._sessionId,
      };

      // Don't add if file path already tracked (cross-pattern dedup)
      if (this.isFilePathTracked(filePath)) {
        return;
      }

      this._activeTools.set(tool.id, tool);
      this.emit('toolStart', tool);
      this.scheduleUpdate();

      // Auto-remove suggestions after 30 seconds
      const timer = setTimeout(() => {
        this._autoRemoveTimers.delete(timer);
        if (this._destroyed) return;
        this._activeTools.delete(tool.id);
        this.scheduleUpdate();
      }, 30000);
      this._autoRemoveTimers.add(timer);
      return;
    }

    // Last fallback: Check for log file paths mentioned anywhere in the line
    LOG_FILE_MENTION_PATTERN.lastIndex = 0;
    let logMatch;
    while ((logMatch = LOG_FILE_MENTION_PATTERN.exec(cleanLine)) !== null) {
      const filePath = logMatch[1].replace(/[,;:]+$/, ''); // Clean trailing punctuation

      // Skip if it looks invalid
      if (INVALID_PATH_PATTERN.test(filePath)) continue;

      // Skip if file path already tracked (cross-pattern dedup)
      if (this.isFilePathTracked(filePath)) continue;

      const tool: ActiveBashTool = {
        id: uuidv4(),
        command: `View: ${filePath}`,
        filePaths: [filePath],
        timeout: undefined,
        startedAt: Date.now(),
        status: 'running',
        sessionId: this._sessionId,
      };

      this._activeTools.set(tool.id, tool);
      this.emit('toolStart', tool);
      this.scheduleUpdate();

      // Auto-remove after 60 seconds
      const timer = setTimeout(() => {
        this._autoRemoveTimers.delete(timer);
        if (this._destroyed) return;
        this._activeTools.delete(tool.id);
        this.scheduleUpdate();
      }, 60000);
      this._autoRemoveTimers.add(timer);
    }
  }

  /**
   * Check if a command is a file-viewing command worth tracking.
   */
  private isFileViewerCommand(command: string): boolean {
    // Commands that typically view files
    if (FILE_VIEWER_COMMANDS.test(command)) {
      return true;
    }

    // Any command with -f (follow) flag is interesting
    if (FOLLOW_MODE_PATTERN.test(` ${command} `)) {
      return true;
    }

    return false;
  }

  /**
   * Extract file paths from a command string.
   * Returns deduplicated paths, preferring more complete/absolute versions.
   */
  private extractFilePaths(command: string): string[] {
    const rawPaths: string[] = [];
    let match;

    // Reset regex state
    FILE_PATH_PATTERN.lastIndex = 0;

    while ((match = FILE_PATH_PATTERN.exec(command)) !== null) {
      const path = match[1];

      // Skip invalid paths
      if (INVALID_PATH_PATTERN.test(path)) {
        continue;
      }

      // Skip if it looks like a flag (starts with -)
      if (path.includes('/-')) {
        continue;
      }

      // Clean up path (remove trailing punctuation)
      const cleanPath = path.replace(/[,;:]+$/, '');

      if (cleanPath) {
        rawPaths.push(cleanPath);
      }
    }

    // Deduplicate paths that resolve to the same file
    return this.deduplicatePaths(rawPaths);
  }

  /**
   * Strip ANSI escape codes from a string.
   */
  private stripAnsi(str: string): string {
    // Comprehensive ANSI pattern
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[=>])/g, '');
  }

  /**
   * Schedule a debounced update emission.
   */
  private scheduleUpdate(): void {
    if (this._pendingUpdate) return;

    this._pendingUpdate = true;
    this._updateTimer = setTimeout(() => {
      this._pendingUpdate = false;
      this.emitUpdate();
    }, EVENT_DEBOUNCE_MS);
  }

  /**
   * Emit the current active tools list.
   */
  private emitUpdate(): void {
    this.emit('toolsUpdate', this.activeTools);
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this._destroyed = true;
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
      this._updateTimer = null;
    }
    // Clear all auto-remove timers to prevent orphaned callbacks
    for (const timer of this._autoRemoveTimers) {
      clearTimeout(timer);
    }
    this._autoRemoveTimers.clear();
    this._activeTools.clear();
    this.removeAllListeners();
  }
}
