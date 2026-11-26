/**
 * @fileoverview A Docker session's reported transcript path is watched on the host
 * (src/web/claude-conversation-report.ts).
 *
 * Claude in a Docker case runs with `HOME=/home/agent`, so a hook or the statusline reports a
 * transcript under `/home/agent/.claude/projects`, which does not exist on the host. The case
 * mounts the host's `~/.claude/projects` there, so the watcher must follow the host's copy.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hostTranscriptPath, noteClaudeConversationReport } from '../src/web/claude-conversation-report.js';
import { CONTAINER_CLAUDE_DIR } from '../src/docker-hosts.js';
import type { Session } from '../src/session.js';

const docker = { docker: { containerName: 'codeman-case' } } as unknown as Pick<Session, 'docker'>;
const reported = `${CONTAINER_CLAUDE_DIR}/projects/-workspace-app/abc.jsonl`;

describe('hostTranscriptPath', () => {
  it("maps a Docker session's container path into the host's projects folder", () => {
    expect(hostTranscriptPath(docker, reported)).toBe(
      join(homedir(), '.claude', 'projects', '-workspace-app', 'abc.jsonl')
    );
  });

  it('leaves a local session, a path outside the projects folder and a path with `..` as reported', () => {
    expect(hostTranscriptPath({ docker: undefined }, reported)).toBe(reported);
    expect(hostTranscriptPath(undefined, reported)).toBe(reported);
    expect(hostTranscriptPath(docker, '/home/agent/elsewhere/abc.jsonl')).toBe('/home/agent/elsewhere/abc.jsonl');
    const escape = `${CONTAINER_CLAUDE_DIR}/projects/../../.ssh/id_rsa`;
    expect(hostTranscriptPath(docker, escape)).toBe(escape);
  });
});

describe('noteClaudeConversationReport', () => {
  it("starts a Docker session's watcher on the host path", () => {
    const startTranscriptWatcher = vi.fn();
    const session = { ...docker, claudeSessionChain: [], adoptClaudeSessionId: vi.fn() };
    const ctx = {
      sessions: new Map([['s1', session]]),
      startTranscriptWatcher,
      persistSessionState: vi.fn(),
    } as unknown as Parameters<typeof noteClaudeConversationReport>[0];
    noteClaudeConversationReport(ctx, 's1', { transcript_path: reported });
    expect(startTranscriptWatcher).toHaveBeenCalledWith(
      's1',
      join(homedir(), '.claude', 'projects', '-workspace-app', 'abc.jsonl')
    );
  });
});
