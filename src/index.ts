#!/usr/bin/env node
/**
 * @fileoverview Codeman CLI entry point
 *
 * This is the main executable entry point for the Codeman CLI.
 * It sets up global error handlers and invokes the CLI parser.
 *
 * @module index
 */

import { program } from './cli.js';

// Detect if we're running the web server (long-lived process)
// In web mode, we should NOT exit on transient errors — log and continue
const isWebMode = process.argv.includes('web');

// Track consecutive unhandled errors in web mode — restart after too many
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;
const ERROR_RESET_MS = 60000; // Reset counter after 1 minute of no errors
let errorResetTimer: ReturnType<typeof setTimeout> | null = null;

function trackError(): void {
  consecutiveErrors++;
  if (errorResetTimer) clearTimeout(errorResetTimer);
  errorResetTimer = setTimeout(() => { consecutiveErrors = 0; }, ERROR_RESET_MS);

  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    console.error(`[FATAL] ${MAX_CONSECUTIVE_ERRORS} consecutive unhandled errors — exiting for systemd restart`);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
  if (isWebMode) {
    console.error('[RECOVERED] Server continuing after uncaught exception:', err.stack);
    trackError();
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  if (isWebMode) {
    console.error('[RECOVERED] Server continuing after unhandled rejection');
    trackError();
  } else {
    process.exit(1);
  }
});

// Run CLI
program.parse();
