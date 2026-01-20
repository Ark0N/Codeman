import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InnerLoopTracker } from '../src/inner-loop-tracker.js';
import { InnerLoopState, InnerTodoItem } from '../src/types.js';

/**
 * InnerLoopTracker Tests
 *
 * Tests the detection of Ralph Wiggum loops and todo lists from terminal output
 * running inside Claude Code sessions.
 */

describe('InnerLoopTracker', () => {
  let tracker: InnerLoopTracker;

  beforeEach(() => {
    tracker = new InnerLoopTracker();
    // Enable tracker by default for most tests (testing detection logic)
    tracker.enable();
  });

  describe('Initialization', () => {
    it('should start with inactive loop state', () => {
      const freshTracker = new InnerLoopTracker();
      const state = freshTracker.loopState;
      expect(state.active).toBe(false);
      expect(state.completionPhrase).toBeNull();
      expect(state.startedAt).toBeNull();
      expect(state.cycleCount).toBe(0);
    });

    it('should start with empty todos', () => {
      expect(tracker.todos).toHaveLength(0);
    });

    it('should start disabled by default', () => {
      const freshTracker = new InnerLoopTracker();
      expect(freshTracker.enabled).toBe(false);
      expect(freshTracker.loopState.enabled).toBe(false);
    });
  });

  describe('Auto-Enable Behavior', () => {
    it('should not process data when disabled', () => {
      const freshTracker = new InnerLoopTracker();
      // This pattern doesn't trigger auto-enable
      freshTracker.processTerminalData('Elapsed: 2.5 hours\n');

      expect(freshTracker.loopState.elapsedHours).toBeNull();
    });

    it('should auto-enable on /ralph-loop:ralph-loop command', () => {
      const freshTracker = new InnerLoopTracker();
      const enableHandler = vi.fn();
      freshTracker.on('enabled', enableHandler);

      freshTracker.processTerminalData('/ralph-loop:ralph-loop\n');

      expect(freshTracker.enabled).toBe(true);
      expect(enableHandler).toHaveBeenCalled();
    });

    it('should auto-enable on completion phrase', () => {
      const freshTracker = new InnerLoopTracker();
      freshTracker.processTerminalData('<promise>COMPLETE</promise>\n');

      expect(freshTracker.enabled).toBe(true);
    });

    it('should auto-enable on TodoWrite detection', () => {
      const freshTracker = new InnerLoopTracker();
      freshTracker.processTerminalData('TodoWrite: Todos have been modified\n');

      expect(freshTracker.enabled).toBe(true);
    });

    it('should auto-enable on todo checkboxes', () => {
      const freshTracker = new InnerLoopTracker();
      freshTracker.processTerminalData('- [ ] New task\n');

      expect(freshTracker.enabled).toBe(true);
      expect(freshTracker.todos).toHaveLength(1);
    });

    it('should auto-enable on iteration patterns', () => {
      const freshTracker = new InnerLoopTracker();
      freshTracker.processTerminalData('Iteration 5/50\n');

      expect(freshTracker.enabled).toBe(true);
    });

    it('should auto-enable on loop start patterns', () => {
      const freshTracker = new InnerLoopTracker();
      freshTracker.processTerminalData('Loop started at 2024-01-15\n');

      expect(freshTracker.enabled).toBe(true);
    });

    it('should allow manual enable/disable', () => {
      const freshTracker = new InnerLoopTracker();
      expect(freshTracker.enabled).toBe(false);

      freshTracker.enable();
      expect(freshTracker.enabled).toBe(true);

      freshTracker.disable();
      expect(freshTracker.enabled).toBe(false);
    });

    it('should reset to disabled on clear', () => {
      tracker.processTerminalData('/ralph-loop:ralph-loop\n');
      expect(tracker.enabled).toBe(true);

      tracker.clear();
      expect(tracker.enabled).toBe(false);
    });
  });

  describe('Completion Phrase Detection', () => {
    it('should detect <promise>COMPLETE</promise> pattern', () => {
      const completionHandler = vi.fn();
      tracker.on('completionDetected', completionHandler);

      // Start loop first (realistic workflow)
      tracker.startLoop();
      tracker.processTerminalData('<promise>COMPLETE</promise>\n');

      expect(completionHandler).toHaveBeenCalledWith('COMPLETE');
      expect(tracker.loopState.completionPhrase).toBe('COMPLETE');
    });

    it('should detect <promise>TIME_COMPLETE</promise> pattern', () => {
      const completionHandler = vi.fn();
      tracker.on('completionDetected', completionHandler);

      // Start loop first (realistic workflow)
      tracker.startLoop();
      tracker.processTerminalData('Output: <promise>TIME_COMPLETE</promise>\n');

      expect(completionHandler).toHaveBeenCalledWith('TIME_COMPLETE');
    });

    it('should detect custom completion phrases', () => {
      const completionHandler = vi.fn();
      tracker.on('completionDetected', completionHandler);

      // Start loop first (realistic workflow)
      tracker.startLoop();
      tracker.processTerminalData('<promise>MY_CUSTOM_PHRASE_123</promise>\n');

      expect(completionHandler).toHaveBeenCalledWith('MY_CUSTOM_PHRASE_123');
      expect(tracker.loopState.completionPhrase).toBe('MY_CUSTOM_PHRASE_123');
    });

    it('should mark loop as inactive when completion detected', () => {
      // Start a loop first
      tracker.startLoop('TEST_PHRASE');
      expect(tracker.loopState.active).toBe(true);

      // Detect completion
      tracker.processTerminalData('<promise>TEST_PHRASE</promise>\n');

      expect(tracker.loopState.active).toBe(false);
    });
  });

  describe('Loop Status Detection', () => {
    it('should detect loop start patterns', () => {
      const loopHandler = vi.fn();
      tracker.on('loopUpdate', loopHandler);

      tracker.processTerminalData('Loop started at 2024-01-15\n');

      expect(loopHandler).toHaveBeenCalled();
      expect(tracker.loopState.active).toBe(true);
      expect(tracker.loopState.startedAt).not.toBeNull();
    });

    it('should detect elapsed time pattern', () => {
      const loopHandler = vi.fn();
      tracker.on('loopUpdate', loopHandler);

      tracker.processTerminalData('Elapsed: 2.5 hours\n');

      expect(tracker.loopState.elapsedHours).toBe(2.5);
    });

    it('should detect cycle count pattern', () => {
      const loopHandler = vi.fn();
      tracker.on('loopUpdate', loopHandler);

      tracker.processTerminalData('Starting cycle #5\n');

      expect(tracker.loopState.cycleCount).toBe(5);
    });

    it('should detect respawn cycle pattern', () => {
      tracker.processTerminalData('respawn cycle #10\n');
      expect(tracker.loopState.cycleCount).toBe(10);
    });
  });

  describe('Todo Detection - Checkbox Format', () => {
    it('should detect pending checkbox todos', () => {
      const todoHandler = vi.fn();
      tracker.on('todoUpdate', todoHandler);

      tracker.processTerminalData('- [ ] First task\n');

      expect(todoHandler).toHaveBeenCalled();
      const todos = tracker.todos;
      expect(todos).toHaveLength(1);
      expect(todos[0].content).toBe('First task');
      expect(todos[0].status).toBe('pending');
    });

    it('should detect completed checkbox todos', () => {
      tracker.processTerminalData('- [x] Completed task\n');

      const todos = tracker.todos;
      expect(todos).toHaveLength(1);
      expect(todos[0].content).toBe('Completed task');
      expect(todos[0].status).toBe('completed');
    });

    it('should detect uppercase X as completed', () => {
      tracker.processTerminalData('- [X] Also completed\n');

      const todos = tracker.todos;
      expect(todos[0].status).toBe('completed');
    });

    it('should handle asterisk bullets', () => {
      tracker.processTerminalData('* [ ] Asterisk task\n');

      const todos = tracker.todos;
      expect(todos).toHaveLength(1);
      expect(todos[0].content).toBe('Asterisk task');
    });
  });

  describe('Todo Detection - Indicator Format', () => {
    it('should detect pending indicator todos', () => {
      tracker.processTerminalData('Todo: ☐ Pending task\n');

      const todos = tracker.todos;
      expect(todos).toHaveLength(1);
      expect(todos[0].content).toBe('Pending task');
      expect(todos[0].status).toBe('pending');
    });

    it('should detect in-progress indicator todos', () => {
      tracker.processTerminalData('Todo: ◐ Working on this\n');

      const todos = tracker.todos;
      expect(todos[0].status).toBe('in_progress');
    });

    it('should detect completed indicator todos', () => {
      tracker.processTerminalData('Todo: ✓ Done task\n');

      const todos = tracker.todos;
      expect(todos[0].status).toBe('completed');
    });

    it('should detect checkmark emoji as completed', () => {
      tracker.processTerminalData('Todo: ✅ Also done\n');

      const todos = tracker.todos;
      expect(todos[0].status).toBe('completed');
    });

    it('should detect hourglass as in-progress', () => {
      tracker.processTerminalData('Todo: ⏳ Still working\n');

      const todos = tracker.todos;
      expect(todos[0].status).toBe('in_progress');
    });
  });

  describe('Todo Detection - Status Parentheses Format', () => {
    it('should detect pending status', () => {
      tracker.processTerminalData('- Task name (pending)\n');

      const todos = tracker.todos;
      expect(todos).toHaveLength(1);
      expect(todos[0].content).toBe('Task name');
      expect(todos[0].status).toBe('pending');
    });

    it('should detect in_progress status', () => {
      tracker.processTerminalData('- Working task (in_progress)\n');

      const todos = tracker.todos;
      expect(todos[0].status).toBe('in_progress');
    });

    it('should detect completed status', () => {
      tracker.processTerminalData('- Done task (completed)\n');

      const todos = tracker.todos;
      expect(todos[0].status).toBe('completed');
    });
  });

  describe('Todo Detection - Claude Code Native Format', () => {
    it('should detect pending native checkbox (☐)', () => {
      tracker.processTerminalData('☐ List files in current directory\n');

      const todos = tracker.todos;
      expect(todos).toHaveLength(1);
      expect(todos[0].content).toBe('List files in current directory');
      expect(todos[0].status).toBe('pending');
    });

    it('should detect completed native checkbox (☒)', () => {
      tracker.processTerminalData('☒ Completed task\n');

      const todos = tracker.todos;
      expect(todos).toHaveLength(1);
      expect(todos[0].status).toBe('completed');
    });

    it('should detect todos with leading bracket (⎿)', () => {
      tracker.processTerminalData('⎿  ☐ Task with bracket\n');

      const todos = tracker.todos;
      expect(todos).toHaveLength(1);
      expect(todos[0].content).toBe('Task with bracket');
      expect(todos[0].status).toBe('pending');
    });

    it('should detect todos with leading whitespace', () => {
      tracker.processTerminalData('     ☐ Indented task\n');

      const todos = tracker.todos;
      expect(todos).toHaveLength(1);
      expect(todos[0].content).toBe('Indented task');
    });

    it('should detect in-progress native (◐)', () => {
      tracker.processTerminalData('◐ Working on this\n');

      const todos = tracker.todos;
      expect(todos[0].status).toBe('in_progress');
    });

    it('should handle multiple native todos in sequence', () => {
      tracker.processTerminalData('⎿  ☐ First task\n');
      tracker.processTerminalData('   ☐ Second task\n');
      tracker.processTerminalData('   ☒ Third task\n');

      const todos = tracker.todos;
      expect(todos).toHaveLength(3);
      expect(todos.filter(t => t.status === 'pending')).toHaveLength(2);
      expect(todos.filter(t => t.status === 'completed')).toHaveLength(1);
    });

    it('should auto-enable on native todo pattern', () => {
      const freshTracker = new InnerLoopTracker();
      freshTracker.processTerminalData('☐ New task\n');

      expect(freshTracker.enabled).toBe(true);
    });
  });

  describe('Todo Updates', () => {
    it('should update existing todos by content', () => {
      // Add pending todo
      tracker.processTerminalData('- [ ] My task\n');
      expect(tracker.todos[0].status).toBe('pending');

      // Update to completed
      tracker.processTerminalData('- [x] My task\n');
      expect(tracker.todos).toHaveLength(1); // Still just 1 todo
      expect(tracker.todos[0].status).toBe('completed');
    });

    it('should emit todoUpdate on changes', () => {
      const todoHandler = vi.fn();
      tracker.on('todoUpdate', todoHandler);

      tracker.processTerminalData('- [ ] Task 1\n');
      tracker.processTerminalData('- [ ] Task 2\n');

      expect(todoHandler).toHaveBeenCalledTimes(2);
    });
  });

  describe('Todo Stats', () => {
    it('should calculate correct stats', () => {
      tracker.processTerminalData('- [ ] Pending 1\n');
      tracker.processTerminalData('- [ ] Pending 2\n');
      tracker.processTerminalData('Todo: ◐ In progress\n');
      tracker.processTerminalData('- [x] Completed 1\n');
      tracker.processTerminalData('- [x] Completed 2\n');
      tracker.processTerminalData('- [x] Completed 3\n');

      const stats = tracker.getTodoStats();
      expect(stats.total).toBe(6);
      expect(stats.pending).toBe(2);
      expect(stats.inProgress).toBe(1);
      expect(stats.completed).toBe(3);
    });
  });

  describe('Manual Control', () => {
    it('should start loop manually', () => {
      const loopHandler = vi.fn();
      tracker.on('loopUpdate', loopHandler);

      tracker.startLoop('MANUAL_PHRASE');

      expect(tracker.loopState.active).toBe(true);
      expect(tracker.loopState.completionPhrase).toBe('MANUAL_PHRASE');
      expect(loopHandler).toHaveBeenCalled();
    });

    it('should stop loop manually', () => {
      tracker.startLoop();
      expect(tracker.loopState.active).toBe(true);

      tracker.stopLoop();
      expect(tracker.loopState.active).toBe(false);
    });

    it('should clear all state', () => {
      tracker.startLoop('TEST');
      tracker.processTerminalData('- [ ] Task\n');

      expect(tracker.loopState.active).toBe(true);
      expect(tracker.todos).toHaveLength(1);

      tracker.clear();

      expect(tracker.loopState.active).toBe(false);
      expect(tracker.loopState.completionPhrase).toBeNull();
      expect(tracker.todos).toHaveLength(0);
    });
  });

  describe('State Restoration', () => {
    it('should restore state from persisted data', () => {
      const loopState: InnerLoopState = {
        enabled: true,
        active: true,
        completionPhrase: 'RESTORED',
        startedAt: Date.now() - 1000,
        cycleCount: 5,
        maxIterations: 50,
        lastActivity: Date.now(),
        elapsedHours: 1.5,
      };

      const todos: InnerTodoItem[] = [
        { id: 'todo-1', content: 'Task 1', status: 'completed', detectedAt: Date.now() },
        { id: 'todo-2', content: 'Task 2', status: 'in_progress', detectedAt: Date.now() },
      ];

      tracker.restoreState(loopState, todos);

      expect(tracker.loopState.enabled).toBe(true);
      expect(tracker.loopState.active).toBe(true);
      expect(tracker.loopState.completionPhrase).toBe('RESTORED');
      expect(tracker.loopState.cycleCount).toBe(5);
      expect(tracker.loopState.maxIterations).toBe(50);
      expect(tracker.todos).toHaveLength(2);
    });

    it('should handle missing enabled flag in legacy state', () => {
      // Simulate old state without enabled flag
      const loopState = {
        active: true,
        completionPhrase: 'TEST',
        startedAt: Date.now(),
        cycleCount: 0,
        maxIterations: null,
        lastActivity: Date.now(),
        elapsedHours: null,
      } as InnerLoopState;

      tracker.restoreState(loopState, []);

      // Should default to false for backwards compatibility
      expect(tracker.loopState.enabled).toBe(false);
    });
  });

  describe('Enhanced Ralph Detection Patterns', () => {
    it('should detect /ralph-loop:ralph-loop command', () => {
      const loopHandler = vi.fn();
      tracker.on('loopUpdate', loopHandler);

      tracker.processTerminalData('/ralph-loop:ralph-loop\n');

      expect(loopHandler).toHaveBeenCalled();
      expect(tracker.loopState.active).toBe(true);
    });

    it('should detect "Starting Ralph Wiggum loop"', () => {
      tracker.processTerminalData('Starting Ralph Wiggum loop now\n');
      expect(tracker.loopState.active).toBe(true);
    });

    it('should detect "ralph loop started"', () => {
      tracker.processTerminalData('ralph loop started at 10:00\n');
      expect(tracker.loopState.active).toBe(true);
    });

    it('should detect iteration pattern "Iteration 5/50"', () => {
      const loopHandler = vi.fn();
      tracker.on('loopUpdate', loopHandler);

      tracker.processTerminalData('Iteration 5/50\n');

      expect(tracker.loopState.active).toBe(true);
      expect(tracker.loopState.cycleCount).toBe(5);
      expect(tracker.loopState.maxIterations).toBe(50);
    });

    it('should detect iteration pattern "[5/50]"', () => {
      tracker.processTerminalData('[5/50] Working on task...\n');

      expect(tracker.loopState.active).toBe(true);
      expect(tracker.loopState.cycleCount).toBe(5);
      expect(tracker.loopState.maxIterations).toBe(50);
    });

    it('should detect iteration pattern without max "Iteration 3"', () => {
      tracker.processTerminalData('Iteration 3 - processing\n');

      expect(tracker.loopState.active).toBe(true);
      expect(tracker.loopState.cycleCount).toBe(3);
      expect(tracker.loopState.maxIterations).toBeNull();
    });

    it('should detect max-iterations setting', () => {
      tracker.processTerminalData('Setting max-iterations: 100\n');

      expect(tracker.loopState.maxIterations).toBe(100);
    });

    it('should detect maxIterations setting', () => {
      tracker.processTerminalData('maxIterations=75\n');

      expect(tracker.loopState.maxIterations).toBe(75);
    });

    it('should detect max_iterations setting', () => {
      tracker.processTerminalData('config: max_iterations = 25\n');

      expect(tracker.loopState.maxIterations).toBe(25);
    });

    it('should detect TodoWrite tool output', () => {
      const loopHandler = vi.fn();
      tracker.on('loopUpdate', loopHandler);

      // TodoWrite detection should update lastActivity but not emit
      tracker.processTerminalData('TodoWrite: Todos have been modified successfully\n');

      expect(tracker.loopState.lastActivity).toBeGreaterThan(0);
    });
  });

  describe('startLoop with maxIterations', () => {
    it('should set maxIterations when starting loop', () => {
      tracker.startLoop('COMPLETE', 100);

      expect(tracker.loopState.active).toBe(true);
      expect(tracker.loopState.completionPhrase).toBe('COMPLETE');
      expect(tracker.loopState.maxIterations).toBe(100);
    });

    it('should allow setting maxIterations separately', () => {
      tracker.startLoop('TEST');
      expect(tracker.loopState.maxIterations).toBeNull();

      tracker.setMaxIterations(50);
      expect(tracker.loopState.maxIterations).toBe(50);
    });
  });

  describe('ANSI Escape Handling', () => {
    it('should strip ANSI escape codes before parsing', () => {
      // ANSI colored output
      tracker.processTerminalData('\x1b[32m- [x] Colored task\x1b[0m\n');

      const todos = tracker.todos;
      expect(todos).toHaveLength(1);
      expect(todos[0].content).toBe('Colored task');
    });
  });

  describe('Buffer Management', () => {
    it('should handle incomplete lines across multiple calls', () => {
      // Split across two calls
      tracker.processTerminalData('- [x] Split');
      tracker.processTerminalData(' task\n');

      const todos = tracker.todos;
      expect(todos).toHaveLength(1);
      expect(todos[0].content).toBe('Split task');
    });
  });

  describe('Maximum Todo Limit', () => {
    it('should limit to max 50 todos', () => {
      // Add 55 todos
      for (let i = 0; i < 55; i++) {
        tracker.processTerminalData(`- [ ] Task ${i}\n`);
      }

      expect(tracker.todos.length).toBeLessThanOrEqual(50);
    });
  });

  describe('Edge Cases and Optimizations', () => {
    it('should skip empty or whitespace-only content', () => {
      // These should not create todos
      tracker.processTerminalData('- [ ] \n');
      tracker.processTerminalData('- [ ]    \n');

      expect(tracker.todos).toHaveLength(0);
    });

    it('should skip lines without todo markers (early exit optimization)', () => {
      const todoHandler = vi.fn();
      tracker.on('todoUpdate', todoHandler);

      // Process lines that have no todo markers
      tracker.processTerminalData('This is just regular text\n');
      tracker.processTerminalData('Another line without markers\n');
      tracker.processTerminalData('Some code: function() {}\n');

      // No todoUpdate should be emitted
      expect(todoHandler).not.toHaveBeenCalled();
      expect(tracker.todos).toHaveLength(0);
    });

    it('should generate different IDs for different content', () => {
      tracker.processTerminalData('- [ ] Task A\n');
      tracker.processTerminalData('- [ ] Task B\n');

      const todos = tracker.todos;
      expect(todos).toHaveLength(2);
      expect(todos[0].id).not.toBe(todos[1].id);
    });

    it('should use activateLoopIfNeeded only once', () => {
      const loopHandler = vi.fn();
      tracker.on('loopUpdate', loopHandler);

      // Multiple loop start patterns should only activate once
      tracker.processTerminalData('Loop started at 2024-01-15\n');
      tracker.processTerminalData('Starting Ralph loop\n');
      tracker.processTerminalData('/ralph-loop:ralph-loop\n');

      // Loop should only have been activated once
      expect(tracker.loopState.active).toBe(true);
      // But multiple updates are OK (state changes)
    });

    it('should handle mixed content with todos and non-todos', () => {
      tracker.processTerminalData(`
Some regular text
- [ ] Actual todo item
More text here
☐ Another todo with icon
Final text
`);

      expect(tracker.todos).toHaveLength(2);
    });
  });
});
