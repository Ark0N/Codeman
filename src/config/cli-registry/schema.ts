/**
 * @fileoverview Zod validation for CLI registry entries.
 *
 * Every object here is `.strict()`: an unknown key is a hard validation error, not a
 * silently-ignored one. That matters for a security-relevant schema — a typo in a field name
 * must never degrade to "field absent, so the permissive default applies".
 *
 * The load-bearing rule enforced here is `SHELL_TOKEN`: it is what makes it impossible for a
 * `clis.json` entry to smuggle shell metacharacters into the eventual `bash -c "..."` string
 * (see argv.ts's file header for the full model).
 *
 * @module config/cli-registry/schema
 */

import { z } from 'zod';
import { compileVersionRegex, TOKEN_PATTERNS } from './patterns.js';
import { isKnownLauncherProfile, isKnownSetenvProfile } from './profiles.js';

/** A bare CLI id: lowercase, starts with a letter, at most 24 chars. Also used as a CSS/URL token. */
const cliId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,23}$/, 'id must be lowercase, start with a letter, and be at most 24 chars');

/** An env var name. */
const envName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, 'env var name must be UPPER_SNAKE_CASE')
  .max(64);

/**
 * A shell-safe bare word: no space, quote, backtick, `$`, `;`, `&`, `|`, `<`, `>`, parens,
 * braces, newline or backslash. Every LITERAL in the launch spec (base command, flag names,
 * fixed values) must satisfy this — see argv.ts's file header.
 */
const shellToken = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:@=+/,-]+$/, 'must be a plain word with no shell metacharacters');

const flagToken = z.string().regex(/^--?[A-Za-z0-9][A-Za-z0-9-]*$/, 'must look like -x or --long-flag');

const quoteStyle = z.enum(['auto', 'bare', 'double', 'single']);

const condSchema: z.ZodType<import('./types.js').Cond> = z.lazy(() =>
  z.union([
    z.object({ param: z.string(), is: z.union([z.string(), z.boolean()]) }).strict(),
    z.object({ param: z.string(), state: z.enum(['set', 'unset']) }).strict(),
    z.object({ allOf: z.array(condSchema).min(1).max(8) }).strict(),
    z.object({ anyOf: z.array(condSchema).min(1).max(8) }).strict(),
    z.object({ not: condSchema }).strict(),
    z.object({ capabilityGate: z.string() }).strict(),
  ])
);

const paramSpecSchema = z.union([
  z
    .object({ type: z.literal('enum'), values: z.array(z.string()).min(1).max(16), default: z.string().optional() })
    .strict(),
  z.object({ type: z.literal('bool') }).strict(),
  z.object({ type: z.literal('token'), pattern: z.enum(TOKEN_PATTERNS as [string, ...string[]]) }).strict(),
  z
    .object({
      type: z.literal('engine'),
      source: z.enum([
        'sessionId',
        'sessionName',
        'muxName',
        'effortLevel',
        'effortSettingsJson',
        'codemanPrefixedSessionId',
        'launcherDefaultTarget',
      ]),
    })
    .strict(),
]);

const argSpecSchema = z.union([
  z.object({ lit: shellToken, when: condSchema.optional() }).strict(),
  z.object({ flag: flagToken, when: condSchema.optional() }).strict(),
  z.object({ flag: flagToken, value: shellToken, quote: quoteStyle.optional(), when: condSchema.optional() }).strict(),
  z
    .object({ flag: flagToken, valueFrom: z.string(), quote: quoteStyle.optional(), when: condSchema.optional() })
    .strict(),
  z.object({ valueFrom: z.string(), quote: quoteStyle.optional(), when: condSchema.optional() }).strict(),
]);

const variantSchema = z
  .object({
    id: z.string().min(1).max(40),
    when: condSchema.optional(),
    // min(0): the `shell` entry declares a variant with no args — tmux-manager resolves the
    // real login shell in code, since it varies per remote user's /etc/passwd entry.
    args: z.array(argSpecSchema).max(32),
  })
  .strict();

const launchSchema = z
  .object({
    params: z.record(z.string(), paramSpecSchema),
    chain: z.enum(['first', 'fallback']).optional(),
    variants: z.array(variantSchema).min(1).max(4),
    legacyConfigAliases: z.record(z.string(), z.string()).optional(),
    legacyConfigField: z.string().min(1).max(40).optional(),
    resumeAppend: z
      .union([
        z.object({ style: z.literal('flag'), flag: flagToken }).strict(),
        z.object({ style: z.literal('positional'), token: shellToken }).strict(),
      ])
      .optional(),
  })
  .strict()
  .superRefine((launch, ctx) => {
    const paramNames = new Set(Object.keys(launch.params));
    const checkValueFrom = (name: string, path: (string | number)[]) => {
      if (!paramNames.has(name)) {
        ctx.addIssue({ code: 'custom', message: `valueFrom "${name}" is not a declared param`, path });
      }
    };
    launch.variants.forEach((variant, vi) => {
      variant.args.forEach((arg, ai) => {
        if ('valueFrom' in arg) checkValueFrom(arg.valueFrom, ['variants', vi, 'args', ai, 'valueFrom']);
      });
    });
    if (launch.chain === 'fallback') {
      const last = launch.variants.at(-1);
      if (last?.when) {
        ctx.addIssue({
          code: 'custom',
          message: 'the last variant of a fallback chain must have no `when` (it must be the guaranteed terminal case)',
          path: ['variants', launch.variants.length - 1, 'when'],
        });
      }
    }
    if (launch.legacyConfigAliases) {
      for (const paramName of Object.keys(launch.legacyConfigAliases)) {
        if (!paramNames.has(paramName)) {
          ctx.addIssue({
            code: 'custom',
            message: `legacyConfigAliases key "${paramName}" is not a declared param`,
            path: ['legacyConfigAliases', paramName],
          });
        }
      }
    }
  });

const versionProbeSchema = z
  .object({
    arg: shellToken,
    regex: z.string().max(200).optional(),
    requireVersionMatch: z.boolean().optional(),
    retryOnTransientFailure: z.boolean().optional(),
  })
  .strict();

const identityProbeSchema = z
  .object({
    arg: shellToken,
    // Same 200-char cap as version.regex, and compiled through the same compileVersionRegex()
    // guard at use time. This is the second and last config-supplied regex in the registry.
    regex: z.string().min(1).max(200),
  })
  .strict();

const discoverySchema = z
  .object({
    // min(0): the `shell` entry has no binary of its own (it resolves the login shell in code).
    binaries: z.array(shellToken).max(4),
    searchDirs: z.array(z.string().max(300)).max(16),
    version: versionProbeSchema.optional(),
    identity: identityProbeSchema.optional(),
    launcherProfile: z.string().max(40).optional(),
    launcherTargetParam: z.string().max(40).optional(),
    install: z
      .object({
        // z.record with an enum key type requires every enum member in Zod v4; the install
        // command legitimately varies by platform and most entries only need one or two, so
        // this is a plain object of optional platform keys instead.
        command: z
          .object({
            linux: z.string().max(500).optional(),
            darwin: z.string().max(500).optional(),
            wsl: z.string().max(500).optional(),
            win32: z.string().max(500).optional(),
          })
          .strict(),
        npmPackage: z.string().max(200).optional(),
        docsUrl: z.url().optional(),
        // Requires a `reason` on purpose — see the field's own doc comment in types.ts. A
        // dedicated agent-image layer with no stated reason is a silent id-keyed special case
        // rebuilding itself inside the data this change moved it out of.
        agentImageLayer: z
          .object({ kind: z.literal('dedicated'), reason: z.string().min(1).max(300) })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

const envExportSchema = z
  .object({
    name: envName,
    value: z.union([
      shellToken,
      z
        .object({
          engine: z.enum([
            'sessionId',
            'sessionName',
            'muxName',
            'effortLevel',
            'effortSettingsJson',
            'codemanPrefixedSessionId',
            'launcherDefaultTarget',
          ]),
        })
        .strict(),
    ]),
    when: condSchema.optional(),
  })
  .strict();

const envSchema = z
  .object({
    exports: z.array(envExportSchema).max(16),
    unset: z.array(envName).max(16),
    tmuxSetenvKeys: z.array(envName).max(32),
    dockerExecEnvNames: z.array(envName).max(32),
    configSetenv: z
      .array(z.object({ name: envName, fromParam: z.string().min(1).max(40) }).strict())
      .max(8)
      .optional(),
    allowedPrefixes: z
      .array(
        z
          .string()
          .min(3)
          .max(32)
          .regex(/^[A-Z][A-Z0-9_]*_$/)
      )
      .max(8),
    allowedKeys: z.array(envName).max(8),
    configContentVar: envName.optional(),
    setenvProfile: z.string().max(40).optional(),
  })
  .strict();

const echoSchema = z
  .object({
    policy: z.enum(['buffer', 'predict', 'off']),
    anchor: z.union([
      z
        .object({ kind: z.literal('glyph'), glyph: z.string().min(1).max(4), offset: z.number().int().min(0).max(16) })
        .strict(),
      z.object({ kind: z.literal('cursor') }).strict(),
      z.object({ kind: z.literal('none') }).strict(),
    ]),
    predictProfile: z.string().max(40).optional(),
  })
  .strict();

/**
 * `capabilities.customModelInjection.launchModel`: the `model` launch-param value that
 * selects the injected provider, with `{modelId}` standing for the chosen id. Bounded to
 * the characters the `model`/`model-pi` token patterns accept plus the placeholder braces,
 * so a template can never smuggle a token the argv engine would have to quote.
 */
const launchModelTemplate = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9._\-/:{}]+$/)
  .optional();

const capabilitiesSchema = z
  .object({
    external: z.boolean(),
    requiresMux: z.boolean(),
    hooks: z.enum(['none', 'always', 'supervised']),
    transcript: z.enum(['claude-jsonl', 'codex-rollout', 'deepseek-zstd', 'omp-jsonl', 'none']),
    altScreen: z.enum(['strip-full', 'strip-mux-only', 'preserve']),
    echo: echoSchema,
    wheelForward: z
      .object({ mode: z.enum(['never', 'version-gated']), minVersion: z.string().max(20).optional() })
      .strict(),
    keyboardAccessory: z.enum(['agent', 'shell']),
    privilegedCommandGate: z.boolean(),
    startMode: z.enum(['interactive', 'shell']),
    stripInkBloat: z.boolean(),
    ralph: z.boolean(),
    respawn: z.boolean(),
    effort: z.boolean(),
    agentSkillInjection: z.boolean(),
    statusLineTelemetry: z.boolean(),
    // How many columns this CLI indents its transcript body by, so a copy can take
    // that much off the clipboard. Bounded, because it is the whole strip: a copy
    // never removes more than this, nor more than every selected line shares.
    //
    // ⚠ DECLARED, not measured off the pane, and two measured attempts are why.
    // Asking whether the pane painted spaces across the unused part of each row
    // separates a TUI from a shell perfectly where it fires and never
    // over-stripped, but it is a function of pane WIDTH: that padding exists
    // only while a rendered line stops short of the CLI's own layout width, and
    // Claude Code's prose wraps to fill it — the share of padded rows on one
    // live transcript ran 44%, 6%, 6%, 7% and 87% at 123, 160, 198, 235 and 298
    // columns, so the strip did nothing at any ordinary size. Taking the
    // narrowest indent on screen instead fires everywhere and over-strips, since
    // a file listing inside the transcript can be the narrowest thing on it.
    // A declared width cannot do either. Absent means no strip, so a CLI whose
    // transcript layout nobody has measured is never touched.
    transcriptGutter: z.number().int().min(1).max(8).optional(),
    workDetect: z
      .object({
        promptGlyph: z.string().min(1).max(8),
        // Config-supplied regex, so it goes through the same guard as `version.regex`:
        // ~/.codeman/clis.json can set this, and the compiled pattern runs on the PTY
        // hot path, where a nested quantifier would be a ReDoS against the event loop.
        // A broken pattern must also fail at LOAD time rather than inside a data handler.
        workingLine: z
          .string()
          .min(1)
          .refine(
            (src) => compileVersionRegex(src) !== null,
            'workingLine must be a regex compileVersionRegex() accepts: at most 200 characters, no nested quantifiers'
          ),
        // Same guard, same reasons: this one runs over the foot of a pane capture every
        // time a session settles, and ~/.codeman/clis.json can set it.
        watchingLine: z
          .string()
          .min(1)
          .refine(
            (src) => compileVersionRegex(src) !== null,
            'watchingLine must be a regex compileVersionRegex() accepts: at most 200 characters, no nested quantifiers'
          )
          .optional(),
        // Bounded hard: this is how far up the screen a config file may push the search,
        // and every row it adds is one more row the agent itself may be able to write.
        watchingLines: z.number().int().min(1).max(8).optional(),
      })
      .strict()
      // A window with nothing to search is a typo, not a configuration. Refused at LOAD
      // time for the same reason `privilegedParams[].param` is checked against the params
      // the entry declares: the failure is otherwise silent and looks like a feature that
      // simply never fires.
      .refine(
        (v) => v.watchingLines === undefined || v.watchingLine !== undefined,
        'watchingLines has nothing to bound without a watchingLine'
      )
      .optional(),
    model: z
      .object({ source: z.enum(['flag', 'claude-settings-file', 'none']), param: z.string().optional() })
      .strict(),
    privilegedParams: z
      .array(
        z
          .object({
            param: z.string(),
            clampTo: z.union([z.boolean(), z.string()]),
            materializeWhenAbsent: z.boolean().optional(),
          })
          .strict()
      )
      .max(8),
    // Exact env var NAMES, not prefixes: this list is a targeted deny, and a prefix here
    // would let one entry silently strip a whole namespace off every owner's overrides.
    privilegedEnvKeys: z.array(envName).max(8),
    gates: z.record(z.string(), z.object({ minVersion: z.string().max(20), failClosed: z.boolean() }).strict()),
    maxFrameBytes: z.number().int().positive().optional(),
    customModelInjection: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('env'),
          baseUrlVar: envName,
          apiKeyVar: envName,
          // Empty is valid: deepseek's model routing is a profile-composition concern, not
          // an env var, so it declares baseUrl/apiKey injection with no model var at all.
          modelVars: z.array(envName).max(8),
          launchModel: launchModelTemplate,
          // Optional: the env var to carry a discovered per-model context-window size
          // (claude's CLAUDE_CODE_MAX_CONTEXT_TOKENS), and/or the env var that isolates
          // this session's config/credential directory from the user's real one (claude's
          // CLAUDE_CONFIG_DIR) so an injected API key never collides with a stored OAuth
          // session. See the customModelInjection doc comment in cli-registry/types.ts.
          contextLengthVar: envName.optional(),
          configDirVar: envName.optional(),
          // Relative path, WITHIN the isolated configDirVar directory, of a trust-dialog
          // seed file the CLI itself owns the shape of — claude's `.claude.json`
          // `customApiKeyResponses.approved` list, the same field an interactive "Detected
          // a custom API key — use it?" prompt writes to on a real terminal. Only makes
          // sense alongside configDirVar (an isolated, otherwise-empty directory has none
          // of a real profile's prior approvals), and only implemented for the
          // 'claude-api-key-responses' shape today — see custom-model-injection-apply.ts.
          apiKeyTrustFile: z
            .object({ relPath: z.string().min(1).max(80), shape: z.literal('claude-api-key-responses') })
            .strict()
            .optional(),
          // An isolated config directory replays the CLI's whole first-run sequence (theme
          // picker, security notes, per-project trust dialog, bypass-permissions warning)
          // on every launch, same root cause as apiKeyTrustFile above — this reuses that
          // same file to pre-seed the state a real, already-onboarded profile carries. See
          // the customModelInjection doc comment in cli-registry/types.ts.
          skipFirstRunPrompts: z.boolean().optional(),
          // DeepSeek-only, confirmed by reading its own bundled SDK source: it concatenates
          // "/chat/completions" onto baseUrlVar's value with no "/v1" of its own, while
          // llama-swap/llama.cpp only serves the "/v1/..." path — claude/gemini must NOT
          // get this. See the customModelInjection doc comment in cli-registry/types.ts.
          appendV1Suffix: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('configContentEnv'),
          envVar: envName,
          template: z.literal('opencode-json'),
          launchModel: launchModelTemplate,
        })
        .strict(),
      z
        .object({
          kind: z.literal('configDir'),
          dirEnvVar: envName,
          fileName: z.string().min(1).max(80),
          template: z.enum(['codex-toml', 'pi-models-json', 'omp-models-yml', 'grok-toml']),
          launchModel: launchModelTemplate,
        })
        .strict(),
      z.object({ kind: z.literal('unsupported') }).strict(),
    ]),
  })
  .strict();

const credStoreSchema = z
  .object({
    rel: z.string().min(1).max(100),
    shareDirs: z.array(z.string().max(100)).optional(),
    shareFiles: z.array(z.string().max(100)).optional(),
    seedFiles: z.array(z.string().max(100)).optional(),
    seedWhole: z.boolean().optional(),
  })
  .strict();

/**
 * A remote/docker default pane command: space-separated bare words from the SAME safe
 * charset as `shellToken` (no shell metacharacters), so `claude --dangerously-skip-permissions`
 * is expressible while still excluding `;`, `|`, `$`, backticks and quotes — this is not an
 * escape hatch into arbitrary shell text, it is one bare command plus bare flags.
 */
const commandLine = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9._:@=+/,-]+( [A-Za-z0-9._:@=+/,-]+)*$/,
    'must be space-separated bare words with no shell metacharacters'
  );

const overlayTargetSchema = z.union([
  z.object({ command: commandLine.optional(), rootCommand: commandLine.optional() }).strict(),
  z.object({ disabled: z.literal(true) }).strict(),
]);

const overlaysSchema = z
  .object({
    remote: overlayTargetSchema.optional(),
    docker: overlayTargetSchema.optional(),
    credStore: credStoreSchema.optional(),
  })
  .strict();

export const CliEntrySchema = z
  .object({
    id: cliId,
    label: z.string().min(1).max(60),
    shortBadge: z.string().min(1).max(6),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'accent must be a 6-digit hex colour'),
    enabled: z.boolean(),
    stock: z.boolean(),
    order: z.number().int(),
    kind: z.enum(['agent', 'shell']),
    discovery: discoverySchema,
    launch: launchSchema,
    env: envSchema,
    capabilities: capabilitiesSchema,
    overlays: overlaysSchema,
  })
  .strict()
  .superRefine((entry, ctx) => {
    const gateNames = new Set(Object.keys(entry.capabilities.gates));
    const walkConds = (cond: import('./types.js').Cond | undefined) => {
      if (!cond) return;
      if ('capabilityGate' in cond && !gateNames.has(cond.capabilityGate)) {
        ctx.addIssue({
          code: 'custom',
          message: `capabilityGate "${cond.capabilityGate}" is not declared in capabilities.gates`,
        });
      }
      if ('allOf' in cond) cond.allOf.forEach(walkConds);
      if ('anyOf' in cond) cond.anyOf.forEach(walkConds);
      if ('not' in cond) walkConds(cond.not);
    };
    for (const variant of entry.launch.variants) {
      walkConds(variant.when);
      for (const arg of variant.args) walkConds(arg.when);
    }

    // Reject a profile name this build does not implement, rather than letting it fail
    // closed at use time. An unimplemented `launcherProfile` would make the CLI look
    // permanently uninstalled, and an unimplemented `setenvProfile` would silently skip
    // setup the CLI needs; both are far easier to diagnose as a load-time error naming the
    // field. (`echo.predictProfile` is deliberately NOT checked here — see profiles.ts.)
    const { launcherProfile } = entry.discovery;
    if (launcherProfile !== undefined && !isKnownLauncherProfile(launcherProfile)) {
      ctx.addIssue({
        code: 'custom',
        message: `discovery.launcherProfile "${launcherProfile}" is not a profile this build implements`,
        path: ['discovery', 'launcherProfile'],
      });
    }
    // An env var exported from a param that does not exist would silently export nothing,
    // and for DSH_PERMISSION_MODE that means silently losing a permission clamp.
    const declaredParams = new Set(Object.keys(entry.launch.params));
    entry.env.configSetenv?.forEach((mapping, i) => {
      if (!declaredParams.has(mapping.fromParam)) {
        ctx.addIssue({
          code: 'custom',
          message: `configSetenv fromParam "${mapping.fromParam}" is not a declared launch param`,
          path: ['env', 'configSetenv', i, 'fromParam'],
        });
      }
    });

    // Same class of silent failure on the OTHER privileged surface, and this one is a
    // security control: `privilegedParams[].param` is the multi-user bypass clamp's only
    // handle on a CLI's privilege switch, and a name that is not a declared param clamps
    // NOTHING — no load error, no failing test, the clamp simply stops running. The clamp
    // resolves the name through `legacyConfigAliases`, so this check is what keeps the two
    // in ONE namespace rather than two that merely coincide today: they do not for codex
    // (`bypassApprovals` vs `dangerouslyBypassApprovals`), and giving deepseek's
    // `permissionMode` an alias later would otherwise have removed its clamp with nothing
    // saying so.
    entry.capabilities.privilegedParams.forEach((clamp, i) => {
      if (!declaredParams.has(clamp.param)) {
        ctx.addIssue({
          code: 'custom',
          message: `privilegedParams param "${clamp.param}" is not a declared launch param`,
          path: ['capabilities', 'privilegedParams', i, 'param'],
        });
      }
    });

    const { setenvProfile } = entry.env;
    if (setenvProfile !== undefined && !isKnownSetenvProfile(setenvProfile)) {
      ctx.addIssue({
        code: 'custom',
        message: `env.setenvProfile "${setenvProfile}" is not a profile this build implements`,
        path: ['env', 'setenvProfile'],
      });
    }
  });

export type ValidatedCliEntry = z.infer<typeof CliEntrySchema>;
