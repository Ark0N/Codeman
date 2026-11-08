/** Explicit output references only: no directory scans, prose paths, external URLs or code examples. */
import { posix } from 'node:path';

const OUTPUT =
  /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|tiff?|pdf|xlsx?|ods|csv|tsv|docx?|odt|pptx?|odp|zip|mp4|webm|mov|mp3|wav|ogg)$/i;
export const DISCORD_ARTIFACT_COUNT = 4;

function localPath(raw: string): string | undefined {
  let path = raw.trim().replace(/^<([\s\S]*)>$/, '$1');
  // eslint-disable-next-line no-control-regex
  if (path.length > 2048 || /[\x00-\x1f\x7f]/.test(path)) return undefined;
  if (path.startsWith('file:')) {
    try {
      const url = new URL(path);
      if (url.hostname || url.username || url.password || url.search) return undefined;
      path = url.pathname;
    } catch {
      return undefined;
    }
  } else if (path.startsWith('sandbox:/')) path = path.slice('sandbox:'.length);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) return undefined;
  path = path.split('#')[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  path = path.replace(/\\([() ])/g, '$1');
  // eslint-disable-next-line no-control-regex
  if (!path || /[\x00-\x1f\x7f\\?]/.test(path) || path.startsWith('//')) return undefined;
  return posix.normalize(path);
}

export function discordArtifactPaths(text: string): string[] {
  const paths = new Set<string>();
  let fence: { char: string; size: number } | undefined;
  for (const line of text.slice(0, 120_000).split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.size && !marker[2].trim())
        fence = undefined;
      continue;
    }
    if (marker) {
      fence = { char: marker[1][0], size: marker[1].length };
      continue;
    }
    // Examples and quotations are not output declarations.
    if (/^(?: {4}|\t|\s*>)/.test(line)) continue;
    const visible = line.replace(/(`+)[^`]*?\1/g, '');
    const add = (raw: string, explicit: boolean) => {
      const path = localPath(raw);
      if (path && (explicit || OUTPUT.test(path))) paths.add(path);
    };
    for (const m of visible.matchAll(/\[artifact:\s*([^\]\n]{1,2048})\]/gi)) add(m[1], true);
    for (const m of visible.matchAll(
      /!?\[([^\]\n]{0,200})\]\(\s*(<[^>\n]{1,2048}>|[^\s\n]{1,2048}?)(?:\s+"[^"\n]*")?\s*\)/g
    ))
      add(m[2], /^download\b/i.test(m[1].trim()));
    // Bound both file reads and parser output, while allowing one extra to report overflow.
    if (paths.size > DISCORD_ARTIFACT_COUNT) break;
  }
  return [...paths].slice(0, DISCORD_ARTIFACT_COUNT + 1);
}

/** Keep readable labels for successfully attached files instead of broken local Markdown links. */
export function discordAttachedFileLabels(text: string, attached: ReadonlySet<string>): string {
  let fence: string | undefined;
  return text
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
        return line;
      }
      if (fence || /^(?: {4}|\t|\s*>)/.test(line)) return line;
      const code = [...line.matchAll(/(`+)[^`]*?\1/g)];
      return line.replace(
        /!?\[([^\]\n]{0,200})\]\(\s*(<[^>\n]{1,2048}>|[^\s\n]{1,2048}?)(?:\s+"[^"\n]*")?\s*\)/g,
        (match, label: string, raw: string, offset: number) => {
          if (code.some((m) => offset >= m.index! && offset < m.index! + m[0].length)) return match;
          const path = localPath(raw);
          return path && attached.has(path) ? label || posix.basename(path) : match;
        }
      );
    })
    .join('\n');
}
