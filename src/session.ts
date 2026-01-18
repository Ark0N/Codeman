import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { SessionState, SessionStatus, SessionConfig } from './types.js';

export interface ClaudeMessage {
  type: 'system' | 'assistant' | 'user' | 'result';
  subtype?: string;
  session_id?: string;
  message?: {
    content: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
}

export interface SessionEvents {
  output: (data: string) => void;
  message: (msg: ClaudeMessage) => void;
  error: (data: string) => void;
  exit: (code: number | null) => void;
  completion: (result: string, cost: number) => void;
}

export class Session extends EventEmitter {
  readonly id: string;
  readonly workingDir: string;
  readonly createdAt: number;

  private process: ChildProcess | null = null;
  private _status: SessionStatus = 'idle';
  private _currentTaskId: string | null = null;
  private _outputBuffer: string = '';
  private _textOutput: string = '';
  private _errorBuffer: string = '';
  private _lastActivityAt: number;
  private _claudeSessionId: string | null = null;
  private _totalCost: number = 0;
  private _messages: ClaudeMessage[] = [];
  private _lineBuffer: string = '';

  constructor(config: Partial<SessionConfig> & { workingDir: string }) {
    super();
    this.id = config.id || uuidv4();
    this.workingDir = config.workingDir;
    this.createdAt = config.createdAt || Date.now();
    this._lastActivityAt = this.createdAt;
  }

  get status(): SessionStatus {
    return this._status;
  }

  get currentTaskId(): string | null {
    return this._currentTaskId;
  }

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  get outputBuffer(): string {
    return this._outputBuffer;
  }

  get textOutput(): string {
    return this._textOutput;
  }

  get errorBuffer(): string {
    return this._errorBuffer;
  }

  get lastActivityAt(): number {
    return this._lastActivityAt;
  }

  get claudeSessionId(): string | null {
    return this._claudeSessionId;
  }

  get totalCost(): number {
    return this._totalCost;
  }

  get messages(): ClaudeMessage[] {
    return this._messages;
  }

  isIdle(): boolean {
    return this._status === 'idle';
  }

  isBusy(): boolean {
    return this._status === 'busy';
  }

  isRunning(): boolean {
    return this._status === 'idle' || this._status === 'busy';
  }

  toState(): SessionState {
    return {
      id: this.id,
      pid: this.pid,
      status: this._status,
      workingDir: this.workingDir,
      currentTaskId: this._currentTaskId,
      createdAt: this.createdAt,
      lastActivityAt: this._lastActivityAt,
    };
  }

  toDetailedState() {
    return {
      ...this.toState(),
      claudeSessionId: this._claudeSessionId,
      totalCost: this._totalCost,
      textOutput: this._textOutput,
      messageCount: this._messages.length,
    };
  }

  async runPrompt(prompt: string): Promise<{ result: string; cost: number }> {
    return new Promise((resolve, reject) => {
      if (this.process) {
        reject(new Error('Session already has a running process'));
        return;
      }

      this._status = 'busy';
      this._outputBuffer = '';
      this._textOutput = '';
      this._errorBuffer = '';
      this._messages = [];
      this._lineBuffer = '';
      this._lastActivityAt = Date.now();

      try {
        // Spawn claude with streaming JSON output
        this.process = spawn('claude', [
          '-p',
          '--output-format', 'stream-json',
          prompt
        ], {
          cwd: this.workingDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        });

        this.process.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          this._outputBuffer += text;
          this._lastActivityAt = Date.now();
          this.emit('output', text);
          this.processJsonLines(text);
        });

        this.process.stderr?.on('data', (data: Buffer) => {
          const text = data.toString();
          this._errorBuffer += text;
          this._lastActivityAt = Date.now();
          this.emit('error', text);
        });

        this.process.on('error', (err) => {
          this._status = 'error';
          this.process = null;
          reject(err);
        });

        this.process.on('exit', (code) => {
          this.process = null;

          // Find the result message
          const resultMsg = this._messages.find(m => m.type === 'result');

          if (resultMsg && !resultMsg.is_error) {
            this._status = 'idle';
            const cost = resultMsg.total_cost_usd || 0;
            this._totalCost += cost;
            this.emit('completion', resultMsg.result || '', cost);
            resolve({ result: resultMsg.result || '', cost });
          } else if (code !== 0 || (resultMsg && resultMsg.is_error)) {
            this._status = 'error';
            reject(new Error(this._errorBuffer || 'Process exited with error'));
          } else {
            this._status = 'idle';
            resolve({ result: this._textOutput, cost: 0 });
          }

          this.emit('exit', code);
        });
      } catch (err) {
        this._status = 'error';
        reject(err);
      }
    });
  }

  private processJsonLines(chunk: string): void {
    this._lineBuffer += chunk;
    const lines = this._lineBuffer.split('\n');

    // Keep incomplete line in buffer
    this._lineBuffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const msg = JSON.parse(line) as ClaudeMessage;
          this._messages.push(msg);
          this.emit('message', msg);

          // Extract text content
          if (msg.type === 'system' && msg.session_id) {
            this._claudeSessionId = msg.session_id;
          }

          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                this._textOutput += block.text;
              }
            }
          }

          if (msg.type === 'result') {
            if (msg.total_cost_usd) {
              this._totalCost += msg.total_cost_usd;
            }
          }
        } catch {
          // Not JSON, treat as raw text
          this._textOutput += line + '\n';
        }
      }
    }
  }

  // Legacy method for compatibility with session-manager
  async start(): Promise<void> {
    // Session is ready by default, actual process starts with runPrompt
    this._status = 'idle';
  }

  // Legacy method for sending input - wraps runPrompt
  async sendInput(input: string): Promise<void> {
    this._status = 'busy';
    this._lastActivityAt = Date.now();
    // Run the prompt asynchronously
    this.runPrompt(input).catch(err => {
      this.emit('error', err.message);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.process) {
        this._status = 'stopped';
        resolve();
        return;
      }

      const cleanup = () => {
        this.process = null;
        this._status = 'stopped';
        this._currentTaskId = null;
        resolve();
      };

      this.process.once('exit', cleanup);
      this.process.kill('SIGTERM');

      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    });
  }

  assignTask(taskId: string): void {
    this._currentTaskId = taskId;
    this._status = 'busy';
    this._outputBuffer = '';
    this._textOutput = '';
    this._errorBuffer = '';
    this._messages = [];
    this._lastActivityAt = Date.now();
  }

  clearTask(): void {
    this._currentTaskId = null;
    this._status = 'idle';
    this._lastActivityAt = Date.now();
  }

  getOutput(): string {
    return this._textOutput;
  }

  getError(): string {
    return this._errorBuffer;
  }

  clearBuffers(): void {
    this._outputBuffer = '';
    this._textOutput = '';
    this._errorBuffer = '';
    this._messages = [];
  }
}
