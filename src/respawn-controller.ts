import { EventEmitter } from 'node:events';
import { Session } from './session.js';

// Maximum terminal buffer size for respawn controller (1MB)
const MAX_RESPAWN_BUFFER_SIZE = 1024 * 1024;
// Keep this much when trimming (512KB)
const RESPAWN_BUFFER_TRIM_SIZE = 512 * 1024;

// Pre-compiled patterns for performance
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[HJKmsu?lh]/g;
const WHITESPACE_PATTERN = /\s+/g;

// The definitive "ready for input" indicator - when Claude shows a suggestion
const READY_INDICATOR = '↵ send';

/**
 * Respawn sequence states
 *
 * The controller cycles through these states:
 * WATCHING → SENDING_UPDATE → WAITING_UPDATE → SENDING_CLEAR → WAITING_CLEAR → SENDING_INIT → WAITING_INIT → MONITORING_INIT → (maybe SENDING_KICKSTART → WAITING_KICKSTART) → WATCHING
 */
export type RespawnState =
  | 'watching'           // Watching for idle, ready to start respawn sequence
  | 'sending_update'     // About to send the update docs prompt
  | 'waiting_update'     // Waiting for update to complete
  | 'sending_clear'      // About to send /clear
  | 'waiting_clear'      // Waiting for clear to complete
  | 'sending_init'       // About to send /init
  | 'waiting_init'       // Waiting for init to complete
  | 'monitoring_init'    // Monitoring if /init triggered work
  | 'sending_kickstart'  // About to send kickstart prompt
  | 'waiting_kickstart'  // Waiting for kickstart to complete
  | 'stopped';           // Controller stopped

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
  /** Optional prompt to send if /init doesn't trigger work */
  kickstartPrompt?: string;
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

  // Terminal patterns - detect when Claude is ready for input
  private readonly PROMPT_PATTERNS = [
    '↵ send',   // Suggestion ready to send (strongest indicator of idle)
    '❯',        // Standard prompt
    '\u276f',   // Unicode variant
    '⏵',        // Claude Code prompt variant
    '> ',       // Fallback
    'tokens',   // The status line shows "X tokens" when at prompt
  ];
  private readonly WORKING_PATTERNS = [
    'Thinking', 'Writing', 'Reading', 'Running', 'Searching',
    'Editing', 'Creating', 'Deleting', 'Analyzing', 'Executing',
    'Synthesizing', 'Brewing',  // Claude's processing indicators
    '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏',  // Spinner chars
    '✻', '✽',  // Activity indicators (spinning star)
  ];

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

    // Check for the definitive "ready for input" indicator
    const isReady = data.includes(READY_INDICATOR);

    // Detect working state
    const isWorking = this.WORKING_PATTERNS.some(pattern => data.includes(pattern));
    if (isWorking) {
      this.workingDetected = true;
      this.promptDetected = false;
      this.lastActivityTime = Date.now();
      this.clearIdleTimer();

      // If we're monitoring init and work started, go to watching (no kickstart needed)
      if (this._state === 'monitoring_init') {
        this.log('/init triggered work, skipping kickstart');
        this.emit('stepCompleted', 'init');
        this.completeCycle();
      }
      return;
    }

    // Detect ready state (↵ send indicator) - immediate response
    if (isReady) {
      this.promptDetected = true;
      this.workingDetected = false;
      this.lastActivityTime = Date.now();
      this.log('Ready indicator detected (↵ send)');

      // Handle based on current state - immediate action
      switch (this._state) {
        case 'watching':
          this.clearIdleTimer();
          this.onIdleDetected();
          break;
        case 'waiting_update':
          this.checkUpdateComplete();
          break;
        case 'waiting_clear':
          this.checkClearComplete();
          break;
        case 'waiting_init':
          this.checkInitComplete();
          break;
        case 'monitoring_init':
          this.checkMonitoringInitIdle();
          break;
        case 'waiting_kickstart':
          this.checkKickstartComplete();
          break;
      }
      return;
    }

    // Fallback: detect prompt characters - start timeout-based check
    const hasPrompt = this.PROMPT_PATTERNS.some(pattern => data.includes(pattern));
    if (hasPrompt) {
      const wasPromptDetected = this.promptDetected;
      this.promptDetected = true;
      this.workingDetected = false;
      this.lastActivityTime = Date.now();

      if (!wasPromptDetected) {
        this.log('Prompt detected');
        // Start fallback timeout for watching state
        if (this._state === 'watching') {
          this.startIdleTimer();
        }
      }
    }
  }

  // Step completion handlers - called when ready indicator is detected
  private checkUpdateComplete(): void {
    this.clearIdleTimer();
    this.log('Update completed (ready indicator)');
    this.emit('stepCompleted', 'update');

    if (this.config.sendClear) {
      this.sendClear();
    } else if (this.config.sendInit) {
      this.sendInit();
    } else {
      this.completeCycle();
    }
  }

  private checkClearComplete(): void {
    this.clearIdleTimer();
    this.log('/clear completed (ready indicator)');
    this.emit('stepCompleted', 'clear');

    if (this.config.sendInit) {
      this.sendInit();
    } else {
      this.completeCycle();
    }
  }

  private checkInitComplete(): void {
    this.clearIdleTimer();
    this.log('/init completed (ready indicator)');

    // If kickstart prompt is configured, monitor to see if /init triggered work
    if (this.config.kickstartPrompt) {
      this.startMonitoringInit();
    } else {
      this.emit('stepCompleted', 'init');
      this.completeCycle();
    }
  }

  private startMonitoringInit(): void {
    this.setState('monitoring_init');
    this.terminalBuffer = '';
    this.workingDetected = false;
    this.log('Monitoring if /init triggered work...');

    // Give Claude a moment to start working before checking for idle
    this.stepTimer = setTimeout(() => {
      // If still in monitoring state and no work detected, consider it idle
      if (this._state === 'monitoring_init' && !this.workingDetected) {
        this.checkMonitoringInitIdle();
      }
    }, 3000); // 3 second grace period for /init to trigger work
  }

  private checkMonitoringInitIdle(): void {
    this.clearIdleTimer();
    if (this.stepTimer) {
      clearTimeout(this.stepTimer);
      this.stepTimer = null;
    }
    this.log('/init did not trigger work, sending kickstart prompt');
    this.emit('stepCompleted', 'init');
    this.sendKickstart();
  }

  private sendKickstart(): void {
    this.setState('sending_kickstart');
    this.terminalBuffer = '';

    this.stepTimer = setTimeout(() => {
      const prompt = this.config.kickstartPrompt!;
      this.log(`Sending kickstart prompt: "${prompt}"`);
      this.session.write(prompt + '\n');
      this.emit('stepSent', 'kickstart', prompt);
      this.setState('waiting_kickstart');
      this.promptDetected = false;
      this.workingDetected = false;
    }, this.config.interStepDelayMs);
  }

  private checkKickstartComplete(): void {
    this.clearIdleTimer();
    this.log('Kickstart completed (ready indicator)');
    this.emit('stepCompleted', 'kickstart');
    this.completeCycle();
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
