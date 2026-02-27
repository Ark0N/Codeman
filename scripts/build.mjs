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
 *   5. Compress with gzip + brotli
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

function run(label, cmd) {
  console.log(`\n[build] ${label}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, shell: true });
}

// 1. TypeScript compilation
run('tsc', 'tsc');
run('chmod dist/index.js', 'chmod +x dist/index.js');

// 2. Copy static assets
run('prepare dirs', 'mkdir -p dist/web dist/templates dist/web/public/vendor');
run('copy web assets', 'cp -r src/web/public dist/web/');
run('copy template', 'cp src/templates/case-template.md dist/templates/');

// 3. Vendor xterm bundles
run('xterm css', 'cp node_modules/xterm/css/xterm.css dist/web/public/vendor/');
run('xterm js', 'npx esbuild node_modules/xterm/lib/xterm.js --minify --outfile=dist/web/public/vendor/xterm.min.js');
run('xterm-addon-fit', 'npx esbuild node_modules/xterm-addon-fit/lib/xterm-addon-fit.js --minify --outfile=dist/web/public/vendor/xterm-addon-fit.min.js');
run('xterm-addon-webgl', 'cp node_modules/xterm-addon-webgl/lib/xterm-addon-webgl.js dist/web/public/vendor/xterm-addon-webgl.min.js');
run('xterm-addon-unicode11', 'npx esbuild node_modules/xterm-addon-unicode11/lib/xterm-addon-unicode11.js --minify --outfile=dist/web/public/vendor/xterm-addon-unicode11.min.js');

// 4. Minify frontend assets
run('minify app.js', 'npx esbuild dist/web/public/app.js --minify --drop:console --outfile=dist/web/public/app.js --allow-overwrite');
run('minify styles.css', 'npx esbuild dist/web/public/styles.css --minify --outfile=dist/web/public/styles.css --allow-overwrite');
run('minify mobile.css', 'npx esbuild dist/web/public/mobile.css --minify --outfile=dist/web/public/mobile.css --allow-overwrite');

// 5. Compress with gzip + brotli
run(
  'compress',
  `for f in dist/web/public/*.js dist/web/public/*.css dist/web/public/*.html dist/web/public/vendor/*.js dist/web/public/vendor/*.css; do` +
    ` [ -f "$f" ] && gzip -9 -k -f "$f" && { brotli -9 -k -f "$f" 2>/dev/null || true; }; done`
);

console.log('\n✓ Build complete');
