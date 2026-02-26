#!/usr/bin/env node

/**
 * Codeman postinstall verification script
 * Runs after `npm install` to check environment readiness
 */

import { execSync } from 'child_process';
import { chmodSync, existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

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
 * Get install instructions for tmux based on platform
 */
function getTmuxInstallInstructions() {
    const os = platform();

    if (os === 'darwin') {
        return [
            '    macOS: brew install tmux',
        ];
    }

    if (os === 'linux') {
        return [
            '    Ubuntu/Debian: sudo apt install tmux',
            '    Fedora/RHEL:   sudo dnf install tmux',
            '    Arch Linux:    sudo pacman -S tmux',
            '    Alpine:        sudo apk add tmux',
        ];
    }

    if (os === 'win32') {
        return [
            '    Windows: Use WSL (Windows Subsystem for Linux)',
        ];
    }

    return ['    Please install tmux for your platform'];
}

// ============================================================================
// Main Checks
// ============================================================================

console.log(colors.bold('Codeman postinstall check...'));
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
// 1b. Fix node-pty spawn-helper permissions (macOS posix_spawnp fix)
// ----------------------------------------------------------------------------

try {
    const require = createRequire(import.meta.url);
    const ptyPath = join(require.resolve('node-pty'), '..');
    const spawnHelper = join(ptyPath, 'build', 'Release', 'spawn-helper');
    if (existsSync(spawnHelper)) {
        chmodSync(spawnHelper, 0o755);
        console.log(colors.green('✓ node-pty spawn-helper permissions fixed'));
    }
} catch {
    // Non-critical — only affects macOS with prebuilt binaries
}

// ----------------------------------------------------------------------------
// 1c. Rebuild node-pty from source for Node.js 22+ compatibility
// ----------------------------------------------------------------------------

if (majorVersion >= 22) {
    try {
        console.log(colors.dim('  Rebuilding node-pty from source for Node.js 22+...'));
        execSync('npm rebuild node-pty --build-from-source', { stdio: 'pipe', timeout: 120000 });
        console.log(colors.green('✓ node-pty rebuilt from source'));
    } catch {
        hasWarnings = true;
        console.log(colors.yellow('⚠ Failed to rebuild node-pty from source'));
        console.log(colors.dim('  You may need to run: npm rebuild node-pty --build-from-source'));
    }
}

// ----------------------------------------------------------------------------
// 2. Check if terminal multiplexer is installed (tmux preferred, screen fallback)
// ----------------------------------------------------------------------------

if (commandExists('tmux')) {
    console.log(colors.green('✓ tmux found (preferred)'));
} else if (commandExists('screen')) {
    console.log(colors.green('✓ GNU Screen found') + colors.dim(' (fallback — consider installing tmux)'));
} else {
    hasWarnings = true;
    console.log(colors.yellow('⚠ No terminal multiplexer found'));
    console.log(colors.dim('  tmux is required for session persistence.'));
    console.log(colors.dim('  Install:'));
    for (const instruction of getTmuxInstallInstructions()) {
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
// 4. Copy xterm vendor files for dev mode (src/web/public/vendor/)
//    Skip for global installs — dist/ already has built vendor files
// ----------------------------------------------------------------------------

const srcDir = join(import.meta.dirname, '..', 'src');
const isGlobalInstall = !existsSync(srcDir);

if (isGlobalInstall) {
    console.log(colors.dim('  Skipping vendor copy (global install — dist/ already has built assets)'));
} else {
    try {
        const require = createRequire(import.meta.url);
        const xtermDir = join(require.resolve('xterm'), '..', '..');
        const fitDir = join(require.resolve('xterm-addon-fit'), '..', '..');
        const vendorDir = join(srcDir, 'web', 'public', 'vendor');

        const { mkdirSync, copyFileSync } = await import('fs');
        mkdirSync(vendorDir, { recursive: true });
        copyFileSync(join(xtermDir, 'css', 'xterm.css'), join(vendorDir, 'xterm.css'));

        // Minify xterm JS for dev vendor dir (npm packages don't ship .min.js)
        try {
            execSync(`npx esbuild "${join(xtermDir, 'lib', 'xterm.js')}" --minify --outfile="${join(vendorDir, 'xterm.min.js')}"`, { stdio: 'pipe' });
            execSync(`npx esbuild "${join(fitDir, 'lib', 'xterm-addon-fit.js')}" --minify --outfile="${join(vendorDir, 'xterm-addon-fit.min.js')}"`, { stdio: 'pipe' });
            console.log(colors.green('✓ xterm vendor files copied to src/web/public/vendor/'));
        } catch {
            // Fallback: copy unminified
            copyFileSync(join(xtermDir, 'lib', 'xterm.js'), join(vendorDir, 'xterm.min.js'));
            copyFileSync(join(fitDir, 'lib', 'xterm-addon-fit.js'), join(vendorDir, 'xterm-addon-fit.min.js'));
            console.log(colors.green('✓ xterm vendor files copied') + colors.dim(' (unminified — esbuild not available)'));
        }
    } catch (err) {
        hasWarnings = true;
        console.log(colors.yellow('⚠ Failed to copy xterm vendor files'));
        console.log(colors.dim(`  ${err.message}`));
        console.log(colors.dim('  Dev server may fail to load xterm.js — run: npm run build'));
    }
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
if (isGlobalInstall) {
    console.log(colors.dim('  1. Start:  ') + colors.cyan('codeman web'));
    console.log(colors.dim('  2. Open:   ') + colors.cyan('http://localhost:3000'));
} else {
    console.log(colors.dim('  1. Build:  ') + colors.cyan('npm run build'));
    console.log(colors.dim('  2. Start:  ') + colors.cyan('codeman web'));
    console.log(colors.dim('  3. Open:   ') + colors.cyan('http://localhost:3000'));
}

if (hasWarnings) {
    console.log('');
    console.log(colors.yellow('Note: Resolve warnings above for full functionality.'));
}

console.log('');
