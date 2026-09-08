/**
 * @fileoverview The shipped stock catalog — one `CliEntry` per CLI Codeman supports out of
 * the box, transcribed to be byte-identical (via the argv engine) to the hand-written
 * builders in tmux-manager.ts that they replace.
 *
 * This is the ONE file allowed to know a CLI's id by name (`test/cli-registry-no-id-branching
 * .test.ts` enforces that nowhere else does). Everything downstream — session.ts,
 * tmux-manager.ts, the routes, the frontend — reads capability flags, never `entry.id ===`.
 *
 * @module config/cli-registry/stock
 */

import type { CliEntry } from './types.js';

const HOME_DIRS = {
  local: '~/.local/bin',
  usrLocal: '/usr/local/bin',
  bunBin: '~/.bun/bin',
  npmGlobal: '~/.npm-global/bin',
  homeBin: '~/bin',
};

const NO_GATES = {};
const NO_PRIVILEGED_PARAMS: CliEntry['capabilities']['privilegedParams'] = [];
/**
 * The common case: every CLI whose privileged switch is a command-line FLAG, reachable
 * only through its own config object and therefore already covered by `privilegedParams`.
 * DeepSeek is the sole exception — its switch is an env var. See CliCapabilities.
 */
const NO_PRIVILEGED_ENV_KEYS: CliEntry['capabilities']['privilegedEnvKeys'] = [];

/** Shared skeleton for the "agent CLI, no unusual behaviour" case (pi's own shape). */
function agentDefaults(): Pick<
  CliEntry['capabilities'],
  | 'external'
  | 'requiresMux'
  | 'hooks'
  | 'transcript'
  | 'altScreen'
  | 'wheelForward'
  | 'keyboardAccessory'
  | 'privilegedCommandGate'
  | 'startMode'
  | 'stripInkBloat'
  | 'ralph'
  | 'respawn'
  | 'effort'
  | 'agentSkillInjection'
  | 'statusLineTelemetry'
  | 'model'
  | 'privilegedParams'
  | 'privilegedEnvKeys'
  | 'gates'
> {
  return {
    external: true,
    requiresMux: true,
    hooks: 'none',
    transcript: 'none',
    altScreen: 'strip-mux-only',
    wheelForward: { mode: 'never' },
    keyboardAccessory: 'agent',
    privilegedCommandGate: false,
    startMode: 'interactive',
    stripInkBloat: true,
    ralph: false,
    respawn: false,
    effort: false,
    agentSkillInjection: false,
    statusLineTelemetry: false,
    model: { source: 'flag', param: 'model' },
    privilegedParams: NO_PRIVILEGED_PARAMS,
    privilegedEnvKeys: NO_PRIVILEGED_ENV_KEYS,
    gates: NO_GATES,
  };
}

const CLAUDE: CliEntry = {
  id: 'claude' as CliEntry['id'],
  label: 'Claude',
  shortBadge: 'CC',
  accent: '#d97757',
  enabled: true,
  stock: true,
  order: 0,
  kind: 'agent',
  discovery: {
    binaries: ['claude'],
    searchDirs: [HOME_DIRS.local, '~/.claude/local', HOME_DIRS.usrLocal, HOME_DIRS.npmGlobal, HOME_DIRS.homeBin],
    version: { arg: '--version', regex: '(\\d+\\.\\d+\\.\\d+)', retryOnTransientFailure: true },
    install: {
      command: {
        linux: 'curl -fsSL https://claude.ai/install.sh | bash',
        darwin: 'curl -fsSL https://claude.ai/install.sh | bash',
        wsl: 'curl -fsSL https://claude.ai/install.sh | bash',
      },
      npmPackage: '@anthropic-ai/claude-code',
      docsUrl: 'https://docs.claude.com/claude-code',
    },
  },
  launch: {
    chain: 'fallback',
    params: {
      claudeMode: {
        type: 'enum',
        values: ['dangerously-skip-permissions', 'auto', 'normal', 'allowedTools'],
        default: 'dangerously-skip-permissions',
      },
      allowedTools: { type: 'token', pattern: 'tool-list' },
      model: { type: 'token', pattern: 'model-claude' },
      resumeId: { type: 'token', pattern: 'uuid' },
      // buildEffortCliArgs carries `ultracode` as a settings JSON blob and every other
      // level as a plain `--effort <level>` flag — two engine values because the two
      // shapes are mutually exclusive and neither is user-typed text (both are produced
      // from the EFFORT_LEVELS allowlist upstream, same as every other engine value).
      effortLevel: { type: 'engine', source: 'effortLevel' },
      effortJson: { type: 'engine', source: 'effortSettingsJson' },
      sessionId: { type: 'engine', source: 'sessionId' },
      sessionName: { type: 'engine', source: 'sessionName' },
    },
    variants: [
      {
        id: 'resume',
        when: { param: 'resumeId', state: 'set' },
        args: [
          { lit: 'claude' },
          { flag: '--dangerously-skip-permissions', when: { param: 'claudeMode', is: 'dangerously-skip-permissions' } },
          { flag: '--permission-mode', value: 'auto', when: { param: 'claudeMode', is: 'auto' } },
          {
            flag: '--allowedTools',
            valueFrom: 'allowedTools',
            quote: 'double',
            when: {
              allOf: [
                { param: 'claudeMode', is: 'allowedTools' },
                { param: 'allowedTools', state: 'set' },
              ],
            },
          },
          { flag: '--resume', valueFrom: 'resumeId', quote: 'double' },
          { flag: '--model', valueFrom: 'model', quote: 'double', when: { param: 'model', state: 'set' } },
          { flag: '--effort', valueFrom: 'effortLevel', quote: 'single', when: { param: 'effortLevel', state: 'set' } },
          { flag: '--settings', valueFrom: 'effortJson', quote: 'single', when: { param: 'effortJson', state: 'set' } },
          { flag: '--name', valueFrom: 'sessionName', quote: 'double', when: { capabilityGate: 'nameFlag' } },
        ],
      },
      {
        id: 'new',
        args: [
          { lit: 'claude' },
          { flag: '--dangerously-skip-permissions', when: { param: 'claudeMode', is: 'dangerously-skip-permissions' } },
          { flag: '--permission-mode', value: 'auto', when: { param: 'claudeMode', is: 'auto' } },
          {
            flag: '--allowedTools',
            valueFrom: 'allowedTools',
            quote: 'double',
            when: {
              allOf: [
                { param: 'claudeMode', is: 'allowedTools' },
                { param: 'allowedTools', state: 'set' },
              ],
            },
          },
          { flag: '--session-id', valueFrom: 'sessionId', quote: 'double' },
          { flag: '--model', valueFrom: 'model', quote: 'double', when: { param: 'model', state: 'set' } },
          { flag: '--effort', valueFrom: 'effortLevel', quote: 'single', when: { param: 'effortLevel', state: 'set' } },
          { flag: '--settings', valueFrom: 'effortJson', quote: 'single', when: { param: 'effortJson', state: 'set' } },
          { flag: '--name', valueFrom: 'sessionName', quote: 'double', when: { capabilityGate: 'nameFlag' } },
        ],
      },
    ],
    // Claude has no `<Mode>Config` object of its own — the bridge synthesizes one from its
    // discrete top-level spawn fields, under their EXISTING field name `resumeSessionId`.
    legacyConfigAliases: { resumeId: 'resumeSessionId' },
  },
  env: {
    exports: [],
    unset: ['CLAUDECODE', 'COLORTERM'],
    tmuxSetenvKeys: [],
    dockerExecEnvNames: [],
    allowedPrefixes: ['CLAUDE_CODE_'],
    allowedKeys: ['CLAUDE_CONFIG_DIR'],
  },
  capabilities: {
    external: false,
    // The historical hard-coded pair, now stated as data. `workingLine` matches both the
    // `✻ Actualizing… (39s · ↓ 2.0k tokens)` status line and the bare `esc to interrupt`
    // footer, because tmux repaints partially and only one of the two may land in a chunk.
    workDetect: {
      promptGlyph: '❯',
      workingLine: String.raw`…\s*\((?:\d+h\s+)?(?:\d+m\s+)?\d+s\b|esc to interrupt`,
    },
    requiresMux: false,
    // Claude installs Codeman's own hooks block into every workspace it runs in, so its
    // stop/idle signals are unconditional — no per-session veto, unlike deepseek's bridge.
    hooks: 'always',
    transcript: 'claude-jsonl',
    altScreen: 'strip-full',
    echo: { policy: 'buffer', anchor: { kind: 'glyph', glyph: '❯', offset: 2 } },
    wheelForward: { mode: 'version-gated', minVersion: '2.1.187' },
    keyboardAccessory: 'agent',
    privilegedCommandGate: false,
    startMode: 'interactive',
    stripInkBloat: true,
    ralph: true,
    respawn: true,
    effort: true,
    agentSkillInjection: true,
    statusLineTelemetry: true,
    model: { source: 'claude-settings-file' },
    privilegedParams: [],
    privilegedEnvKeys: [],
    gates: { nameFlag: { minVersion: '2.1.224', failClosed: true } },
  },
  overlays: {
    // Mirrors the local default so the remote/in-container agent runs non-interactively
    // (no trust-folder/permission prompt that nothing on that side can answer). A per-host
    // `commands.claude` override, or the docker multi-user clamp, stays the escape hatch.
    remote: { command: 'claude --dangerously-skip-permissions' },
    // ⚠️ As root the flag is not merely unnecessary, it is REFUSED ("cannot be used with
    // root/sudo privileges"), and only inside the container — so an adopted root container
    // would just show a dead pane. Drop it there and let claude ask.
    docker: { command: 'claude --dangerously-skip-permissions', rootCommand: 'claude' },
    // Claude's docker/remote credential handling has its own dedicated code path
    // (claudeDockerPaneCommand, artifacts at docker-hosts.ts:537-575) — no generic credStore.
  },
};

const SHELL: CliEntry = {
  id: 'shell' as CliEntry['id'],
  label: 'Shell',
  shortBadge: 'SH',
  accent: '#6b7280',
  enabled: true,
  stock: true,
  order: 1,
  kind: 'shell',
  discovery: {
    binaries: [],
    searchDirs: [],
    install: { command: {} },
  },
  launch: {
    params: {},
    variants: [{ id: 'shell', args: [] }], // tmux-manager resolves the real login shell in code
  },
  env: {
    exports: [],
    unset: ['COLORTERM'],
    tmuxSetenvKeys: [],
    dockerExecEnvNames: [],
    allowedPrefixes: [],
    allowedKeys: [],
  },
  capabilities: {
    external: false,
    requiresMux: false,
    // ⚠️ `false` here while `external` is ALSO false is the pairing that matters: a shell
    // has no hooks but is not an "external CLI", so a predicate derived from `external`
    // once accepted `until=stop` on a shell session and hung for the full timeout.
    hooks: 'none',
    transcript: 'none',
    altScreen: 'preserve',
    echo: { policy: 'off', anchor: { kind: 'none' } },
    wheelForward: { mode: 'never' },
    keyboardAccessory: 'shell',
    privilegedCommandGate: true,
    startMode: 'shell',
    stripInkBloat: false,
    ralph: false,
    respawn: false,
    effort: false,
    agentSkillInjection: false,
    statusLineTelemetry: false,
    model: { source: 'none' },
    privilegedParams: [],
    privilegedEnvKeys: [],
    gates: {},
  },
  overlays: {
    // No `remote` entry: defaultRemoteCommandForMode special-cases kind==='shell' directly
    // (an interactive login shell, no `-c '<command>'` wrapping at all).
    docker: { disabled: true },
  },
};

const OPENCODE: CliEntry = {
  id: 'opencode' as CliEntry['id'],
  label: 'OpenCode',
  shortBadge: 'OC',
  accent: '#f59e0b',
  enabled: true,
  stock: true,
  order: 10,
  kind: 'agent',
  discovery: {
    binaries: ['opencode'],
    searchDirs: [
      '~/.opencode/bin',
      HOME_DIRS.local,
      HOME_DIRS.usrLocal,
      '~/go/bin',
      HOME_DIRS.bunBin,
      HOME_DIRS.npmGlobal,
      HOME_DIRS.homeBin,
    ],
    version: { arg: '--version', regex: '(\\d+\\.\\d+\\.\\d+)' },
    install: {
      command: {
        linux: 'curl -fsSL https://opencode.ai/install | bash',
        darwin: 'curl -fsSL https://opencode.ai/install | bash',
      },
      npmPackage: 'opencode-ai',
      docsUrl: 'https://opencode.ai/docs',
    },
  },
  launch: {
    params: {
      model: { type: 'token', pattern: 'model' },
      resumeId: { type: 'token', pattern: 'id' },
      forkSession: { type: 'bool' },
    },
    variants: [
      {
        id: 'default',
        args: [
          { lit: 'opencode' },
          { flag: '--model', valueFrom: 'model', when: { param: 'model', state: 'set' } },
          { flag: '--session', valueFrom: 'resumeId', when: { param: 'resumeId', state: 'set' } },
          {
            flag: '--fork',
            when: {
              allOf: [
                { param: 'resumeId', state: 'set' },
                { param: 'forkSession', is: true },
              ],
            },
          },
        ],
      },
    ],
    legacyConfigAliases: { resumeId: 'continueSession' },
    legacyConfigField: 'openCodeConfig',
  },
  env: {
    exports: [],
    unset: ['COLORTERM'],
    tmuxSetenvKeys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'],
    dockerExecEnvNames: [],
    allowedPrefixes: ['OPENCODE_'],
    allowedKeys: [],
    configContentVar: 'OPENCODE_CONFIG_CONTENT',
  },
  capabilities: {
    ...agentDefaults(),
    altScreen: 'strip-mux-only',
    echo: { policy: 'buffer', anchor: { kind: 'cursor' }, predictProfile: undefined },
  },
  overlays: {
    credStore: { rel: '.config/opencode', seedWhole: true },
  },
};

const CODEX: CliEntry = {
  id: 'codex' as CliEntry['id'],
  label: 'Codex',
  shortBadge: 'CX',
  accent: '#6b7fd7',
  enabled: true,
  stock: true,
  order: 20,
  kind: 'agent',
  discovery: {
    binaries: ['codex'],
    searchDirs: [
      '~/.codex/bin',
      HOME_DIRS.local,
      HOME_DIRS.usrLocal,
      HOME_DIRS.bunBin,
      HOME_DIRS.npmGlobal,
      HOME_DIRS.homeBin,
    ],
    version: { arg: '--version', regex: '(\\d+\\.\\d+\\.\\d+)' },
    install: {
      command: { linux: 'npm install -g @openai/codex', darwin: 'npm install -g @openai/codex' },
      npmPackage: '@openai/codex',
      docsUrl: 'https://developers.openai.com/codex/cli',
    },
  },
  launch: {
    params: {
      bypassApprovals: { type: 'bool' },
      animations: { type: 'bool' },
      model: { type: 'token', pattern: 'model' },
      resumeId: { type: 'token', pattern: 'id' },
    },
    variants: [
      {
        id: 'default',
        args: [
          { lit: 'codex' },
          { flag: '--dangerously-bypass-approvals-and-sandbox', when: { param: 'bypassApprovals', is: true } },
          { flag: '--config', value: 'tui.animations=true', when: { param: 'animations', is: true } },
          { flag: '--config', value: 'tui.animations=false', when: { param: 'animations', is: false } },
          { flag: '--model', valueFrom: 'model', when: { param: 'model', state: 'set' } },
          { lit: 'resume', when: { param: 'resumeId', state: 'set' } },
          { valueFrom: 'resumeId', when: { param: 'resumeId', state: 'set' } },
        ],
      },
    ],
    legacyConfigAliases: { bypassApprovals: 'dangerouslyBypassApprovals', resumeId: 'resumeSessionId' },
    legacyConfigField: 'codexConfig',
    resumeAppend: { style: 'positional', token: 'resume' },
  },
  env: {
    exports: [
      { name: 'COLORTERM', value: 'truecolor' },
      { name: 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', value: { engine: 'codemanPrefixedSessionId' } },
    ],
    unset: ['NO_COLOR'],
    tmuxSetenvKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME'],
    dockerExecEnvNames: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    allowedPrefixes: ['CODEX_'],
    allowedKeys: [],
  },
  capabilities: {
    ...agentDefaults(),
    // Codex draws `› Ask Codex to do anything` on its composer row and
    // `Working (2m 49s • esc to interrupt)` above it while a turn runs. It animates no
    // braille spinner, and it never prints `esc to interrupt` at rest, so that phrase
    // alone separates a running turn from an idle one.
    workDetect: { promptGlyph: '›', workingLine: '[Ee]sc to interrupt' },
    transcript: 'codex-rollout',
    altScreen: 'strip-full',
    echo: { policy: 'predict', anchor: { kind: 'cursor' }, predictProfile: 'codex' },
    wheelForward: { mode: 'never' }, // #227: codex ignores SGR wheel reports, never forward
    maxFrameBytes: 32 * 1024,
    // codex's own bare-spawn default (no config sent) is already safe (no bypass flag), so
    // the multi-user clamp only needs to force an EXPLICITLY-SENT bypass back off.
    //
    // `param` names the REGISTRY param, like every other `param` in this file — the clamp
    // resolves it through `legacyConfigAliases` on the way out, exactly as `configSetenv`
    // does. codex is the entry where the two names differ (`bypassApprovals` here,
    // `dangerouslyBypassApprovals` on the wire), so it is the one that would have caught a
    // regression; `schema.ts` now rejects a name that is not a declared param.
    privilegedParams: [{ param: 'bypassApprovals', clampTo: false }],
  },
  overlays: {
    credStore: {
      rel: '.codex',
      shareDirs: ['sessions'],
      shareFiles: ['history.jsonl'],
      seedFiles: ['auth.json', 'config.toml'],
    },
  },
};

const GEMINI: CliEntry = {
  id: 'gemini' as CliEntry['id'],
  label: 'Gemini',
  shortBadge: 'GM',
  accent: '#4285f4',
  enabled: true,
  stock: true,
  order: 30,
  kind: 'agent',
  discovery: {
    binaries: ['gemini'],
    searchDirs: [
      '~/.gemini/bin',
      HOME_DIRS.local,
      HOME_DIRS.usrLocal,
      HOME_DIRS.bunBin,
      HOME_DIRS.npmGlobal,
      HOME_DIRS.homeBin,
    ],
    version: { arg: '--version', regex: '(\\d+\\.\\d+\\.\\d+)' },
    install: {
      command: { linux: 'npm install -g @google/gemini-cli', darwin: 'npm install -g @google/gemini-cli' },
      npmPackage: '@google/gemini-cli',
      docsUrl: 'https://github.com/google-gemini/gemini-cli',
    },
  },
  launch: {
    params: {
      approvalMode: { type: 'enum', values: ['default', 'auto_edit', 'yolo', 'plan'], default: 'yolo' },
      model: { type: 'token', pattern: 'model' },
      resumeId: { type: 'token', pattern: 'id-dotted' },
    },
    variants: [
      {
        id: 'default',
        args: [
          { lit: 'gemini' },
          { flag: '--skip-trust' },
          { flag: '--approval-mode', valueFrom: 'approvalMode' },
          { flag: '--model', valueFrom: 'model', when: { param: 'model', state: 'set' } },
          { flag: '--resume', valueFrom: 'resumeId', when: { param: 'resumeId', state: 'set' } },
        ],
      },
    ],
    legacyConfigAliases: { resumeId: 'resumeSession' },
    legacyConfigField: 'geminiConfig',
    resumeAppend: { style: 'flag', flag: '--resume' },
  },
  env: {
    exports: [{ name: 'COLORTERM', value: 'truecolor' }],
    unset: ['NO_COLOR'],
    tmuxSetenvKeys: [
      'GEMINI_API_KEY',
      'GEMINI_MODEL',
      'GOOGLE_API_KEY',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_LOCATION',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_GENAI_USE_VERTEXAI',
    ],
    dockerExecEnvNames: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    allowedPrefixes: ['GEMINI_', 'GOOGLE_'],
    allowedKeys: [],
  },
  capabilities: {
    ...agentDefaults(),
    altScreen: 'strip-full',
    echo: { policy: 'buffer', anchor: { kind: 'cursor' } },
    // gemini's builder defaults an ABSENT approvalMode to 'yolo', so the clamp must
    // MATERIALIZE a config (not just touch an already-sent one) or a non-granted owner who
    // sends no geminiConfig at all would still get yolo for free.
    privilegedParams: [{ param: 'approvalMode', clampTo: 'auto_edit', materializeWhenAbsent: true }],
  },
  overlays: {
    credStore: { rel: '.gemini', seedWhole: true }, // also covers antigravity — see its own entry
  },
};

const ANTIGRAVITY: CliEntry = {
  id: 'antigravity' as CliEntry['id'],
  label: 'Antigravity',
  shortBadge: 'AG',
  accent: '#8b5cf6',
  enabled: true,
  stock: true,
  order: 40,
  kind: 'agent',
  discovery: {
    // Binary is `agy`, NOT `antigravity` — the mode-name/binary-name split that made
    // probeDockerCliVersion wrong before this registry existed.
    binaries: ['agy'],
    searchDirs: [HOME_DIRS.local, '~/.antigravity/bin', HOME_DIRS.usrLocal, HOME_DIRS.homeBin],
    version: { arg: '--version', regex: '(\\d+\\.\\d+\\.\\d+)' },
    install: {
      command: {
        linux: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
        darwin: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      },
      docsUrl: 'https://antigravity.google/cli',
    },
  },
  launch: {
    params: {
      dangerouslySkipPermissions: { type: 'bool' },
      model: { type: 'token', pattern: 'model' },
      resumeId: { type: 'token', pattern: 'id-dotted' },
    },
    variants: [
      {
        id: 'default',
        args: [
          { lit: 'agy' },
          { flag: '--dangerously-skip-permissions', when: { param: 'dangerouslySkipPermissions', is: true } },
          { flag: '--model', valueFrom: 'model', when: { param: 'model', state: 'set' } },
          { flag: '--conversation', valueFrom: 'resumeId', when: { param: 'resumeId', state: 'set' } },
        ],
      },
    ],
    legacyConfigAliases: { resumeId: 'resumeConversationId' },
    legacyConfigField: 'antigravityConfig',
    resumeAppend: { style: 'flag', flag: '--conversation' },
  },
  env: {
    exports: [{ name: 'COLORTERM', value: 'truecolor' }],
    unset: ['NO_COLOR'],
    tmuxSetenvKeys: [],
    dockerExecEnvNames: [],
    allowedPrefixes: ['ANTIGRAVITY_'],
    allowedKeys: [],
  },
  capabilities: {
    ...agentDefaults(),
    altScreen: 'strip-mux-only',
    echo: { policy: 'buffer', anchor: { kind: 'cursor' } },
    // Like codex: an ABSENT config already defaults safe (no bypass flag), so only a
    // SENT config needs the flag forced off — nothing is materialized.
    privilegedParams: [{ param: 'dangerouslySkipPermissions', clampTo: false }],
  },
  overlays: {
    // No credStore of its own: agy nests its whole state under ~/.gemini/antigravity-cli/,
    // which gemini's seedWhole entry already covers.
  },
};

const PI: CliEntry = {
  id: 'pi' as CliEntry['id'],
  label: 'Pi',
  shortBadge: 'PI',
  accent: '#10b981',
  enabled: true,
  stock: true,
  order: 50,
  kind: 'agent',
  discovery: {
    binaries: ['pi'],
    searchDirs: [HOME_DIRS.local, HOME_DIRS.usrLocal, HOME_DIRS.bunBin, HOME_DIRS.npmGlobal, HOME_DIRS.homeBin],
    // pi is a generic binary name (Raspberry Pi tooling, personal scripts), so a `which`
    // hit alone is not evidence of the right program — require the version match.
    version: { arg: '--version', regex: '(?:^|\\s)(\\d+\\.\\d+\\.\\d+)', requireVersionMatch: true },
    install: {
      command: {
        linux: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
        darwin: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
      },
      npmPackage: '@earendil-works/pi-coding-agent',
      docsUrl: 'https://pi.dev',
      agentImageLayer: {
        kind: 'dedicated',
        reason: 'installed with --ignore-scripts in its own layer, so the flag cannot leak to the shared block',
      },
    },
  },
  launch: {
    params: {
      approveProjectTrust: { type: 'bool' },
      model: { type: 'token', pattern: 'model-pi' },
      provider: { type: 'token', pattern: 'slug' },
      thinking: { type: 'enum', values: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
      resumeId: { type: 'token', pattern: 'id-dotted' },
      continueSession: { type: 'bool' },
    },
    variants: [
      {
        id: 'default',
        args: [
          { lit: 'pi' },
          { flag: '--approve', when: { param: 'approveProjectTrust', is: true } },
          { flag: '--no-approve', when: { param: 'approveProjectTrust', is: false } },
          { flag: '--model', valueFrom: 'model', when: { param: 'model', state: 'set' } },
          { flag: '--provider', valueFrom: 'provider', when: { param: 'provider', state: 'set' } },
          { flag: '--thinking', valueFrom: 'thinking', when: { param: 'thinking', state: 'set' } },
          { flag: '--session', valueFrom: 'resumeId', when: { param: 'resumeId', state: 'set' } },
          {
            lit: '-c',
            when: {
              allOf: [
                { param: 'continueSession', is: true },
                { param: 'resumeId', state: 'unset' },
              ],
            },
          },
        ],
      },
    ],
    legacyConfigAliases: { resumeId: 'resumeSessionId' },
    legacyConfigField: 'piConfig',
    resumeAppend: { style: 'flag', flag: '--session' },
  },
  env: {
    exports: [{ name: 'COLORTERM', value: 'truecolor' }],
    unset: ['NO_COLOR'],
    // Pi's ~34 provider keys share no common prefix, so they are deliberately NOT
    // allowlisted here — same reasoning as today's PI_ only prefix. Pi users authenticate
    // via `/login` or the server process's own env.
    tmuxSetenvKeys: [],
    dockerExecEnvNames: [],
    allowedPrefixes: ['PI_'],
    allowedKeys: [],
  },
  capabilities: {
    ...agentDefaults(),
    altScreen: 'preserve', // pi's TUI renders into the main screen with terminal-owned scrollback
    echo: { policy: 'buffer', anchor: { kind: 'cursor' } },
    // pi's absent-config default is an interactive trust PROMPT the session user could
    // just answer "yes" to, so omitting --approve is not itself a clamp — MATERIALIZE
    // approveProjectTrust:false so buildPiCommand emits --no-approve outright.
    privilegedParams: [{ param: 'approveProjectTrust', clampTo: false, materializeWhenAbsent: true }],
  },
  overlays: {
    credStore: {
      rel: '.pi/agent',
      seedFiles: ['auth.json', 'settings.json', 'trust.json', 'models.json', 'models-store.json'],
    },
  },
};

// Grok Build (xAI, `grok`). Transcribed from the hand-written buildGrokCommand into
// registry data; enabled by default, like every other shipped mode.
const GROK: CliEntry = {
  id: 'grok' as CliEntry['id'],
  label: 'Grok',
  shortBadge: 'GK',
  // Upstream hand-authored a charcoal GRADIENT across 4+ CSS spots (welcome button, tab
  // badge, run-mode dot, mobile skin overrides) rather than one flat colour; our registry's
  // `accent` is a single hex, so this is the closest single value (the run-mode-dot colour,
  // zinc-400). Nothing reads `accent` yet — the frontend is untouched in this change and
  // keeps its own hand-authored CSS; the field is here so the entry is complete.
  accent: '#a1a1aa',
  enabled: true,
  stock: true,
  order: 70,
  kind: 'agent',
  discovery: {
    binaries: ['grok'],
    searchDirs: ['~/.grok/bin', HOME_DIRS.local, HOME_DIRS.usrLocal, HOME_DIRS.homeBin],
    // `grok` has a known npm squatter (@vibe-kit/grok-cli also installs a `grok` bin), so a
    // bare `which grok` hit is not evidence of the right program — same defence as pi,
    // byte-identical regex.
    version: { arg: '--version', regex: '(?:^|\\s)(\\d+\\.\\d+\\.\\d+)', requireVersionMatch: true },
    install: {
      command: {
        linux: 'curl -fsSL https://x.ai/cli/install.sh | bash',
        darwin: 'curl -fsSL https://x.ai/cli/install.sh | bash',
      },
      // Not on npm — xAI ships a standalone installer/binary, same shape as Antigravity.
      docsUrl: 'https://github.com/xai-org/grok-build',
    },
  },
  launch: {
    params: {
      alwaysApprove: { type: 'bool' },
      model: { type: 'token', pattern: 'model' },
      resumeId: { type: 'token', pattern: 'id-dotted' },
      continueSession: { type: 'bool' },
    },
    variants: [
      {
        id: 'default',
        args: [
          { lit: 'grok' },
          { flag: '--always-approve', when: { param: 'alwaysApprove', is: true } },
          { flag: '--model', valueFrom: 'model', when: { param: 'model', state: 'set' } },
          { flag: '--resume', valueFrom: 'resumeId', when: { param: 'resumeId', state: 'set' } },
          {
            lit: '--continue',
            when: {
              allOf: [
                { param: 'continueSession', is: true },
                { param: 'resumeId', state: 'unset' },
              ],
            },
          },
        ],
      },
    ],
    legacyConfigAliases: { resumeId: 'resumeSessionId' },
    legacyConfigField: 'grokConfig',
    resumeAppend: { style: 'flag', flag: '--resume' },
  },
  env: {
    exports: [{ name: 'COLORTERM', value: 'truecolor' }],
    unset: ['NO_COLOR'],
    // No tmuxSetenvKeys: XAI_API_KEY (xAI's documented headless auth var) is covered by the
    // XAI_ prefix allowlist below, same "rely on the prefix, not an explicit key list"
    // reasoning as pi's ~34 provider keys.
    tmuxSetenvKeys: [],
    dockerExecEnvNames: [],
    allowedPrefixes: ['GROK_', 'XAI_'],
    allowedKeys: [],
  },
  capabilities: {
    ...agentDefaults(),
    // Fullscreen alt-screen TUI with mouse support — same shape as opencode/antigravity:
    // only the tmux-attach-time smcup strip, not Ink's full erase-scrollback+DECSET strip.
    altScreen: 'strip-mux-only',
    // Buffer-policy fallthrough default, unmeasured against an authenticated grok composer
    // (the existing hedge, preserved verbatim) — same as gemini/antigravity/pi.
    echo: { policy: 'buffer', anchor: { kind: 'cursor' } },
    // codex/antigravity-shaped clamp: grok's own bare-spawn default (no config sent) is
    // already its safe interactive ask-mode, so the multi-user clamp only needs to force an
    // EXPLICITLY-SENT bypass flag back off — nothing is materialized when config is absent.
    privilegedParams: [{ param: 'alwaysApprove', clampTo: false }],
  },
  overlays: {
    // ~/.grok also holds sessions/, memory/, downloads/ (the ~160MB binary), completions/,
    // docs/, bin/ — per-file seeding like pi's credStore, not a whole-dir seedWhole copy.
    credStore: { rel: '.grok', seedFiles: ['auth.json', 'config.toml', 'pager.toml'] },
    // No remote/docker overlay needed: the defaults (exec grok / login-shell `grok`) are
    // already correct — verified against upstream's own pinned test/grok-mode.test.ts
    // expectation `exec "${SHELL:-/bin/sh}" -i -l -c 'grok'`.
  },
};

// DeepSeek Harness (`dsh`, deepseek-ai/deepseek-harness). The awkward one, and worth
// reading before assuming it looks like its siblings — it breaks four of this catalog's
// normal assumptions at once, which is why the schema carries four extensions for it:
//
//   1. `dsh` is a PROFILE LAUNCHER, not the agent. It boots $DSH_HOME/profiles/<name>, and
//      DeepSeek ships only `web`/`headless`/`base`, none of which can drive a terminal
//      pane — so the terminal front door is ALWAYS third-party and "installed" is not
//      "runnable". Hence `discovery.launcherProfile`.
//   2. Its permission switch is the `DSH_PERMISSION_MODE` ENV VAR, not a flag — the
//      harness has none. Hence `env.configSetenv` (so the ordinary privilegedParams clamp
//      still reaches it) plus `capabilities.privilegedEnvKeys` (so an envOverrides send
//      cannot hand the privilege straight back).
//   3. It is the only non-claude mode with real hook signals, and for it alone that is a
//      per-SESSION question. Hence `hooks: 'supervised'`.
//   4. Its transcript is zstd session files, one frame per write. Hence
//      `transcript: 'deepseek-zstd'`.
//
// The identity probe is the strictest in the catalog for a sharper reason than pi's or
// grok's npm squatters: Debian ships an unrelated `dsh` (dancer's shell, `apt install
// dsh`) that would pass a version probe perfectly happily.
const DEEPSEEK: CliEntry = {
  id: 'deepseek' as CliEntry['id'],
  label: 'DeepSeek',
  shortBadge: 'DS',
  accent: '#4d6bfe',
  enabled: true,
  stock: true,
  order: 80,
  kind: 'agent',
  discovery: {
    binaries: ['dsh'],
    searchDirs: [HOME_DIRS.local, HOME_DIRS.usrLocal, HOME_DIRS.npmGlobal, HOME_DIRS.homeBin],
    // Checked BEFORE the version probe: dancer's shell answers --version happily, so a
    // version match alone would accept it.
    identity: { arg: '--help', regex: 'DeepSeek\\s+Harness' },
    // Keeps the `-rc.2` prerelease tail — dsh ships them, and the `codeman doctor` row
    // shares this regex so the two cannot disagree about what version a binary reports.
    version: {
      arg: '--version',
      regex: '(?:^|\\s)v?(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)',
      requireVersionMatch: true,
    },
    launcherProfile: 'deepseek-profile',
    launcherTargetParam: 'profile',
    install: {
      command: {
        linux: 'npm install -g @deepseek-ai/dsh',
        darwin: 'npm install -g @deepseek-ai/dsh',
      },
      npmPackage: '@deepseek-ai/dsh',
      docsUrl: 'https://github.com/deepseek-ai/deepseek-harness',
      agentImageLayer: {
        kind: 'dedicated',
        reason: 'needs pnpm alongside it (dsh plugin, issue #352) and a dsh-tui profile install',
      },
    },
  },
  launch: {
    params: {
      // A single path segment: interpolated into the shell line AND joined into a
      // filesystem path, so `path-segment` rather than the looser `id-dotted`.
      profile: { type: 'token', pattern: 'path-segment' },
      // Resolved at spawn time from what is actually installed — see launcherProfile.
      defaultProfile: { type: 'engine', source: 'launcherDefaultTarget' },
      resumeId: { type: 'token', pattern: 'id-dotted' },
      resumeSession: { type: 'bool' },
      // Never appears in argv. Declared so `configSetenv` can export it and, more to the
      // point, so `privilegedParams` can clamp it — see capabilities below.
      permissionMode: { type: 'enum', values: ['read-only', 'workspace-write', 'danger-full-access'] },
      // Never appears in argv either; read by the status-bridge setenv profile.
      statusReporting: { type: 'bool' },
    },
    variants: [
      {
        id: 'default',
        args: [
          { lit: 'dsh' },
          { flag: '--profile', valueFrom: 'profile', when: { param: 'profile', state: 'set' } },
          // An invalid profile name resolves to undefined, so `profile` reads as UNSET and
          // this arm takes over — reproducing the hand-written builder's fall back to the
          // resolved default rather than failing the spawn outright.
          {
            flag: '--profile',
            valueFrom: 'defaultProfile',
            when: {
              allOf: [
                { param: 'profile', state: 'unset' },
                { param: 'defaultProfile', state: 'set' },
              ],
            },
          },
          // The launcher forwards everything after its own flags to the profile's app,
          // which is where --resume is understood. An explicit id wins over the
          // most-recent-session form, mirroring the sibling builders.
          { flag: '--resume', valueFrom: 'resumeId', when: { param: 'resumeId', state: 'set' } },
          {
            flag: '--resume',
            when: {
              allOf: [
                { param: 'resumeId', state: 'unset' },
                { param: 'resumeSession', is: true },
              ],
            },
          },
        ],
      },
    ],
    legacyConfigAliases: { resumeId: 'resumeSessionId' },
    legacyConfigField: 'deepSeekConfig',
    resumeAppend: { style: 'flag', flag: '--resume' },
  },
  env: {
    exports: [{ name: 'COLORTERM', value: 'truecolor' }],
    unset: ['NO_COLOR'],
    // DEEPSEEK_BASE_URL is forwarded from the SERVER's own env alongside the API key,
    // which is exactly why a non-granted owner may not override it — see privilegedEnvKeys.
    tmuxSetenvKeys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_HOME'],
    dockerExecEnvNames: [],
    configSetenv: [{ name: 'DSH_PERMISSION_MODE', fromParam: 'permissionMode' }],
    // Only the vendor namespaces. A dsh settings.yaml can nominate ANY env var as a
    // provider credential (`apiKeyEnv`), so admitting foreign provider keys here would
    // widen one GLOBAL allowlist for every mode at once — the same lesson pi taught.
    allowedPrefixes: ['DSH_', 'DEEPSEEK_'],
    allowedKeys: [],
    setenvProfile: 'deepseek-status-bridge',
  },
  capabilities: {
    ...agentDefaults(),
    // Definitive rather than inferred: the harness TUI reports idle/working/blocked to a
    // supervisor and Codeman is that supervisor. 'supervised' rather than 'always' because
    // the session can disarm the bridge, and docker/remote cannot reach it at all.
    hooks: 'supervised',
    transcript: 'deepseek-zstd',
    altScreen: 'strip-mux-only',
    echo: { policy: 'buffer', anchor: { kind: 'cursor' } },
    // Model is NOT a session field for dsh — it is a profile composition entry.
    model: { source: 'none' },
    // Only-if-sent, like codex/antigravity/grok: an ABSENT permissionMode means the
    // launcher's own default, `workspace-write`, which already asks. Clamping to
    // `read-only` instead would break the workspace rather than protect it.
    privilegedParams: [{ param: 'permissionMode', clampTo: 'workspace-write' }],
    // The half no other CLI needs. `DSH_*` is an allowlisted envOverrides prefix and
    // applyEnvOverrides() runs LAST, so without this a non-granted owner could send
    // DSH_PERMISSION_MODE on the same request and land after the config clamp.
    privilegedEnvKeys: ['DSH_PERMISSION_MODE', 'DSH_HOME', 'DEEPSEEK_BASE_URL'],
  },
  overlays: {
    // No credStore: dsh keeps everything under $DSH_HOME (default ~/.dsh), which is
    // forwarded as a plain env var above rather than seeded as a credential directory.
  },
};

// OMP (`omp`, omp.sh). The plainest entry in the catalog after opencode: no permission
// flags at all — omp reads its model routing and hooks from `~/.omp/agent`, so the CLI's
// own config governs and there is deliberately nothing bypass-shaped to clamp. Its only
// privileged surface is a pair of ENV keys (see privilegedEnvKeys below).
const OMP: CliEntry = {
  id: 'omp' as CliEntry['id'],
  label: 'OMP',
  shortBadge: 'OM',
  accent: '#7c9cf5',
  enabled: true,
  stock: true,
  order: 90,
  kind: 'agent',
  discovery: {
    binaries: ['omp'],
    // `~/.local/bin` leads: omp.sh's installer targets it with no `--dir` override
    // (verified against a real `--no-cache` docker build); `~/.omp/bin` is a defensive
    // fallback only.
    searchDirs: [
      HOME_DIRS.local,
      '~/.omp/bin',
      HOME_DIRS.usrLocal,
      HOME_DIRS.bunBin,
      HOME_DIRS.npmGlobal,
      HOME_DIRS.homeBin,
    ],
    // A real `omp --version` prints `omp/<semver>`. `omp` is another short generic name, so
    // the `omp/` prefix is what distinguishes the coding agent from anything else of that
    // name — same defence as pi and grok, one notch stricter because the prefix is checked.
    version: { arg: '--version', regex: '(?:^|\\s)omp/(\\d+\\.\\d+\\.\\d+)', requireVersionMatch: true },
    install: {
      command: {
        linux: 'curl -fsSL https://omp.sh/install | sh',
        darwin: 'brew install can1357/tap/omp',
      },
      docsUrl: 'https://omp.sh',
    },
  },
  launch: {
    params: {
      model: { type: 'token', pattern: 'model' },
      resumeId: { type: 'token', pattern: 'id-dotted' },
      continueSession: { type: 'bool' },
    },
    variants: [
      {
        id: 'default',
        args: [
          { lit: 'omp' },
          { flag: '--model', valueFrom: 'model', when: { param: 'model', state: 'set' } },
          // `--resume` and `--continue` conflict; a valid explicit id wins, mirroring the
          // sibling builders (grok/pi/opencode).
          { flag: '--resume', valueFrom: 'resumeId', when: { param: 'resumeId', state: 'set' } },
          {
            lit: '--continue',
            when: {
              allOf: [
                { param: 'continueSession', is: true },
                { param: 'resumeId', state: 'unset' },
              ],
            },
          },
        ],
      },
    ],
    legacyConfigAliases: { resumeId: 'resumeSessionId' },
    legacyConfigField: 'ompConfig',
    resumeAppend: { style: 'flag', flag: '--resume' },
  },
  env: {
    exports: [{ name: 'COLORTERM', value: 'truecolor' }],
    unset: ['NO_COLOR'],
    // omp's provider credentials live in `~/.omp` config files, not env vars, so there is
    // nothing for the server to forward into the pane.
    tmuxSetenvKeys: [],
    dockerExecEnvNames: [],
    allowedPrefixes: ['OMP_'],
    allowedKeys: [],
  },
  capabilities: {
    ...agentDefaults(),
    // Fullscreen alt-screen TUI, same shape as opencode/antigravity/grok: only the
    // tmux-attach-time smcup strip, not Ink's full erase-scrollback+DECSET strip.
    altScreen: 'strip-mux-only',
    // Codeman reads omp's own `~/.omp/agent/sessions/**/*.jsonl` host-side, which is what
    // makes an omp conversation survive a full session kill.
    transcript: 'omp-jsonl',
    echo: { policy: 'buffer', anchor: { kind: 'cursor' } },
    // No permission prompts and no bypass flag, so nothing config-shaped to clamp — the
    // whole privileged surface here is env-shaped.
    privilegedParams: [],
    // Where omp resolves its auth from. No known concrete exfiltration path today (omp
    // forwards no operator-held key into a pane), but a non-granted owner redirecting where
    // a shared multi-tenant deployment resolves auth is not something to allow silently.
    privilegedEnvKeys: ['OMP_AUTH_BROKER_URL', 'OMP_AUTH_BROKER_TOKEN'],
  },
  overlays: {
    // `~/.omp/agent` also holds agent.db/history.db/models.db (SQLite caches) and
    // terminal-sessions/blobs/cache (large, regenerable), so only the config files are
    // seeded. UNLIKE pi/grok, `sessions/` is SHARED (RW) rather than host-invisible:
    // Codeman reads it HOST-SIDE for history recovery and `--resume` pinning, the same
    // reason codex's `sessions/` is shared — without it an in-container omp conversation
    // would be invisible to Codeman's own resume logic.
    credStore: {
      rel: '.omp/agent',
      shareDirs: ['sessions'],
      seedFiles: ['config.yml', 'mcp.json', 'models.yml', 'settings.yml'],
    },
  },
};

/** The full stock catalog, in the order the run menu shows by default. */
export const STOCK_CLIS: CliEntry[] = [CLAUDE, SHELL, OPENCODE, CODEX, GEMINI, ANTIGRAVITY, PI, GROK, DEEPSEEK, OMP];
