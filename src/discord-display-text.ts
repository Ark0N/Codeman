/** Hide reserved assistant annotations in chat, while preserving literal code and other XML/citations. */
export function discordDisplayText(text: string): string {
  const out: string[] = [];
  let hidden = false,
    changed = false;
  let fence: { char: string; length: number } | undefined;
  const opening = /^ {0,3}<oai-mem-citation>/;
  const closing = '</oai-mem-citation>';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (hidden) {
      const at = line.indexOf(closing);
      if (at >= 0) {
        hidden = false;
        const rest = line.slice(at + closing.length);
        if (rest.trim()) out.push(rest);
      }
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      out.push(line);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim())
        fence = undefined;
      continue;
    }
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      fence = { char: marker[1][0], length: marker[1].length };
      out.push(line);
      continue;
    }
    if (opening.test(line)) {
      changed = true;
      const at = line.indexOf(closing);
      if (at < 0) hidden = true;
      else {
        const rest = line.slice(at + closing.length);
        if (rest.trim()) out.push(rest);
      }
      continue;
    }
    // An incomplete reserved tag at the stream boundary must not flash into the chat.
    const trimmed = line.trim();
    if (i === lines.length - 1 && /^ {0,3}<oai-mem-/.test(line) && '<oai-mem-citation>'.startsWith(trimmed)) {
      changed = true;
      continue;
    }
    out.push(line);
  }
  return changed ? out.join('\n').trimEnd() : text;
}
