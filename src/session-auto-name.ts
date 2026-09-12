/**
 * Helpers for assigning a useful default name after the first submitted prompt.
 *
 * This deliberately does not call an LLM: the prompt is already available at
 * the input boundary, so a bounded local title is private, deterministic, and
 * works for every CLI backend.
 */

const MAX_PROMPT_BUFFER_LENGTH = 8_192;
const MAX_AUTO_NAME_CODE_POINTS = 72;

/**
 * Tracks terminal input until Enter is received. Terminal input arrives in
 * arbitrary chunks, so this keeps only a small composer buffer and ignores
 * navigation/control escape sequences.
 */
export class SubmittedPromptTracker {
  private buffer = '';
  private escapeSequence = '';

  feed(data: string): string[] {
    const submitted: string[] = [];

    for (const character of data) {
      if (this.escapeSequence) {
        this.escapeSequence += character;
        // CSI sequences end with a byte in the final-byte range.
        const isCsiIntroducer = this.escapeSequence === '\x1b[' || this.escapeSequence === '\x1bO';
        if (/[\x40-\x7e]/.test(character) && !isCsiIntroducer) {
          const isBracketedPasteMarker = this.escapeSequence === '\x1b[200~' || this.escapeSequence === '\x1b[201~';
          if (!isBracketedPasteMarker) this.buffer = '';
          this.escapeSequence = '';
        }
        continue;
      }

      if (character === '\x1b') {
        this.escapeSequence = character;
        continue;
      }

      if (character === '\r' || character === '\n') {
        const prompt = this.buffer.trim();
        if (prompt) submitted.push(prompt);
        this.buffer = '';
        continue;
      }

      if (character === '\x08' || character === '\x7f') {
        this.buffer = Array.from(this.buffer).slice(0, -1).join('');
        continue;
      }

      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint < 0x20 || codePoint === 0x7f) {
        // Ctrl-C/Ctrl-U and cursor controls make the append-only buffer
        // unreliable. The next printable text starts a fresh candidate.
        this.buffer = '';
        continue;
      }

      this.buffer += character;
      if (this.buffer.length > MAX_PROMPT_BUFFER_LENGTH) {
        this.buffer = this.buffer.slice(-MAX_PROMPT_BUFFER_LENGTH);
      }
    }

    return submitted;
  }
}

/**
 * Converts a submitted prompt into a compact session title.
 * Returns null for empty text and slash commands, which are usually controls
 * such as /clear or /resume rather than the task the user wants to remember.
 */
export function deriveAutoSessionName(prompt: string): string | null {
  // Terminal input can legitimately contain ANSI/control bytes; they are
  // removed before the title is persisted or broadcast.
  const normalized = prompt
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized.startsWith('/')) return null;

  const firstSentence = normalized.match(/^.*?(?:[.!?。！？](?:\s|$)|$)/)?.[0]?.trim() || normalized;
  const codePoints = Array.from(firstSentence);
  if (codePoints.length <= MAX_AUTO_NAME_CODE_POINTS) return firstSentence;
  return `${codePoints
    .slice(0, MAX_AUTO_NAME_CODE_POINTS - 1)
    .join('')
    .trimEnd()}…`;
}

/** Existing Codeman-generated tab names are safe to upgrade on first prompt. */
export function isGeneratedSessionName(name: string): boolean {
  return /^[ws]\d+-[a-zA-Z0-9_-]+$/.test(name);
}
