/** @fileoverview Resolve only the exact Codex resume invocation belonging to the attached remote pane. */
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
# Locate the command, not command-like words in prompts or option values.
value_options={'-c','--config','-m','--model','-p','--profile','-s','--sandbox','-a','--ask-for-approval','-C','--cd','-i','--image','--add-dir','--enable','--disable','--local-provider','--remote','--remote-auth-token-env'}
flag_options={'--oss','--full-auto','--dangerously-bypass-approvals-and-sandbox','--no-alt-screen','--search','--help','-h','--version','-V'}
auxiliary={'exec','e','review','app-server','mcp-server','exec-server','login','logout','mcp','plugin','remote-control','completion','update','doctor','sandbox','debug','apply','a','queue','archive','delete','migrate-rollouts','migrate-nfs-db','unarchive','features','help'}
def command_at(argv):
 i=1
 while i<len(argv):
  arg=argv[i]
  if arg=='--':return None
  if arg in value_options:
   i+=2;continue
  if arg.startswith('--') and '=' in arg and arg.split('=',1)[0] in value_options:
   i+=1;continue
  if len(arg)>2 and arg[:2] in value_options and not arg.startswith('--'):
   i+=1;continue
  if arg in flag_options:
   i+=1;continue
  if arg.startswith('-'):return None
  return i
 return None
ids=[];native=0;native_pids=[]
for pid in owned:
 try:argv=shlex.split(procs[pid][1])
 except Exception:continue
 if not argv or os.path.basename(argv[0]) not in ('codex','codx'):continue
 command=command_at(argv)
 if command is not None and argv[command] in auxiliary:continue
 native+=1;native_pids.append(pid)
 if command is None or argv[command]!='resume':continue
 i=command+1
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

export interface RemoteDiscordRuntime {
  id?: string;
  configHome: string;
  fingerprint: string;
}

/** Decode NUL-delimited process metadata on the host; never return arbitrary environment values. */
export const REMOTE_CODEX_ENV_READER = String.raw`
def selected_environment(fields):
 out={}
 for field in fields:
  key,sep,value=field.partition(b'=')
  if sep and key in (b'HOME',b'CODEX_HOME'):
   name=key.decode('ascii')
   if name in out:raise Exception('ambiguous runtime environment')
   out[name]=value.decode('utf-8')
 return out
def darwin_environment(data):
 import struct
 if len(data)<4:raise Exception('invalid process metadata')
 argc=struct.unpack_from('i',data)[0]
 if argc<1 or argc>4096:raise Exception('invalid argument count')
 at=data.find(b'\0',4)
 if at<0:raise Exception('invalid executable path')
 while at<len(data) and data[at]==0:at+=1
 for _ in range(argc):
  end=data.find(b'\0',at)
  if end<0:raise Exception('invalid process arguments')
  at=end+1
 return selected_environment(data[at:].split(b'\0'))
def runtime_environment(pid):
 if sys.platform=='darwin':
  import ctypes
  libc=ctypes.CDLL(None,use_errno=True)
  libc.sysctl.argtypes=[ctypes.POINTER(ctypes.c_int),ctypes.c_uint,ctypes.c_void_p,ctypes.POINTER(ctypes.c_size_t),ctypes.c_void_p,ctypes.c_size_t]
  libc.sysctl.restype=ctypes.c_int
  mib=(ctypes.c_int*3)(1,49,pid);size=ctypes.c_size_t()
  if libc.sysctl(mib,3,None,ctypes.byref(size),None,0)!=0 or size.value>1024*1024:raise Exception('process metadata unavailable')
  buf=ctypes.create_string_buffer(size.value)
  if libc.sysctl(mib,3,buf,ctypes.byref(size),None,0)!=0:raise Exception('process metadata unavailable')
  return darwin_environment(buf.raw[:size.value])
 with open('/proc/'+str(pid)+'/environ','rb') as f:data=f.read(1024*1024+1)
 if len(data)>1024*1024:raise Exception('process metadata limit')
 return selected_environment(data.split(b'\0'))
`;

export const REMOTE_CODEX_RUNTIME_PROBE =
  REMOTE_CODEX_RESUME_PROBE.slice(0, REMOTE_CODEX_RESUME_PROBE.lastIndexOf('print(json.dumps')) +
  REMOTE_CODEX_ENV_READER +
  String.raw`
import hashlib
if native!=1:
 print(json.dumps({'id':None}));sys.exit(0)
pid=native_pids[0]
def stamp():
 value=subprocess.check_output(['ps','-ww','-p',str(pid),'-o','lstart=','-o','command='],text=True,timeout=4)
 if not value.strip() or len(value)>65536:raise Exception('process changed')
 return value
before=stamp();env=runtime_environment(pid);home=env.get('CODEX_HOME')
base=env.get('HOME','')
if not home:home=os.path.join(base,'.codex') if os.path.isabs(base) else None
if home and home.startswith('~/') and os.path.isabs(base):home=os.path.join(base,home[2:])
if home and not os.path.isabs(home):
 if sys.platform=='darwin':
  rows=subprocess.check_output(['lsof','-a','-p',str(pid),'-d','cwd','-Fn'],text=True,timeout=4)
  paths=[line[1:] for line in rows.splitlines() if line.startswith('n')]
  if len(paths)!=1:raise Exception('runtime cwd unavailable')
  cwd=paths[0]
 else:cwd=os.readlink('/proc/'+str(pid)+'/cwd')
 if not os.path.isabs(cwd):raise Exception('runtime cwd unavailable')
 home=os.path.join(cwd,home)
if not home or len(home)>4096 or any(ord(c)<32 for c in home):raise Exception('runtime home unavailable')
home=os.path.normpath(home)
if stamp()!=before:raise Exception('process changed')
fingerprint=hashlib.sha256((str(root)+':'+str(pid)+':'+before).encode()).hexdigest()
print(json.dumps({'id':ids[0] if len(ids)==1 else None,'configHome':home,'fingerprint':fingerprint}))
`;

export async function probeRemoteDiscordRuntime(
  remote: SessionRemote,
  sessionId: string
): Promise<RemoteDiscordRuntime | undefined> {
  const result = await runDiscordRemoteRead(
    remote,
    withRemotePathBootstrap(
      'python3 -c ' +
        shellescape(REMOTE_CODEX_RUNTIME_PROBE) +
        ' ' +
        shellescape(JSON.stringify({ location: remoteTmuxLocation(remote, sessionId) }))
    )
  );
  return parseDiscordRuntime(result);
}

export function parseDiscordRuntime(result: Buffer): RemoteDiscordRuntime | undefined {
  if (result.length > 16384) return undefined;
  const value = JSON.parse(result.toString('utf8')) as Partial<RemoteDiscordRuntime>;
  if (
    typeof value.configHome !== 'string' ||
    value.configHome.length > 4096 ||
    !value.configHome.startsWith('/') ||
    Array.from(value.configHome).some((c) => c.charCodeAt(0) < 32) ||
    typeof value.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    (value.id != null &&
      (typeof value.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.id)))
  )
    return undefined;
  return { id: value.id ?? undefined, configHome: value.configHome, fingerprint: value.fingerprint };
}
