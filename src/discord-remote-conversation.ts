/** Resolve only the exact Codex resume invocation belonging to the attached remote pane. */
import type { SessionRemote } from './types/session.js';
import { remoteTmuxLocation } from './tmux-manager.js';
import { withRemotePathBootstrap, shellescape } from './remote-hosts.js';
import { runDiscordRemoteRead } from './discord-file-transfers.js';
export const REMOTE_CODEX_RESUME_PROBE = String.raw`
import subprocess,json,sys,re,os,shlex
s=json.loads(sys.argv[1]);loc=s['location'];uuid=r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
panes=subprocess.check_output(['tmux','-L',loc['socket'],'list-panes','-t',loc['sessionName'],'-F','#{pane_pid}'],text=True,timeout=4).strip().splitlines()
if len(panes)!=1 or not panes[0].isdigit():raise Exception('ambiguous pane')
root=int(panes[0]);rows=subprocess.check_output(['ps','-ww','-axo','pid=,ppid=,command='],text=True,timeout=5)
if len(rows)>4*1024*1024:raise Exception('process inventory limit')
procs={}
for row in rows.splitlines():
 m=re.match(r'\s*(\d+)\s+(\d+)\s+(.*)',row)
 if m:procs[int(m[1])]=(int(m[2]),m[3])
if root not in procs:raise Exception('pane process missing')
owned={root}
for _ in range(16):
 new=owned|{pid for pid,(parent,cmd) in procs.items() if parent in owned}
 if new==owned:break
 owned=new
if len(owned)>64:raise Exception('ambiguous process tree')
ids=[];native=0
for pid in owned:
 try:argv=shlex.split(procs[pid][1])
 except Exception:continue
 if not argv or os.path.basename(argv[0]) not in ('codex','codx'):continue
 if 'exec' in argv[1:]:continue
 native+=1
 positions=[i for i,a in enumerate(argv) if a=='resume']
 if len(positions)!=1:continue
 i=positions[0]+1
 if i<len(argv) and re.fullmatch(uuid,argv[i],re.I):ids.append(argv[i])
print(json.dumps({'id':ids[0] if native==1 and len(ids)==1 else None}))
`;
export async function probeRemoteDiscordConversation(
  remote: SessionRemote,
  sessionId: string
): Promise<string | undefined> {
  const result = await runDiscordRemoteRead(
    remote,
    withRemotePathBootstrap(
      'python3 -c ' +
        shellescape(REMOTE_CODEX_RESUME_PROBE) +
        ' ' +
        shellescape(JSON.stringify({ location: remoteTmuxLocation(remote, sessionId) }))
    )
  );
  if (result.length > 1024) return undefined;
  const id: unknown = (JSON.parse(result.toString('utf8')) as { id?: unknown }).id;
  return typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
    ? id
    : undefined;
}
