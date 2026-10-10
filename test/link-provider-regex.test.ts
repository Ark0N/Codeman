/**
 * @fileoverview Regression guard for the terminal link-provider regexes in
 * `src/web/public/terminal-ui.js`.
 *
 * The link provider runs its patterns against every hovered terminal line
 * (logical lines — xterm re-joins wrapped rows, so inputs reach multiple KB).
 * A pattern with ambiguous backtracking freezes the entire tab on hover:
 * 0.9.10's `cmdPattern` used `(?:[^\s\/]*\s+)*` (empty-matchable token,
 * unbounded), which went exponential on real Claude output — wrapped
 * `git commit -m "$(cat <<'EOF'` heredoc lines hung the main thread for
 * minutes per hover.
 *
 * This test extracts the pattern literals FROM THE SHIPPED SOURCE (no copies
 * that can drift) and asserts they stay linear-time on those killer shapes,
 * and that `cmdPattern` still links the command+path forms it exists for.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const publicFile = (name: string) => readFileSync(join(__dirname, '..', 'src', 'web', 'public', name), 'utf-8');

const SOURCE = publicFile('terminal-ui.js');
// The file-path pattern lives in constants.js: the response viewer linkifies the
// same paths out of markdown, and one definition is what keeps a path that is
// clickable in the terminal from being inert in the chat.
const CONSTANTS_SOURCE = publicFile('constants.js');

/** Extract `const <name> = /.../g;` from the shipped sources and build the RegExp. */
function shippedPattern(name: string): RegExp {
  const literal = new RegExp(`const ${name} =\\s*\\n?\\s*(/(?:[^/\\\\\\n]|\\\\.)+/[a-z]*)`);
  const m = SOURCE.match(literal) ?? CONSTANTS_SOURCE.match(literal);
  if (!m) throw new Error(`pattern ${name} not found in terminal-ui.js or constants.js`);
  const lit = m[1];
  const lastSlash = lit.lastIndexOf('/');
  return new RegExp(lit.slice(1, lastSlash), lit.slice(lastSlash + 1));
}

const PATTERN_NAMES = [
  'urlPattern',
  'cmdPattern',
  'FILE_PATH_LINK_PATTERN',
  'RELATIVE_FILE_PATH_LINK_PATTERN',
  'bashPattern',
];

/** Lines that made 0.9.10's cmdPattern backtrack exponentially (>2s each). */
const KILLER_LINES = [
  // wrapped git-commit heredoc from real Claude tool output (the 0.9.10 freeze)
  `      /Users/arbbot/codeman-cases/topagent-control commit -m "$(cat <<'EOF'${' '.repeat(3000)}`,
  // aligned table row: trigger word + multi-space-separated columns + mid-token slash
  'watch  ' + 'col   '.repeat(40) + ' BTC/USDT',
  // trigger word followed by many tokens and no token-initial path
  'cat ' + 'word '.repeat(800) + 'no-path-here',
  // long URL-ish and path-ish soup for the other patterns
  'https://example.com/' + 'a/'.repeat(1500) + ' ' + '/home/x/'.repeat(400) + '.'.repeat(2000),
  'Bash(' + 'x'.repeat(4000),
];

describe('terminal link-provider regexes (shipped source)', () => {
  it('all patterns stay linear-time on killer lines', () => {
    const patterns = PATTERN_NAMES.map((n) => [n, shippedPattern(n)] as const);
    const start = Date.now();
    for (const [, re] of patterns) {
      for (const line of KILLER_LINES) {
        re.lastIndex = 0;
        while (re.exec(line) !== null) {
          /* drain all matches like the provider does */
        }
      }
    }
    const elapsed = Date.now() - start;
    // 20 pattern×line runs over multi-KB inputs: linear patterns finish in a few
    // ms; the 0.9.10 cmdPattern alone needed minutes for ONE line.
    expect(elapsed).toBeLessThan(500);
  });

  it('cmdPattern still links command + path forms', () => {
    const cmd = shippedPattern('cmdPattern');
    const cases: Array<[string, string]> = [
      ['tail -f /var/log/app.log', '/var/log/app.log'],
      ['cat -n /tmp/x.json', '/tmp/x.json'],
      ['grep -rn pattern /home/user/src', '/home/user/src'],
      ['watch ls /opt/data', '/opt/data'],
      ['head -c 100 /etc/hosts', '/etc/hosts'],
    ];
    for (const [line, want] of cases) {
      cmd.lastIndex = 0;
      const m = cmd.exec(line);
      expect(m, line).not.toBeNull();
      expect(m![2]).toBe(want);
    }
  });

  it('urlPattern keeps query strings whole (a single & is part of the URL)', () => {
    // Excluding `&` truncated every real query string: a WordPress edit link
    // resolved to `?post=1479` and opened the wrong page, and Claude Code's OAuth
    // login URL (many `&` params) was not clickable at all.
    const url = shippedPattern('urlPattern');
    const strip = (u: string) => u.replace(/[.,;:!?)&]+$/, '');
    const cases: Array<[string, string]> = [
      [
        'updated in place: https://bio-hacking.blog/wp-admin/post.php?post=1479&action=edit',
        'https://bio-hacking.blog/wp-admin/post.php?post=1479&action=edit',
      ],
      [
        'open https://claude.ai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference&state=xyz',
        'https://claude.ai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference&state=xyz',
      ],
      ['see https://x.com/a?b=1&c=2&d=3 ok', 'https://x.com/a?b=1&c=2&d=3'],
      // A lone trailing & is punctuation, not part of the target.
      ['trailing https://x.com/a?b=1& next', 'https://x.com/a?b=1'],
    ];
    for (const [line, want] of cases) {
      url.lastIndex = 0;
      const m = url.exec(line);
      expect(m, line).not.toBeNull();
      expect(strip(m![0]), line).toBe(want);
    }
  });

  it('urlPattern still stops at the shell && operator', () => {
    // `&&` never appears inside a URL, so it must remain a boundary or a link
    // would swallow the next command.
    const url = shippedPattern('urlPattern');
    for (const line of ['curl https://x.com/api && echo done', 'curl https://x.com/api&&echo done']) {
      url.lastIndex = 0;
      expect(url.exec(line)![0], line).toBe('https://x.com/api');
    }
  });

  it('the file-path pattern links pasted image/PDF/media attachment paths', () => {
    // `.codeman-uploads/paste-*.png` is what Codeman writes for a pasted screenshot;
    // without image extensions the path rendered as plain, unclickable text.
    const ext = shippedPattern('FILE_PATH_LINK_PATTERN');
    const cases = [
      '/home/arkon/default/claudeman/.codeman-uploads/paste-1785164958410-d11eb7d0.png',
      '/tmp/shot.jpeg',
      '/opt/app/report.pdf',
      '/home/a/diagram.svg',
      // An agent's own scratchpad capture — the path shape this whole feature
      // exists for, and the one that used to open a "File not found" preview.
      '/tmp/claude-1000/-home-arkon-default-claudeman/7b3fefd2/scratchpad/probe-run-native.png',
      // macOS and WSL roots: unmatched before, so Mac users had no clickable
      // paths at all outside /var and /tmp.
      '/Users/arbbot/codeman-cases/report.docx',
      '/mnt/d/captures/demo.mp4',
      // Longer extension of a family must win over its prefix (tsx over ts).
      '/home/a/src/App.tsx',
    ];
    for (const path of cases) {
      ext.lastIndex = 0;
      const m = ext.exec(`see ${path} here`);
      expect(m, path).not.toBeNull();
      expect(m![1], path).toBe(path);
    }
  });

  it('the file-path pattern refuses /etc roots (blocked server-side, so the link could only 403)', () => {
    // `/etc` sits in DEFAULT_BLOCKED_TREES (config/attachment-guard.ts), so an
    // /etc link is guaranteed dead: it renders clickable, then the preview 403s.
    // It used to be in the root alternation, which linked exactly those paths.
    const ext = shippedPattern('FILE_PATH_LINK_PATTERN');
    const cases = [
      'see /etc/hosts here',
      // Extension-bearing, so only the root removal keeps it out.
      'see /etc/app/config.json here',
      'cat /etc/nginx/nginx.conf.txt',
    ];
    for (const line of cases) {
      ext.lastIndex = 0;
      expect(ext.exec(line), line).toBeNull();
    }
  });

  it('terminal-ui finds its paths through the shared helper', () => {
    // Structural guard: a local literal here would drift from the response
    // viewer's linkifier, which is the divergence the move exists to prevent.
    expect(SOURCE).toContain('findFilePathLinks(lineText)');
    expect(SOURCE).not.toMatch(/const extPattern =\s*\n?\s*\//);
  });

  it('the rooted and the relative path pattern link the same extensions', () => {
    const extensions = (name: string) => /\\\.\(\?:([^()]*)\)\)\\b$/.exec(shippedPattern(name).source)?.[1];
    expect(extensions('FILE_PATH_LINK_PATTERN')).toBeTruthy();
    expect(extensions('RELATIVE_FILE_PATH_LINK_PATTERN')).toBe(extensions('FILE_PATH_LINK_PATTERN'));
  });

  it('cmdPattern arg group cannot match empty tokens (the exponential trigger)', () => {
    // structural guard: the dangerous construct is an empty-matchable token
    // inside a repeated group — `[^\s\/]*\s+` repeated. Check the pattern
    // literal itself (not the whole file — the warning comment quotes it).
    const lit = shippedPattern('cmdPattern').source;
    expect(lit).not.toContain('[^\\s\\/]*\\s+)*');
  });
});
