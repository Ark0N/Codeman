#!/usr/bin/env node

/**
 * Claudeman postinstall verification script
 * Runs after `npm install` to check environment readiness
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

// ============================================================================
// Configuration
// ============================================================================

const MIN_NODE_VERSION = 18;

// Claude CLI search paths (must match src/session.ts)
const home = homedir();
const CLAUDE_SEARCH_PATHS = [
    join(home, '.local/bin/claude'),
    join(home, '.claude/local/claude'),
    '/usr/local/bin/claude',
    join(home, '.npm-global/bin/claude'),
    join(home, 'bin/claude'),
];

// ============================================================================
// Colors (with fallback for no-color environments)
// ============================================================================

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const colors = {
    green: (s) => useColor ? `\x1b[32m${s}\x1b[0m` : s,
    yellow: (s) => useColor ? `\x1b[33m${s}\x1b[0m` : s,
    red: (s) => useColor ? `\x1b[31m${s}\x1b[0m` : s,
    cyan: (s) => useColor ? `\x1b[36m${s}\x1b[0m` : s,
    bold: (s) => useColor ? `\x1b[1m${s}\x1b[0m` : s,
    dim: (s) => useColor ? `\x1b[2m${s}\x1b[0m` : s,
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a command exists in PATH
 * Works on Unix and Windows
 */
function commandExists(cmd) {
    try {
        const checkCmd = platform() === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
        execSync(checkCmd, { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Get install instructions for screen based on platform
 */
function getScreenInstallInstructions() {
    const os = platform();

    if (os === 'darwin') {
        return [
            '    macOS: brew install screen',
        ];
    }

    if (os === 'linux') {
        return [
            '    Ubuntu/Debian: sudo apt install screen',
            '    Fedora/RHEL:   sudo dnf install screen',
            '    Arch Linux:    sudo pacman -S screen',
            '    Alpine:        sudo apk add screen',
        ];
    }

    if (os === 'win32') {
        return [
            '    Windows: Use WSL (Windows Subsystem for Linux)',
            '             GNU Screen is not available on native Windows',
        ];
    }

    return ['    Please install GNU Screen for your platform'];
}

// ============================================================================
// Main Checks
// ============================================================================

console.log(colors.bold('Claudeman postinstall check...'));
console.log('');

let hasWarnings = false;
let hasErrors = false;

// ----------------------------------------------------------------------------
// 1. Check Node.js version >= 18
// ----------------------------------------------------------------------------

const nodeVersion = process.versions.node;
const majorVersion = parseInt(nodeVersion.split('.')[0], 10);

if (majorVersion < MIN_NODE_VERSION) {
    console.log(colors.red(`✗ Node.js v${nodeVersion} is too old`));
    console.log(colors.dim(`  Minimum required: v${MIN_NODE_VERSION}`));
    console.log('');
    hasErrors = true;
} else {
    console.log(colors.green(`✓ Node.js v${nodeVersion}`) + colors.dim(` (meets >=v${MIN_NODE_VERSION} requirement)`));
}

// ----------------------------------------------------------------------------
// 2. Check if GNU Screen is installed
// ----------------------------------------------------------------------------

if (commandExists('screen')) {
    console.log(colors.green('✓ GNU Screen found'));
} else {
    hasWarnings = true;
    console.log(colors.yellow('⚠ GNU Screen not found'));
    console.log(colors.dim('  Screen is required for session persistence.'));
    console.log(colors.dim('  Install:'));
    for (const instruction of getScreenInstallInstructions()) {
        console.log(colors.dim(instruction));
    }
}

// ----------------------------------------------------------------------------
// 3. Check if Claude CLI is found
// ----------------------------------------------------------------------------

let claudeFound = false;
let claudePath = null;

// First try PATH lookup
if (commandExists('claude')) {
    claudeFound = true;
    try {
        const checkCmd = platform() === 'win32' ? 'where claude' : 'command -v claude';
        claudePath = execSync(checkCmd, { stdio: 'pipe', encoding: 'utf-8' }).trim().split('\n')[0];
    } catch {
        // Ignore, we know it exists
    }
}

// Check known paths if not found in PATH
if (!claudeFound) {
    for (const p of CLAUDE_SEARCH_PATHS) {
        if (existsSync(p)) {
            claudeFound = true;
            claudePath = p;
            break;
        }
    }
}

if (claudeFound) {
    const pathInfo = claudePath ? colors.dim(` (${claudePath})`) : '';
    console.log(colors.green('✓ Claude CLI found') + pathInfo);
} else {
    hasWarnings = true;
    console.log(colors.yellow('⚠ Claude CLI not found'));
    console.log(colors.dim('  Claude CLI is required to run AI sessions.'));
    console.log(colors.dim('  Install:'));
    console.log(colors.cyan('    curl -fsSL https://claude.ai/install.sh | bash'));
}

// ----------------------------------------------------------------------------
// Print Summary and Next Steps
// ----------------------------------------------------------------------------

console.log('');

if (hasErrors) {
    console.log(colors.red(colors.bold('Installation cannot proceed due to errors above.')));
    process.exit(1);
}

console.log(colors.bold('Next steps:'));
console.log(colors.dim('  1. Build:  ') + colors.cyan('npm run build'));
console.log(colors.dim('  2. Start:  ') + colors.cyan('claudeman web --https'));
console.log(colors.dim('  3. Open:   ') + colors.cyan('https://localhost:3000'));

if (hasWarnings) {
    console.log('');
    console.log(colors.yellow('Note: Resolve warnings above for full functionality.'));
}

console.log('');
