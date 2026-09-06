/**
 * @fileoverview Session type definitions.
 *
 * Core domain type — SessionState is the primary entity in the system.
 *
 * Key exports:
 * - SessionState — full session state (status, tokens, respawn, ralph, CLI metadata)
 * - SessionConfig — creation-time config (id, workingDir, createdAt)
 * - SessionOutput — captured stdout/stderr/exitCode
 * - SessionStatus — 'idle' | 'busy' | 'stopped' | 'error'
 * - SessionMode — 'claude' | 'shell' | 'opencode' | 'codex' | 'gemini' | 'antigravity' | 'pi' | 'grok' | 'deepseek' | 'omp' (which CLI backend)
 * - ClaudeMode — CLI permission mode ('dangerously-skip-permissions' | 'auto' | 'normal' | 'allowedTools')
 * - SessionColor — visual differentiation color
 * - OpenCodeConfig — OpenCode-specific settings (model, autoAllowTools, continueSession)
 * - CodexConfig — Codex (OpenAI CLI)-specific settings (model, resumeSessionId)
 * - GeminiConfig — Gemini CLI-specific settings (model, approvalMode, resumeSession)
 * - AntigravityConfig — Antigravity CLI (agy) settings (model, dangerouslySkipPermissions, resumeConversationId)
 * - PiConfig — Pi CLI (pi.dev) settings (model, provider, thinking, resume/continue, project trust)
 * - GrokConfig — Grok Build CLI (xAI `grok`) settings (model, alwaysApprove, resume/continue)
 * - DeepSeekConfig — DeepSeek Harness (`dsh`) settings (profile, permissionMode, resume, status bridge)
 *
 * Cross-domain relationships:
 * - SessionState.respawnConfig embeds RespawnConfig (respawn domain)
 * - SessionState.id is referenced by: RalphSessionState.sessionId (ralph),
 *   RunSummary.sessionId (run-summary), ActiveBashTool.sessionId (tools),
 *   TeamConfig.leadSessionId (teams), RespawnCycleMetrics.sessionId (respawn),
 *   TaskState.assignedSessionId (task)
 *
 * Persisted to `~/.codeman/state.json`. Served at `GET /api/sessions` and
 * `GET /api/sessions/:id`.
 */

import type { RespawnConfig } from './respawn.js';
import type { AttachmentDetectedType } from './tools.js';

/** Status of a Claude session */
export type SessionStatus = 'idle' | 'busy' | 'stopped' | 'error';

/**
 * Claude CLI startup permission mode.
 * - `'dangerously-skip-permissions'`: Bypass all permission prompts (default)
 * - `'auto'`: Anthropic's classifier-guarded low-prompt mode (`--permission-mode auto`)
 * - `'normal'`: Standard mode with permission prompts
 * - `'allowedTools'`: Only allow specific tools (requires allowedTools list)
 */
export type ClaudeMode = 'dangerously-skip-permissions' | 'auto' | 'normal' | 'allowedTools';

/** Session mode: which CLI backend a session runs */
export type SessionMode =
  | 'claude'
  | 'shell'
  | 'opencode'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'pi'
  | 'grok'
  | 'deepseek'
  | 'omp';

/** Whether a session name may still be replaced by the first submitted prompt. */
export type SessionNameSource = 'auto' | 'manual';

export type RemoteCommandMode = Extract<
  SessionMode,
  'shell' | 'claude' | 'opencode' | 'codex' | 'gemini' | 'antigravity' | 'pi' | 'grok' | 'deepseek' | 'omp'
>;

/**
 * Advanced SSH connection options shared by RemoteHost and SessionRemote.
 *
 * COD-107 — all fields are optional; every field absent reproduces today's
 * behavior (port-22, default-identity, directly-SSH-able hosts). These describe
 * HOW Codeman reaches the host (identity, proxy, jump host, arbitrary `-o`),
 * letting it connect to e.g. a host fronted by a cloudflared SOCKS5 proxy on a
 * custom port — the same connection `ssh-aa-desktop` makes — without a wrapper.
 */
export interface RemoteSshOptions {
  /**
   * Path to an SSH identity (private key) file — path ONLY, never key bytes.
   * A leading `~`/`$HOME` is expanded to an absolute path at command-build time
   * (ssh does not expand `~` in `-i`).
   */
  identityFile?: string;
  /**
   * SOCKS5 proxy as `host:port` (e.g. `127.0.0.1:1080`). Expands to
   * `-o ProxyCommand=nc -X 5 -x <host:port> %h %p` (the cloudflared/SOCKS5 case).
   */
  socksProxy?: string;
  /** SSH jump host (`[user@]host[:port]`) emitted as `-J <jumpHost>`. */
  jumpHost?: string;
  /** Arbitrary additional `-o KEY=VALUE` options (escape hatch). Each `KEY=VALUE`. */
  extraSshOptions?: string[];
}

export interface RemoteHost extends RemoteSshOptions {
  id: string;
  label: string;
  host: string;
  username: string;
  port?: number;
  commands?: Partial<Record<RemoteCommandMode, string>>;
}

export interface RemoteCase {
  name: string;
  type: 'remote';
  /** Owning username in multi-user mode; absent = legacy/unassigned (admin-only). */
  owner?: string;
  hostId: string;
  remotePath: string;
}

export interface SessionRemote extends RemoteSshOptions {
  hostId: string;
  label: string;
  host: string;
  username: string;
  port?: number;
  remotePath: string;
  commands?: Partial<Record<RemoteCommandMode, string>>;
  /**
   * COD-105 — whether THIS Codeman created the remote tmux session.
   *
   * - `true` (default for COD-104 launched sessions): we own the remote session;
   *   an explicit "kill" may propagate a remote `tmux kill-session`.
   * - `false` (discovered + attached an existing remote session another Codeman
   *   created): closing the local tab must DETACH only — we must NEVER issue a
   *   remote `kill-session`, or we'd nuke work the remote's own Codeman (or
   *   another instance) still relies on. See `killSession()` gate.
   *
   * Absent is treated as owned (legacy/COD-104 sessions persisted before this
   * field existed were all launched by us).
   */
  owned?: boolean;
  /**
   * COD-105 — for a NON-owned (discovered + attached) session, the EXISTING
   * remote tmux session name to `attach -t` (e.g. `codeman-disco1`). It differs
   * from this Codeman's deterministic `codeman-<id>` name because the remote
   * session was created elsewhere. Only meaningful when `owned === false`.
   */
  remoteSessionName?: string;
}

/**
 * COD-105 — a `codeman-*` tmux session discovered on a remote host's
 * `tmux -L codeman` socket (may have been created by the remote's own Codeman,
 * another instance, or this one). Returned by `listRemoteCodemanSessions`.
 */
export interface RemoteSessionInfo {
  /** tmux session name (always starts `codeman-`). */
  name: string;
  /** Whether at least one client is currently attached to the remote session. */
  attached: boolean;
  /** COD-106 — number of clients attached (tmux `session_attached`); >1 = shared. */
  attachedClients: number;
  /** tmux `session_created` epoch seconds. */
  created: number;
  /** Number of windows in the remote session. */
  windows: number;
}

// ========== Docker cases (COD-Docker) ==========
//
// Docker mode is a LOCATION OVERLAY on cases (never a 6th SessionMode), the exact
// analog of the remote-SSH feature above: instead of a local tmux pane running
// `ssh host` into a durable remote tmux server, a local tmux pane runs
// `docker exec -it` into a durable in-container tmux server. The container is
// scoped to the CASE (not the session), so multiple sessions can `docker exec`
// into the same long-lived container. See `docs/docker-cases-plan.md`.

/** Which CLI backends a Docker case can run (same set as remote). */
export type DockerCommandMode = Extract<
  SessionMode,
  'shell' | 'claude' | 'opencode' | 'codex' | 'gemini' | 'antigravity' | 'pi' | 'grok' | 'deepseek' | 'omp'
>;

/** Container engine. Docker and Podman differ in the uid/userns + host-gateway alias. */
export type DockerEngine = 'docker' | 'podman';

/**
 * Container network mode. `host` and any inbound `-p` publish are deliberately
 * unrepresentable (never in this union, never emitted by the flag builder).
 * - `bridge`: own netns, NAT egress, no inbound (default — every API CLI needs egress)
 * - `none`: fully offline sandbox (breaks API CLIs; reserved for `shell`)
 * - `custom`: a user-defined bridge `codeman-net-<slug>` (future egress-allowlist chokepoint)
 */
export type DockerNetworkMode = 'bridge' | 'none' | 'custom';

/** Per-container resource caps. Advisory under non-delegated rootless (see `capsEnforced`). */
export interface DockerResourceLimits {
  /** e.g. '4g' -> --memory 4g --memory-swap 4g (swap==memory: a real OOM cap) */
  memory?: string;
  /** e.g. '2' -> --cpus 2 */
  cpus?: string;
  /** e.g. 512 -> --pids-limit 512 (fork-bomb guard) */
  pidsLimit?: number;
  /** e.g. '4096:8192' -> --ulimit nofile=4096:8192 */
  nofile?: string;
  /** e.g. '256m' -> --shm-size (only when a tool needs /dev/shm) */
  shmSize?: string;
}

/** A reusable Docker engine/image/network/resource profile (mirror of RemoteHost). */
export interface DockerHost {
  id: string;
  label: string;
  /** Engine; when absent the availability probe resolves it (docker, else podman). */
  engine?: DockerEngine;
  /** Base image ref (built locally by scripts/build-agent-image.mjs, e.g. codeman/agent:base). */
  image: string;
  /** Advanced: remote daemon (-H ssh://user@host or a DOCKER_HOST value). */
  daemonHost?: string;
  /** Advanced: docker `--context` name. */
  context?: string;
  /** Network mode (default 'bridge'). */
  network?: DockerNetworkMode;
  /** Custom bridge name when network === 'custom'. */
  networkName?: string;
  resources?: DockerResourceLimits;
  /** GPU allocation, e.g. 'all' / '1' / 'device=0,1' -> `--gpus <value>` (needs the NVIDIA container toolkit). */
  gpus?: string;
  /** true (default) = convenient: bind-mount host cred dirs RW. false = sealed (blocks full-image export). */
  mountCredentials?: boolean;
  /** true (default) = wire in-container hooks (host-gateway callback + workspace scaffold). */
  hooksEnabled?: boolean;
  /** true (default) = a relaunch resumes the last conversation from the bind-mounted transcript. */
  resumeOnStart?: boolean;
  /** Per-mode command overrides (mirror RemoteHost.commands). */
  commands?: Partial<Record<DockerCommandMode, string>>;
  /** Escape hatch: extra `docker create` args (validated like extraSshOptions). */
  extraCreateArgs?: string[];
  /** Escape hatch: extra `docker exec` args. */
  extraExecArgs?: string[];
}

/** A case linked to a Docker container (mirror of RemoteCase). */
export interface DockerCase {
  name: string;
  type: 'docker';
  /** Owning username in multi-user mode; absent = legacy/unassigned (admin-only). */
  owner?: string;
  hostId: string;
  /** Absolute HOST directory: the bind-mount source AND Session.workingDir (real host bytes). */
  hostWorkspacePath: string;
  /** Container path (default = hostWorkspacePath: mirror -> transcript projHash correlates). */
  containerWorkdir?: string;
  /** Container name (default codeman-case-<slug>). */
  container?: string;
  /**
   * Whether THIS Codeman created the container (mirror of `SessionRemote.owned`).
   *
   * - `true` (default for cases Codeman linked/quick-created): we own the
   *   container; drift may recreate it, case-delete may `docker rm -f` it, and
   *   the launch chain may create + start it.
   * - `false` (ADOPTED: an already-running container the user built and runs
   *   themselves): Codeman must never create, start, stop, restart or remove it.
   *   The launch chain fails closed when the container is missing or not running
   *   instead of touching its lifecycle, drift is not evaluated (there is no
   *   `codeman.confighash` label to compare), and no credential seed is copied
   *   into its HOME. Only the in-container tmux session is ever created or
   *   killed — exactly the `owned:false` remote-SSH contract.
   *
   * Absent is treated as owned (cases persisted before this field existed were
   * all created by us).
   */
  owned?: boolean;
  /**
   * CLIs found INSIDE the container by the adoption preflight. A container case
   * runs its agents in the container, so host CLI availability says nothing about
   * what this case can run — the base image ships every CLI, and an adopted
   * container ships whatever its owner installed. Absent = unknown (owned cases,
   * or a case linked before this field existed), which callers read as "do not
   * gate".
   */
  availableModes?: SessionMode[];
  /** Last captured Claude conversation id, replayed via --resume on a fresh launch. */
  lastClaudeSessionId?: string;
}

/**
 * Flattened Docker execution metadata carried on a live session (mirror of
 * SessionRemote). Round-trips through MuxSession/SessionState/mux-sessions.json.
 */
export interface SessionDocker {
  hostId: string;
  label: string;
  engine: DockerEngine;
  image: string;
  /** Per-CASE container name (shared by all sessions of the case). */
  containerName: string;
  hostWorkspacePath: string;
  containerWorkdir: string;
  network: DockerNetworkMode;
  networkName?: string;
  resources?: DockerResourceLimits;
  /** GPU allocation ('all' / '1' / 'device=0,1'). */
  gpus?: string;
  mountCredentials: boolean;
  hooksEnabled: boolean;
  resumeOnStart: boolean;
  daemonHost?: string;
  context?: string;
  commands?: Partial<Record<DockerCommandMode, string>>;
  extraCreateArgs?: string[];
  extraExecArgs?: string[];
  /** Stable hash of the drift-relevant create args (recreate-on-drift detection). */
  configHash?: string;
  /**
   * Whether the container's exec user is root. Claude Code REFUSES
   * `--dangerously-skip-permissions` as root, and an adopted container's user
   * belongs to its owner, so the flag is omitted rather than letting the pane
   * die with a message only visible inside the container.
   */
  runsAsRoot?: boolean;
  /**
   * Mirror of `DockerCase.owned`, flattened onto the live session so every
   * lifecycle decision (launch chain, drift, stop, remove) can see it without
   * re-reading docker-cases.json. Absent = owned. See `DockerCase.owned`.
   */
  owned?: boolean;
}

/**
 * Valid Claude CLI effort levels (claude >= 2.1.154).
 * `ultracode` = xhigh effort + standing dynamic-workflow orchestration; it is a
 * separate `ultracode` settings key rather than an `effortLevel` value.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;

/** Claude CLI effort level for new sessions (soft default, switchable via /effort in-session) */
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Type guard: is the string a valid EffortLevel? */
export function isEffortLevel(value: string | undefined): value is EffortLevel {
  return value !== undefined && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** OpenCode session configuration */
export interface OpenCodeConfig {
  /** Model identifier (e.g., "anthropic/claude-sonnet-4-5", "openai/gpt-5.2", "ollama/codellama") */
  model?: string;
  /** Whether to auto-allow all tool executions (sets permission.* = allow) */
  autoAllowTools?: boolean;
  /** Session ID to continue from */
  continueSession?: string;
  /** Whether to fork when continuing (branch the conversation) */
  forkSession?: boolean;
  /** Custom inline config JSON (passed via OPENCODE_CONFIG_CONTENT) */
  configContent?: string;
}

/** Codex (OpenAI CLI) browser rendering strategy. Hybrid TUI is the only supported mode. */
export type CodexRenderMode = 'hybrid';

/** Codex (OpenAI CLI) session configuration */
export interface CodexConfig {
  /** Model identifier (e.g., "gpt-5", "o4-mini"). Passed via --model. */
  model?: string;
  /** Resume a previous codex conversation by session id (passed via --resume) */
  resumeSessionId?: string;
  /** Bypass approval prompts (passes --dangerously-bypass-approvals-and-sandbox) */
  dangerouslyBypassApprovals?: boolean;
  /** Enable Codex's decorative TUI animations. Disable to reduce remote terminal redraws. */
  animations?: boolean;
  /** Browser rendering strategy for Codex sessions. Hybrid TUI is the only supported mode. */
  renderMode?: CodexRenderMode;
}

/** Gemini CLI session configuration */
export interface GeminiConfig {
  /** Model identifier (e.g., "gemini-2.5-pro"). Passed via --model. */
  model?: string;
  /** Gemini approval mode for tool calls. */
  approvalMode?: 'default' | 'auto_edit' | 'yolo' | 'plan';
  /** Resume a previous Gemini session ("latest", index, or session id). */
  resumeSession?: string;
}

/** Antigravity CLI (agy) session configuration */
export interface AntigravityConfig {
  /** Model identifier. Passed via --model. */
  model?: string;
  /** Auto-approve all tool permission requests (passes --dangerously-skip-permissions). Absent = agy's default prompting. */
  dangerouslySkipPermissions?: boolean;
  /** Resume a previous conversation by ID (passed via --conversation). */
  resumeConversationId?: string;
}

/** OMP CLI session configuration */
export interface OmpConfig {
  /** Model identifier (e.g., "crof/glm-5.2"). Passed via --model. */
  model?: string;
  /** Resume a previous conversation (passed via --resume). */
  resumeSessionId?: string;
  /** Continue the most recent session in this directory (passed via --continue). */
  continueSession?: boolean;
}

/**
 * Pi CLI (pi.dev) session configuration.
 *
 * Pi has NO permission prompts and no `--dangerously-skip-permissions` analog,
 * so there is deliberately no bypass field here. The one privilege-shaped knob is
 * `approveProjectTrust`, which controls whether pi loads and EXECUTES repo-local
 * `.pi/` extensions (and installs missing project packages).
 */
export interface PiConfig {
  /** Model pattern or ID. Supports `provider/id` and a `:<thinking>` suffix (e.g. `sonnet:high`). Passed via --model. */
  model?: string;
  /** Provider name (anthropic, openai, google, ...). Passed via --provider. */
  provider?: string;
  /** Reasoning level. Passed via --thinking. */
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Continue the most recent session (-c). Skipped when resumeSessionId is set (the two conflict). */
  continueSession?: boolean;
  /** Resume a specific session by ID or partial UUID (--session). Ids only, never paths. */
  resumeSessionId?: string;
  /**
   * Tri-state project trust (repo-local `.pi/` settings/extensions/skills, plus
   * installing missing project packages):
   *   true   -> --approve    (trust for this run; loads and EXECUTES repository TypeScript)
   *   false  -> --no-approve (force-deny; the trust prompt never appears)
   *   absent -> pi's own defaultProjectTrust (ask).
   * Multi-user: MATERIALIZED to false for non-granted owners, because pi's
   * absent-config default is a prompt the session user could answer themselves.
   */
  approveProjectTrust?: boolean;
}

/**
 * Grok Build CLI (xAI `grok`) session configuration.
 *
 * Grok has Claude-style permission modes; the bypass switch is `--always-approve`
 * ("auto-approve all tool executions", the CLI's `bypassPermissions` mode). Deny
 * rules from `~/.grok/config.toml` / project `.grok/config.toml` still apply on
 * top of it. Verified against grok 1.0.5.
 */
export interface GrokConfig {
  /** Model ID (e.g. "grok-4.5", or a custom `[model.<name>]` from config.toml). Passed via --model. */
  model?: string;
  /**
   * Auto-approve all tool executions (passes --always-approve). Absent = grok's
   * own default permission mode (ask). Multi-user: forced off for non-granted
   * owners by the only-if-sent clamp branch, like codex/antigravity — the
   * absent-config spawn already defaults safe.
   */
  alwaysApprove?: boolean;
  /** Continue the most recent session for the working directory (-c). Skipped when resumeSessionId is set. */
  continueSession?: boolean;
  /** Resume a specific session by ID (--resume). Ids only, never titles or paths. */
  resumeSessionId?: string;
}

/**
 * DeepSeek Harness (`dsh`) session configuration.
 *
 * Two things make this config shaped unlike every sibling above it.
 *
 * **1. The agent is a PROFILE, not the binary.** `dsh` is a launcher: it boots
 * `$DSH_HOME/profiles/<name>`, an ordered stack of plugin-bundle patch layers.
 * DeepSeek ships only `web`, `headless` and `base`, so the interactive terminal
 * agent is always a third-party profile the user installed. `profile` is
 * therefore the primary knob, and an absent one resolves to the first
 * pane-capable profile found (see resolveDefaultDeepSeekProfile).
 *
 * **2. Permissions are an ENV VAR, not a flag.** The harness has no
 * `--dangerously-skip-permissions` equivalent; its sandbox and approval rows are
 * config, driven by one documented input, `DSH_PERMISSION_MODE`, with three
 * presets (measured from `dsh --dump-default-config`):
 *
 *   read-only          sandbox read-only,          approval ask
 *   workspace-write    sandbox workspace-write,    approval ask     <- default
 *   danger-full-access sandbox danger-full-access, approval never
 *
 * This is the one place a Codeman env export is the RIGHT mechanism rather than
 * the forbidden one: unlike `CLAUDE_CODE_EFFORT_LEVEL` (which hard-locks
 * in-session `/effort`), `DSH_PERMISSION_MODE` is read with `??` as a boot-time
 * DEFAULT, so it stays a soft default the user can still change in-session. It
 * is exported via `tmux setenv`, never on the spawn command line.
 */
export interface DeepSeekConfig {
  /**
   * Profile under `$DSH_HOME/profiles` to boot (`dsh --profile <name>`). Absent
   * = the first pane-capable profile installed. A `web`/`headless` profile is
   * refused at spawn time: neither can drive an interactive pane.
   */
  profile?: string;
  /**
   * Sandbox + approval preset, exported as `DSH_PERMISSION_MODE`. Absent = the
   * harness's own `workspace-write` default, which still ASKS — which is why the
   * multi-user clamp only needs the only-if-sent branch here, like
   * codex/antigravity/grok rather than pi.
   */
  permissionMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Resume the most recent session for this workspace (`--resume`). */
  resumeSession?: boolean;
  /** Resume a specific session by ID (`--resume <id>`). Wins over resumeSession. */
  resumeSessionId?: string;
  /**
   * Report idle/working/blocked back to Codeman through the Herdr-compatible
   * status shim (see `deepseek-status-shim.ts`). Default ON: it upgrades this
   * mode from output-stabilization guessing to definitive hook events. Only
   * TUIs that implement the contract report; for one that does not, this is
   * inert rather than harmful.
   */
  statusReporting?: boolean;
}

/**
 * Configuration for creating a new session
 */
export interface SessionConfig {
  /** Unique session identifier */
  id: string;
  /** Working directory for the session */
  workingDir: string;
  /** Timestamp when session was created */
  createdAt: number;
}

/**
 * Available session colors for visual differentiation
 */
export type SessionColor = 'default' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink';

export type SessionAttachmentHistorySource = 'detected' | 'external';

/**
 * Session-scoped attachment history entry.
 *
 * `externalPath` is server-private. It may be present in the internal persisted
 * history copy, but API-bound session state must sanitize it before returning
 * to the browser.
 */
export interface SessionAttachmentHistoryItem {
  /** Stable history identity used for dedupe and list rendering */
  id: string;
  /** Codeman session ID this item belongs to */
  sessionId: string;
  /** Display filename */
  fileName: string;
  /** Lowercase extension without a leading dot */
  extension: string;
  /** Viewer category used by the web UI */
  attachmentType: AttachmentDetectedType;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp in milliseconds, if known */
  mtimeMs: number;
  /** Last time this attachment was seen or explicitly published */
  timestamp: number;
  /** How the attachment entered the session */
  source: SessionAttachmentHistorySource;
  /** Workspace-relative path for detected session files */
  relativePath?: string;
  /** Server-private absolute path for explicitly published external files */
  externalPath?: string;
}

/**
 * Current state of a session
 */
export interface SessionState {
  /** Unique session identifier */
  id: string;
  /** Process ID of the PTY process, null if not running */
  pid: number | null;
  /** Current session status */
  status: SessionStatus;
  /** Working directory path */
  workingDir: string;
  /** Remote execution metadata, present when this session runs over SSH through local tmux */
  remote?: SessionRemote;
  /** Docker execution metadata, present when this session runs inside a container via local tmux + docker exec */
  docker?: SessionDocker;
  /** Owning username in multi-user mode; undefined in single-user (ignored when the flag is off) */
  owner?: string;
  /**
   * The Codeman session that spawned this one, supplied by the caller at create time
   * (`parentSessionId` body field or the `X-Codeman-Parent-Session` header) and resolved
   * against live sessions before being stored.
   *
   * ⚠️ UI DECORATION ONLY — it draws the lineage lines between tabs. It is never an
   * ownership, permission, or lifecycle signal: a child outlives its parent, and an
   * unresolvable value is dropped rather than failing the spawn.
   */
  parentSessionId?: string;
  /** ID of currently assigned task, null if none */
  currentTaskId: string | null;
  /** Timestamp when session was created */
  createdAt: number;
  /** Timestamp of last activity */
  lastActivityAt: number;
  /** Session display name */
  name?: string;
  /** Name ownership; auto names are replaced after the first real prompt. */
  nameSource?: SessionNameSource;
  /** Session mode */
  mode?: SessionMode;
  /** Auto-clear enabled */
  autoClearEnabled?: boolean;
  /** Auto-clear token threshold */
  autoClearThreshold?: number;
  /** Auto-compact enabled */
  autoCompactEnabled?: boolean;
  /** Auto-compact token threshold */
  autoCompactThreshold?: number;
  /** Auto-compact prompt */
  autoCompactPrompt?: string;
  /** Auto-resume on usage limit enabled */
  autoResumeEnabled?: boolean;
  /** Pending usage-limit auto-resume fire time (epoch ms), if armed */
  autoResumeAt?: number;
  /** Pinned to the top of the session manager list (COD-139) */
  pinned?: boolean;
  /** When the session was pinned (epoch ms) — orders the pinned group, most-recent-first */
  pinnedAt?: number;
  /** Image watcher enabled for this session */
  imageWatcherEnabled?: boolean;
  /** Total cost in USD */
  totalCost?: number;
  /** Input tokens used */
  inputTokens?: number;
  /** Output tokens used */
  outputTokens?: number;
  /** Whether respawn controller is currently enabled/running */
  respawnEnabled?: boolean;
  /** Respawn controller config (if enabled) */
  respawnConfig?: RespawnConfig & { durationMinutes?: number };
  /** Ralph / Todo tracker enabled */
  ralphEnabled?: boolean;
  /** Ralph auto-enable disabled (user explicitly turned off Ralph) */
  ralphAutoEnableDisabled?: boolean;
  /** Ralph completion phrase (if set) */
  ralphCompletionPhrase?: string;
  /** Parent agent ID if this session is a spawned agent */
  parentAgentId?: string;
  /** Child agent IDs spawned by this session */
  childAgentIds?: string[];
  /** Nice priority enabled */
  niceEnabled?: boolean;
  /** Nice value (-20 to 19) */
  niceValue?: number;
  /** User-assigned color for visual differentiation */
  color?: SessionColor;
  /** Flicker filter enabled (buffers output after screen clears) */
  flickerFilterEnabled?: boolean;
  /**
   * True while the CLI in the pane has a mouse-tracking DECSET on, as observed
   * by the server on its way out of the stream (those sequences are stripped for
   * claude/codex/gemini, so the browser can never see them itself). The browser
   * hand-encodes a click report ONLY when this is true; without it, every click
   * sent mouse reports to a CLI that never asked for them.
   */
  cliMouseTracking?: boolean;
  /** Claude Code CLI version (parsed from terminal, e.g., "2.1.27") */
  cliVersion?: string;
  /** Claude model in use (parsed from terminal, e.g., "Opus 4.5") */
  cliModel?: string;
  /** Account type (parsed from terminal, e.g., "Claude Max", "API") */
  cliAccountType?: string;
  /** Latest CLI version available (parsed from version check) */
  cliLatestVersion?: string;
  /** OpenCode-specific configuration (only for mode === 'opencode') */
  openCodeConfig?: OpenCodeConfig;
  /** Codex-specific configuration (only for mode === 'codex') */
  codexConfig?: CodexConfig;
  /** Gemini-specific configuration (only for mode === 'gemini') */
  geminiConfig?: GeminiConfig;
  /** Antigravity-specific configuration (only for mode === 'antigravity') */
  antigravityConfig?: AntigravityConfig;
  /** Pi-specific configuration (only for mode === 'pi') */
  piConfig?: PiConfig;
  /** Grok-specific configuration (only for mode === 'grok') */
  grokConfig?: GrokConfig;
  /** DeepSeek Harness configuration (only for mode === 'deepseek') */
  deepSeekConfig?: DeepSeekConfig;
  /** OMP-specific configuration (only for mode === 'omp') */
  ompConfig?: OmpConfig;
  /** Claude conversation session ID to resume after reboot (set by restore script) */
  resumeSessionId?: string;
  /** Claude CLI effort level (soft default via --settings, switchable in-session via /effort) */
  effort?: EffortLevel;
  /** Sanitized per-session attachment history. */
  attachmentHistory?: SessionAttachmentHistoryItem[];
  /**
   * Wall-clock ms of this pane's last Enter (Session.lastSubmitAt). Persisted
   * because it is the response-viewer's only anchor for re-deriving the pane's
   * live conversation after a Codeman restart: `start()` resets
   * `claudeSessionId` to the launch id even when re-attaching to a mux session
   * whose CLI has since moved on via `/clear`, and the correlation cannot run
   * again until the pane's own Enter is known.
   */
  lastSubmitAt?: number;
  /**
   * PTY-exit circuit breaker tripped — respawn blocked until an explicit restart
   * (COD-118). Runtime-only: never restored on boot (fresh server = fresh breaker).
   */
  respawnBlocked?: boolean;
}

/**
 * Output captured from a session
 */
