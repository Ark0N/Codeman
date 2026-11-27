/**
 * @fileoverview The launch params a CLI takes a different value for when it is started as
 * root. Pure: the caller says whether the launch runs as root, this module never asks.
 *
 * Claude Code refuses `--dangerously-skip-permissions` under uid 0 and exits, so a Codeman
 * server that runs as root (a VPS, an LXC container) showed a dead pane for every local
 * Claude session, the default permission mode being exactly that flag. Docker cases already
 * answer the same refusal for a root container with `overlays.docker.rootCommand`; this is
 * the host-level form, for a CLI the server process starts as its own child.
 *
 * Which value gives way to which is registry DATA (`ParamSpec.rootValue` on an enum param),
 * so no code here or at the call sites names a CLI. `applyRootValues()` runs BEFORE the argv
 * engine and only rewrites the param values handed to it: the engine, and with it every
 * command line of a launch that is not root, is untouched.
 *
 * ⚠️ Local launches only. A remote or Docker launch runs under another account, which the
 * server's uid says nothing about; those keep their own handling (`buildRemoteLaunchCommand`,
 * `rootCommand`). The callers decide that, by passing `runsAsRoot` false.
 *
 * @module config/cli-registry/root-launch
 */

import { resolveEnumValue, type ParamValues } from './argv.js';
import type { CliLaunch } from './types.js';

/** One param that was launched with its `rootValue` instead of the value it resolved to. */
export interface RootValueChange {
  param: string;
  from: string;
  to: string;
}

/**
 * Apply every declared `rootValue` to `params`.
 *
 * Returns the SAME `params` object when nothing changes (not root, or no param whose
 * resolved value has a replacement), so a caller can rely on a launch that is not root
 * rendering from exactly the values it passed in. Otherwise a copy, with `changes` naming
 * what was swapped so the caller can log it.
 *
 * The value judged is the one the renderer would emit: an absent or undeclared value counts
 * as the param's default, which is how the default permission mode is caught although no
 * caller ever sends it.
 */
export function applyRootValues(
  launch: CliLaunch,
  params: ParamValues,
  runsAsRoot: boolean
): { params: ParamValues; changes: RootValueChange[] } {
  const changes: RootValueChange[] = [];
  if (!runsAsRoot) return { params, changes };
  let out = params;
  for (const [name, spec] of Object.entries(launch.params)) {
    if (spec.type !== 'enum' || !spec.rootValue) continue;
    const from = resolveEnumValue(spec, params[name]);
    if (from === undefined || !Object.hasOwn(spec.rootValue, from)) continue;
    const to = spec.rootValue[from];
    // Schema-validated at load; belt and braces, since a value outside `values` would
    // resolve back to the default, which is the very value being replaced.
    if (to === from || !spec.values.includes(to)) continue;
    if (out === params) out = { ...params };
    out[name] = to;
    changes.push({ param: name, from, to });
  }
  return { params: out, changes };
}

/**
 * The one log line for a launch that took a `rootValue`. `what` names the launch ("Claude
 * Code session 0f9c2b14"); the wording stays free of any CLI's vocabulary because the
 * params and values in it are the registry's own.
 */
export function describeRootValueChanges(what: string, changes: readonly RootValueChange[]): string {
  const swapped = changes.map((c) => `${c.param} "${c.from}" as "${c.to}"`).join(', ');
  return (
    `${what} is launched with ${swapped}: the Codeman server runs as root (uid 0), and the CLI refuses ` +
    `the configured value under root. Run Codeman as a normal user to get the configured value back.`
  );
}
