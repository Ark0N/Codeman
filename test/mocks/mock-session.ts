/**
 * Shared MockSession for tests that need terminal simulation.
 * Used by respawn, route, and subagent tests.
 */
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { SessionStatus } from '../../src/types.js';

/**
 * Enhanced mock session for testing RespawnController.
 * Extends the existing MockSession pattern with additional utilities.
 */
export class MockSession extends EventEmitter {
  id: string;
  workingDir: string = '/tmp/test-workdir';
  /**
   * The REAL union, deliberately. This used to be `'idle' | 'working'`, and
   * `'working'` is not a `SessionStatus` at all — so `signalForStatus()` fell to its
   * `default: null` branch in every route test and the busy / stopped / error halves
   * of the immediate-resolve mapping had zero coverage while appearing to be tested.
   */
  status: SessionStatus = 'idle';
  /** `null` once the PTY is gone (or before it has ever started) — see `pid` in Session. */
  pid: number | null = 12345;
  isWorking: boolean = false;
  private _activeChildProcesses: { pid: number; command: string }[] = [];
  ralphTracker: null = null;
  writeBuffer: string[] = [];
  terminalBuffer: string = '';
  /** Mirrors Session.lastSubmitAt — the response viewer credits history entries by it. */
  lastSubmitAt: number = 0;
  /** Mirrors Session.claudeSessionId — the conversation the viewer reads. */
  claudeSessionId: string | null = null;
  /** Mirrors Session.claudeSessionIdIsFirstHand — set only by a hook adoption. */
  claudeSessionIdIsFirstHand: boolean = false;
  /** Mirrors Session.claudeSessionChain — oldest first, current last. */
  claudeSessionChain: string[] = [];

  /** Mirrors Session.adoptClaudeSessionId, including the first-hand chain rule. */
  adoptClaudeSessionId(newId: string, options: { firstHand?: boolean } = {}): void {
    if (!newId) return;
    if (options.firstHand) {
      this.claudeSessionIdIsFirstHand = true;
      if (this.claudeSessionChain[this.claudeSessionChain.length - 1] !== newId) {
        const existing = this.claudeSessionChain.indexOf(newId);
        if (existing !== -1) this.claudeSessionChain.splice(existing, 1);
        this.claudeSessionChain.push(newId);
      }
    }
    if (newId === this.claudeSessionId) return;
    this.claudeSessionId = newId;
  }

  /** Mirrors Session.markPromptSubmitted. */
  markPromptSubmitted(): void {
    this.lastSubmitAt = Date.now();
  }

  private _muxName: string | null = null;

  constructor(id: string = 'mock-session-id') {
    super();
    this.id = id;
    this._muxName = `codeman-test-${id.slice(0, 8)}`;
  }

  /**
   * Set to simulate a session whose PTY is gone: both write paths report failure,
   * which is the state in which input used to disappear silently.
   */
  failWrites = false;

  /** Direct PTY write (used by session.write()). Mirrors the real boolean return. */
  write(data: string): boolean {
    if (this.failWrites) return false;
    this.writeBuffer.push(data);
    return true;
  }

  /** Write via mux (used by respawn controller) */
  async writeViaMux(data: string): Promise<boolean> {
    if (this.failWrites) return false;
    this.writeBuffer.push(data);
    return true;
  }

  /** Exactly-once input dedup — mirrors Session.shouldApplyInput so route tests
   *  exercising the reliable-delivery path behave like production. */
  private _appliedInputSeq = new Map<string, number>();
  forgetInputSeq(clientId: string, seq: number): void {
    if (this._appliedInputSeq.get(clientId) === seq) this._appliedInputSeq.set(clientId, seq - 1);
  }

  shouldApplyInput(clientId: string, seq: number): boolean {
    const last = this._appliedInputSeq.get(clientId);
    if (last !== undefined && seq <= last) return false;
    this._appliedInputSeq.set(clientId, seq);
    return true;
  }

  /** Get the last written data */
  get lastWrite(): string | undefined {
    return this.writeBuffer[this.writeBuffer.length - 1];
  }

  /** Clear the write buffer */
  clearWriteBuffer(): void {
    this.writeBuffer = [];
  }

  /** Check if a specific command was written */
  hasWritten(pattern: string | RegExp): boolean {
    return this.writeBuffer.some((data) => (typeof pattern === 'string' ? data.includes(pattern) : pattern.test(data)));
  }

  // ========== Terminal Output Simulation ==========

  /** Simulate raw terminal output */
  simulateTerminalOutput(data: string): void {
    this.terminalBuffer += data;
    this.emit('terminal', data);
  }

  /** Simulate prompt appearing (legacy fallback signal) */
  simulatePrompt(): void {
    this.simulateTerminalOutput('\u276f ');
    this.status = 'idle';
    this.emit('idle');
  }

  /** Simulate ready state with definitive indicator (legacy) */
  simulateReady(): void {
    this.simulateTerminalOutput('\u21b5 send');
    this.status = 'idle';
    this.emit('idle');
  }

  /**
   * Simulate completion message (primary idle detection in Claude Code 2024+).
   * This triggers the multi-layer detection flow.
   */
  simulateCompletionMessage(duration: string = '2m 46s'): void {
    this.simulateTerminalOutput(`\u273b Worked for ${duration}`);
    this.status = 'idle';
  }

  /** Simulate working state with spinner */
  simulateWorking(text: string = 'Thinking'): void {
    this.simulateTerminalOutput(`${text}... \u280b`);
    // 'busy' is what the real Session sets while a turn is in flight; the old
    // 'working' here was the event name, not a status value.
    this.status = 'busy';
    this.emit('working');
  }

  /** Simulate /clear completion */
  simulateClearComplete(): void {
    this.simulateTerminalOutput('conversation cleared');
    setTimeout(() => this.simulateCompletionMessage(), 50);
  }

  /** Simulate /init completion */
  simulateInitComplete(): void {
    this.simulateTerminalOutput('Analyzing CLAUDE.md...');
    setTimeout(() => this.simulateCompletionMessage(), 100);
  }

  /**
   * Simulate plan mode approval prompt.
   * This triggers auto-accept detection.
   */
  simulatePlanModePrompt(): void {
    this.simulateTerminalOutput(
      'Would you like to proceed with this plan?\n' + '\u276f 1. Yes\n' + '  2. No\n' + '  3. Type your own\n'
    );
  }

  /**
   * Simulate elicitation dialog (AskUserQuestion).
   * This should block auto-accept.
   */
  simulateElicitationDialog(): void {
    this.simulateTerminalOutput('What would you like to name the new file?\n' + '> ');
  }

  /** Simulate token count display */
  simulateTokenCount(tokens: number | string): void {
    const formatted =
      typeof tokens === 'number' ? (tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)) : tokens;
    this.simulateTerminalOutput(`${formatted} tokens used`);
  }

  /** Simulate ANSI escape codes */
  simulateAnsiOutput(text: string, color: 'green' | 'red' | 'blue' = 'green'): void {
    const codes: Record<string, string> = {
      green: '\x1b[32m',
      red: '\x1b[31m',
      blue: '\x1b[34m',
    };
    this.simulateTerminalOutput(`${codes[color]}${text}\x1b[0m`);
  }

  /** Clear terminal buffer */
  clearTerminalBuffer(): void {
    this.terminalBuffer = '';
  }

  // ========== Session Lifecycle ==========

  /** Simulate session closing */
  close(): void {
    this.emit('exit', 0);
    this.removeAllListeners();
  }

  /** Get mux name (for mux-based operations) */
  get muxName(): string | null {
    return this._muxName;
  }

  /**
   * Mirrors `Session.usesMux`. True by default because that is the normal
   * configuration, and it is what makes a route's pane-liveness probe reachable:
   * `session.pid` is the tmux ATTACH CLIENT, so a mux-backed session's worker can be
   * dead while `pid` is still a live number.
   */
  usesMux: boolean = true;

  /** Check for active child processes (mock returns configurable list) */
  getActiveChildProcesses(): { pid: number; command: string }[] {
    return this._activeChildProcesses;
  }

  /** Set active child processes for testing */
  setActiveChildProcesses(processes: { pid: number; command: string }[]): void {
    this._activeChildProcesses = processes;
  }

  // ========== Route-test conveniences ==========

  /** Session display name */
  name: string = 'test-session';

  /** Session color tag */
  color: string = 'default';

  /** CLI mode */
  mode: string = 'claude';

  /** Text output buffer (stripped of ANSI) */
  textOutput: string = '';

  /** Structured messages */
  messages: unknown[] = [];

  /** Error buffer */
  errorBuffer: string = '';

  /** Ralph loop state */
  ralphLoopState: Record<string, unknown> | null = null;

  /** Ralph todo items */
  ralphTodos: unknown[] = [];

  /** Ralph todo statistics */
  ralphTodoStats: Record<string, unknown> = {};

  /** Currently active tools */
  activeTools: unknown[] = [];

  /** Token tracking */
  inputTokens: number = 0;
  outputTokens: number = 0;
  totalCost: number = 0;

  /** Terminal buffer byte length */
  get terminalBufferLength(): number {
    return this.terminalBuffer.length;
  }

  /** Return a state-like object for route handlers */
  toState(): Record<string, unknown> {
    return {
      id: this.id,
      workingDir: this.workingDir,
      status: this.status,
      name: this.name,
      color: this.color,
      mode: this.mode,
      muxName: this._muxName,
      pinned: this.pinned || undefined,
      pinnedAt: this.pinned ? (this.pinnedAt ?? undefined) : undefined,
    };
  }

  /** Auto-resume on usage limit (token pause control) */
  autoResumeEnabled: boolean = false;
  autoResumeAt: number | null = null;
  isLimitPaused: boolean = false;
  setAutoResume = vi.fn((enabled: boolean) => {
    this.autoResumeEnabled = enabled;
    if (!enabled) this.autoResumeAt = null;
  });

  /** Pin state (COD-139) */
  pinned: boolean = false;
  pinnedAt: number | null = null;
  setPinned = vi.fn((pinned: boolean) => {
    this.pinned = pinned;
    this.pinnedAt = pinned ? Date.now() : null;
  });

  /** Check if session is busy */
  isBusy = vi.fn(() => false);

  /** Set session color */
  setColor = vi.fn((c: string) => {
    this.color = c;
  });

  /** Custom Model Endpoint Profiles (deployment_plan.md) */
  customModel: { endpointId: string; modelId: string; label?: string } | undefined = undefined;
  private _mockCustomModelConfigDir: string | undefined;
  setCustomModel = vi.fn(
    (
      next: { endpointId: string; modelId: string; label?: string; envKeys: string[]; configDir?: string } | undefined,
      _envOverrides?: Record<string, string>
    ): string | undefined => {
      const previous = this._mockCustomModelConfigDir;
      this._mockCustomModelConfigDir = next?.configDir;
      this.customModel = next ? { endpointId: next.endpointId, modelId: next.modelId, label: next.label } : undefined;
      return previous;
    }
  );
  restartCli = vi.fn(async () => true);

  /** Stub for sendInput */
  sendInput = vi.fn();

  /** Stub for resize */
  resize = vi.fn();

  /** Stubs for the desktop sizing claims used by resize arbitration */
  claimDesktopSizing = vi.fn();
  releaseDesktopSizing = vi.fn();
  noteDesktopActivity = vi.fn();

  /** Stub for runPrompt */
  runPrompt = vi.fn(async () => {});

  /** Stub for startInteractive */
  startInteractive = vi.fn(async () => {});

  /** Stub for resetRespawnBreaker (COD-118) */
  resetRespawnBreaker = vi.fn();

  /** Stub for startShell */
  startShell = vi.fn(async () => {});

  /** Stub for compact */
  compact = vi.fn();

  /** Stub for getTextOutput */
  getTextOutput = vi.fn(() => '');

  /** Stub for getMessages */
  getMessages = vi.fn(() => []);
}

/**
 * Generate realistic terminal output for testing.
 * Must match the patterns used in MockSession's simulate* methods.
 */
export const terminalOutputs = {
  /** Standard completion message */
  completion(duration: string = '2m 46s'): string {
    return `\n\u273b Worked for ${duration}\n  123.4k tokens used\n`;
  },

  /** Working spinner output */
  working(activity: string = 'Thinking'): string {
    return `${activity}... \u280b`;
  },

  /** Plan mode prompt */
  planMode(question: string = 'Would you like to proceed?'): string {
    return [`\n${question}\n`, '\u276f 1. Yes\n', '  2. No\n', '  3. Type your own\n'].join('');
  },

  /** Prompt character */
  prompt(): string {
    return '\n\u276f ';
  },

  /** Token count display */
  tokens(count: number): string {
    const formatted =
      count >= 1000000
        ? `${(count / 1000000).toFixed(1)}M`
        : count >= 1000
          ? `${(count / 1000).toFixed(1)}k`
          : String(count);
    return `  ${formatted} tokens\n`;
  },

  /** Large output for buffer testing */
  largeOutput(sizeKb: number = 100): string {
    const baseText = 'Lorem ipsum dolor sit amet. '.repeat(100);
    const repetitions = Math.ceil((sizeKb * 1024) / baseText.length);
    return baseText.repeat(repetitions).slice(0, sizeKb * 1024);
  },

  /** ANSI colored output */
  ansiColored(text: string): string {
    return `\x1b[32m${text}\x1b[0m`;
  },
};

/**
 * Convenience factory.
 */
export function createMockSession(id?: string): MockSession {
  return new MockSession(id);
}
