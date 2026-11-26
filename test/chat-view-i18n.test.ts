/**
 * @fileoverview The chat view's strings in Chinese (zh-CN), run through the real translator.
 *
 * chat-view.js looks its strings up itself (`_chatViewT`), because i18n.js skips the
 * `data-i18n-skip` conversation. Pinned here:
 * - each string the chat view draws reads in Chinese, and the numbers in it survive;
 * - the setting that shows or hides the Chat / Terminal switch reads in Chinese.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, describe, expect, it } from 'vitest';

const I18N = readFileSync(resolve(import.meta.dirname, '../src/web/public/i18n.js'), 'utf8');

type Api = { t(s: string, vars?: Record<string, string>): string; configure(o: Record<string, string>): void };

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  runScripts: 'outside-only',
  url: 'http://localhost/',
});
vm.runInContext(I18N, dom.getInternalVMContext(), { filename: 'i18n.js' });
const api = (dom.window as unknown as { CodemanI18n: Api }).CodemanI18n;
api.configure({ language: 'zh-CN' });
afterAll(() => dom.window.close());

describe('the chat view in zh-CN', () => {
  it('translates the fold button, the empty thread and the dialog notice', () => {
    expect(api.t('No messages yet.')).toBe('还没有消息。');
    expect(api.t('Show all (3 lines)')).toBe('显示全部（3 行）');
    expect(api.t('Claude is waiting for your answer in the terminal.')).toBe('Claude 正在终端中等待你的回答。');
    // The notification drawer shows the same sentence without the period.
    expect(api.t('Codex is waiting for your answer in the terminal')).toBe('Codex 正在终端中等待你的回答');
  });

  it('translates the Chat / Terminal switch setting', () => {
    expect(api.t('Show the Chat / Terminal switch')).toBe('显示聊天 / 终端开关');
    expect(
      api.t(
        'Show the Chat / Terminal switch at the top right of a Claude session. Alt+Shift+C switches views without it. Not on phones.'
      )
    ).toBe('在 Claude 会话右上角显示聊天 / 终端开关。没有它时，Alt+Shift+C 也能切换视图。手机上不可用。');
  });
});
