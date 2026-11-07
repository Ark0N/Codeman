/** Read only public model catalog fields; never return account metadata or credentials. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { withRemotePathBootstrap, shellescape } from './remote-hosts.js';
import { runDiscordRemoteRead } from './discord-file-transfers.js';
import type { Session } from './session.js';

export interface DiscordCatalogModel {
  id: string;
  label: string;
  efforts: string[];
}
export function parseDiscordModelCatalog(raw: unknown): DiscordCatalogModel[] {
  if (!raw || typeof raw !== 'object') return [];
  const models = (raw as { models?: unknown }).models;
  if (!Array.isArray(models) || models.length > 256) return [];
  return models.flatMap((model: unknown) => {
    if (!model || typeof model !== 'object') return [];
    const m = model as Record<string, unknown>;
    if (
      typeof m.slug !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/.test(m.slug) ||
      typeof m.display_name !== 'string' ||
      !m.display_name ||
      m.display_name.length > 100 ||
      /[\r\n]/.test(m.display_name)
    )
      return [];
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
    const efforts = levels.flatMap((level: unknown) => {
      const effort = level && typeof level === 'object' ? (level as { effort?: unknown }).effort : undefined;
      return typeof effort === 'string' && /^(none|minimal|low|medium|high|xhigh|max|ultra)$/.test(effort)
        ? [effort]
        : [];
    });
    return [{ id: m.slug, label: m.display_name, efforts: [...new Set(efforts)] }];
  });
}

const CATALOG_READ = String.raw`
import os,sys,json,stat
home=os.path.expanduser(sys.argv[1] or os.environ.get('CODEX_HOME') or '~/.codex')
if not os.path.isabs(home): home=os.path.join(sys.argv[2],home)
p=os.path.join(home,'models_cache.json');f=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
try:
 s=os.fstat(f)
 if not stat.S_ISREG(s.st_mode) or s.st_size>4*1024*1024: raise Exception('catalog unavailable')
 raw=json.loads(os.read(f,4*1024*1024));models=raw.get('models',[])
 if not isinstance(models,list) or len(models)>256: raise Exception('catalog unavailable')
 print(json.dumps({'models':[{k:m.get(k) for k in ['slug','display_name','supported_reasoning_levels']} for m in models if isinstance(m,dict)]}))
finally: os.close(f)
`;
export async function readDiscordModelCatalog(session: Session): Promise<DiscordCatalogModel[]> {
  try {
    const configured = session.envOverrideValue('CODEX_HOME');
    if (session.remote) {
      const command = withRemotePathBootstrap(
        'python3 -c ' +
          shellescape(CATALOG_READ) +
          ' ' +
          shellescape(configured ?? '') +
          ' ' +
          shellescape(session.remote.remotePath)
      );
      const raw = await runDiscordRemoteRead(session.remote, command);
      return parseDiscordModelCatalog(JSON.parse(raw.toString('utf8')));
    }
    const value = configured ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const root = value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(session.workingDir, value);
    const file = await fs.open(
      join(root, 'models_cache.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 4 * 1024 * 1024) return [];
      const bytes = Buffer.alloc(info.size + 1);
      const read = await file.read(bytes, 0, bytes.length, 0);
      return parseDiscordModelCatalog(JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8')));
    } finally {
      await file.close();
    }
  } catch {
    return [];
  }
}
