#!/usr/bin/env node
/**
 * Build script for Codeman.
 * Extracted from the package.json one-liner for readability and debuggability.
 *
 * Steps:
 *   1. TypeScript compilation
 *   2. Copy static assets (web/public, templates)
 *   3. Build vendor xterm bundles
 *   4. Minify frontend assets (app.js, styles.css, mobile.css)
 *   5. Content-hash cache busting (rename assets, rewrite index.html)
 *   6. Compress with gzip + brotli
 */

import { execSync } from 'child_process';
import { appendFileSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { join, extname, basename, dirname } from 'path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

function run(label, cmd) {
  console.log(`\n[build] ${label}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, shell: true });
}

// 1. TypeScript compilation
run('tsc', 'tsc');
run('chmod dist/index.js', 'chmod +x dist/index.js');

// 2. Copy static assets (clean first to remove stale hashed files from previous builds)
run('clean public', 'rm -rf dist/web/public');
run('prepare dirs', 'mkdir -p dist/web dist/templates dist/web/public/vendor');
// Fetch the opt-in gesture overlay's MediaPipe wasm + model into src/ (idempotent,
// non-fatal, kept out of git) so the copy below carries them into dist/.
run('gesture assets', 'node scripts/fetch-gesture-assets.mjs');
// Rebuild the gesture overlay bundle from its vendored source (packages/gesture-control)
// into src/web/public/gesture/gesture-codeman.js, so prod always reflects current source.
run('gesture bundle', 'node scripts/build-gesture-bundle.mjs');
run('copy web assets', 'cp -r src/web/public dist/web/');
run('copy template', 'cp src/templates/case-template.md dist/templates/');

// 3. Vendor xterm bundles (xterm.js 6.x — @xterm scoped packages)
run('xterm css', 'cp node_modules/@xterm/xterm/css/xterm.css dist/web/public/vendor/');
run('xterm js', 'npx esbuild node_modules/@xterm/xterm/lib/xterm.js --minify --outfile=dist/web/public/vendor/xterm.min.js');
run('xterm-addon-fit', 'npx esbuild node_modules/@xterm/addon-fit/lib/addon-fit.js --minify --outfile=dist/web/public/vendor/xterm-addon-fit.min.js');
run('xterm-addon-serialize', 'npx esbuild node_modules/@xterm/addon-serialize/lib/addon-serialize.js --minify --outfile=dist/web/public/vendor/xterm-addon-serialize.min.js');
run('xterm-addon-webgl', 'cp node_modules/@xterm/addon-webgl/lib/addon-webgl.js dist/web/public/vendor/xterm-addon-webgl.min.js');
run('xterm-addon-unicode11', 'npx esbuild node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js --minify --outfile=dist/web/public/vendor/xterm-addon-unicode11.min.js');
run('xterm-zerolag-input', 'npx esbuild packages/xterm-zerolag-input/src/zerolag-input-addon.ts --bundle --minify --format=iife --global-name=XtermZerolagInput --outfile=dist/web/public/vendor/xterm-zerolag-input.js');

// Append global aliases so app.js can use `new LocalEchoOverlay(terminal)`
appendFileSync(
  join(ROOT, 'dist/web/public/vendor/xterm-zerolag-input.js'),
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

// Predictive echo (codex): separate bundle so the zerolag bundle stays byte-identical
run('xterm-predictive-echo', 'npx esbuild packages/xterm-zerolag-input/src/predictive-echo-addon.ts --bundle --minify --format=iife --global-name=XtermPredictiveEcho --outfile=dist/web/public/vendor/xterm-predictive-echo.js');
appendFileSync(
  join(ROOT, 'dist/web/public/vendor/xterm-predictive-echo.js'),
  '\n// Global aliases for browser usage\n' +
  'if(typeof window!=="undefined"){' +
    'window.PredictiveEchoAddon=XtermPredictiveEcho.PredictiveEchoAddon;' +
    'window.PredictiveEchoOverlay=class extends XtermPredictiveEcho.PredictiveEchoAddon{' +
      'constructor(terminal){' +
        'super({});' +
        'this.activate(terminal);' +
      '}' +
    '};' +
  '}\n'
);

// 4. Minify frontend assets
run('minify input-cjk.js', 'npx esbuild dist/web/public/input-cjk.js --minify --outfile=dist/web/public/input-cjk.js --allow-overwrite');
run('minify terminal-keycode229-recovery.js', 'npx esbuild dist/web/public/terminal-keycode229-recovery.js --minify --outfile=dist/web/public/terminal-keycode229-recovery.js --allow-overwrite');
run('minify i18n.js', 'npx esbuild dist/web/public/i18n.js --minify --outfile=dist/web/public/i18n.js --allow-overwrite');
run('minify sanitize-html.js', 'npx esbuild dist/web/public/sanitize-html.js --minify --outfile=dist/web/public/sanitize-html.js --allow-overwrite');
run('minify app.js', 'npx esbuild dist/web/public/app.js --minify --outfile=dist/web/public/app.js --allow-overwrite');
run('minify tab-rail-resize.js', 'npx esbuild dist/web/public/tab-rail-resize.js --minify --outfile=dist/web/public/tab-rail-resize.js --allow-overwrite');
run('minify terminal-ui.js', 'npx esbuild dist/web/public/terminal-ui.js --minify --outfile=dist/web/public/terminal-ui.js --allow-overwrite');
run('minify respawn-ui.js', 'npx esbuild dist/web/public/respawn-ui.js --minify --outfile=dist/web/public/respawn-ui.js --allow-overwrite');
run('minify ralph-panel.js', 'npx esbuild dist/web/public/ralph-panel.js --minify --outfile=dist/web/public/ralph-panel.js --allow-overwrite');
run('minify settings-ui.js', 'npx esbuild dist/web/public/settings-ui.js --minify --outfile=dist/web/public/settings-ui.js --allow-overwrite');
run('minify panels-ui.js', 'npx esbuild dist/web/public/panels-ui.js --minify --outfile=dist/web/public/panels-ui.js --allow-overwrite');
run('minify session-ui.js', 'npx esbuild dist/web/public/session-ui.js --minify --outfile=dist/web/public/session-ui.js --allow-overwrite');
run('minify styles.css', 'npx esbuild dist/web/public/styles.css --minify --outfile=dist/web/public/styles.css --allow-overwrite');
run('minify mobile.css', 'npx esbuild dist/web/public/mobile.css --minify --outfile=dist/web/public/mobile.css --allow-overwrite');

// 5. Content-hash cache busting
console.log('\n[build] content-hash cache busting');
{
  const distPublic = join(ROOT, 'dist/web/public');
  const HASHABLE = [
    'styles.css',
    'mobile.css',
    'constants.js',
    'i18n.js',
    'mobile-handlers.js',
    'voice-input.js',
    'notification-manager.js',
    'keyboard-accessory.js',
    'input-cjk.js',
    'terminal-keycode229-recovery.js',
    'sanitize-html.js',
    'app.js',
    'tab-rail-resize.js',
    'terminal-ui.js',
    'respawn-ui.js',
    'ralph-panel.js',
    'settings-ui.js',
    'panels-ui.js',
    'session-ui.js',
    'ralph-wizard.js',
    'api-client.js',
    'subagent-windows.js',
    'image-input.js',
    'vendor/xterm-zerolag-input.js',
    'vendor/xterm-predictive-echo.js',
  ];
  const manifest = {};
  for (const file of HASHABLE) {
    const filePath = join(distPublic, file);
    const content = readFileSync(filePath);
    const hash = createHash('md5').update(content).digest('hex').slice(0, 8);
    const ext = extname(file);
    const base = basename(file, ext);
    const dir = dirname(file);
    const hashed = dir === '.' ? `${base}.${hash}${ext}` : `${dir}/${base}.${hash}${ext}`;
    renameSync(filePath, join(distPublic, hashed));
    manifest[file] = hashed;
  }
  // Rewrite index.html to reference hashed filenames
  let html = readFileSync(join(distPublic, 'index.html'), 'utf8');
  for (const [original, hashed] of Object.entries(manifest)) {
    html = html.replaceAll(`"${original}"`, `"${hashed}"`);
  }
  writeFileSync(join(distPublic, 'index.html'), html);
  console.log('  Hashed files:');
  for (const [orig, hashed] of Object.entries(manifest)) {
    console.log(`    ${orig} -> ${hashed}`);
  }
}

// 6. Compress with gzip + brotli
run(
  'compress',
  `for f in dist/web/public/*.js dist/web/public/*.css dist/web/public/*.html dist/web/public/vendor/*.js dist/web/public/vendor/*.css; do` +
    ` [ -f "$f" ] && gzip -9 -k -f "$f" && { brotli -9 -k -f "$f" 2>/dev/null || true; }; done`
);

console.log('\n✓ Build complete');
