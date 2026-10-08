/**
 * @fileoverview The config readers a CLI's registry entry may name for the model its
 * session runs (`capabilities.modelDetect.configResolver`): the per-CLI behaviour lives
 * here, keyed by name, so no code branches on a CLI id (like the launcher profiles in
 * config/cli-registry/profiles.ts).
 *
 * A reader answers the model the CLI's own config pins for one session, or null when
 * it pins none or the answer is in any doubt. It must be read-only, bounded (no
 * synchronous filesystem call, nothing that can wait on a dead mount) and must return
 * the model id alone, never another config value.
 *
 * @module model-config-resolvers
 */

import type { ModelConfigResolverName } from './config/cli-registry/types.js';
import { effectiveDshHome, readDeepSeekRouteModel } from './deepseek-route-config.js';

/** What a reader gets to know about the session. */
export interface ModelConfigContext {
  /** The session's own launch config for its CLI (its `<Mode>Config`), if any. */
  config: Record<string, unknown> | undefined;
  /** The environment the session's CLI runs with (its own overrides, then the server's). */
  env: (key: string) => string | undefined;
}

const RESOLVERS: Record<ModelConfigResolverName, (ctx: ModelConfigContext) => Promise<string | null>> = {
  // dsh-TUI's route: the session's profile (else the one the launch boots, which the
  // launch names from the server's own dsh home) read under the session's dsh home.
  'deepseek-route': (ctx) =>
    readDeepSeekRouteModel({
      profile: ctx.config?.profile,
      home: effectiveDshHome(ctx.env),
      serverHome: effectiveDshHome((key) => process.env[key]),
    }),
};

/**
 * The model the named reader resolves for a session, or null.
 *
 * @param name a `configResolver` from the registry (schema-checked at load)
 * @param ctx what the reader may know about the session
 */
export async function resolveConfigModel(
  name: ModelConfigResolverName,
  ctx: ModelConfigContext
): Promise<string | null> {
  const resolver = RESOLVERS[name];
  return resolver ? resolver(ctx) : null;
}
