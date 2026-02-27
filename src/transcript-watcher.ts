/**
 * @fileoverview Transcript Watcher - Real-time monitoring of Claude Code session transcripts
 *
 * Watches the main session transcript JSONL file and emits structured events for:
 * - Assistant message completion
 * - Tool execution state
 * - Error conditions
 * - Plan mode prompts
 *
 * The transcript path is provided by Claude Code hooks in the `transcript_path` field.
 */

import { EventEmitter } from 'node:events';
import { watch, statSync, existsSync, FSWatcher } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// ========== Types ==========

/**
 * Parsed transcript entry from the JSONL file
 */
export interface TranscriptEntry {
  type: 'user' | 'assistant' | 'system' | 'result';
  timestamp: string;
  message?: {
    role: string;
    content: string | TranscriptContentBlock[];
  };
  total_cost_usd?: number;
  duration_ms?: number;
  error?: {
    type: string;
    message: string;
  };
}

export interface TranscriptContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  is_error?: boolean;
}

/**
 * Detected state from transcript analysis
 */
export interface TranscriptState {
  /** Whether the last entry indicates completion */
  isComplete: boolean;
  /** Whether a tool is currently executing */
  toolExecuting: boolean;
  /** Current tool name if executing */
  currentTool: string | null;
  /** Whether an error was detected */
  hasError: boolean;
  /** Error message if any */
  errorMessage: string | null;
  /** Whether a plan mode prompt was detected */
  planModeDetected: boolean;
  /** Last assistant message (truncated) */
  lastAssistantMessage: string | null;
  /** Total entries processed */
  entryCount: number;
  /** Last update timestamp */
  lastUpdateAt: string | null;
}

export interface TranscriptWatcherEvents {
  'transcript:update': (state: TranscriptState) => void;
  'transcript:complete': (state: TranscriptState) => void;
  'transcript:tool_start': (toolName: string) => void;
  'transcript:tool_end': (toolName: string, isError: boolean) => void;
  'transcript:error': (error: Error) => void;
  'transcript:plan_mode': () => void;
}

// ========== Constants ==========

/** How often to check for new content when file watching fails */
const POLL_INTERVAL_MS = 1000;

/** Max characters to keep for lastAssistantMessage */
const MAX_MESSAGE_LENGTH = 500;

/** Patterns that indicate plan mode / approval prompt */
const PLAN_MODE_PATTERNS = [
  /ExitPlanMode/i,
  /AskUserQuestion/i,
  /Ready for user approval/i,
  /approve.*plan/i,
];

// ========== TranscriptWatcher Class ==========

export class TranscriptWatcher extends EventEmitter {
  private transcriptPath: string | null = null;
  private fileWatcher: FSWatcher | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private filePosition: number = 0;
  private _isRunning: boolean = false;
  private _isProcessing: boolean = false;
  private state: TranscriptState = this.getInitialState();

  constructor() {
    super();
  }

  private getInitialState(): TranscriptState {
    return {
      isComplete: false,
      toolExecuting: false,
      currentTool: null,
      hasError: false,
      errorMessage: null,
      planModeDetected: false,
      lastAssistantMessage: null,
      entryCount: 0,
      lastUpdateAt: null,
    };
  }

  // ========== Public API ==========

  /**
   * Start watching a transcript file
   * @param transcriptPath - Path to the JSONL transcript file
   */
  start(transcriptPath: string): void {
    if (this._isRunning && this.transcriptPath === transcriptPath) {
      return; // Already watching this file
    }

    // Stop any existing watcher
    this.stop();

    this.transcriptPath = transcriptPath;
    this._isRunning = true;
    this.state = this.getInitialState();
    this.filePosition = 0;

    // Check if file exists
    if (!existsSync(transcriptPath)) {
      // File doesn't exist yet, poll until it does
      this.startPolling();
      return;
    }

    // Get initial file size
    try {
      const stat = statSync(transcriptPath);
      // Start from the end to only process new entries
      this.filePosition = stat.size;
    } catch {
      this.filePosition = 0;
    }

    // Start watching
    this.setupFileWatcher();
  }

  /**
   * Stop watching
   */
  stop(): void {
    this._isRunning = false;

    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.transcriptPath = null;
    this.state = this.getInitialState();
  }

  /**
   * Check if watcher is running
   */
  isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Get current state
   */
  getState(): TranscriptState {
    return { ...this.state };
  }

  /**
   * Update the transcript path (e.g., from a new hook event)
   */
  updatePath(transcriptPath: string): void {
    if (this.transcriptPath !== transcriptPath) {
      this.start(transcriptPath);
    }
  }

  // ========== Private Methods ==========

  private startPolling(): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(() => {
      if (!this.transcriptPath || !this._isRunning) return;

      if (existsSync(this.transcriptPath)) {
        // File now exists, switch to file watching
        clearInterval(this.pollInterval!);
        this.pollInterval = null;
        this.setupFileWatcher();
      }
    }, POLL_INTERVAL_MS);
  }

  private setupFileWatcher(): void {
    if (!this.transcriptPath || !this._isRunning) return;

    try {
      this.fileWatcher = watch(this.transcriptPath, (eventType) => {
        if (eventType === 'change') {
          this.processNewContent();
        }
      });

      // Add error handler to prevent unhandled errors and fall back to polling
      this.fileWatcher.on('error', (err) => {
        this.emit('transcript:error', err as Error);
        this.fileWatcher?.close();
        this.fileWatcher = null;
        // Fall back to polling on error
        if (this._isRunning) {
          this.startPolling();
        }
      });

      // Initial read
      this.processNewContent();
    } catch (err) {
      // Fall back to polling if watch fails
      this.emit('transcript:error', err as Error);
      this.startPolling();
    }
  }

  private async processNewContent(): Promise<void> {
    if (!this.transcriptPath || !this._isRunning) return;
    if (this._isProcessing) return; // Guard against concurrent calls
    this._isProcessing = true;

    try {
      const stat = statSync(this.transcriptPath);
      if (stat.size < this.filePosition) {
        // File was truncated/replaced — reset and re-read from start
        this.filePosition = 0;
        this.state = this.getInitialState();
      } else if (stat.size === this.filePosition) {
        return; // No new content
      }

      // Read new content
      const newEntries = await this.readNewEntries();

      for (const entry of newEntries) {
        this.processEntry(entry);
      }

      if (newEntries.length > 0) {
        this.emit('transcript:update', this.getState());
      }
    } catch (err) {
      this.emit('transcript:error', err as Error);
    } finally {
      this._isProcessing = false;
    }
  }

  private readNewEntries(): Promise<TranscriptEntry[]> {
    return new Promise((resolve, reject) => {
      if (!this.transcriptPath) {
        resolve([]);
        return;
      }

      const entries: TranscriptEntry[] = [];
      const transcriptPath = this.transcriptPath;

      const stream = createReadStream(transcriptPath, {
        start: this.filePosition,
        encoding: 'utf-8',
      });

      const rl = createInterface({
        input: stream,
        crlfDelay: Infinity, // Handles both LF and CRLF
      });

      rl.on('line', (line) => {
        if (!line.trim()) return;

        try {
          const entry = JSON.parse(line) as TranscriptEntry;
          entries.push(entry);
        } catch {
          // Skip malformed lines
        }
      });

      rl.on('close', () => {
        // Update position to current file size (accounts for any line ending style)
        try {
          this.filePosition = statSync(transcriptPath).size;
        } catch {
          // File may have been deleted between read and stat
        }
        resolve(entries);
      });

      rl.on('error', reject);
      stream.on('error', reject);
    });
  }

  private processEntry(entry: TranscriptEntry): void {
    this.state.entryCount++;
    this.state.lastUpdateAt = entry.timestamp || new Date().toISOString();

    // Handle based on entry type
    switch (entry.type) {
      case 'assistant':
        this.handleAssistantEntry(entry);
        break;
      case 'result':
        this.handleResultEntry(entry);
        break;
      case 'user':
        // User message means new turn, reset some state
        this.state.isComplete = false;
        this.state.hasError = false;
        this.state.errorMessage = null;
        break;
      case 'system':
        // System messages are informational
        break;
    }

    // Check for plan mode patterns
    this.checkPlanMode(entry);
  }

  private handleAssistantEntry(entry: TranscriptEntry): void {
    if (!entry.message?.content) return;

    const content = entry.message.content;

    if (typeof content === 'string') {
      this.state.lastAssistantMessage = content.slice(0, MAX_MESSAGE_LENGTH);
    } else if (Array.isArray(content)) {
      // Process content blocks
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          this.state.lastAssistantMessage = block.text.slice(0, MAX_MESSAGE_LENGTH);
        } else if (block.type === 'tool_use' && block.name) {
          // Tool started
          this.state.toolExecuting = true;
          this.state.currentTool = block.name;
          this.emit('transcript:tool_start', block.name);
        } else if (block.type === 'tool_result') {
          // Tool completed
          const wasError = block.is_error === true;
          const toolName = this.state.currentTool;
          this.state.toolExecuting = false;
          this.state.currentTool = null;
          if (toolName) {
            this.emit('transcript:tool_end', toolName, wasError);
          }
          if (wasError && block.content) {
            this.state.hasError = true;
            this.state.errorMessage = String(block.content).slice(0, 200);
          }
        }
      }
    }
  }

  private handleResultEntry(entry: TranscriptEntry): void {
    // Result entry indicates completion
    this.state.isComplete = true;
    this.state.toolExecuting = false;
    this.state.currentTool = null;

    if (entry.error) {
      this.state.hasError = true;
      this.state.errorMessage = entry.error.message?.slice(0, 200) || 'Unknown error';
    }

    this.emit('transcript:complete', this.getState());
  }

  private checkPlanMode(entry: TranscriptEntry): void {
    // Check assistant messages for plan mode patterns
    if (entry.type !== 'assistant' || !entry.message?.content) return;

    const content = entry.message.content;
    const textToCheck =
      typeof content === 'string'
        ? content
        : content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && !!b.text)
            .map((b) => b.text)
            .join(' ');

    // Also check for tool_use with ExitPlanMode or AskUserQuestion
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use' && block.name) {
          if (block.name === 'ExitPlanMode' || block.name === 'AskUserQuestion') {
            this.state.planModeDetected = true;
            this.emit('transcript:plan_mode');
            return;
          }
        }
      }
    }

    for (const pattern of PLAN_MODE_PATTERNS) {
      if (pattern.test(textToCheck)) {
        this.state.planModeDetected = true;
        this.emit('transcript:plan_mode');
        return;
      }
    }
  }
}

// ========== Singleton Export ==========

export const transcriptWatcher = new TranscriptWatcher();
