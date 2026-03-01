/**
 * Shared MockSession for tests that need terminal simulation.
 *
 * Copied from test/respawn-test-utils.ts (the canonical, most complete version).
 * Used by respawn, route, and subagent tests.
 */
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

/**
 * Enhanced mock session for testing RespawnController.
 * Extends the existing MockSession pattern with additional utilities.
 */
export class MockSession extends EventEmitter {
  id: string;
  workingDir: string = '/tmp/test-workdir';
  status: 'idle' | 'working' = 'idle';
  pid: number = 12345;
  isWorking: boolean = false;
  ralphTracker: null = null;
  writeBuffer: string[] = [];
  terminalBuffer: string = '';

  private _muxName: string | null = null;

  constructor(id: string = 'mock-session-id') {
    super();
    this.id = id;
    this._muxName = `codeman-test-${id.slice(0, 8)}`;
  }

  /** Direct PTY write (used by session.write()) */
  write(data: string): void {
    this.writeBuffer.push(data);
  }

  /** Write via mux (used by respawn controller) */
  async writeViaMux(data: string): Promise<boolean> {
    this.writeBuffer.push(data);
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
    return this.writeBuffer.some((data) =>
      typeof pattern === 'string' ? data.includes(pattern) : pattern.test(data),
    );
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
    this.status = 'working';
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
      'Would you like to proceed with this plan?\n' +
        '\u276f 1. Yes\n' +
        '  2. No\n' +
        '  3. Type your own\n',
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
      typeof tokens === 'number'
        ? tokens >= 1000
          ? `${(tokens / 1000).toFixed(1)}k`
          : String(tokens)
        : tokens;
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
    };
  }

  /** Check if session is busy */
  isBusy = vi.fn(() => false);

  /** Set session color */
  setColor = vi.fn((c: string) => {
    this.color = c;
  });

  /** Stub for sendInput */
  sendInput = vi.fn();

  /** Stub for resize */
  resize = vi.fn();

  /** Stub for runPrompt */
  runPrompt = vi.fn(async () => {});

  /** Stub for startInteractive */
  startInteractive = vi.fn(async () => {});

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
