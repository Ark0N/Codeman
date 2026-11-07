/** @fileoverview Discord-native response cards and conservative, code-aware prose formatting. */
import type { DiscordPost } from './discord-bridge.js';
import { formatDiscordTables } from './discord-tables.js';

export const DISCORD_RESPONSE_COLOR = 0x58a6ff;
export const DISCORD_WARNING_COLOR = 0xf2b84b;
export const DISCORD_CRITICAL_COLOR = 0xed6b6b;

function splitMarkdown(text: string, max = 1900, maxPosts = 8, detail = false): string[] {
  if (
    !Number.isInteger(max) ||
    max < 128 ||
    max > 4096 ||
    !Number.isInteger(maxPosts) ||
    maxPosts < 1 ||
    maxPosts > (detail ? 8192 : 64)
  )
    throw new RangeError('Invalid Discord message chunk limits');
  const posts: string[] = [];
  let cur = '';
  let fence: { marker: string; hint: string } | null = null;
  let cut = false;
  const budget = max - 64; // Reserve a closing fence and the explicit overflow note.
  const opening = () => (fence === null ? '' : fence.marker + fence.hint + '\n');
  const flush = () => {
    if (cur.trim() && cur !== opening())
      posts.push(cur.replace(/\n$/, '') + (fence !== null ? '\n' + fence.marker : ''));
    cur = opening();
  };
  for (let line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (posts.length >= maxPosts) {
      cut = true;
      break;
    }
    const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const nextFence: { marker: string; hint: string } | null =
      fenceLine &&
      fence === null &&
      fenceLine[1].length <= 16 &&
      !(fenceLine[1][0] === '`' && fenceLine[2].includes('`'))
        ? { marker: fenceLine[1], hint: fenceLine[2].trim().slice(0, 32) }
        : null;
    if (nextFence) line = nextFence.marker + nextFence.hint;
    if (cur.length + line.length + 1 > budget && cur.trim() && cur !== opening()) flush();
    while (line.length > budget - cur.length) {
      let end = budget - cur.length;
      // Do not split a UTF-16 surrogate pair (emoji and non-BMP characters).
      if (end > 0 && /[\uD800-\uDBFF]/.test(line[end - 1]) && /[\uDC00-\uDFFF]/.test(line[end] ?? '')) end--;
      cur += line.slice(0, end) + '\n';
      line = line.slice(end);
      flush();
      if (posts.length >= maxPosts) {
        cut = true;
        break;
      }
    }
    if (cut) break;
    if (cur.length + line.length + 1 > budget) flush();
    cur += line + '\n';
    if (fenceLine) {
      if (fence === null) fence = nextFence;
      else if (
        fenceLine[1][0] === fence.marker[0] &&
        fenceLine[1].length >= fence.marker.length &&
        !fenceLine[2].trim()
      )
        fence = null;
    }
  }
  if (!cut) flush();
  if (cut && posts.length > 0) posts[posts.length - 1] += '\n*(The message continues in the tab.)*';
  return posts.slice(0, maxPosts);
}

/** Plain message compatibility: content remains below Discord's 2000-character limit. */
export function splitForDiscord(text: string, max = 1900, maxPosts = 8): string[] {
  if (max > 1900) throw new RangeError('Invalid Discord message chunk limits');
  return splitMarkdown(text, max, maxPosts);
}

/** Detail panels page one bounded export without the normal chat-message count cap. */
export function discordDetailPages(text: string): string[] {
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new RangeError('Detail export exceeds 8 MB');
  return splitMarkdown(text, 1700, 8192, true);
}

/** Only style obvious prose, never fenced/indented code, inline code, URLs or Markdown links. */
function readableLine(line: string): string {
  // Mixed Markdown/URLs are left alone instead of guessing their token boundaries.
  if (line.includes('`') || line.includes('[') || line.includes(']') || /https?:\/\//.test(line)) return line;
  return line.replace(/\S+/g, (token) => {
    let start = 0,
      end = token.length;
    while (start < end && '("'.includes(token[start])) start++;
    while (end > start && '),;".'.includes(token[end - 1])) end--;
    const path = token.slice(start, end);
    const slash = path.lastIndexOf('/'),
      dot = path.lastIndexOf('.');
    if (
      slash < 0 ||
      path.startsWith('//') ||
      dot <= slash + 1 ||
      dot === path.length - 1 ||
      !/^[A-Za-z0-9_.~/-]+$/.test(path) ||
      !/^[A-Za-z0-9_-]+$/.test(path.slice(dot + 1))
    )
      return token;
    return token.slice(0, start) + '`' + path + '`' + token.slice(end);
  });
}
function inlineCodeState(line: string, initial: number): number {
  let ticks = initial;
  for (const match of line.matchAll(/`+/g)) {
    let slashes = 0;
    for (let at = match.index - 1; at >= 0 && line[at] === '\\'; at--) slashes++;
    if (slashes % 2) continue;
    if (!ticks) ticks = match[0].length;
    else if (ticks === match[0].length) ticks = 0;
  }
  return ticks;
}
export function formatDiscordResponseText(text: string): string {
  const out: string[] = [];
  let fence: { char: string; length: number } | undefined;
  let inlineTicks = 0;
  for (const original of formatDiscordTables(text).split('\n')) {
    if (inlineTicks) {
      inlineTicks = inlineCodeState(original, inlineTicks);
      out.push(original);
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(original);
    if (fence) {
      out.push(original);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim())
        fence = undefined;
      continue;
    }
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      fence = { char: marker[1][0], length: marker[1].length };
      out.push(original);
      continue;
    }
    if (!fence && !/^(?: {4}|\t|>)/.test(original) && original.includes('`')) {
      inlineTicks = inlineCodeState(original, 0);
    }
    if (original.length > 8192 || /^(?: {4}|\t|>)/.test(original) || original.includes('`')) {
      out.push(original);
      continue;
    }
    const item = /^(\d+[.)] )(.*)$/.exec(original);
    let line = original;
    if (item) {
      const label = /^([\p{L}][\p{L}\p{N} &/()_-]{0,59}:)(?=\s|$)/u.exec(item[2]);
      if (label) line = item[1] + '**' + label[1] + '**' + item[2].slice(label[1].length);
      if (out.length && out.at(-1)?.trim()) out.push('');
    }
    out.push(readableLine(line));
  }
  return out.join('\n');
}

/** One cohesive native card per chunk, including heading, Markdown and controls. */
export const DISCORD_COMPONENTS_V2 = 1 << 15;
/** Visible in history/unread badges, without desktop or push notifications. */
export const DISCORD_SUPPRESS_NOTIFICATIONS = 1 << 12;
export function discordResponsePosts(
  text: string,
  options: {
    title?: string;
    color?: number;
    users?: string[];
    subtitle?: string;
    controls?: DiscordPost['components'];
    silent?: boolean;
  } = {}
): DiscordPost[] {
  const users = options.users ?? [];
  const title = (options.title ?? 'Response').slice(0, 120);
  const mentions = users.map((id) => `<@${id}>`).join(' ');
  const chunks = splitMarkdown((mentions ? mentions + '\n' : '') + formatDiscordResponseText(text), 1900);
  return chunks.map((body, index) => ({
    content: '', // Removed at the API boundary; V2 uses Text Display components.
    flags: DISCORD_COMPONENTS_V2 | 4 | (options.silent || index > 0 ? DISCORD_SUPPRESS_NOTIFICATIONS : 0),
    components: [
      {
        type: 17,
        accent_color: options.color ?? DISCORD_RESPONSE_COLOR,
        components: [
          ...(index === 0
            ? [
                {
                  type: 10,
                  content: `**${title}**${options.subtitle ? '\n-# ' + options.subtitle.slice(0, 160) : ''}`,
                },
              ]
            : []),
          { type: 10, content: body },
          ...(chunks.length > 1 ? [{ type: 10, content: `-# ${index + 1} / ${chunks.length}` }] : []),
          ...(index === chunks.length - 1 && options.controls?.length
            ? [{ type: 14, divider: true, spacing: 1 }, ...options.controls]
            : []),
        ],
      },
    ],
    allowed_mentions: { parse: [], users: index === 0 ? users : [] },
  }));
}
/** One durable, editable native progress message; no completion is inferred from its prose. */
export function discordProgressPost(
  status: string,
  update: string,
  count: number,
  controls: DiscordPost['components'] = []
): DiscordPost {
  const compact = update.replace(/\s+/g, ' ').slice(0, 420);
  return {
    content: '',
    flags: DISCORD_COMPONENTS_V2 | 4 | DISCORD_SUPPRESS_NOTIFICATIONS,
    allowed_mentions: { parse: [], users: [] },
    components: [
      {
        type: 10,
        content: `-# ${status}${count ? ' · ' + count + ' progress update' + (count === 1 ? '' : 's') : ''}`,
      },
      ...(compact ? [{ type: 10, content: compact }] : []),
      ...controls,
    ],
  };
}
