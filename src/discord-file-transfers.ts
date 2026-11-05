/** Bounded local/SSH attachment access using the session workspace and shared path/SSH guards. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, isAbsolute, relative, sep, posix } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isBlockedAttachmentPath, loadAttachmentGuardConfig } from './config/attachment-guard.js';
import { remoteProbePaths } from './remote-files.js';
import { writeRemoteFileBytes } from './remote-file-transfer.js';
import { buildSshConnectionArgv, remoteSshTarget, shellescape, withRemotePathBootstrap } from './remote-hosts.js';
import { runWithRemoteSshLimit } from './remote-ssh-limiter.js';
import type { SessionRemote } from './types/session.js';
import { probePathKind, describeUnknownPath } from './utils/bounded-path-probe.js';

export const DISCORD_FILE_LIMIT = 8 * 1024 * 1024;
export interface DiscordFileScope {
  workingDir: string;
  remote?: SessionRemote;
}
export interface DiscordTransferredFile {
  name: string;
  data: Uint8Array;
}
export class DiscordFileProblem extends Error {}
const inside = (root: string, path: string) => {
  const rel = posix.relative(root, path);
  return !!rel && rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel);
};
function validRemote(remote: SessionRemote): void {
  if (!remote.host || !remote.username || !posix.isAbsolute(remote.remotePath) || /[\0\r\n]/.test(remote.remotePath))
    throw new DiscordFileProblem('Remote session connection metadata is incomplete');
}
const READ_SCRIPT = String.raw`
import os,sys,json,stat
o=json.loads(sys.argv[1]);root=o["root"];path=o["path"];limit=o["limit"]
rel=os.path.relpath(path,root)
if rel=="." or rel==".." or rel.startswith("../") or os.path.isabs(rel): raise Exception("outside workspace")
flags=os.O_RDONLY|os.O_NOFOLLOW
fds=[]
try:
 d=os.open(root,flags|os.O_DIRECTORY);fds.append(d)
 parts=rel.split("/")
 for part in parts[:-1]:
  if part in ("",".",".."): raise Exception("invalid path")
  d=os.open(part,flags|os.O_DIRECTORY,dir_fd=d);fds.append(d)
 f=os.open(parts[-1],flags|os.O_NONBLOCK,dir_fd=d);fds.append(f)
 info=os.fstat(f)
 if not stat.S_ISREG(info.st_mode) or info.st_size>limit: raise Exception("not a bounded regular file")
 chunks=[];total=0
 while True:
  chunk=os.read(f,min(65536,limit+1-total))
  if not chunk: break
  total+=len(chunk)
  if total>limit: raise Exception("file exceeds limit")
  chunks.append(chunk)
 sys.stdout.buffer.write(b"".join(chunks))
finally:
 for f in reversed(fds): os.close(f)
`;
export function discordRemoteReadCommand(root: string, path: string, maxBytes = DISCORD_FILE_LIMIT): string {
  return withRemotePathBootstrap(
    'python3 -c ' + shellescape(READ_SCRIPT) + ' ' + shellescape(JSON.stringify({ root, path, limit: maxBytes }))
  );
}
export async function runDiscordRemoteRead(remote: SessionRemote, command: string): Promise<Buffer> {
  return runWithRemoteSshLimit(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        const child = spawn('ssh', [...buildSshConnectionArgv(remote), remoteSshTarget(remote), command], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const chunks: Buffer[] = [];
        let bytes = 0,
          stderr = 0,
          settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) {
            child.kill('SIGTERM');
            reject(err);
          } else resolve(Buffer.concat(chunks));
        };
        const timer = setTimeout(() => finish(new DiscordFileProblem('Remote file transfer timed out')), 30000);
        child.stdout.on('data', (data: Buffer) => {
          if (settled) return;
          bytes += data.length;
          if (bytes > DISCORD_FILE_LIMIT) finish(new DiscordFileProblem('The file is over 8 MB'));
          else chunks.push(Buffer.from(data));
        });
        child.stderr.on('data', (data: Buffer) => {
          stderr += data.length;
          if (stderr > 65536) finish(new DiscordFileProblem('Remote file transfer failed'));
        });
        child.on('error', () => finish(new DiscordFileProblem('Remote file transfer failed')));
        child.on('close', (code) =>
          finish(code === 0 ? undefined : new DiscordFileProblem('Remote file could not be read safely'))
        );
      })
  );
}

export async function readDiscordSessionFile(scope: DiscordFileScope, path: string): Promise<DiscordTransferredFile> {
  if (!(scope.remote ? posix.isAbsolute(path) : isAbsolute(path)) || /[\0\r\n]/.test(path))
    throw new DiscordFileProblem('The file path must be absolute');
  const guard = await loadAttachmentGuardConfig();
  if (isBlockedAttachmentPath(path, guard.blockedTrees))
    throw new DiscordFileProblem('That file cannot be sent: it can hold credentials');
  if (scope.remote) {
    validRemote(scope.remote);
    let root, file;
    try {
      [root, file] = await remoteProbePaths(scope.remote, [scope.remote.remotePath, path]);
    } catch {
      throw new DiscordFileProblem('Remote workspace is unavailable');
    }
    if (root?.kind !== 'directory' || file?.kind !== 'file')
      throw new DiscordFileProblem('Not a regular file in an available remote workspace');
    if (!inside(root.realPath, file.realPath))
      throw new DiscordFileProblem('The file must be inside the session folder');
    if (isBlockedAttachmentPath(file.realPath, guard.blockedTrees))
      throw new DiscordFileProblem('That file cannot be sent: it can hold credentials');
    if (file.size > DISCORD_FILE_LIMIT) throw new DiscordFileProblem('The file is over 8 MB');
    return {
      name: posix.basename(path),
      data: await runDiscordRemoteRead(scope.remote, discordRemoteReadCommand(root.realPath, file.realPath)),
    };
  }
  if ((await probePathKind(scope.workingDir, { pastCap: true })) !== 'directory')
    throw new DiscordFileProblem(describeUnknownPath('The session folder', scope.workingDir, { pastCap: true }));
  const kind = await probePathKind(path, { pastCap: true });
  if (kind === 'unknown') throw new DiscordFileProblem(describeUnknownPath('The file', path, { pastCap: true }));
  if (kind !== 'file') throw new DiscordFileProblem('Not a regular file');
  let root, real;
  try {
    [root, real] = await Promise.all([fs.realpath(scope.workingDir), fs.realpath(path)]);
  } catch {
    throw new DiscordFileProblem('The file could not be read');
  }
  const rel = relative(root, real);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new DiscordFileProblem('The file must be inside the session folder');
  if (isBlockedAttachmentPath(real, guard.blockedTrees))
    throw new DiscordFileProblem('That file cannot be sent: it can hold credentials');
  let file;
  try {
    file = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile()) throw new DiscordFileProblem('Not a regular file');
    if (info.size > DISCORD_FILE_LIMIT) throw new DiscordFileProblem('The file is over 8 MB');
    const bytes: Buffer[] = [];
    let total = 0;
    while (total <= DISCORD_FILE_LIMIT) {
      const buf = Buffer.alloc(Math.min(65536, DISCORD_FILE_LIMIT + 1 - total));
      const got = await file.read(buf, 0, buf.length, null);
      if (!got.bytesRead) break;
      total += got.bytesRead;
      if (total > DISCORD_FILE_LIMIT) throw new DiscordFileProblem('The file is over 8 MB');
      bytes.push(buf.subarray(0, got.bytesRead));
    }
    return { name: basename(path), data: Buffer.concat(bytes) };
  } catch (err) {
    if (err instanceof DiscordFileProblem) throw err;
    throw new DiscordFileProblem('The file could not be read');
  } finally {
    await file?.close();
  }
}

export async function writeDiscordRemoteAttachment(
  remote: SessionRemote,
  name: string,
  bytes: Uint8Array
): Promise<string> {
  validRemote(remote);
  if (bytes.byteLength > DISCORD_FILE_LIMIT) throw new DiscordFileProblem('The file is over 8 MB');
  const [root] = await remoteProbePaths(remote, [remote.remotePath]);
  if (root?.kind !== 'directory') throw new DiscordFileProblem('Remote workspace is unavailable');
  const guard = await loadAttachmentGuardConfig();
  if (isBlockedAttachmentPath(root.realPath, guard.blockedTrees))
    throw new DiscordFileProblem('The remote workspace is not allowed for attachments');
  const dir = posix.join(root.realPath, '.codeman-discord');
  const safe =
    (name.split(/[\\/]/).pop() ?? 'file')
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^[._]+/, '')
      .slice(0, 80) || 'file';
  const path = posix.join(dir, randomUUID() + '-' + safe);
  try {
    const base = {
      dir,
      timeoutMs: 30000,
      transferLabel: 'Discord attachment upload',
      notADirectoryMessage: 'Remote upload folder must be a real directory',
      privateDirectory: true,
      strict: true,
    };
    await runWithRemoteSshLimit(() =>
      writeRemoteFileBytes(remote, { ...base, filePath: posix.join(dir, '.gitignore'), bytes: Buffer.from('*\n') })
    );
    await runWithRemoteSshLimit(() =>
      writeRemoteFileBytes(remote, { ...base, filePath: path, bytes: Buffer.from(bytes) })
    );
    // Verify the path and bytes before they are ever passed to the native CLI.
    const actual = await readDiscordSessionFile(
      { workingDir: root.realPath, remote: { ...remote, remotePath: root.realPath } },
      path
    );
    const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
    if (digest(actual.data) !== digest(bytes)) throw new DiscordFileProblem('Remote attachment verification failed');
  } catch (err) {
    if (err instanceof DiscordFileProblem) throw err;
    throw new DiscordFileProblem('Remote attachment transfer failed');
  }
  return path;
}

/** Download a Discord CDN body without trusting its declared size or accumulating unbounded bytes. */
export async function boundedDiscordDownload(res: Response): Promise<Uint8Array> {
  if (!res.ok || !res.body) throw new DiscordFileProblem('Attachment download failed');
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DISCORD_FILE_LIMIT) throw new DiscordFileProblem('The file is over 8 MB');
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(parts);
}
