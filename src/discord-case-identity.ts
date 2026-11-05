/** Case grouping uses workspace/transport/owner metadata, never a tab's display-name prefix. */
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, basename, posix } from 'node:path';
import type { CaseInfo, SessionRemote, SessionDocker } from './types.js';
export interface DiscordCaseIdentity {
  key: string;
  name: string;
}
export interface DiscordCaseSession {
  id: string;
  workingDir: string;
  owner?: string;
  remote?: SessionRemote;
  docker?: SessionDocker;
}
const key = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export function resolveDiscordCase(session: DiscordCaseSession, cases: CaseInfo[]): DiscordCaseIdentity {
  const owner = session.owner ?? '@single';
  if (session.docker) {
    const d = session.docker;
    const configured = cases.find((c) => c.docker?.hostId === d.hostId && c.docker.container === d.containerName);
    return {
      key: key([owner, 'docker', d.hostId, d.containerName, d.containerWorkdir]),
      name: configured?.name ?? (basename(d.hostWorkspacePath || session.workingDir) || 'container'),
    };
  }
  const remote = session.remote,
    path = remote ? remote.remotePath : session.workingDir;
  if (!path || !(remote ? posix.isAbsolute(path) : isAbsolute(path)))
    return { key: key([owner, 'unlinked-session', session.id]), name: 'unlinked-session' };
  const normalize = remote ? posix.normalize : resolve;
  const workspace = normalize(path);
  const matches = cases
    .filter(
      (c) =>
        !c.docker && (remote ? c.remote?.hostId === remote.hostId && c.remote.username === remote.username : !c.remote)
    )
    .map((c) => ({ c, root: normalize(remote ? c.remote!.path : c.path) }))
    .filter(({ root }) => {
      const rel = remote ? posix.relative(root, workspace) : relative(root, workspace);
      return (
        rel === '' ||
        (!rel.startsWith('..' + (remote ? '/' : process.platform === 'win32' ? '\\' : '/')) &&
          rel !== '..' &&
          !(remote ? posix.isAbsolute(rel) : isAbsolute(rel)))
      );
    })
    .sort((a, b) => b.root.length - a.root.length || a.c.name.localeCompare(b.c.name));
  // Equal roots are aliases of one workspace; use its stable path identity rather than guessing an alias.
  const match = matches[0],
    root = match?.root ?? workspace;
  const host = remote ? ['ssh', remote.hostId, remote.username] : ['local'];
  const name = match?.c.name ?? ((remote ? posix.basename(root) : basename(root)) || 'workspace');
  return { key: key([owner, ...host, root]), name };
}
