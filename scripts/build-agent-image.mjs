#!/usr/bin/env node
/**
 * Build the Codeman agent base image locally (decision: "build locally on first
 * use", see docs/docker-cases-plan.md). No registry account required.
 *
 * Usage:
 *   node scripts/build-agent-image.mjs [--engine docker|podman] [--image <ref>] [--no-cache]
 *
 * Defaults: engine=docker (falls back to podman if docker is absent),
 *           image=codeman/agent:base
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { agentImageBuildArgPairs, readCatalog } from './lib/cli-catalog.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DOCKERFILE = join(REPO_ROOT, 'docker', 'agent.Dockerfile');
const DEFAULT_IMAGE = 'codeman/agent:base';

function parseArgs(argv) {
  const args = { image: DEFAULT_IMAGE, engine: undefined, noCache: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--image') args.image = argv[++i];
    else if (a === '--engine') args.engine = argv[++i];
    else if (a === '--no-cache') args.noCache = true;
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function engineAvailable(engine) {
  const r = spawnSync(engine, ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

function resolveEngine(preferred) {
  if (preferred) {
    if (!engineAvailable(preferred)) {
      console.error(`[build-agent-image] engine "${preferred}" not found on PATH`);
      process.exit(1);
    }
    return preferred;
  }
  if (engineAvailable('docker')) return 'docker';
  if (engineAvailable('podman')) return 'podman';
  console.error('[build-agent-image] neither docker nor podman found on PATH. Install one and retry.');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: node scripts/build-agent-image.mjs [--engine docker|podman] [--image <ref>] [--no-cache]');
  process.exit(0);
}

const engine = resolveEngine(args.engine);
const buildArgs = ['build', '-f', DOCKERFILE, '-t', args.image];
if (args.noCache) buildArgs.push('--no-cache');
// The CLI list comes from the generated catalogue rather than the Dockerfile, so adding a
// stock CLI needs no edit in either. `src/docker-hosts.ts` assembles the same argv for the
// in-app auto-build; test/agent-image-build-args-parity.test.ts pins the two together, since
// two independent producers of one command line is exactly how they drift.
for (const [name, value] of agentImageBuildArgPairs(readCatalog())) {
  buildArgs.push('--build-arg', `${name}=${value}`);
}
buildArgs.push(REPO_ROOT);

console.log(`[build-agent-image] ${engine} ${buildArgs.join(' ')}`);
const child = spawn(engine, buildArgs, { stdio: 'inherit' });
child.on('exit', (code) => {
  if (code === 0) {
    console.log(`\n[build-agent-image] built ${args.image}. Docker cases can now launch.`);
  } else {
    console.error(`\n[build-agent-image] build failed (exit ${code}).`);
  }
  process.exit(code ?? 1);
});
