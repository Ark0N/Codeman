/**
 * Unit tests for the docker launch/kill command builders in tmux-manager.ts
 * (mirror of test/remote-ssh-options.test.ts). Pure string assertions: the
 * escaping must survive bash -c -> docker exec -> sh -lc -> tmux.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDockerLaunchCommand,
  buildDockerKillCommand,
  buildDockerStopCommand,
  buildDockerRemoveCommand,
  dockerTmuxSessionName,
  type DockerLaunchOptions,
} from '../src/tmux-manager.js';
import { DEFAULT_AGENT_IMAGE, toSessionDocker, type DockerCreateContext } from '../src/docker-hosts.js';
import type { DockerCase, DockerHost, SessionMode } from '../src/types.js';

// The exact adopt-guard the in-container Codeman would use to discover its own sessions.
const SAFE_MUX_NAME_PATTERN = /^codeman-[a-f0-9-]+$/;

const HOST: DockerHost = { id: 'local', label: 'Local', image: DEFAULT_AGENT_IMAGE };
const CASE: DockerCase = {
  name: 'myproj',
  type: 'docker',
  hostId: 'local',
  hostWorkspacePath: '/home/arkon/cases/myproj',
};

function launchOpts(overrides: Partial<DockerLaunchOptions> = {}): DockerLaunchOptions {
  const docker = overrides.docker ?? toSessionDocker(HOST, CASE);
  const createContext: DockerCreateContext = {
    docker,
    sessionId: '1a2b3c4d5e6f',
    instance: '',
    userArgs: ['--user', '1000:0'],
    credentialMounts: [{ src: '/home/arkon/.claude', dst: '/home/agent/.claude' }],
    extraMounts: [],
    envCreate: { HOME: '/home/agent', CODEMAN_API_URL: 'https://host.docker.internal:3000' },
    addHostGateway: true,
    gatewayAlias: 'host.docker.internal',
  };
  return {
    mode: 'claude',
    docker,
    sessionId: '1a2b3c4d5e6f',
    createContext,
    execEnv: { TERM: 'xterm-256color', CODEMAN_SESSION_ID: '1a2b3c4d', CODEMAN_MUX: '1' },
    execEnvNames: [],
    ...overrides,
  };
}

describe('dockerTmuxSessionName', () => {
  it('is stable from the first 8 chars of the sessionId', () => {
    expect(dockerTmuxSessionName('1a2b3c4d5e6f')).toBe('codeman-dkr-1a2b3c4d');
  });
  it('deliberately FAILS the in-container adopt guard', () => {
    // 'k'/'r' are not hex, so an in-container Codeman never adopts our session
    expect(SAFE_MUX_NAME_PATTERN.test(dockerTmuxSessionName('1a2b3c4d5e6f'))).toBe(false);
  });
});

describe('buildDockerLaunchCommand', () => {
  it('image-check precedes ensure precedes start precedes exec', () => {
    const cmd = buildDockerLaunchCommand(launchOpts());
    const iImage = cmd.indexOf('docker image inspect');
    const iEnsure = cmd.indexOf('docker inspect');
    const iStart = cmd.indexOf('docker start');
    const iExec = cmd.indexOf('exec docker exec -it');
    expect(iImage).toBeGreaterThanOrEqual(0);
    expect(iImage).toBeLessThan(iEnsure);
    expect(iEnsure).toBeLessThan(iStart);
    expect(iStart).toBeLessThan(iExec);
  });

  it('ensures the container idempotently (inspect-or-create) with --pull=never', () => {
    const cmd = buildDockerLaunchCommand(launchOpts());
    expect(cmd).toContain("docker inspect 'codeman-case-myproj' >/dev/null 2>&1 || docker create");
    expect(cmd).toContain('--pull=never');
    expect(cmd).toContain("docker start 'codeman-case-myproj'");
  });

  it('avoids eager create expansion, tolerates a concurrent creator, and preserves real failures in compatibility mode', () => {
    const opts = launchOpts();
    opts.createContext.disableSwapLimit = true;
    const cmd = buildDockerLaunchCommand(opts);
    // No command substitution or shell variables: either could expand eagerly
    // before the inspect side of || short-circuits in a nested launch shell.
    expect(cmd).not.toContain('$(');
    expect(cmd).not.toContain('codeman_create_output');
    expect(cmd).toContain('if docker create');
    expect(cmd).toContain("'/tmp/codeman-create-1a2b3c4d5e6f.log'");
    // If another session created the case between inspect and create, re-inspect
    // succeeds and the losing creator continues without printing the conflict.
    expect(cmd).toContain("elif docker inspect 'codeman-case-myproj' >/dev/null 2>&1; then rm -f");
    expect(cmd).toContain('Your kernel does not support swap limit capabilities');
    expect(cmd).toContain('else sed');
    expect(cmd).toContain('>&2; rm -f');
    expect(cmd).toContain('; false; fi;');
    expect(cmd).not.toContain('--memory-swap');
  });

  it('execs a TTY into the durable in-container tmux', () => {
    const cmd = buildDockerLaunchCommand(launchOpts());
    expect(cmd).toContain("exec docker exec -it --workdir '/home/arkon/cases/myproj'");
    expect(cmd).toContain('tmux -L codeman-docker setenv -g CODEMAN_SESSION_ID');
    expect(cmd).toContain('new-session -A -s codeman-dkr-1a2b3c4d');
    expect(cmd).toContain("sh -lc '");
    // The in-container tmux keeps prefix C-q. Without this reduction its stock
    // prefix table runs switch-client / choose-tree for the inner client.
    const unbind = cmd.indexOf('unbind-key -a -T prefix');
    const bind = cmd.indexOf('bind-key -T prefix C-q send-prefix');
    expect(unbind).toBeGreaterThan(cmd.indexOf('prefix C-q'));
    expect(bind).toBeGreaterThan(unbind);
  });

  it('pins a deterministic conversation id with a reboot-surviving fallback (fresh launch)', () => {
    const cmd = buildDockerLaunchCommand(launchOpts());
    // --session-id first (fresh start), || --resume so a container stop/reboot
    // relaunch of the SAME session resumes instead of dead-paning on
    // "Session ID already in use".
    expect(cmd).toContain(
      'claude --dangerously-skip-permissions --session-id 1a2b3c4d5e6f || ' +
        'claude --dangerously-skip-permissions --resume 1a2b3c4d5e6f'
    );
    // exec is stripped from the claude pane command — an exec'd first branch could never fall back.
    expect(cmd).not.toContain('exec claude');
  });

  it('resumes an explicit id with a --session-id fallback (stale id never dead-panes)', () => {
    const withResume = buildDockerLaunchCommand(launchOpts({ resumeSessionId: 'abc-123-def' }));
    expect(withResume).toContain(
      'claude --dangerously-skip-permissions --resume abc-123-def || ' +
        'claude --dangerously-skip-permissions --session-id 1a2b3c4d5e6f'
    );
  });

  it('uses codex resume syntax and drops an unsafe resume id', () => {
    const codex = buildDockerLaunchCommand(
      launchOpts({ mode: 'codex' as SessionMode, resumeSessionId: '01H-codex-id' })
    );
    expect(codex).toContain('exec codex resume 01H-codex-id');
    const unsafe = buildDockerLaunchCommand(launchOpts({ resumeSessionId: 'x; rm -rf /' }));
    expect(unsafe).not.toContain('x; rm'); // unsafe id dropped entirely
    expect(unsafe).not.toContain('rm -rf');
    // falls back to the deterministic fresh-launch chain on the session's own id
    expect(unsafe).toContain('--session-id 1a2b3c4d5e6f');
  });

  it('forwards codex/gemini keys NAME-ONLY (no value in argv)', () => {
    const codex = buildDockerLaunchCommand(
      launchOpts({ mode: 'codex' as SessionMode, execEnvNames: ['OPENAI_API_KEY', 'CODEX_API_KEY'] })
    );
    expect(codex).toContain('--env OPENAI_API_KEY');
    expect(codex).not.toMatch(/--env OPENAI_API_KEY=/); // never a value
  });

  it('primes CODEMAN_SESSION_ID / CODEMAN_MUX at exec time', () => {
    const cmd = buildDockerLaunchCommand(launchOpts());
    expect(cmd).toContain("--env 'CODEMAN_SESSION_ID=1a2b3c4d'");
    expect(cmd).toContain("--env 'CODEMAN_MUX=1'");
  });

  it('keeps a workspace path with spaces a single token through every layer', () => {
    const docker = toSessionDocker(HOST, { ...CASE, hostWorkspacePath: '/home/arkon/my cases/proj' });
    const cmd = buildDockerLaunchCommand(launchOpts({ docker }));
    // workdir single-quoted at the docker exec layer
    expect(cmd).toContain("--workdir '/home/arkon/my cases/proj'");
    // and the cd inside the (nested-escaped) paneCommand still references the spaced path
    expect(cmd).toContain('/home/arkon/my cases/proj');
  });

  it('honors a per-host command override (exec stripped for the session-id chain)', () => {
    const docker = { ...toSessionDocker(HOST, CASE), commands: { claude: 'exec claude --model opus' } };
    const cmd = buildDockerLaunchCommand(launchOpts({ docker }));
    expect(cmd).toContain('claude --model opus --session-id 1a2b3c4d5e6f');
    const shellOverride = { ...toSessionDocker(HOST, CASE), commands: { shell: 'exec zsh -l' } };
    const shellCmd = buildDockerLaunchCommand(launchOpts({ mode: 'shell' as SessionMode, docker: shellOverride }));
    expect(shellCmd).toContain('exec zsh -l'); // non-claude overrides keep their exec
  });

  it('seeds writable config (guarded copies, mkdir -p parent) from the read-only seed mounts', () => {
    const cmd = buildDockerLaunchCommand(
      launchOpts({
        seedCopies: [
          { from: '/home/agent/.codeman/claude.seed.json', to: '/home/agent/.claude.json' },
          { from: '/home/agent/.codeman/claude-creds.seed.json', to: '/home/agent/.claude/.credentials.json' },
          // whole-dir credential seed → cp -a
          { from: '/home/agent/.codeman/cred-seeds/.gemini', to: '/home/agent/.gemini', recursive: true },
        ],
      })
    );
    // Each copy mkdir -p's its parent then is guarded so a reconnect never clobbers config.
    expect(cmd).toContain(
      'mkdir -p /home/agent 2>/dev/null; [ -e /home/agent/.claude.json ] || cp /home/agent/.codeman/claude.seed.json /home/agent/.claude.json'
    );
    expect(cmd).toContain(
      'mkdir -p /home/agent/.claude 2>/dev/null; [ -e /home/agent/.claude/.credentials.json ] || cp /home/agent/.codeman/claude-creds.seed.json /home/agent/.claude/.credentials.json'
    );
    // recursive whole-dir seed uses cp -a
    expect(cmd).toContain(
      '[ -e /home/agent/.gemini ] || cp -a /home/agent/.codeman/cred-seeds/.gemini /home/agent/.gemini'
    );
    expect(cmd.indexOf('.claude.json')).toBeLessThan(cmd.indexOf('tmux -L codeman-docker'));
  });

  it('omits the seed-copy step when there are no seedCopies', () => {
    const cmd = buildDockerLaunchCommand(launchOpts());
    expect(cmd).not.toContain('claude.seed.json');
  });
});

describe('buildDockerKillCommand (multi-session safe)', () => {
  it('kills ONLY this session in-container tmux, never the shared container', () => {
    const docker = toSessionDocker(HOST, CASE);
    const cmd = buildDockerKillCommand({ docker, sessionId: '1a2b3c4d5e6f' });
    expect(cmd).toBe("docker exec 'codeman-case-myproj' tmux -L codeman-docker kill-session -t 'codeman-dkr-1a2b3c4d'");
    expect(cmd).not.toContain('docker stop');
    expect(cmd).not.toContain('docker rm');
  });
});

describe('explicit teardown commands', () => {
  it('stop and remove target the whole container', () => {
    const docker = toSessionDocker(HOST, CASE);
    expect(buildDockerStopCommand(docker)).toBe("docker stop -t 10 'codeman-case-myproj'");
    expect(buildDockerRemoveCommand(docker)).toBe("docker rm -f 'codeman-case-myproj'");
  });

  it('uses the podman engine prefix when configured', () => {
    const docker = toSessionDocker({ ...HOST, engine: 'podman' }, CASE);
    expect(buildDockerStopCommand(docker)).toBe("podman stop -t 10 'codeman-case-myproj'");
  });
});
