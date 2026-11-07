/** Read-only, explicitly unattributed workspace diff. Every exported path uses the file guard. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, posix } from 'node:path';
import { readDiscordSessionFile, runDiscordRemoteRead } from './discord-file-transfers.js';
import { shellescape, withRemotePathBootstrap } from './remote-hosts.js';
import type { DiscordFileScope } from './discord-file-transfers.js';
const exec = promisify(execFile);
async function workspaceGit(scope: DiscordFileScope, args: string[]): Promise<string> {
  const argv = ['--no-pager', '-c', 'core.fsmonitor=false', '--literal-pathspecs', ...args];
  if (scope.remote) {
    const cwd = scope.remote.remotePath;
    return (
      await runDiscordRemoteRead(
        scope.remote,
        withRemotePathBootstrap(`cd ${shellescape(cwd)} && git ${argv.map(shellescape).join(' ')}`)
      )
    ).toString('utf8');
  }
  return (await exec('git', argv, { cwd: scope.workingDir, timeout: 8000, maxBuffer: 256 * 1024, encoding: 'utf8' }))
    .stdout;
}

/** Names only: rendering a results menu must not download every changed remote file. */
export async function discordWorkspaceHasChanges(scope: DiscordFileScope): Promise<boolean> {
  return !!(await workspaceGit(scope, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--']))
    .length;
}

export async function discordWorkspaceResults(scope: DiscordFileScope): Promise<{ summary: string; diff: string }> {
  const run = (args: string[]) => workspaceGit(scope, args);
  const names = (await run(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--']))
    .split('\0')
    .filter(Boolean);
  if (names.length > 200) throw new Error('Workspace has more than 200 changed paths; narrow the review in Codeman');
  let diff = '',
    omitted = 0;
  const visible: string[] = [];
  for (const path of names) {
    if (visible.length >= 20 || diff.length > 180000) {
      omitted++;
      continue;
    }
    // A real regular file inside the originating workspace is required. Deleted files,
    // symlinks, secrets and out-of-scope paths cannot leak through a raw git diff.
    const absolute = scope.remote ? posix.resolve(scope.remote.remotePath, path) : resolve(scope.workingDir, path);
    try {
      await readDiscordSessionFile(scope, absolute);
      const text = await run(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', path]);
      if (diff.length + text.length > 200000) {
        omitted++;
        continue;
      }
      visible.push(path.replace(/[\r\n`@]/g, ' ').slice(0, 180));
      diff += text;
    } catch {
      omitted++;
    }
  }
  return {
    summary: visible.length
      ? visible.map((p) => '• ' + p).join('\n') +
        (omitted ? `\n${omitted} paths omitted (guarded, deleted, binary or bounded output).` : '')
      : 'No exportable tracked changes. Untracked files are not included.',
    diff: diff || 'No exportable tracked diff.\n',
  };
}
