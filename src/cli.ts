/**
 * @fileoverview Claudeman CLI command definitions
 *
 * Defines all CLI commands and subcommands for managing Claude sessions,
 * tasks, Ralph loops, and the web server.
 *
 * @module cli
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getSessionManager } from './session-manager.js';
import { getTaskQueue } from './task-queue.js';
import { getRalphLoop } from './ralph-loop.js';
import { getStore } from './state-store.js';

const program = new Command();

program
  .name('claudeman')
  .description('Claude Code session manager with autonomous Ralph Loop')
  .version('1.0.0');

// ============ Session Commands ============

const sessionCmd = program
  .command('session')
  .alias('s')
  .description('Manage Claude sessions');

sessionCmd
  .command('start')
  .description('Start a new Claude session')
  .option('-d, --dir <path>', 'Working directory', process.cwd())
  .action(async (options) => {
    try {
      const manager = getSessionManager();
      const session = await manager.createSession(options.dir);
      console.log(chalk.green(`✓ Session started: ${session.id}`));
      console.log(`  Working directory: ${session.workingDir}`);
      console.log(`  PID: ${session.pid}`);
    } catch (err) {
      console.error(chalk.red(`✗ Failed to start session: ${(err as Error).message}`));
      process.exit(1);
    }
  });

sessionCmd
  .command('stop <id>')
  .description('Stop a session')
  .action(async (id) => {
    try {
      const manager = getSessionManager();
      await manager.stopSession(id);
      console.log(chalk.green(`✓ Session stopped: ${id}`));
    } catch (err) {
      console.error(chalk.red(`✗ Failed to stop session: ${(err as Error).message}`));
      process.exit(1);
    }
  });

sessionCmd
  .command('list')
  .alias('ls')
  .description('List all sessions')
  .action(() => {
    const manager = getSessionManager();
    const sessions = manager.getAllSessions();
    const stored = manager.getStoredSessions();

    if (sessions.length === 0 && Object.keys(stored).length === 0) {
      console.log(chalk.yellow('No sessions found'));
      return;
    }

    console.log(chalk.bold('\nActive Sessions:'));
    if (sessions.length === 0) {
      console.log('  (none)');
    } else {
      for (const session of sessions) {
        const status = session.status === 'idle'
          ? chalk.green('idle')
          : session.status === 'busy'
            ? chalk.yellow('busy')
            : chalk.red(session.status);
        console.log(`  ${chalk.cyan(session.id.slice(0, 8))} ${status} ${session.workingDir}`);
      }
    }

    const stoppedSessions = Object.values(stored).filter((s) => s.status === 'stopped');
    if (stoppedSessions.length > 0) {
      console.log(chalk.bold('\nStopped Sessions:'));
      for (const session of stoppedSessions) {
        console.log(`  ${chalk.gray(session.id.slice(0, 8))} ${chalk.gray('stopped')} ${session.workingDir}`);
      }
    }
    console.log('');
  });

sessionCmd
  .command('logs <id>')
  .description('View session output')
  .option('-e, --errors', 'Show stderr instead of stdout')
  .action((id, options) => {
    const manager = getSessionManager();
    const output = options.errors
      ? manager.getSessionError(id)
      : manager.getSessionOutput(id);

    if (output === null) {
      console.log(chalk.yellow(`Session ${id} not found or not active`));
      return;
    }

    if (output === '') {
      console.log(chalk.gray('(no output)'));
      return;
    }

    console.log(output);
  });

// ============ Task Commands ============

const taskCmd = program
  .command('task')
  .alias('t')
  .description('Manage tasks');

taskCmd
  .command('add <prompt>')
  .description('Add a new task')
  .option('-d, --dir <path>', 'Working directory', process.cwd())
  .option('-p, --priority <n>', 'Priority (higher = first)', '0')
  .option('-c, --completion <phrase>', 'Completion phrase to detect')
  .option('--timeout <ms>', 'Timeout in milliseconds')
  .action((prompt, options) => {
    const queue = getTaskQueue();
    const task = queue.addTask({
      prompt,
      workingDir: options.dir,
      priority: parseInt(options.priority, 10),
      completionPhrase: options.completion,
      timeoutMs: options.timeout ? parseInt(options.timeout, 10) : undefined,
    });
    console.log(chalk.green(`✓ Task added: ${task.id}`));
    console.log(`  Prompt: ${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}`);
    console.log(`  Priority: ${task.priority}`);
  });

taskCmd
  .command('list')
  .alias('ls')
  .description('List all tasks')
  .option('-s, --status <status>', 'Filter by status (pending, running, completed, failed)')
  .action((options) => {
    const queue = getTaskQueue();
    let tasks = queue.getAllTasks();

    if (options.status) {
      tasks = tasks.filter((t) => t.status === options.status);
    }

    if (tasks.length === 0) {
      console.log(chalk.yellow('No tasks found'));
      return;
    }

    const statusColors = {
      pending: chalk.gray,
      running: chalk.yellow,
      completed: chalk.green,
      failed: chalk.red,
    };

    console.log(chalk.bold('\nTasks:'));
    for (const task of tasks) {
      const color = statusColors[task.status];
      const prompt = task.prompt.slice(0, 40) + (task.prompt.length > 40 ? '...' : '');
      console.log(`  ${chalk.cyan(task.id.slice(0, 8))} ${color(task.status.padEnd(10))} [${task.priority}] ${prompt}`);
    }

    const counts = queue.getCount();
    console.log(chalk.bold('\nSummary:'));
    console.log(`  Pending: ${counts.pending}, Running: ${counts.running}, Completed: ${counts.completed}, Failed: ${counts.failed}`);
    console.log('');
  });

taskCmd
  .command('status <id>')
  .description('Show task details')
  .action((id) => {
    const queue = getTaskQueue();
    const task = queue.getTask(id);

    if (!task) {
      console.log(chalk.red(`Task ${id} not found`));
      return;
    }

    console.log(chalk.bold('\nTask Details:'));
    console.log(`  ID: ${task.id}`);
    console.log(`  Status: ${task.status}`);
    console.log(`  Priority: ${task.priority}`);
    console.log(`  Prompt: ${task.prompt}`);
    console.log(`  Working Dir: ${task.workingDir}`);
    if (task.assignedSessionId) {
      console.log(`  Session: ${task.assignedSessionId}`);
    }
    if (task.error) {
      console.log(`  Error: ${chalk.red(task.error)}`);
    }
    if (task.output) {
      console.log(chalk.bold('\nOutput:'));
      console.log(task.output.slice(0, 500) + (task.output.length > 500 ? '...' : ''));
    }
    console.log('');
  });

taskCmd
  .command('remove <id>')
  .alias('rm')
  .description('Remove a task')
  .action((id) => {
    const queue = getTaskQueue();
    if (queue.removeTask(id)) {
      console.log(chalk.green(`✓ Task removed: ${id}`));
    } else {
      console.log(chalk.red(`Task ${id} not found`));
    }
  });

taskCmd
  .command('clear')
  .description('Clear completed/failed tasks')
  .option('-a, --all', 'Clear all tasks')
  .option('-f, --failed', 'Clear only failed tasks')
  .action((options) => {
    const queue = getTaskQueue();
    let count: number;

    if (options.all) {
      count = queue.clearAll();
      console.log(chalk.green(`✓ Cleared ${count} tasks`));
    } else if (options.failed) {
      count = queue.clearFailed();
      console.log(chalk.green(`✓ Cleared ${count} failed tasks`));
    } else {
      count = queue.clearCompleted();
      console.log(chalk.green(`✓ Cleared ${count} completed tasks`));
    }
  });

// ============ Ralph Loop Commands ============

const ralphCmd = program
  .command('ralph')
  .alias('r')
  .description('Control the Ralph autonomous loop');

ralphCmd
  .command('start')
  .description('Start the Ralph loop')
  .option('-m, --min-hours <hours>', 'Minimum duration in hours')
  .option('--no-auto-generate', 'Disable auto-generating follow-up tasks')
  .action(async (options) => {
    const loop = getRalphLoop({
      autoGenerateTasks: options.autoGenerate,
    });

    if (options.minHours) {
      loop.setMinDuration(parseFloat(options.minHours));
    }

    if (loop.isRunning()) {
      console.log(chalk.yellow('Ralph loop is already running'));
      return;
    }

    loop.on('taskAssigned', (taskId, sessionId) => {
      console.log(chalk.cyan(`→ Task ${taskId.slice(0, 8)} assigned to session ${sessionId.slice(0, 8)}`));
    });

    loop.on('taskCompleted', (taskId) => {
      console.log(chalk.green(`✓ Task ${taskId.slice(0, 8)} completed`));
    });

    loop.on('taskFailed', (taskId, error) => {
      console.log(chalk.red(`✗ Task ${taskId.slice(0, 8)} failed: ${error}`));
    });

    loop.on('stopped', () => {
      console.log(chalk.yellow('\nRalph loop stopped'));
      printStats(loop.getStats());
      process.exit(0);
    });

    await loop.start();
    console.log(chalk.green('✓ Ralph loop started'));
    if (options.minHours) {
      console.log(`  Minimum duration: ${options.minHours} hours`);
    }
    console.log(chalk.gray('  Press Ctrl+C to stop\n'));

    // Keep process running
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\nStopping Ralph loop...'));
      loop.stop();
    });
  });

ralphCmd
  .command('stop')
  .description('Stop the Ralph loop')
  .action(() => {
    const loop = getRalphLoop();
    if (!loop.isRunning()) {
      console.log(chalk.yellow('Ralph loop is not running'));
      return;
    }
    loop.stop();
    console.log(chalk.green('✓ Ralph loop stopped'));
  });

ralphCmd
  .command('status')
  .description('Show Ralph loop status')
  .action(() => {
    const loop = getRalphLoop();
    const stats = loop.getStats();
    printStats(stats);
  });

function printStats(stats: ReturnType<ReturnType<typeof getRalphLoop>['getStats']>) {
  const statusColor =
    stats.status === 'running' ? chalk.green :
    stats.status === 'paused' ? chalk.yellow :
    chalk.gray;

  console.log(chalk.bold('\nRalph Loop Status:'));
  console.log(`  Status: ${statusColor(stats.status)}`);
  console.log(`  Elapsed: ${stats.elapsedHours.toFixed(2)} hours`);
  if (stats.minDurationMs) {
    const minHours = stats.minDurationMs / (1000 * 60 * 60);
    console.log(`  Min Duration: ${minHours.toFixed(2)} hours (${stats.minDurationReached ? 'reached' : 'not reached'})`);
  }

  console.log(chalk.bold('\nTasks:'));
  console.log(`  Pending: ${stats.pending}`);
  console.log(`  Running: ${stats.running}`);
  console.log(`  Completed: ${stats.completed} (${stats.tasksCompleted} this session)`);
  console.log(`  Failed: ${stats.failed}`);
  console.log(`  Generated: ${stats.tasksGenerated}`);

  console.log(chalk.bold('\nSessions:'));
  console.log(`  Active: ${stats.activeSessions}`);
  console.log(`  Idle: ${stats.idleSessions}`);
  console.log(`  Busy: ${stats.busySessions}`);
  console.log('');
}

// ============ Utility Commands ============

program
  .command('status')
  .description('Show overall status')
  .action(() => {
    const manager = getSessionManager();
    const queue = getTaskQueue();
    const loop = getRalphLoop();

    const sessions = manager.getAllSessions();
    const taskCounts = queue.getCount();
    const loopStatus = loop.status;

    console.log(chalk.bold('\nClaudeman Status'));
    console.log('─'.repeat(40));

    console.log(chalk.bold('\nSessions:'));
    console.log(`  Active: ${sessions.length}`);
    console.log(`  Idle: ${sessions.filter((s) => s.isIdle()).length}`);
    console.log(`  Busy: ${sessions.filter((s) => s.isBusy()).length}`);

    console.log(chalk.bold('\nTasks:'));
    console.log(`  Total: ${taskCounts.total}`);
    console.log(`  Pending: ${taskCounts.pending}`);
    console.log(`  Running: ${taskCounts.running}`);
    console.log(`  Completed: ${taskCounts.completed}`);
    console.log(`  Failed: ${taskCounts.failed}`);

    const statusColor =
      loopStatus === 'running' ? chalk.green :
      loopStatus === 'paused' ? chalk.yellow :
      chalk.gray;
    console.log(chalk.bold('\nRalph Loop:'));
    console.log(`  Status: ${statusColor(loopStatus)}`);
    console.log('');
  });

program
  .command('reset')
  .description('Reset all state')
  .option('-f, --force', 'Skip confirmation')
  .action(async (options) => {
    if (!options.force) {
      console.log(chalk.yellow('This will stop all sessions and clear all state.'));
      console.log(chalk.yellow('Use --force to confirm.'));
      return;
    }

    const manager = getSessionManager();
    const store = getStore();

    await manager.stopAllSessions();
    store.reset();

    console.log(chalk.green('✓ All state reset'));
  });

// Shorthand commands at root level
program
  .command('start')
  .description('Start a new session (shorthand)')
  .option('-d, --dir <path>', 'Working directory', process.cwd())
  .action(async (options) => {
    const manager = getSessionManager();
    const session = await manager.createSession(options.dir);
    console.log(chalk.green(`✓ Session started: ${session.id}`));
  });

program
  .command('list')
  .alias('ls')
  .description('List all sessions (shorthand)')
  .action(() => {
    const manager = getSessionManager();
    const sessions = manager.getAllSessions();
    const stored = manager.getStoredSessions();

    if (sessions.length === 0 && Object.keys(stored).length === 0) {
      console.log(chalk.yellow('No sessions found'));
      return;
    }

    console.log(chalk.bold('\nActive Sessions:'));
    if (sessions.length === 0) {
      console.log('  (none)');
    } else {
      for (const session of sessions) {
        const status = session.status === 'idle'
          ? chalk.green('idle')
          : session.status === 'busy'
            ? chalk.yellow('busy')
            : chalk.red(session.status);
        console.log(`  ${chalk.cyan(session.id.slice(0, 8))} ${status} ${session.workingDir}`);
      }
    }
    console.log('');
  });

// Web interface command
program
  .command('web')
  .description('Start the web interface')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .action(async (options) => {
    const { startWebServer } = await import('./web/server.js');
    const port = parseInt(options.port, 10);

    console.log(chalk.cyan(`Starting Claudeman web interface on port ${port}...`));

    try {
      await startWebServer(port);
      console.log(chalk.green(`\n✓ Web interface running at http://localhost:${port}`));
      console.log(chalk.gray('  Press Ctrl+C to stop\n'));
    } catch (err) {
      console.error(chalk.red(`✗ Failed to start web server: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// TUI command
program
  .command('tui')
  .description('Start the terminal user interface')
  .option('--with-web', 'Automatically start the web server if not running (no prompt)')
  .option('--no-web', 'Skip web server check entirely')
  .option('-p, --port <port>', 'Web server port (default: 3000)', '3000')
  .action(async (options: { withWeb?: boolean; web?: boolean; port?: string }) => {
    try {
      const { startTUI } = await import('./tui/index.js');
      const port = parseInt(options.port || '3000', 10);
      await startTUI({
        autoStartWeb: options.withWeb || false,
        skipWebCheck: options.web === false,
        port,
      });
    } catch (err) {
      console.error(chalk.red(`✗ Failed to start TUI: ${(err as Error).message}`));
      process.exit(1);
    }
  });

export { program };
