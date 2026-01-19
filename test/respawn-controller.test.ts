import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RespawnController, RespawnState, RespawnConfig } from '../src/respawn-controller.js';
import { Session } from '../src/session.js';
import { EventEmitter } from 'node:events';

/**
 * RespawnController Tests
 *
 * Tests the state machine that manages automatic respawning of Claude sessions
 * State flow: WATCHING → SENDING_UPDATE → WAITING_UPDATE → SENDING_CLEAR → WAITING_CLEAR → SENDING_INIT → WAITING_INIT → WATCHING
 */

// Mock Session for testing
class MockSession extends EventEmitter {
  id = 'mock-session-id';
  workingDir = '/tmp';
  status = 'idle';
  writeBuffer: string[] = [];

  write(data: string): void {
    this.writeBuffer.push(data);
  }

  // Simulate terminal output
  simulateTerminalOutput(data: string): void {
    this.emit('terminal', data);
  }

  // Simulate prompt appearing (basic prompt character)
  simulatePrompt(): void {
    this.emit('terminal', '❯ ');
  }

  // Simulate ready state with the definitive indicator
  simulateReady(): void {
    this.emit('terminal', '↵ send');
  }

  // Simulate working state
  simulateWorking(): void {
    this.emit('terminal', 'Thinking... ⠋');
  }

  // Simulate clear completion (followed by ready indicator)
  simulateClearComplete(): void {
    this.emit('terminal', 'conversation cleared');
    setTimeout(() => this.simulateReady(), 50);
  }

  // Simulate init completion (followed by ready indicator)
  simulateInitComplete(): void {
    this.emit('terminal', 'Analyzing CLAUDE.md...');
    setTimeout(() => this.simulateReady(), 100);
  }
}

describe('RespawnController', () => {
  let session: MockSession;
  let controller: RespawnController;

  beforeEach(() => {
    session = new MockSession();
    controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 100, // Short timeout for testing
      interStepDelayMs: 50,
    });
  });

  afterEach(() => {
    controller.stop();
  });

  describe('Initialization', () => {
    it('should start in stopped state', () => {
      expect(controller.state).toBe('stopped');
      expect(controller.isRunning).toBe(false);
    });

    it('should have default configuration', () => {
      const config = controller.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.updatePrompt).toBe('update all the docs and CLAUDE.md');
    });

    it('should allow custom configuration', () => {
      const customController = new RespawnController(session as unknown as Session, {
        updatePrompt: 'custom prompt',
        idleTimeoutMs: 10000,
      });
      const config = customController.getConfig();
      expect(config.updatePrompt).toBe('custom prompt');
      expect(config.idleTimeoutMs).toBe(10000);
      customController.stop();
    });
  });

  describe('State Machine', () => {
    it('should transition to watching state on start', () => {
      const states: RespawnState[] = [];
      controller.on('stateChanged', (state) => states.push(state));

      controller.start();

      expect(controller.state).toBe('watching');
      expect(states).toContain('watching');
    });

    it('should not start if already running', () => {
      controller.start();
      const initialState = controller.state;

      controller.start(); // Try to start again

      expect(controller.state).toBe(initialState);
    });

    it('should transition to stopped on stop', () => {
      controller.start();
      controller.stop();

      expect(controller.state).toBe('stopped');
      expect(controller.isRunning).toBe(false);
    });

    it('should track cycle count', () => {
      expect(controller.currentCycle).toBe(0);
    });
  });

  describe('Idle Detection', () => {
    it('should detect prompt pattern', async () => {
      const logMessages: string[] = [];
      controller.on('log', (msg) => logMessages.push(msg));

      controller.start();
      session.simulatePrompt();

      // Wait for log
      await new Promise(resolve => setTimeout(resolve, 50));

      const hasPromptLog = logMessages.some(msg => msg.includes('Prompt detected'));
      expect(hasPromptLog).toBe(true);
    });

    it('should detect multiple prompt patterns', () => {
      controller.start();

      // All these should trigger prompt detection
      const promptPatterns = ['❯', '\u276f', '⏵', '> ', 'tokens'];

      for (const pattern of promptPatterns) {
        session.simulateTerminalOutput(pattern);
      }

      // Controller should still be running after all patterns
      expect(controller.isRunning).toBe(true);
    });

    it('should detect working patterns and clear prompt state', () => {
      controller.start();
      session.simulatePrompt();

      // Simulate working - should clear prompt detected
      session.simulateWorking();

      const status = controller.getStatus();
      expect(status.workingDetected).toBe(true);
      expect(status.promptDetected).toBe(false);
    });
  });

  describe('Respawn Cycle', () => {
    it('should start cycle when idle timeout fires', async () => {
      let cycleStarted = false;
      controller.on('respawnCycleStarted', () => {
        cycleStarted = true;
      });

      controller.start();
      session.simulatePrompt();

      // Wait for idle timeout
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(cycleStarted).toBe(true);
      expect(controller.currentCycle).toBe(1);
    });

    it('should send update prompt during cycle', async () => {
      let stepSent: string | null = null;
      controller.on('stepSent', (step) => {
        stepSent = step;
      });

      controller.start();
      session.simulatePrompt();

      // Wait for idle timeout and step
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(stepSent).toBe('update');
      expect(session.writeBuffer.length).toBeGreaterThan(0);
      expect(session.writeBuffer[0]).toContain('update all the docs');
    });

    it('should transition through states during cycle', async () => {
      const states: RespawnState[] = [];
      controller.on('stateChanged', (state) => states.push(state));

      controller.start();
      session.simulatePrompt();

      // Wait for initial state change
      await new Promise(resolve => setTimeout(resolve, 200));

      // Should have transitioned through multiple states
      expect(states).toContain('watching');
      expect(states.length).toBeGreaterThan(1);
    });
  });

  describe('Configuration Update', () => {
    it('should update configuration', () => {
      controller.updateConfig({ updatePrompt: 'new prompt' });

      const config = controller.getConfig();
      expect(config.updatePrompt).toBe('new prompt');
    });

    it('should merge partial configuration', () => {
      const originalTimeout = controller.getConfig().idleTimeoutMs;
      controller.updateConfig({ updatePrompt: 'new prompt' });

      const config = controller.getConfig();
      expect(config.idleTimeoutMs).toBe(originalTimeout);
    });
  });

  describe('Status', () => {
    it('should provide complete status', () => {
      controller.start();

      const status = controller.getStatus();

      expect(status).toHaveProperty('state');
      expect(status).toHaveProperty('cycleCount');
      expect(status).toHaveProperty('lastActivityTime');
      expect(status).toHaveProperty('timeSinceActivity');
      expect(status).toHaveProperty('promptDetected');
      expect(status).toHaveProperty('workingDetected');
      expect(status).toHaveProperty('config');
    });

    it('should track time since activity', async () => {
      controller.start();

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));

      const status = controller.getStatus();
      expect(status.timeSinceActivity).toBeGreaterThan(0);
    });
  });

  describe('Disabled State', () => {
    it('should not start when disabled', () => {
      const disabledController = new RespawnController(session as unknown as Session, {
        enabled: false,
      });

      disabledController.start();

      expect(disabledController.state).toBe('stopped');
      disabledController.stop();
    });
  });

  describe('Pause and Resume', () => {
    it('should pause without changing state', () => {
      controller.start();
      const stateBeforePause = controller.state;

      controller.pause();

      expect(controller.state).toBe(stateBeforePause);
    });

    it('should resume from watching state', () => {
      controller.start();
      controller.pause();
      controller.resume();

      expect(controller.state).toBe('watching');
    });
  });

  describe('Terminal Buffer Management', () => {
    it('should handle large terminal output', () => {
      controller.start();

      // Send lots of data
      const largeData = 'x'.repeat(20000);
      session.simulateTerminalOutput(largeData);

      // Should not crash and controller should still work
      expect(controller.isRunning).toBe(true);
    });
  });

  describe('Event Emission', () => {
    it('should emit stateChanged events', async () => {
      const events: Array<{ state: RespawnState; prevState: RespawnState }> = [];
      controller.on('stateChanged', (state, prevState) => {
        events.push({ state, prevState });
      });

      controller.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].state).toBe('watching');
      expect(events[0].prevState).toBe('stopped');
    });

    it('should emit log events', () => {
      const logs: string[] = [];
      controller.on('log', (msg) => logs.push(msg));

      controller.start();

      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some(l => l.includes('Starting'))).toBe(true);
    });
  });
});

describe('RespawnController Integration', () => {
  it('should handle rapid terminal data without errors', () => {
    const session = new MockSession();
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 1000,
    });

    controller.start();

    // Simulate rapid terminal output
    for (let i = 0; i < 100; i++) {
      session.simulateTerminalOutput(`Line ${i}\n`);
    }

    expect(controller.isRunning).toBe(true);
    controller.stop();
  });

  it('should handle mixed working and idle states', async () => {
    const session = new MockSession();
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 100,
    });

    controller.start();

    // Alternate between working and idle
    session.simulatePrompt();
    await new Promise(resolve => setTimeout(resolve, 50));

    session.simulateWorking();
    await new Promise(resolve => setTimeout(resolve, 50));

    session.simulatePrompt();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Should handle transitions gracefully
    expect(controller.isRunning).toBe(true);
    controller.stop();
  });

  it('should handle ANSI escape codes in terminal output', () => {
    const session = new MockSession();
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 1000,
    });

    controller.start();

    // Simulate output with ANSI codes
    session.simulateTerminalOutput('\x1b[32mGreen text\x1b[0m');
    session.simulateTerminalOutput('\x1b[1;34mBold blue\x1b[0m');
    session.simulateTerminalOutput('\x1b[2J\x1b[H'); // Clear screen and move cursor
    session.simulateTerminalOutput('\x1b[?25l'); // Hide cursor
    session.simulateTerminalOutput('\x1b[?25h'); // Show cursor

    // Should handle ANSI codes without crashing
    expect(controller.isRunning).toBe(true);
    controller.stop();
  });

  it('should handle empty terminal output', () => {
    const session = new MockSession();
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 1000,
    });

    controller.start();

    // Simulate empty and whitespace output
    session.simulateTerminalOutput('');
    session.simulateTerminalOutput('   ');
    session.simulateTerminalOutput('\n\n\n');
    session.simulateTerminalOutput('\t\t');

    expect(controller.isRunning).toBe(true);
    controller.stop();
  });

  it('should handle start/stop cycles without memory leaks', () => {
    const session = new MockSession();

    for (let i = 0; i < 10; i++) {
      const controller = new RespawnController(session as unknown as Session, {
        idleTimeoutMs: 100,
      });
      controller.start();
      session.simulatePrompt();
      session.simulateWorking();
      session.simulatePrompt();
      controller.stop();
    }

    // If we got here without crashing, the test passes
    expect(true).toBe(true);
  });

  it('should handle Unicode prompt characters', () => {
    const session = new MockSession();
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 1000,
    });

    controller.start();

    // Test various prompt characters
    session.simulateTerminalOutput('❯ ');
    session.simulateTerminalOutput('\u276f '); // Unicode variant
    session.simulateTerminalOutput('⏵ '); // Alternative

    const status = controller.getStatus();
    expect(status.promptDetected).toBe(true);
    controller.stop();
  });

  it('should handle spinner animations', () => {
    const session = new MockSession();
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 1000,
    });

    controller.start();

    // Simulate spinner animation
    const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    for (const char of spinnerChars) {
      session.simulateTerminalOutput(`Working... ${char}`);
    }

    const status = controller.getStatus();
    expect(status.workingDetected).toBe(true);
    controller.stop();
  });

  it('should not trigger cycle when disabled', async () => {
    const session = new MockSession();
    const controller = new RespawnController(session as unknown as Session, {
      enabled: false,
      idleTimeoutMs: 50,
    });

    let cycleStarted = false;
    controller.on('respawnCycleStarted', () => {
      cycleStarted = true;
    });

    controller.start();
    session.simulatePrompt();

    await new Promise(resolve => setTimeout(resolve, 200));

    expect(cycleStarted).toBe(false);
    controller.stop();
  });
});
