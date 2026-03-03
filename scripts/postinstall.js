#!/usr/bin/env node

/**
 * Codeman postinstall verification script
 * Runs after `npm install` to check environment readiness
 */

import { execSync, spawn } from 'child_process';
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
 * Check if a TCP port is already in use
 */
async function isPortBusy(port) {
    const net = await import('node:net');
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(true));
        srv.once('listening', () => { srv.close(); resolve(false); });
        srv.listen(port, '127.0.0.1');
    });
}

/**
 * Wait for a server to start accepting connections
 */
async function waitForServer(port, timeoutMs = 15000) {
    const net = await import('node:net');
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ok = await new Promise((resolve) => {
            const conn = net.createConnection({ port, host: '127.0.0.1' });
            conn.once('connect', () => { conn.destroy(); resolve(true); });
            conn.once('error', () => resolve(false));
        });
        if (ok) return true;
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
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
        const webglDir = join(require.resolve('xterm-addon-webgl'), '..', '..');
        const unicode11Dir = join(require.resolve('xterm-addon-unicode11'), '..', '..');
        const vendorDir = join(srcDir, 'web', 'public', 'vendor');

        const { mkdirSync, copyFileSync } = await import('fs');
        mkdirSync(vendorDir, { recursive: true });
        copyFileSync(join(xtermDir, 'css', 'xterm.css'), join(vendorDir, 'xterm.css'));

        // Minify xterm JS for dev vendor dir (npm packages don't ship .min.js)
        try {
            execSync(`npx esbuild "${join(xtermDir, 'lib', 'xterm.js')}" --minify --outfile="${join(vendorDir, 'xterm.min.js')}"`, { stdio: 'pipe' });
            execSync(`npx esbuild "${join(fitDir, 'lib', 'xterm-addon-fit.js')}" --minify --outfile="${join(vendorDir, 'xterm-addon-fit.min.js')}"`, { stdio: 'pipe' });
            execSync(`npx esbuild "${join(unicode11Dir, 'lib', 'xterm-addon-unicode11.js')}" --minify --outfile="${join(vendorDir, 'xterm-addon-unicode11.min.js')}"`, { stdio: 'pipe' });
            console.log(colors.green('✓ xterm vendor files copied to src/web/public/vendor/'));
        } catch {
            // Fallback: copy unminified
            copyFileSync(join(xtermDir, 'lib', 'xterm.js'), join(vendorDir, 'xterm.min.js'));
            copyFileSync(join(fitDir, 'lib', 'xterm-addon-fit.js'), join(vendorDir, 'xterm-addon-fit.min.js'));
            copyFileSync(join(unicode11Dir, 'lib', 'xterm-addon-unicode11.js'), join(vendorDir, 'xterm-addon-unicode11.min.js'));
            console.log(colors.green('✓ xterm vendor files copied') + colors.dim(' (unminified — esbuild not available)'));
        }

        // WebGL addon: copy unminified (matches build script behavior)
        copyFileSync(join(webglDir, 'lib', 'xterm-addon-webgl.js'), join(vendorDir, 'xterm-addon-webgl.min.js'));

        // xterm-zerolag-input: bundle local package as IIFE for <script> tag loading
        try {
            const zerolagSrc = join(import.meta.dirname, '..', 'packages', 'xterm-zerolag-input', 'src', 'zerolag-input-addon.ts');
            const zerolagOut = join(vendorDir, 'xterm-zerolag-input.js');
            execSync(
                `npx esbuild "${zerolagSrc}" --bundle --format=iife --global-name=XtermZerolagInput --outfile="${zerolagOut}"`,
                { stdio: 'pipe' }
            );
            // Append global aliases so app.js can use `new LocalEchoOverlay(terminal)`
            const { appendFileSync } = await import('fs');
            appendFileSync(
                zerolagOut,
                '\n// Global aliases for browser usage\n' +
                'if(typeof window!=="undefined"){' +
                    'window.ZerolagInputAddon=XtermZerolagInput.ZerolagInputAddon;' +
                    'window.LocalEchoOverlay=class extends XtermZerolagInput.ZerolagInputAddon{' +
                        'constructor(terminal){' +
                            'super({prompt:{type:"character",char:"\\u276f",offset:2}});' +
                            'this.activate(terminal);' +
                        '}' +
                    '};' +
                '}\n'
            );
            console.log(colors.green('✓ xterm-zerolag-input bundled to vendor/'));
        } catch {
            console.log(colors.yellow('⚠ Failed to bundle xterm-zerolag-input — overlay may not work in dev mode'));
        }
    } catch (err) {
        hasWarnings = true;
        console.log(colors.yellow('⚠ Failed to copy xterm vendor files'));
        console.log(colors.dim(`  ${err.message}`));
        console.log(colors.dim('  Dev server may fail to load xterm.js — run: npm run build'));
    }
}

// ----------------------------------------------------------------------------
// 5. Install git pre-commit hook (format check)
// ----------------------------------------------------------------------------

if (!isGlobalInstall) {
    try {
        const { writeFileSync, mkdirSync } = await import('fs');
        const gitHooksDir = join(import.meta.dirname, '..', '.git', 'hooks');
        if (existsSync(join(import.meta.dirname, '..', '.git'))) {
            mkdirSync(gitHooksDir, { recursive: true });
            const hook = `#!/bin/bash
# Auto-installed by postinstall — prevents CI format failures
staged_ts=$(git diff --cached --name-only --diff-filter=ACM -- '*.ts')
[ -z "$staged_ts" ] && exit 0
echo "$staged_ts" | xargs npx prettier --check 2>&1
if [ $? -ne 0 ]; then
    echo ""
    echo "Pre-commit: Prettier check failed. Run 'npm run format' to fix."
    exit 1
fi
`;
            const hookPath = join(gitHooksDir, 'pre-commit');
            writeFileSync(hookPath, hook, { mode: 0o755 });
            console.log(colors.green('✓ Git pre-commit hook installed (prettier check)'));
        }
    } catch {
        // Non-critical — git hook is a convenience
    }
}

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------

console.log('');

if (hasErrors) {
    console.log(colors.red(colors.bold('Installation cannot proceed due to errors above.')));
    process.exit(1);
}

if (hasWarnings) {
    console.log(colors.yellow('Note: Resolve warnings above for full functionality.'));
    console.log('');
}

// ----------------------------------------------------------------------------
// Auto-start Codeman web server
// ----------------------------------------------------------------------------

const port = parseInt(process.env.PORT || '3000', 10);
const projectRoot = join(import.meta.dirname, '..');

if (process.env.CI || process.env.CODEMAN_NO_AUTOSTART) {
    // CI or explicit opt-out — just print next steps
    console.log(colors.bold('Next steps:'));
    if (isGlobalInstall) {
        console.log(colors.dim('  1. Start:  ') + colors.cyan('codeman web'));
        console.log(colors.dim('  2. Open:   ') + colors.cyan(`http://localhost:${port}`));
    } else {
        console.log(colors.dim('  1. Build:  ') + colors.cyan('npm run build'));
        console.log(colors.dim('  2. Start:  ') + colors.cyan('npx codeman web'));
        console.log(colors.dim('  3. Open:   ') + colors.cyan(`http://localhost:${port}`));
    }
    console.log('');
} else {
    // Auto-start the server
    const portInUse = await isPortBusy(port);

    if (portInUse) {
        console.log(colors.green('✓ Codeman appears to be already running'));
        console.log('');
        console.log(colors.bold('  ┌──────────────────────────────────────────┐'));
        console.log(colors.bold(`  │  ${colors.cyan(`→ http://localhost:${port}`)}${' '.repeat(Math.max(0, 21 - String(port).length))}│`));
        console.log(colors.bold('  └──────────────────────────────────────────┘'));
        console.log('');
    } else {
        // Build if dist/ doesn't exist (local install only)
        const distEntry = join(projectRoot, 'dist', 'index.js');
        let buildOk = existsSync(distEntry);

        if (!buildOk && !isGlobalInstall) {
            const hasTsc = existsSync(join(projectRoot, 'node_modules', '.bin', 'tsc'));
            if (hasTsc) {
                console.log(colors.dim('  Building Codeman...'));
                try {
                    execSync('npm run build', {
                        stdio: ['ignore', 'pipe', 'pipe'],
                        timeout: 180000,
                        cwd: projectRoot,
                    });
                    console.log(colors.green('✓ Build complete'));
                    buildOk = true;
                } catch {
                    console.log(colors.yellow('⚠ Build failed — start manually: npm run build && npx codeman web'));
                }
            } else {
                console.log(colors.yellow('⚠ TypeScript not found — run: npm run build'));
            }
        }

        if (buildOk) {
            console.log(colors.dim('  Starting Codeman web server...'));
            try {
                const child = spawn('node', [join(projectRoot, 'dist', 'index.js'), 'web'], {
                    detached: true,
                    stdio: 'ignore',
                    cwd: projectRoot,
                    env: { ...process.env, NODE_ENV: 'production' },
                });
                child.unref();

                const ready = await waitForServer(port);

                console.log('');
                if (ready) {
                    console.log(colors.green('✓ Codeman is running'));
                } else {
                    console.log(colors.yellow('⚠ Server may still be starting...'));
                }

                console.log('');
                console.log(colors.bold('  ┌──────────────────────────────────────────┐'));
                console.log(colors.bold(`  │  ${colors.cyan(`→ http://localhost:${port}`)}${' '.repeat(Math.max(0, 21 - String(port).length))}│`));
                console.log(colors.bold('  └──────────────────────────────────────────┘'));
                console.log('');
            } catch (err) {
                console.log(colors.yellow(`⚠ Could not auto-start: ${err.message}`));
                console.log(colors.dim('  Start manually: npx codeman web'));
                console.log('');
            }
        }
    }
}
