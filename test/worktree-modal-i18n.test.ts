/**
 * @fileoverview The git worktree UI in Chinese (zh-CN), run through the real translator over the
 * real index.html in JSDOM:
 *
 * - every application string of the worktree dialog, Close Session's worktree option and the
 *   phone case sheet's Worktrees button reads in Chinese, with no English left beyond Git (a
 *   product name), git's own commands and the `.claude/worktrees/` and `worktree-<name>` paths;
 * - the strings session-ui.js inserts at runtime (row badges, buttons, the removal note, the
 *   validation message) and its toasts translate too, the toasts keeping the user's worktree and
 *   branch names verbatim;
 * - the slots holding user or git text (case name, repository path, worktree name) are skipped.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const I18N = readFileSync(resolve(PUBLIC, 'i18n.js'), 'utf8');
const INDEX = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
const SESSION_UI = readFileSync(resolve(PUBLIC, 'session-ui.js'), 'utf8');

type Api = { t(s: string): string; configure(o: Record<string, string>): void; start(): void };

function translator(language: string) {
  const dom = new JSDOM(INDEX, { runScripts: 'outside-only', url: 'http://localhost/' });
  vm.runInContext(I18N, dom.getInternalVMContext(), { filename: 'i18n.js' });
  const api = (dom.window as unknown as { CodemanI18n: Api }).CodemanI18n;
  api.start();
  api.configure({ language });
  return { dom, api };
}

const zh = translator('zh-CN');
const en = translator('en');
afterAll(() => {
  zh.dom.window.close();
  en.dom.window.close();
});

/**
 * Latin left once the names that stay are removed: Git (product), git and its commands, the
 * `.claude/worktrees/` path, the branch template, HEAD, and the display name (Codeman by default).
 */
const leftover = (text: string) =>
  text
    .replace(/git (worktree remove|branch -d)/g, '')
    .replace(/\.claude\/worktrees\/|worktree-<name>|\bHEAD\b|\bGit\b|\bgit\b|\bCodeman\b/g, '')
    .match(/[A-Za-z]+/g) ?? [];

/** Visible text of the static surfaces, one entry per text-bearing element (skips excluded). */
function staticStrings(doc: Document): string[] {
  const roots = [
    doc.getElementById('worktreeModal')!,
    doc.getElementById('closeConfirmWorktree')!,
    doc.querySelector('.btn-case-worktrees-mobile')!,
  ];
  const out: string[] = [];
  for (const root of roots) {
    const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.nodeValue || '').trim();
      if (!text || (n.parentElement && n.parentElement.closest('[data-i18n-skip]'))) continue;
      out.push(text);
    }
    for (const el of root.querySelectorAll('[aria-label], [title]')) {
      for (const attr of ['aria-label', 'title']) {
        const v = el.getAttribute(attr);
        if (v) out.push(v);
      }
    }
  }
  return out;
}

describe('the git worktree UI in zh-CN', () => {
  const english = staticStrings(en.dom.window.document);
  const chinese = staticStrings(zh.dom.window.document);

  it('finds the strings it checks (not vacuous)', () => {
    expect(english).toContain('Create & start session');
    expect(english).toContain('Kill & remove worktree');
    expect(english).toContain('Worktrees');
    expect(english).toContain('Close git worktrees');
    expect(english.length).toBe(chinese.length);
    expect(english.length).toBeGreaterThan(15);
  });

  it('translates every static string, leaving only Git, git commands and paths in Latin', () => {
    // Symbols with no words (the close cross, the worktree glyph) have nothing to translate.
    const bad = chinese.filter(
      (text, i) => /[A-Za-z]/.test(english[i]) && (text === english[i] || leftover(text).length > 0)
    );
    expect(bad).toEqual([]);
  });

  it('keeps the user/git slots out of the translator', () => {
    const doc = zh.dom.window.document;
    for (const id of ['worktreeModalCase', 'closeConfirmWorktreeName']) {
      expect(doc.getElementById(id)!.hasAttribute('data-i18n-skip'), id).toBe(true);
    }
  });

  it('translates the strings session-ui.js inserts at runtime', () => {
    const runtime = [
      'Git worktrees…',
      'Loading worktrees…',
      'No worktrees yet. Create one below.',
      'detached HEAD',
      'main checkout',
      'not created by Codeman',
      'locked',
      'missing',
      'Open',
      'Start a session in this worktree',
      'Remove…',
      'git worktree remove refuses while the worktree has uncommitted or untracked files. Codeman never forces it.',
      'Its folder is gone. Removing it clears the record git keeps of it, so the name can be used again.',
      'Also delete its branch (git branch -d keeps a branch that is not merged)',
      'Remove worktree',
      'Cancel',
      'Name: letters, digits, ".", "_" and "-", starting with a letter or digit, at most 64 characters.',
      'A launch is already in progress',
      'Codeman did not answer.',
      'Worktrees…',
      '2 sessions',
    ];
    // Each literal is really in session-ui.js (the count badge is built from `${n} session`).
    for (const s of runtime.filter((r) => r !== '2 sessions')) expect(SESSION_UI.includes(`'${s}'`), s).toBe(true);
    expect(SESSION_UI).toContain('session${wt.sessionCount === 1 ?');
    const bad = runtime.filter((s) => {
      const text = zh.api.t(s);
      return text === s || leftover(text).length > 0 || en.api.t(s) !== s;
    });
    expect(bad).toEqual([]);
  });

  it('translates the toasts and keeps the names verbatim', () => {
    expect(zh.api.t('Worktree fix-login created on branch feat/login')).toBe('已创建工作树 fix-login，分支 feat/login');
    expect(zh.api.t('Worktree fix-login and branch worktree-fix-login removed')).toBe(
      '已移除工作树 fix-login 和分支 worktree-fix-login'
    );
    expect(zh.api.t('Worktree fix-login removed')).toBe('已移除工作树 fix-login');
    expect(
      zh.api.t("Worktree w2 removed. Branch worktree-w2 kept: error: the branch 'worktree-w2' is not fully merged")
    ).toBe("已移除工作树 w2。保留了分支 worktree-w2：error: the branch 'worktree-w2' is not fully merged");
    expect(zh.api.t('Worktree w1 was kept: git refused to remove the worktree: fatal: x')).toBe(
      '工作树 w1 已保留：git refused to remove the worktree: fatal: x'
    );
  });
});
