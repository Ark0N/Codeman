/**
 * @fileoverview Collapse a prompt onto the one line an unattended sender writes.
 *
 * @module utils/single-line
 */

/**
 * A prompt as one line: every run of line breaks, with the whitespace around it,
 * becomes a single space; a single-line prompt is returned as is.
 *
 * For the senders that run unattended through `writeViaMux` (respawn's update and
 * kickstart steps, auto-compact). The mux pastes a multi-line prompt as one block,
 * and the check that re-presses a stranded Enter cannot recognise a multi-line paste
 * in the composer, so nobody would notice a prompt left unsubmitted. Cron rejects
 * multi-line prompts for the same reason; these senders join them instead, so a
 * saved multi-line setting is still sent rather than refused.
 */
export function toSingleLine(prompt: string): string {
  return prompt.replace(/\s*[\r\n]+\s*/g, ' ');
}
