import { EventEmitter } from 'node:events';
import { Session } from './session.js';

// Maximum terminal buffer size for respawn controller (1MB)
const MAX_RESPAWN_BUFFER_SIZE = 1024 * 1024;
// Keep this much when trimming (512KB)
const RESPAWN_BUFFER_TRIM_SIZE = 512 * 1024;

// Pre-compiled patterns for performance
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[HJKmsu?lh]/g;
const WHITESPACE_PATTERN = /\s+/g;

/**
 * Respawn sequence states
 *
 * The controller cycles through these states:
 * WATCHING → SENDING_UPDATE → WAITING_UPDATE → SENDING_CLEAR → WAITING_CLEAR → SENDING_INIT → WAITING_INIT → WATCHING
 */
export type RespawnState =
  | 'watching'        // Watching for idle, ready to start respawn sequence
  | 'sending_update'  // About to send the update docs prompt
  | 'waiting_update'  // Waiting for update to complete
  | 'sending_clear'   // About to send /clear
  | 'waiting_clear'   // Waiting for clear to complete
  | 'sending_init'    // About to send /init
  | 'waiting_init'    // Waiting for init to complete
  | 'stopped';        // Controller stopped

export interface RespawnConfig {
  /** How long to wait after seeing prompt before considering truly idle (ms) */
  idleTimeoutMs: number;
  /** The prompt to send for updating docs */
  updatePrompt: string;
  /** Delay between sending steps (ms) */
  interStepDelayMs: number;
  /** Whether to enable respawn loop */
  enabled: boolean;
  /** Whether to send /clear after update prompt */
  sendClear: boolean;
  /** Whether to send /init after /clear */
  sendInit: boolean;
}

export interface RespawnEvents {
  stateChanged: (state: RespawnState, prevState: RespawnState) => void;
  respawnCycleStarted: (cycleNumber: number) => void;
  respawnCycleCompleted: (cycleNumber: number) => void;
  stepSent: (step: string, input: string) => void;
  stepCompleted: (step: string) => void;
  error: (error: Error) => void;
  log: (message: string) => void;
}

const DEFAULT_CONFIG: RespawnConfig = {
  idleTimeoutMs: 10000,          // 10 seconds of no activity after prompt
  updatePrompt: 'update all the docs and CLAUDE.md',
  interStepDelayMs: 1000,        // 1 second between steps
  enabled: true,
  sendClear: true,               // send /clear after update prompt
  sendInit: true,                // send /init after /clear
};

/**
 * RespawnController manages automatic respawning of Claude Code sessions
 *
 * When Claude finishes working (detected by idle prompt), it:
 * 1. Sends an update docs prompt
 * 2. Waits for completion
 * 3. Sends /clear
 * 4. Sends /init
 * 5. Repeats
 */
export class RespawnController extends EventEmitter {
  private session: Session;
  private config: RespawnConfig;
  private _state: RespawnState = 'stopped';
  private idleTimer: NodeJS.Timeout | null = null;
  private stepTimer: NodeJS.Timeout | null = null;
  private cycleCount: number = 0;
  private lastActivityTime: number = 0;
  private terminalBuffer: string = '';
  private promptDetected: boolean = false;
  private workingDetected: boolean = false;

  // Terminal patterns
  private readonly PROMPT_PATTERNS = [
    '❯',        // Standard prompt
    '\u276f',   // Unicode variant
    '⏵',        // Claude Code prompt variant
    '> ',       // Fallback
    'tokens',   // The status line shows "X tokens" when at prompt
  ];
  private readonly WORKING_PATTERNS = [
    'Thinking', 'Writing', 'Reading', 'Running', 'Searching',
    'Editing', 'Creating', 'Deleting', 'Analyzing', 'Executing',
    '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏',  // Spinner chars
  ];
  private readonly CLEAR_COMPLETE_PATTERN = /conversation cleared|cleared|❯|⏵/i;
  private readonly INIT_COMPLETE_PATTERN = /initialized|analyzing|❯|⏵|CLAUDE\.md/i;

  constructor(session: Session, config: Partial<RespawnConfig> = {}) {
    super();
    this.session = session;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get state(): RespawnState {
    return this._state;
  }

  get currentCycle(): number {
    return this.cycleCount;
  }

  get isRunning(): boolean {
    return this._state !== 'stopped';
  }

  private setState(newState: RespawnState): void {
    if (newState === this._state) return;

    const prevState = this._state;
    this._state = newState;
    this.log(`State: ${prevState} → ${newState}`);
    this.emit('stateChanged', newState, prevState);
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    this.emit('log', `[${timestamp}] [Respawn] ${message}`);
  }

  /**
   * Start watching the session for idle state
   */
  start(): void {
    if (!this.config.enabled) {
      this.log('Respawn is disabled');
      return;
    }

    if (this._state !== 'stopped') {
      this.log('Already running');
      return;
    }

    this.log('Starting respawn controller');
    this.setState('watching');
    this.setupTerminalListener();
    this.lastActivityTime = Date.now();
  }

  /**
   * Stop the respawn controller
   */
  stop(): void {
    this.log('Stopping respawn controller');
    this.clearTimers();
    this.setState('stopped');
    this.session.removeAllListeners('terminal');
  }

  /**
   * Pause respawn (keeps listening but won't trigger)
   */
  pause(): void {
    this.log('Pausing respawn');
    this.clearTimers();
    // Stay in current state but clear timers
  }

  /**
   * Resume respawn
   */
  resume(): void {
    this.log('Resuming respawn');
    if (this._state === 'watching') {
      this.checkIdleAndMaybeStart();
    }
  }

  private setupTerminalListener(): void {
    // Clear any existing listener
    this.session.removeAllListeners('terminal');

    this.session.on('terminal', (data: string) => {
      this.handleTerminalData(data);
    });
  }

  private handleTerminalData(data: string): void {
    this.terminalBuffer += data;

    // Keep buffer manageable (max 1MB, trim to 512KB)
    if (this.terminalBuffer.length > MAX_RESPAWN_BUFFER_SIZE) {
      this.terminalBuffer = this.terminalBuffer.slice(-RESPAWN_BUFFER_TRIM_SIZE);
    }

    // Filter out noise - only count meaningful data as activity
    // Ignore: cursor movements, color codes alone, small whitespace-only data
    // Uses pre-compiled patterns for performance
    const meaningfulData = data
      .replace(ANSI_ESCAPE_PATTERN, '') // Remove ANSI escape sequences
      .replace(WHITESPACE_PATTERN, '')  // Remove whitespace
      .trim();

    const isMeaningfulActivity = meaningfulData.length > 0;

    // Detect working state
    const isWorking = this.WORKING_PATTERNS.some(pattern => data.includes(pattern));
    if (isWorking) {
      this.workingDetected = true;
      this.promptDetected = false;
      this.lastActivityTime = Date.now();
      this.clearIdleTimer();
      return;
    }

    // Detect prompt (idle) state
    const hasPrompt = this.PROMPT_PATTERNS.some(pattern => data.includes(pattern));
    if (hasPrompt) {
      const wasPromptDetected = this.promptDetected;
      this.promptDetected = true;
      this.workingDetected = false;

      if (!wasPromptDetected) {
        // First time seeing prompt (or after being cleared) - log it
        this.lastActivityTime = Date.now();
        this.log('Prompt detected');

        // Only start idle timer in watching state
        if (this._state === 'watching') {
          this.startIdleTimer();
        }
      }
      // In waiting_* states, checkXxxComplete will handle the state transition
    } else if (isMeaningfulActivity) {
      // Meaningful activity that's not a prompt or working indicator
      this.lastActivityTime = Date.now();
      if (this.promptDetected && this._state === 'watching') {
        // Still at prompt but got some other data - restart timer
        this.startIdleTimer();
      }
    }

    // Handle state-specific terminal data
    switch (this._state) {
      case 'waiting_update':
        this.checkUpdateComplete(data);
        break;
      case 'waiting_clear':
        this.checkClearComplete(data);
        break;
      case 'waiting_init':
        this.checkInitComplete(data);
        break;
    }
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();

    this.idleTimer = setTimeout(() => {
      // Double-check we're still idle and in watching state
      if (this._state === 'watching' && this.promptDetected && !this.workingDetected) {
        const timeSinceActivity = Date.now() - this.lastActivityTime;
        this.log(`Idle timeout fired (${timeSinceActivity}ms since last activity)`);
        this.onIdleDetected();
      }
    }, this.config.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearIdleTimer();
    if (this.stepTimer) {
      clearTimeout(this.stepTimer);
      this.stepTimer = null;
    }
  }

  private onIdleDetected(): void {
    if (this._state !== 'watching') {
      return;
    }

    // Start the respawn cycle
    this.cycleCount++;
    this.log(`Starting respawn cycle #${this.cycleCount}`);
    this.emit('respawnCycleStarted', this.cycleCount);

    this.sendUpdateDocs();
  }

  private sendUpdateDocs(): void {
    this.setState('sending_update');
    this.terminalBuffer = ''; // Clear buffer for fresh detection

    this.stepTimer = setTimeout(() => {
      const input = this.config.updatePrompt + '\n';
      this.log(`Sending update prompt: "${this.config.updatePrompt}"`);
      this.session.write(input);
      this.emit('stepSent', 'update', this.config.updatePrompt);
      this.setState('waiting_update');
      this.promptDetected = false;
      this.workingDetected = false;
    }, this.config.interStepDelayMs);
  }

  private checkUpdateComplete(data: string): void {
    // Update is complete when we see the prompt again after working
    if (this.promptDetected && !this.workingDetected) {
      // Wait to make sure it's truly done (use configured idle timeout)
      this.clearIdleTimer();
      this.idleTimer = setTimeout(() => {
        if (this.promptDetected && !this.workingDetected) {
          this.log('Update docs completed');
          this.emit('stepCompleted', 'update');
          // Proceed based on config
          if (this.config.sendClear) {
            this.sendClear();
          } else if (this.config.sendInit) {
            this.sendInit();
          } else {
            this.completeCycle();
          }
        }
      }, this.config.idleTimeoutMs); // Use configured idle timeout
    }
  }

  private sendClear(): void {
    this.setState('sending_clear');
    this.terminalBuffer = '';

    this.stepTimer = setTimeout(() => {
      this.log('Sending /clear');
      this.session.write('/clear\n');
      this.emit('stepSent', 'clear', '/clear');
      this.setState('waiting_clear');
      this.promptDetected = false;
    }, this.config.interStepDelayMs);
  }

  private checkClearComplete(data: string): void {
    // Clear is fast, but wait for prompt and verify idle
    if (this.CLEAR_COMPLETE_PATTERN.test(data) || this.promptDetected) {
      this.clearIdleTimer();
      this.idleTimer = setTimeout(() => {
        this.log('/clear completed');
        this.emit('stepCompleted', 'clear');
        // Proceed based on config
        if (this.config.sendInit) {
          this.sendInit();
        } else {
          this.completeCycle();
        }
      }, this.config.idleTimeoutMs); // Use configured idle timeout
    }
  }

  private sendInit(): void {
    this.setState('sending_init');
    this.terminalBuffer = '';

    this.stepTimer = setTimeout(() => {
      this.log('Sending /init');
      this.session.write('/init\n');
      this.emit('stepSent', 'init', '/init');
      this.setState('waiting_init');
      this.promptDetected = false;
      this.workingDetected = false;
    }, this.config.interStepDelayMs);
  }

  private checkInitComplete(data: string): void {
    // Init completes when we see the prompt after it finishes
    if (this.promptDetected && !this.workingDetected) {
      this.clearIdleTimer();
      this.idleTimer = setTimeout(() => {
        if (this.promptDetected && !this.workingDetected) {
          this.log('/init completed');
          this.emit('stepCompleted', 'init');
          this.completeCycle();
        }
      }, this.config.idleTimeoutMs); // Use configured idle timeout
    }
  }

  private completeCycle(): void {
    this.log(`Respawn cycle #${this.cycleCount} completed`);
    this.emit('respawnCycleCompleted', this.cycleCount);

    // Go back to watching state for next cycle
    this.setState('watching');
    this.terminalBuffer = '';
    this.promptDetected = false;
    this.workingDetected = false;
  }

  private checkIdleAndMaybeStart(): void {
    // Check if already idle
    const timeSinceActivity = Date.now() - this.lastActivityTime;
    if (timeSinceActivity > this.config.idleTimeoutMs && this.promptDetected) {
      this.onIdleDetected();
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<RespawnConfig>): void {
    this.config = { ...this.config, ...config };
    this.log(`Config updated: ${JSON.stringify(config)}`);
  }

  /**
   * Get current configuration
   */
  getConfig(): RespawnConfig {
    return { ...this.config };
  }

  /**
   * Get status information
   */
  getStatus() {
    return {
      state: this._state,
      cycleCount: this.cycleCount,
      lastActivityTime: this.lastActivityTime,
      timeSinceActivity: Date.now() - this.lastActivityTime,
      promptDetected: this.promptDetected,
      workingDetected: this.workingDetected,
      config: this.config,
    };
  }
}
