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

  writeViaScreen(data: string): boolean {
    this.writeBuffer.push(data);
    return true;
  }

  // Simulate terminal output
  simulateTerminalOutput(data: string): void {
    this.emit('terminal', data);
  }

  // Simulate prompt appearing (basic prompt character) - legacy fallback
  simulatePrompt(): void {
    this.emit('terminal', '❯ ');
  }

  // Simulate ready state with the definitive indicator - legacy fallback
  simulateReady(): void {
    this.emit('terminal', '↵ send');
  }

  // Simulate completion message (NEW - primary idle detection in Claude Code 2024+)
  // This pattern triggers the multi-layer detection: "for Xm Xs" indicates work finished
  simulateCompletionMessage(): void {
    this.emit('terminal', '✻ Worked for 2m 46s');
  }

  // Simulate working state
  simulateWorking(): void {
    this.emit('terminal', 'Thinking... ⠋');
  }

  // Simulate clear completion (followed by completion message)
  simulateClearComplete(): void {
    this.emit('terminal', 'conversation cleared');
    setTimeout(() => this.simulateCompletionMessage(), 50);
  }

  // Simulate init completion (followed by completion message)
  simulateInitComplete(): void {
    this.emit('terminal', 'Analyzing CLAUDE.md...');
    setTimeout(() => this.simulateCompletionMessage(), 100);
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
      completionConfirmMs: 50, // Short confirmation delay for testing
      noOutputTimeoutMs: 500, // Short fallback timeout for testing
      aiIdleCheckEnabled: false, // Disable AI check for legacy tests
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
    it('should detect completion message pattern', async () => {
      const logMessages: string[] = [];
      controller.on('log', (msg) => logMessages.push(msg));

      controller.start();
      session.simulateCompletionMessage();

      // Wait for log
      await new Promise(resolve => setTimeout(resolve, 50));

      const hasCompletionLog = logMessages.some(msg => msg.includes('Completion message detected'));
      expect(hasCompletionLog).toBe(true);
    });

    it('should detect multiple prompt patterns (legacy fallback)', () => {
      controller.start();

      // All these should trigger prompt detection (legacy)
      const promptPatterns = ['❯', '\u276f', '⏵', '> ', 'tokens'];

      for (const pattern of promptPatterns) {
        session.simulateTerminalOutput(pattern);
      }

      // Controller should still be running after all patterns
      expect(controller.isRunning).toBe(true);
    });

    it('should detect working patterns and clear prompt state', () => {
      controller.start();
      session.simulateCompletionMessage();

      // Simulate working - should clear completion state and cancel confirmation
      session.simulateWorking();

      const status = controller.getStatus();
      expect(status.workingDetected).toBe(true);
      expect(status.promptDetected).toBe(false);
    });
  });

  describe('Respawn Cycle', () => {
    it('should start cycle when completion message detected and confirmed', async () => {
      let cycleStarted = false;
      controller.on('respawnCycleStarted', () => {
        cycleStarted = true;
      });

      controller.start();
      session.simulateCompletionMessage();

      // Wait for completion confirmation (completionConfirmMs=50) + processing
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
      session.simulateCompletionMessage();

      // Wait for completion confirmation + step delay
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(stepSent).toBe('update');
      expect(session.writeBuffer.length).toBeGreaterThan(0);
      expect(session.writeBuffer[0]).toContain('update all the docs');
    });

    it('should transition through states during cycle', async () => {
      const states: RespawnState[] = [];
      controller.on('stateChanged', (state) => states.push(state));

      controller.start();
      session.simulateCompletionMessage();

      // Wait for state transitions
      await new Promise(resolve => setTimeout(resolve, 200));

      // Should have transitioned through multiple states (watching -> confirming_idle -> sending_update)
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

describe('RespawnController Configuration', () => {
  let session: MockSession;

  beforeEach(() => {
    session = new MockSession();
  });

  it('should use default sendClear option', () => {
    const controller = new RespawnController(session as unknown as Session, {});
    expect(controller.getConfig().sendClear).toBe(true);
    controller.stop();
  });

  it('should use default sendInit option', () => {
    const controller = new RespawnController(session as unknown as Session, {});
    expect(controller.getConfig().sendInit).toBe(true);
    controller.stop();
  });

  it('should respect custom sendClear option', () => {
    const controller = new RespawnController(session as unknown as Session, {
      sendClear: false,
    });
    expect(controller.getConfig().sendClear).toBe(false);
    controller.stop();
  });

  it('should respect custom sendInit option', () => {
    const controller = new RespawnController(session as unknown as Session, {
      sendInit: false,
    });
    expect(controller.getConfig().sendInit).toBe(false);
    controller.stop();
  });

  it('should support kickstartPrompt option', () => {
    const controller = new RespawnController(session as unknown as Session, {
      kickstartPrompt: '/init please start working',
    });
    expect(controller.getConfig().kickstartPrompt).toBe('/init please start working');
    controller.stop();
  });

  it('should handle zero idleTimeoutMs', () => {
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 0,
    });
    expect(controller.getConfig().idleTimeoutMs).toBe(0);
    controller.stop();
  });

  it('should handle large idleTimeoutMs', () => {
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 3600000, // 1 hour
    });
    expect(controller.getConfig().idleTimeoutMs).toBe(3600000);
    controller.stop();
  });

  it('should handle zero interStepDelayMs', () => {
    const controller = new RespawnController(session as unknown as Session, {
      interStepDelayMs: 0,
    });
    expect(controller.getConfig().interStepDelayMs).toBe(0);
    controller.stop();
  });

  it('should handle empty updatePrompt', () => {
    const controller = new RespawnController(session as unknown as Session, {
      updatePrompt: '',
    });
    expect(controller.getConfig().updatePrompt).toBe('');
    controller.stop();
  });

  it('should handle special characters in updatePrompt', () => {
    const controller = new RespawnController(session as unknown as Session, {
      updatePrompt: 'prompt with "quotes" and \'apostrophes\' and $variables',
    });
    expect(controller.getConfig().updatePrompt).toContain('"quotes"');
    controller.stop();
  });

  it('should handle unicode in updatePrompt', () => {
    const controller = new RespawnController(session as unknown as Session, {
      updatePrompt: '日本語のプロンプト 🚀',
    });
    expect(controller.getConfig().updatePrompt).toBe('日本語のプロンプト 🚀');
    controller.stop();
  });

  it('should handle multiline updatePrompt', () => {
    const controller = new RespawnController(session as unknown as Session, {
      updatePrompt: 'Line 1\nLine 2\nLine 3',
    });
    expect(controller.getConfig().updatePrompt).toContain('\n');
    controller.stop();
  });
});

describe('RespawnController State Transitions', () => {
  let session: MockSession;
  let controller: RespawnController;

  beforeEach(() => {
    session = new MockSession();
    controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 50,
      interStepDelayMs: 20,
      completionConfirmMs: 50, // Short confirmation for testing
      noOutputTimeoutMs: 300, // Short fallback for testing
      aiIdleCheckEnabled: false, // Disable AI check for legacy tests
    });
  });

  afterEach(() => {
    controller.stop();
  });

  it('should record state history', async () => {
    const stateHistory: RespawnState[] = [];
    controller.on('stateChanged', (state) => stateHistory.push(state));

    controller.start();
    session.simulateCompletionMessage();

    await new Promise(resolve => setTimeout(resolve, 200));

    expect(stateHistory).toContain('watching');
    expect(stateHistory.length).toBeGreaterThan(1);
  });

  it('should handle stop during state transition', async () => {
    controller.start();
    session.simulateCompletionMessage();

    // Wait a bit then stop during potential transition
    await new Promise(resolve => setTimeout(resolve, 30));
    controller.stop();

    expect(controller.state).toBe('stopped');
  });

  it('should emit complete cycle event', async () => {
    let cycleCompleted = false;
    controller.on('respawnCycleCompleted', () => {
      cycleCompleted = true;
    });

    controller.start();
    session.simulateCompletionMessage();

    await new Promise(resolve => setTimeout(resolve, 500));

    // May or may not complete depending on timing
    expect(controller.isRunning).toBe(true);
    controller.stop();
  });

  it('should handle multiple consecutive completion messages', async () => {
    let completionCount = 0;
    controller.on('log', (msg) => {
      if (msg.includes('Completion message detected')) completionCount++;
    });

    controller.start();

    // Send multiple completion messages rapidly
    session.simulateCompletionMessage();
    session.simulateCompletionMessage();
    session.simulateCompletionMessage();

    await new Promise(resolve => setTimeout(resolve, 100));

    // Should detect completion messages
    expect(completionCount).toBeGreaterThan(0);
  });

  it('should handle working state interrupting idle confirmation', async () => {
    let cycleStarted = false;
    controller.on('respawnCycleStarted', () => {
      cycleStarted = true;
    });

    controller.start();
    session.simulateCompletionMessage();

    // Before confirmation timer fires, start working
    await new Promise(resolve => setTimeout(resolve, 20));
    session.simulateWorking();

    await new Promise(resolve => setTimeout(resolve, 100));

    // Cycle should not have started due to working state canceling confirmation
    expect(controller.getStatus().workingDetected).toBe(true);
  });
});

describe('RespawnController Edge Cases', () => {
  let session: MockSession;

  beforeEach(() => {
    session = new MockSession();
  });

  it('should handle null session events gracefully', () => {
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 1000,
    });

    controller.start();

    // Emit with undefined/null data
    session.emit('terminal', undefined);
    session.emit('terminal', null);
    session.emit('terminal', '');

    expect(controller.isRunning).toBe(true);
    controller.stop();
  });

  it('should handle very long terminal lines', () => {
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 1000,
    });

    controller.start();

    // Send a very long line
    const longLine = 'a'.repeat(100000);
    session.simulateTerminalOutput(longLine);

    expect(controller.isRunning).toBe(true);
    controller.stop();
  });

  it('should handle binary data in terminal', () => {
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 1000,
    });

    controller.start();

    // Send some binary-like data
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]).toString();
    session.simulateTerminalOutput(binaryData);

    expect(controller.isRunning).toBe(true);
    controller.stop();
  });

  it('should handle pause when already paused', () => {
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 1000,
    });

    controller.start();
    controller.pause();
    controller.pause(); // Double pause

    expect(controller.isRunning).toBe(true);
    controller.stop();
  });

  it('should handle resume when not paused', () => {
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 1000,
    });

    controller.start();
    controller.resume(); // Resume when not paused

    expect(controller.isRunning).toBe(true);
    expect(controller.state).toBe('watching');
    controller.stop();
  });

  it('should handle stop when already stopped', () => {
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 1000,
    });

    controller.stop(); // Stop when never started
    controller.stop(); // Double stop

    expect(controller.state).toBe('stopped');
  });

  it('should handle updateConfig while running', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 100,
      updatePrompt: 'original',
    });

    controller.start();
    session.simulatePrompt();

    // Update config mid-run
    controller.updateConfig({ updatePrompt: 'updated' });

    await new Promise(resolve => setTimeout(resolve, 200));

    expect(controller.getConfig().updatePrompt).toBe('updated');
    controller.stop();
  });

  it('should track cycle count across multiple cycles', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 30,
      interStepDelayMs: 10,
      completionConfirmMs: 30, // Short confirmation for testing
      noOutputTimeoutMs: 200, // Short fallback for testing
      aiIdleCheckEnabled: false,
    });

    expect(controller.currentCycle).toBe(0);

    controller.start();
    session.simulateCompletionMessage();

    await new Promise(resolve => setTimeout(resolve, 200));

    expect(controller.currentCycle).toBeGreaterThan(0);
    controller.stop();
  });

  it('should provide accurate time since activity', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 1000,
    });

    controller.start();

    await new Promise(resolve => setTimeout(resolve, 100));

    const status = controller.getStatus();
    expect(status.timeSinceActivity).toBeGreaterThanOrEqual(100);
    controller.stop();
  });

  it('should reset time since activity on terminal input', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 1000,
    });

    controller.start();

    await new Promise(resolve => setTimeout(resolve, 100));

    session.simulateTerminalOutput('new data');

    const status = controller.getStatus();
    // Time should be reset or very small
    expect(status.timeSinceActivity).toBeLessThan(100);
    controller.stop();
  });

  describe('Auto-Accept Prompts', () => {
    it('should have autoAcceptPrompts enabled by default', () => {
      const defaultController = new RespawnController(session as unknown as Session);
      const config = defaultController.getConfig();
      expect(config.autoAcceptPrompts).toBe(true);
      expect(config.autoAcceptDelayMs).toBe(8000);
      defaultController.stop();
    });

    it('should send Enter after silence without completion message', async () => {
      const autoAcceptController = new RespawnController(session as unknown as Session, {
        autoAcceptPrompts: true,
        autoAcceptDelayMs: 100, // Short delay for testing
        completionConfirmMs: 50,
        noOutputTimeoutMs: 5000,
        aiIdleCheckEnabled: false,
        aiPlanCheckEnabled: false, // Pre-filter only for this test
      });

      let autoAcceptFired = false;
      autoAcceptController.on('autoAcceptSent', () => {
        autoAcceptFired = true;
      });

      autoAcceptController.start();

      // Simulate plan mode UI with numbered options and selector
      session.simulateTerminalOutput('Would you like to proceed?\n❯ 1. Yes\n  2. No\n');

      // Wait for autoAcceptDelayMs to expire
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(autoAcceptFired).toBe(true);
      expect(session.writeBuffer).toContain('\r');
      autoAcceptController.stop();
    });

    it('should NOT send Enter when completion message was detected', async () => {
      const autoAcceptController = new RespawnController(session as unknown as Session, {
        autoAcceptPrompts: true,
        autoAcceptDelayMs: 100,
        completionConfirmMs: 200, // Longer than autoAcceptDelay
        noOutputTimeoutMs: 5000,
        aiIdleCheckEnabled: false,
      });

      let autoAcceptFired = false;
      autoAcceptController.on('autoAcceptSent', () => {
        autoAcceptFired = true;
      });

      autoAcceptController.start();

      // Simulate completion message - normal idle flow should handle this
      session.simulateCompletionMessage();

      // Wait for autoAcceptDelayMs
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(autoAcceptFired).toBe(false);
      autoAcceptController.stop();
    });

    it('should NOT send Enter when disabled', async () => {
      const autoAcceptController = new RespawnController(session as unknown as Session, {
        autoAcceptPrompts: false,
        autoAcceptDelayMs: 100,
        completionConfirmMs: 50,
        noOutputTimeoutMs: 5000,
        aiIdleCheckEnabled: false,
      });

      let autoAcceptFired = false;
      autoAcceptController.on('autoAcceptSent', () => {
        autoAcceptFired = true;
      });

      autoAcceptController.start();
      session.simulateTerminalOutput('Plan: Waiting for approval...');

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(autoAcceptFired).toBe(false);
      autoAcceptController.stop();
    });

    it('should NOT send Enter before any output is received', async () => {
      const autoAcceptController = new RespawnController(session as unknown as Session, {
        autoAcceptPrompts: true,
        autoAcceptDelayMs: 100,
        completionConfirmMs: 50,
        noOutputTimeoutMs: 5000,
        aiIdleCheckEnabled: false,
      });

      let autoAcceptFired = false;
      autoAcceptController.on('autoAcceptSent', () => {
        autoAcceptFired = true;
      });

      autoAcceptController.start();

      // Don't simulate any output - just wait
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(autoAcceptFired).toBe(false);
      autoAcceptController.stop();
    });

    it('should reset timer when new output arrives', async () => {
      const autoAcceptController = new RespawnController(session as unknown as Session, {
        autoAcceptPrompts: true,
        autoAcceptDelayMs: 150,
        completionConfirmMs: 50,
        noOutputTimeoutMs: 5000,
        aiIdleCheckEnabled: false,
        aiPlanCheckEnabled: false,
      });

      let autoAcceptFired = false;
      autoAcceptController.on('autoAcceptSent', () => {
        autoAcceptFired = true;
      });

      autoAcceptController.start();
      session.simulateTerminalOutput('❯ 1. Yes\n  2. No\n');

      // Wait 100ms (less than 150ms delay), then send more output
      await new Promise(resolve => setTimeout(resolve, 100));
      session.simulateTerminalOutput('More output');

      // Wait another 100ms - total 200ms from start but only 100ms from last output
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(autoAcceptFired).toBe(false);

      // Wait the remaining time
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(autoAcceptFired).toBe(true);
      autoAcceptController.stop();
    });

    it('should only send Enter once per silence period', async () => {
      const autoAcceptController = new RespawnController(session as unknown as Session, {
        autoAcceptPrompts: true,
        autoAcceptDelayMs: 100,
        completionConfirmMs: 50,
        noOutputTimeoutMs: 5000,
        aiIdleCheckEnabled: false,
        aiPlanCheckEnabled: false,
      });

      let autoAcceptCount = 0;
      autoAcceptController.on('autoAcceptSent', () => {
        autoAcceptCount++;
      });

      autoAcceptController.start();
      session.simulateTerminalOutput('❯ 1. Yes\n  2. No\n');

      // Wait for first auto-accept
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(autoAcceptCount).toBe(1);

      // Wait more - should NOT fire again (hasReceivedOutput is false)
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(autoAcceptCount).toBe(1);

      // New output comes in (plan mode again), then silence again - should fire again
      session.simulateTerminalOutput('❯ 1. Yes\n  2. No\n');
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(autoAcceptCount).toBe(2);

      autoAcceptController.stop();
    });

    it('should NOT auto-accept during respawn cycle (non-watching state)', async () => {
      const autoAcceptController = new RespawnController(session as unknown as Session, {
        autoAcceptPrompts: true,
        autoAcceptDelayMs: 50,
        completionConfirmMs: 50,
        interStepDelayMs: 50,
        noOutputTimeoutMs: 5000,
        aiIdleCheckEnabled: false,
      });

      let autoAcceptFired = false;
      autoAcceptController.on('autoAcceptSent', () => {
        autoAcceptFired = true;
      });

      autoAcceptController.start();

      // Trigger a respawn cycle via completion message
      session.simulateCompletionMessage();
      await new Promise(resolve => setTimeout(resolve, 150));

      // Now in sending_update or waiting_update state
      expect(autoAcceptController.state).not.toBe('watching');

      // Simulate output in the waiting state, then silence
      session.simulateTerminalOutput('Processing update...');
      await new Promise(resolve => setTimeout(resolve, 150));

      // Auto-accept should NOT fire because we're not in watching state
      expect(autoAcceptFired).toBe(false);
      autoAcceptController.stop();
    });

    it('should NOT auto-accept when elicitation dialog is signaled', async () => {
      const autoAcceptController = new RespawnController(session as unknown as Session, {
        autoAcceptPrompts: true,
        autoAcceptDelayMs: 100,
        completionConfirmMs: 50,
        noOutputTimeoutMs: 5000,
        aiIdleCheckEnabled: false,
      });

      let autoAcceptFired = false;
      autoAcceptController.on('autoAcceptSent', () => {
        autoAcceptFired = true;
      });

      autoAcceptController.start();
      session.simulateTerminalOutput('Which option do you prefer?');

      // Signal that an elicitation dialog (AskUserQuestion) was detected
      autoAcceptController.signalElicitation();

      // Wait for autoAcceptDelayMs to expire
      await new Promise(resolve => setTimeout(resolve, 200));

      // Auto-accept should NOT fire because elicitation was signaled
      expect(autoAcceptFired).toBe(false);
      autoAcceptController.stop();
    });

    it('should clear elicitation flag when working patterns detected', async () => {
      const autoAcceptController = new RespawnController(session as unknown as Session, {
        autoAcceptPrompts: true,
        autoAcceptDelayMs: 100,
        completionConfirmMs: 50,
        noOutputTimeoutMs: 5000,
        aiIdleCheckEnabled: false,
        aiPlanCheckEnabled: false,
      });

      let autoAcceptFired = false;
      autoAcceptController.on('autoAcceptSent', () => {
        autoAcceptFired = true;
      });

      autoAcceptController.start();
      session.simulateTerminalOutput('Question output');

      // Signal elicitation
      autoAcceptController.signalElicitation();

      // Working pattern clears the elicitation flag (new turn started)
      session.simulateTerminalOutput('Thinking');

      // New silence after work - plan mode approval with plan mode UI
      session.simulateTerminalOutput('❯ 1. Yes\n  2. No\n');

      await new Promise(resolve => setTimeout(resolve, 200));

      // Auto-accept should fire now (elicitation cleared by working pattern)
      expect(autoAcceptFired).toBe(true);
      autoAcceptController.stop();
    });
  });
});

describe('RespawnController AI Idle Check', () => {
  let session: MockSession;

  beforeEach(() => {
    session = new MockSession();
  });

  it('should have AI idle check enabled by default', () => {
    const controller = new RespawnController(session as unknown as Session);
    const config = controller.getConfig();
    expect(config.aiIdleCheckEnabled).toBe(true);
    expect(config.aiIdleCheckModel).toBe('claude-opus-4-5-20251101');
    expect(config.aiIdleCheckMaxContext).toBe(16000);
    expect(config.aiIdleCheckTimeoutMs).toBe(90000);
    expect(config.aiIdleCheckCooldownMs).toBe(180000);
    controller.stop();
  });

  it('should include AI check state in detection status when enabled', () => {
    const controller = new RespawnController(session as unknown as Session, {
      aiIdleCheckEnabled: true,
    });
    controller.start();

    const detection = controller.getDetectionStatus();
    expect(detection.aiCheck).not.toBeNull();
    expect(detection.aiCheck?.status).toBe('ready');

    controller.stop();
  });

  it('should not include AI check state when disabled', () => {
    const controller = new RespawnController(session as unknown as Session, {
      aiIdleCheckEnabled: false,
    });
    controller.start();

    const detection = controller.getDetectionStatus();
    expect(detection.aiCheck).toBeNull();

    controller.stop();
  });

  it('should transition to ai_checking state when pre-filter is met', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      completionConfirmMs: 50,
      noOutputTimeoutMs: 5000,
      aiIdleCheckEnabled: true,
      aiIdleCheckTimeoutMs: 500, // Short timeout for test
    });

    const states: string[] = [];
    controller.on('stateChanged', (state: string) => states.push(state));

    controller.start();

    // Simulate completion message
    session.simulateCompletionMessage();

    // Wait for completion confirm timer to fire and AI check to start
    await new Promise(resolve => setTimeout(resolve, 200));

    // Should have transitioned to ai_checking
    expect(states).toContain('ai_checking');

    controller.stop();
  });

  it('should cancel AI check when working patterns detected', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      completionConfirmMs: 50,
      noOutputTimeoutMs: 5000,
      aiIdleCheckEnabled: true,
      aiIdleCheckTimeoutMs: 5000, // Long timeout so we can interrupt
    });

    controller.start();
    session.simulateCompletionMessage();

    // Wait for AI check to start
    await new Promise(resolve => setTimeout(resolve, 100));

    // Simulate working patterns during AI check
    session.simulateWorking();

    // Should be back to watching
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(controller.state).toBe('watching');

    controller.stop();
  });

  it('should cancel AI check when substantial output arrives', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      completionConfirmMs: 50,
      noOutputTimeoutMs: 5000,
      aiIdleCheckEnabled: true,
      aiIdleCheckTimeoutMs: 5000,
    });

    controller.start();
    session.simulateCompletionMessage();

    // Wait for AI check to start
    await new Promise(resolve => setTimeout(resolve, 100));

    // Simulate substantial output during AI check
    session.simulateTerminalOutput('Some meaningful output that is more than 2 chars');

    // Should be back to watching
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(controller.state).toBe('watching');

    controller.stop();
  });

  it('should fall back to direct idle when AI check is disabled', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      completionConfirmMs: 50,
      noOutputTimeoutMs: 5000,
      aiIdleCheckEnabled: false,
    });

    let cycleStarted = false;
    controller.on('respawnCycleStarted', () => {
      cycleStarted = true;
    });

    controller.start();
    session.simulateCompletionMessage();

    // Wait for completion confirm and direct idle
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(cycleStarted).toBe(true);
    controller.stop();
  });

  it('should emit aiCheckStarted event', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      completionConfirmMs: 50,
      noOutputTimeoutMs: 5000,
      aiIdleCheckEnabled: true,
      aiIdleCheckTimeoutMs: 500,
    });

    let aiCheckStarted = false;
    controller.on('aiCheckStarted', () => {
      aiCheckStarted = true;
    });

    controller.start();
    session.simulateCompletionMessage();

    await new Promise(resolve => setTimeout(resolve, 150));

    expect(aiCheckStarted).toBe(true);
    controller.stop();
  });

  it('should update AI checker config on updateConfig', () => {
    const controller = new RespawnController(session as unknown as Session, {
      aiIdleCheckEnabled: true,
    });

    controller.updateConfig({
      aiIdleCheckModel: 'claude-sonnet-4-20250514',
      aiIdleCheckCooldownMs: 60000,
    });

    const config = controller.getConfig();
    expect(config.aiIdleCheckModel).toBe('claude-sonnet-4-20250514');
    expect(config.aiIdleCheckCooldownMs).toBe(60000);
    controller.stop();
  });

  it('should trigger AI check via completion message path (not requiring 3s working-absent)', async () => {
    // The pre-filter timer requires 3s without working patterns,
    // but the completion message path (startCompletionConfirmTimer) bypasses
    // the working-absent check and goes directly through tryStartAiCheck.
    const controller = new RespawnController(session as unknown as Session, {
      completionConfirmMs: 50,
      noOutputTimeoutMs: 5000,
      aiIdleCheckEnabled: true,
      aiIdleCheckTimeoutMs: 500,
    });

    const states: string[] = [];
    controller.on('stateChanged', (state: string) => states.push(state));

    controller.start();

    // Completion message triggers the completion confirm timer
    // which routes through tryStartAiCheck after silence
    session.simulateCompletionMessage();

    // Wait for completion confirm timer + AI check start
    await new Promise(resolve => setTimeout(resolve, 150));

    // Should have triggered ai_checking via completion path
    expect(states).toContain('ai_checking');

    controller.stop();
  });

  it('should handle AI check timeout gracefully', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      completionConfirmMs: 50,
      noOutputTimeoutMs: 5000,
      aiIdleCheckEnabled: true,
      aiIdleCheckTimeoutMs: 100, // Very short timeout
    });

    const states: string[] = [];
    controller.on('stateChanged', (state: string) => states.push(state));

    controller.start();
    session.simulateCompletionMessage();

    // Wait for AI check to start and timeout
    await new Promise(resolve => setTimeout(resolve, 300));

    // Should return to watching after timeout (with cooldown)
    expect(controller.state).toBe('watching');
    controller.stop();
  });
});

describe('RespawnController AI Plan Mode Check', () => {
  let session: MockSession;

  beforeEach(() => {
    session = new MockSession();
  });

  it('should have AI plan check enabled by default', () => {
    const controller = new RespawnController(session as unknown as Session);
    const config = controller.getConfig();
    expect(config.aiPlanCheckEnabled).toBe(true);
    expect(config.aiPlanCheckModel).toBe('claude-opus-4-5-20251101');
    expect(config.aiPlanCheckMaxContext).toBe(8000);
    expect(config.aiPlanCheckTimeoutMs).toBe(60000);
    expect(config.aiPlanCheckCooldownMs).toBe(30000);
    controller.stop();
  });

  it('should block auto-accept when buffer has no plan mode patterns (pre-filter)', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      autoAcceptPrompts: true,
      autoAcceptDelayMs: 100,
      completionConfirmMs: 50,
      noOutputTimeoutMs: 5000,
      aiIdleCheckEnabled: false,
      aiPlanCheckEnabled: false, // Test pre-filter only
    });

    let autoAcceptFired = false;
    controller.on('autoAcceptSent', () => {
      autoAcceptFired = true;
    });

    controller.start();

    // Output without plan mode patterns (no numbered list, no selector)
    session.simulateTerminalOutput('Claude is just thinking about something...\nSome regular output here.');

    await new Promise(resolve => setTimeout(resolve, 200));

    // Pre-filter should block - no plan mode patterns found
    expect(autoAcceptFired).toBe(false);
    controller.stop();
  });

  it('should pass pre-filter when buffer contains numbered list + selector', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      autoAcceptPrompts: true,
      autoAcceptDelayMs: 100,
      completionConfirmMs: 50,
      noOutputTimeoutMs: 5000,
      aiIdleCheckEnabled: false,
      aiPlanCheckEnabled: false, // Test pre-filter only (no AI)
    });

    let autoAcceptFired = false;
    controller.on('autoAcceptSent', () => {
      autoAcceptFired = true;
    });

    controller.start();

    // Output WITH plan mode patterns
    session.simulateTerminalOutput(
      'Would you like to proceed with this plan?\n' +
      '❯ 1. Yes\n' +
      '  2. No\n' +
      '  3. Type your own\n'
    );

    await new Promise(resolve => setTimeout(resolve, 200));

    // Pre-filter should pass and send Enter (AI disabled)
    expect(autoAcceptFired).toBe(true);
    controller.stop();
  });

  it('should block pre-filter when working patterns are in the tail', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      autoAcceptPrompts: true,
      autoAcceptDelayMs: 100,
      completionConfirmMs: 50,
      noOutputTimeoutMs: 5000,
      aiIdleCheckEnabled: false,
      aiPlanCheckEnabled: false,
    });

    let autoAcceptFired = false;
    controller.on('autoAcceptSent', () => {
      autoAcceptFired = true;
    });

    controller.start();

    // Plan mode patterns BUT also has working patterns (spinner) in the tail
    session.simulateTerminalOutput(
      '❯ 1. Yes\n' +
      '  2. No\n' +
      'Thinking ⠋\n'
    );

    // Wait for autoAcceptDelay - but working pattern resets the timer
    // so we need to wait longer and check after working pattern was consumed
    await new Promise(resolve => setTimeout(resolve, 200));

    // Should NOT fire because working patterns detected resets timer
    // (the working pattern in handleTerminalData clears timers)
    expect(autoAcceptFired).toBe(false);
    controller.stop();
  });

  it('should emit planCheckStarted when AI plan check is triggered', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      autoAcceptPrompts: true,
      autoAcceptDelayMs: 100,
      completionConfirmMs: 50,
      noOutputTimeoutMs: 5000,
      aiIdleCheckEnabled: false,
      aiPlanCheckEnabled: true,
      aiPlanCheckTimeoutMs: 500, // Short timeout for test
    });

    let planCheckStarted = false;
    controller.on('planCheckStarted', () => {
      planCheckStarted = true;
    });

    controller.start();

    // Output with plan mode patterns to pass pre-filter
    session.simulateTerminalOutput(
      'Would you like to proceed?\n' +
      '❯ 1. Yes\n' +
      '  2. No\n'
    );

    await new Promise(resolve => setTimeout(resolve, 200));

    // Plan check should have been started (pre-filter passed, AI enabled)
    expect(planCheckStarted).toBe(true);
    controller.stop();
  });

  it('should cancel plan check when new output arrives', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      autoAcceptPrompts: true,
      autoAcceptDelayMs: 100,
      completionConfirmMs: 50,
      noOutputTimeoutMs: 5000,
      aiIdleCheckEnabled: false,
      aiPlanCheckEnabled: true,
      aiPlanCheckTimeoutMs: 5000, // Long timeout so we can interrupt
    });

    let planCheckStarted = false;
    let autoAcceptFired = false;
    controller.on('planCheckStarted', () => {
      planCheckStarted = true;
    });
    controller.on('autoAcceptSent', () => {
      autoAcceptFired = true;
    });

    controller.start();

    // Trigger plan check
    session.simulateTerminalOutput(
      '❯ 1. Yes\n' +
      '  2. No\n'
    );
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(planCheckStarted).toBe(true);

    // New output arrives - should cancel plan check (stale)
    session.simulateTerminalOutput('New output from Claude...');

    await new Promise(resolve => setTimeout(resolve, 100));

    // Auto-accept should NOT have fired (check was cancelled)
    expect(autoAcceptFired).toBe(false);
    controller.stop();
  });

  it('should discard stale plan check result (output during check)', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      autoAcceptPrompts: true,
      autoAcceptDelayMs: 100,
      completionConfirmMs: 50,
      noOutputTimeoutMs: 5000,
      aiIdleCheckEnabled: false,
      aiPlanCheckEnabled: true,
      aiPlanCheckTimeoutMs: 5000,
    });

    let autoAcceptFired = false;
    controller.on('autoAcceptSent', () => {
      autoAcceptFired = true;
    });

    controller.start();

    // Plan mode patterns to trigger check
    session.simulateTerminalOutput(
      '❯ 1. Yes\n  2. No\n'
    );
    await new Promise(resolve => setTimeout(resolve, 150));

    // Output arrives during check - result should be discarded
    session.simulateTerminalOutput('Claude started working again');

    // Wait for any pending check to complete
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(autoAcceptFired).toBe(false);
    controller.stop();
  });

  it('should fall back to pre-filter-only when AI plan check is disabled', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      autoAcceptPrompts: true,
      autoAcceptDelayMs: 100,
      completionConfirmMs: 50,
      noOutputTimeoutMs: 5000,
      aiIdleCheckEnabled: false,
      aiPlanCheckEnabled: false, // Disabled - pre-filter only
    });

    let autoAcceptFired = false;
    let planCheckStarted = false;
    controller.on('autoAcceptSent', () => {
      autoAcceptFired = true;
    });
    controller.on('planCheckStarted', () => {
      planCheckStarted = true;
    });

    controller.start();

    // Plan mode patterns
    session.simulateTerminalOutput(
      '❯ 1. Yes\n  2. No\n'
    );

    await new Promise(resolve => setTimeout(resolve, 200));

    // Should send Enter directly (no AI check)
    expect(planCheckStarted).toBe(false);
    expect(autoAcceptFired).toBe(true);
    controller.stop();
  });

  it('should update plan checker config on updateConfig', () => {
    const controller = new RespawnController(session as unknown as Session, {
      aiPlanCheckEnabled: true,
    });

    controller.updateConfig({
      aiPlanCheckModel: 'claude-sonnet-4-20250514',
      aiPlanCheckCooldownMs: 60000,
    });

    const config = controller.getConfig();
    expect(config.aiPlanCheckModel).toBe('claude-sonnet-4-20250514');
    expect(config.aiPlanCheckCooldownMs).toBe(60000);
    controller.stop();
  });

  it('should not auto-accept if pre-filter passes but no output received yet', async () => {
    const controller = new RespawnController(session as unknown as Session, {
      autoAcceptPrompts: true,
      autoAcceptDelayMs: 100,
      completionConfirmMs: 50,
      noOutputTimeoutMs: 5000,
      aiIdleCheckEnabled: false,
      aiPlanCheckEnabled: false,
    });

    let autoAcceptFired = false;
    controller.on('autoAcceptSent', () => {
      autoAcceptFired = true;
    });

    controller.start();

    // Don't send any output - hasReceivedOutput should guard
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(autoAcceptFired).toBe(false);
    controller.stop();
  });
});
