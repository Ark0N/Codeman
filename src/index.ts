#!/usr/bin/env node
/**
 * @fileoverview Claudeman CLI entry point
 *
 * This is the main executable entry point for the Claudeman CLI.
 * It sets up global error handlers and invokes the CLI parser.
 *
 * @module index
 */

import { program } from './cli.js';

// Detect if we're running the web server (long-lived process)
// In web mode, we should NOT exit on transient errors — log and continue
const isWebMode = process.argv.includes('web');

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
  if (isWebMode) {
    // Log full stack trace for debugging but keep the server running
    console.error('[RECOVERED] Server continuing after uncaught exception:', err.stack);
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  if (isWebMode) {
    console.error('[RECOVERED] Server continuing after unhandled rejection');
  } else {
    process.exit(1);
  }
});

// Run CLI
program.parse();
