/**
 * @fileoverview Which model a session is running, as far as the server can know it
 * (`SessionState.displayModel`, shown in the tile grid's and split pane's headers).
 *
 * Pure: the session feeds it what it has and publishes the answer through `toState()`.
 *
 * ## Sources, strongest first
 *
 * 1. **custom-endpoint**: a session pointed at a Custom Model Endpoint Profile is answered
 *    by that endpoint's `modelId`, whatever alias the CLI itself prints.
 * 2. **statusline / screen**: what the running CLI REPORTS, newest report wins. Claude's
 *    statusLine exporter posts `model.display_name` on every render (it follows an
 *    in-session `/model`); a CLI whose registry entry declares
 *    `capabilities.modelDetect` has its footer read off the pane capture the idle/working
 *    probe already takes.
 * 3. **launch**: the model the session was launched with (claude's `--model` or the
 *    app-wide default it was created with; another CLI's `<cli>Config.model`). What was
 *    asked for, not what was reported, so it only shows when nothing reported.
 *
 * Nothing known means no field at all: the header shows the harness logo alone, never a
 * placeholder or a guess.
 *
 * ## Untrusted text
 *
 * A screen-read model is pane text, and a statusline payload is a POST body: both are
 * stripped of escape sequences and control characters, whitespace-collapsed and capped
 * here, and the browser renders the result with `textContent`.
 *
 * Tests: `test/session-display-model.test.ts`.
 *
 * @module session-display-model
 */

import type { DisplayModel, DisplayModelSource } from './types/session.js';
import { stripAnsi } from './utils/index.js';
import { getCli } from './config/cli-registry/index.js';
import { legacyConfigForMode } from './session-cli-registry-bridge.js';

/** Longest model name published (the header truncates long before this). */
export const MAX_DISPLAY_MODEL_CHARS = 64;

/** A report from the running CLI itself: the sources a restart may restore. */
export type ReportedModelSource = Extract<DisplayModelSource, 'statusline' | 'screen'>;

export interface ReportedModel {
  model: string;
  source: ReportedModelSource;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/**
 * A model name fit to publish, or undefined when nothing printable is left.
 *
 * @param raw anything; only a string can yield a name
 */
export function sanitizeModelName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const clean = stripAnsi(raw).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.slice(0, MAX_DISPLAY_MODEL_CHARS).trimEnd();
}

/**
 * The model a pane's own chrome shows, read with the CLI's `modelDetect` pattern.
 *
 * Only the last `tailRows` non-blank rows are searched (joined with `\n`, so a pattern
 * can anchor on the row above), which keeps the search below the transcript: the
 * pattern itself must still anchor on chrome only that CLI draws.
 *
 * @param paneText a plain `capture-pane -p` frame, or null when it could not be read
 * @param pattern compiled through `compileVersionRegex()`, capture group 1 = the model
 * @param tailRows how many non-blank rows from the bottom the pattern sees
 * @returns the model, or undefined when the frame shows none
 */
export function readScreenModel(
  paneText: string | null | undefined,
  pattern: RegExp,
  tailRows: number = 1
): string | undefined {
  if (!paneText) return undefined;
  const rows = stripAnsi(paneText)
    .split('\n')
    .map((row) => row.trimEnd())
    .filter((row) => row !== '');
  const window = rows.slice(-Math.max(1, Math.min(tailRows, 8))).join('\n');
  // compileVersionRegex() never sets `g`, but a pattern from elsewhere might, and a
  // stale lastIndex would make the same frame match every other call.
  pattern.lastIndex = 0;
  const match = pattern.exec(window);
  return match ? sanitizeModelName(match[1]) : undefined;
}

/**
 * The model a session was launched with, read the way its spawn reads it: where the
 * model param lives is registry data (`capabilities.model` names the param, the entry's
 * `legacyConfigField` the `<Mode>Config` object holding it, or the option bag itself for
 * claude), never a branch on the CLI id. A CLI whose model is not a launch param (shell,
 * dsh) has none.
 *
 * @param mode the session's CLI id
 * @param bag the session's launch option bag (`model`, `codexConfig`, ...)
 */
export function launchModelFor(mode: string, bag: Record<string, unknown>): string | undefined {
  const entry = getCli(mode);
  const model = entry?.capabilities.model;
  if (!entry || !model || model.source === 'none') return undefined;
  const param = model.param ?? 'model';
  const key = entry.launch.legacyConfigAliases?.[param] ?? param;
  const value = legacyConfigForMode(mode, bag)?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The persisted `displayModel` of a previous run, when it was a report from the CLI
 * itself: a restart shows it until the next report replaces it. A custom-endpoint or
 * launch answer is not restored, since the session derives those again by itself.
 */
export function restoredReportedModel(saved: unknown): ReportedModel | undefined {
  if (!saved || typeof saved !== 'object') return undefined;
  const { model, source } = saved as { model?: unknown; source?: unknown };
  if (source !== 'statusline' && source !== 'screen') return undefined;
  const name = sanitizeModelName(model);
  return name ? { model: name, source } : undefined;
}

/**
 * The model a session header shows, and where it came from.
 *
 * @param input.customModelId the custom endpoint's model, when the session is pointed at one
 * @param input.reported the newest report from the CLI itself
 * @param input.launchModel the model the session was launched with
 */
export function resolveDisplayModel(input: {
  customModelId?: string;
  reported?: ReportedModel | null;
  launchModel?: string;
}): DisplayModel | undefined {
  const custom = sanitizeModelName(input.customModelId);
  if (custom) return { model: custom, source: 'custom-endpoint' };
  const reported = input.reported ? sanitizeModelName(input.reported.model) : undefined;
  if (reported && input.reported) return { model: reported, source: input.reported.source };
  const launch = sanitizeModelName(input.launchModel);
  if (launch) return { model: launch, source: 'launch' };
  return undefined;
}
