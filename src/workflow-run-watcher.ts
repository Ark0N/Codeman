/**
 * @fileoverview Workflow (ultracode) Run Watcher
 *
 * Emits events powering the master-detail "working agents" view (tasks/phases on
 * the LEFT, per-agent tokens/tool-calls on the RIGHT) AND the floating run
 * windows, from TWO disk sources per run:
 *
 *   1. COMPLETION artifact — `…/workflows/wf_<id>.json`. The Workflow runtime
 *      writes this with the FULL run state (phases, per-agent tokens/tool-calls,
 *      result), but — as of the mid-2026 runtime — only when the run FINISHES
 *      (always a terminal status). It is the authoritative, detailed record.
 *   2. LIVE transcript dir — `…/subagents/workflows/wf_<id>/` (agent-*.jsonl +
 *      journal.jsonl). This appears WHILE a run is in flight, before any
 *      `wf_<id>.json` exists. From it we synthesize a minimal ACTIVE run
 *      (status 'running', agent slots keyed by agentId, lastActivityAt from file
 *      mtimes) so the floating window pops DURING the run instead of only after.
 *
 * Precedence: when a completion `wf_<id>.json` exists it ALWAYS supersedes the
 * synthesized live record (same runId), so a finished run shows full detail and
 * the normal finish→auto-close flow runs. Without source 2 the floating-window
 * feature is dead for live runs (the completion file only lands at the end, so
 * the watcher would never see a run while it is active).
 *
 * Still STANDALONE: it never imports from or touches subagent-watcher.ts. It
 * independently reads the same `subagents/workflows/` tree subagent-watcher uses,
 * but as a separate singleton with no shared mutable state.
 *
 * Discovery is dual: a periodic poll (catches new run dirs + removals) plus a
 * per-dir chokidar watcher (live updates). A per-source mtime skip keeps the hot
 * path cheap — the completion JSON / live dir is re-read only when its mtime moves.
 *
 * @module workflow-run-watcher
 */

import { EventEmitter } from 'node:events';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from 'chokidar';

import type { WorkflowRunInfo, WorkflowRunSummary, WorkflowAgentInfo, WorkflowRunPhase } from './types/workflow-run.js';
import { closeWatcherOnError } from './utils/close-watcher-on-error.js';
import { LRUMap } from './utils/lru-map.js';
import {
  WORKFLOW_RUN_POLL_INTERVAL_MS,
  MAX_CACHED_WORKFLOW_RUNS,
  WORKFLOW_RUN_RECENT_WINDOW_MIN,
} from './config/workflow-config.js';

const WORKFLOWS_SUBDIR = 'workflows';
const SUBAGENTS_SUBDIR = 'subagents';
const RUN_FILE_PREFIX = 'wf_';
const RUN_FILE_SUFFIX = '.json';
const LIVE_JOURNAL_FILE = 'journal.jsonl';
const LIVE_AGENT_PREFIX = 'agent-';
const LIVE_TRANSCRIPT_SUFFIX = '.jsonl';
const SCRIPTS_SUBDIR = 'scripts';

/** Hard caps on the largest per-agent strings so a 28-agent run stays compact. */
const PROMPT_PREVIEW_MAX = 200;
const RESULT_PREVIEW_MAX = 240;
/** Cap a live script read so a runaway/huge embedded script can't blow memory. */
const SCRIPT_READ_MAX_BYTES = 512 * 1024;
/** LRU cap on cached per-agent transcript stats across all live runs. */
const MAX_CACHED_AGENT_STATS = 2000;

function truncate(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** First text from a transcript message's `content` (string or content-block array). */
function extractMessageText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const t = (block as { text?: string }).text;
        if (typeof t === 'string' && t.trim()) return t.trim();
      }
    }
  }
  return undefined;
}

/**
 * Isolate the `meta = { … }` object literal from a workflow script so that later
 * declarations (e.g. JSON-Schema objects with their own `description:`/`title:`
 * fields, or prose containing `phases: [`) can't be mistaken for meta. Brace-matches
 * naively — a `{`/`}` inside a string value can still confuse it, in which case we
 * return undefined and the caller falls back to scanning the whole body. Best-effort.
 */
function extractMetaBlock(body: string): string | undefined {
  const m = /(?:^|[^A-Za-z0-9_])(?:export\s+const|const|let|var)\s+meta\s*=\s*\{/.exec(body);
  if (!m) return undefined;
  const open = body.indexOf('{', m.index);
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) return body.slice(open, i + 1);
  }
  return undefined; // unterminated (truncated script) — caller falls back to whole body
}

/**
 * Best-effort extraction of a single/double-quoted `key: '...'` value from a workflow
 * `meta` literal (the script is JS we must not eval). The key is anchored to a key
 * position (`{`/`,`/whitespace before it) so e.g. `description` can't match the tail
 * of `..._description`; pass the scoped meta block so later same-named schema fields
 * can't win. Returns undefined on no match.
 */
function extractMetaString(body: string, key: string): string | undefined {
  const re = new RegExp(`(?:^|[{,\\s])${key}\\s*:\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`);
  const m = re.exec(body);
  return m ? m[2].replace(/\\(['"\\`])/g, '$1') : undefined;
}

/** Best-effort `meta.phases: [{title, detail}, …]` extraction (pass the scoped meta block). */
function extractMetaPhases(body: string): WorkflowRunPhase[] {
  const keyMatch = /(?:^|[^A-Za-z0-9_])phases\s*:\s*\[/.exec(body);
  if (!keyMatch) return [];
  const open = body.indexOf('[', keyMatch.index);
  if (open < 0) return [];
  // Brace-match to the array's closing ] so nested arrays don't end it early.
  let depth = 0;
  let end = -1;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '[') depth++;
    else if (body[i] === ']' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  const block = body.slice(open, end + 1);
  const phases: WorkflowRunPhase[] = [];
  const re = /title\s*:\s*(['"])((?:\\.|(?!\1).)*)\1(?:\s*,\s*detail\s*:\s*(['"])((?:\\.|(?!\3).)*)\3)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null && phases.length < 20) {
    phases.push({
      title: m[2].replace(/\\(['"\\`])/g, '$1'),
      detail: (m[4] || '').replace(/\\(['"\\`])/g, '$1'),
    });
  }
  return phases;
}

/** Drop the heavy `agents[]` for list/snapshot use. */
export function summarizeRun(info: WorkflowRunInfo): WorkflowRunSummary {
  const { agents: _agents, ...summary } = info;
  void _agents;
  return summary;
}

interface DiscoveredRun {
  filePath: string;
  projectHash: string;
  sessionUuid: string;
  runId: string;
}

/** An in-flight run discovered from its `subagents/workflows/wf_<id>/` transcript dir. */
interface DiscoveredLiveRun {
  dirPath: string;
  projectHash: string;
  sessionUuid: string;
  runId: string;
}

/** Per-agent stats parsed from one `agent-<id>.jsonl` transcript (mtime-cached). */
interface AgentTranscriptStats {
  /** Tokens for the agent's LAST usage-bearing message (in+out+cache) ≈ the completion-JSON `tokens`. */
  tokens: number;
  /** Count of `tool_use` blocks across the transcript (matches the completion-JSON `toolCalls`). */
  toolCalls: number;
  /** Most-recent model id seen. */
  model: string;
  /** Name of the most-recent `tool_use` block. */
  lastToolName?: string;
  /** First user-message text, truncated — a hint of what the agent was asked. */
  promptPreview?: string;
}

/** Workflow meta derived live from `workflows/scripts/<name>-<runId>.js`. */
interface LiveWorkflowMeta {
  workflowName?: string;
  summary?: string;
  phases: WorkflowRunPhase[];
}

/** A live agent file on disk (transcript and/or meta), keyed by its `<id>` stem. */
interface LiveAgentFile {
  agentId: string;
  transcriptPath?: string;
  transcriptMtime?: number;
}

/** A `workflowProgress[]` entry as it appears on disk (loosely typed for defensive parsing). */
interface RawProgressEntry {
  type?: string;
  index?: number;
  label?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
  state?: string;
  queuedAt?: number;
  lastProgressAt?: number;
  promptPreview?: string;
  agentId?: string;
  startedAt?: number;
  attempt?: number;
  tokens?: number;
  toolCalls?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  durationMs?: number;
  resultPreview?: string;
}

export class WorkflowRunWatcher extends EventEmitter {
  private projectsDir: string;
  private pollTimer: NodeJS.Timeout | null = null;
  private _isRunning = false;

  /** runId -> latest parsed run info (LRU-bounded). */
  private runs = new LRUMap<string, WorkflowRunInfo>({ maxSize: MAX_CACHED_WORKFLOW_RUNS });
  /** absolute run-file path -> last seen mtimeMs (skip unchanged files). */
  private fileMtimes = new Map<string, number>();
  /** runId -> absolute run-file path (for mtime cleanup on removal). */
  private runIdToPath = new Map<string, string>();
  /** absolute live transcript-dir path -> newest member mtimeMs (skip unchanged live runs). */
  private liveDirMtimes = new Map<string, number>();
  /** runId -> absolute live transcript-dir path (for mtime cleanup on removal). */
  private runIdToLiveDir = new Map<string, string>();
  /** transcript abs path -> { mtimeMs, stats }; re-parse a transcript only when its mtime moves. */
  private agentStatCache = new LRUMap<string, { mtimeMs: number; stats: AgentTranscriptStats }>({
    maxSize: MAX_CACHED_AGENT_STATS,
  });
  /** runId -> derived script meta (immutable per run; re-derived only until a name is found). */
  private liveMetaCache = new Map<string, LiveWorkflowMeta>();
  /** journal abs path -> { mtimeMs, parsed }; re-parse the journal only when it grows. */
  private journalCache = new Map<
    string,
    { mtimeMs: number; parsed: { startedOrder: string[]; doneIds: Set<string> } }
  >();
  /** watched-dir absolute path -> chokidar watcher (workflows/ + subagents/workflows/). */
  private dirWatchers = new Map<string, ChokidarWatcher>();

  constructor(projectsDir?: string) {
    super();
    this.projectsDir = projectsDir || join(homedir(), '.claude', 'projects');
    this.setMaxListeners(50);
  }

  // ========== Public API ==========

  isRunning(): boolean {
    return this._isRunning;
  }

  start(): void {
    if (this._isRunning) return;
    this._isRunning = true;
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), WORKFLOW_RUN_POLL_INTERVAL_MS);
  }

  stop(): void {
    this._isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const watcher of this.dirWatchers.values()) {
      watcher.close().catch(() => {}); // best-effort teardown
    }
    this.dirWatchers.clear();
    this.runs.clear();
    this.fileMtimes.clear();
    this.runIdToPath.clear();
    this.liveDirMtimes.clear();
    this.runIdToLiveDir.clear();
    this.agentStatCache.clear();
    this.liveMetaCache.clear();
    this.journalCache.clear();
  }

  /** All cached runs (no recency filter), most-recently-active first. */
  getAllRuns(): WorkflowRunInfo[] {
    return Array.from(this.runs.values()).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /** Runs active within the last `minutes`, most-recently-active first. */
  getRecentRuns(minutes: number = WORKFLOW_RUN_RECENT_WINDOW_MIN): WorkflowRunInfo[] {
    const cutoff = Date.now() - minutes * 60_000;
    return this.getAllRuns().filter((r) => r.lastActivityAt >= cutoff);
  }

  /**
   * Lightweight summaries (no agents[]) of ALL cached runs, most-recently-active
   * first. This is the LEFT-pane list + getLightState snapshot source: the cache
   * is LRU-bounded (MAX_CACHED_WORKFLOW_RUNS), so it's already size-capped, and a
   * run-browser should show past runs — NOT hide everything older than a window.
   */
  getAllRunSummaries(): WorkflowRunSummary[] {
    return this.getAllRuns().map(summarizeRun);
  }

  /** Summaries filtered to the last `minutes` of activity (opt-in via ?minutes). */
  getRecentRunSummaries(minutes: number = WORKFLOW_RUN_RECENT_WINDOW_MIN): WorkflowRunSummary[] {
    return this.getRecentRuns(minutes).map(summarizeRun);
  }

  getRun(runId: string): WorkflowRunInfo | undefined {
    return this.runs.get(runId);
  }

  getStats(): { runCount: number; running: number; agentCount: number } {
    let running = 0;
    let agentCount = 0;
    for (const run of this.runs.values()) {
      if (run.status === 'running') running++;
      agentCount += run.agents.length;
    }
    return { runCount: this.runs.size, running, agentCount };
  }

  // ========== Private ==========

  private poll(): void {
    this.pollAsync().catch(() => {
      // Filesystem may be transiently unavailable; the next poll retries.
    });
  }

  private async pollAsync(): Promise<void> {
    const { files, liveDirs, watchDirs } = await this.discover();

    // Install a live watcher for each watched dir; tear down watchers for dirs that vanished.
    for (const dir of watchDirs) this.ensureDirWatcher(dir);
    for (const dir of Array.from(this.dirWatchers.keys())) {
      if (!watchDirs.has(dir)) this.removeDirWatcher(dir);
    }

    const seenRunIds = new Set<string>();
    const realRunIds = new Set<string>();
    for (const file of files) {
      seenRunIds.add(file.runId);
      realRunIds.add(file.runId);
      await this.maybeParse(file);
    }

    // In-flight runs: synthesize from the transcript tree ONLY while no completion
    // wf_*.json exists yet — the real file (full detail + terminal status) supersedes.
    for (const live of liveDirs) {
      if (realRunIds.has(live.runId)) continue;
      seenRunIds.add(live.runId);
      await this.maybeParseLive(live);
    }

    // Removal by set-diff: a cached run discoverable from neither source.
    for (const runId of Array.from(this.runs.keys())) {
      if (!seenRunIds.has(runId)) {
        this.runs.delete(runId);
        const path = this.runIdToPath.get(runId);
        if (path) this.fileMtimes.delete(path);
        this.runIdToPath.delete(runId);
        const liveDir = this.runIdToLiveDir.get(runId);
        if (liveDir) {
          this.liveDirMtimes.delete(liveDir);
          // Drop cached transcript stats + journal parse under this run's live dir.
          const prefix = liveDir.endsWith('/') ? liveDir : liveDir + '/';
          for (const key of Array.from(this.agentStatCache.keys())) {
            if (key.startsWith(prefix)) this.agentStatCache.delete(key);
          }
          for (const key of Array.from(this.journalCache.keys())) {
            if (key.startsWith(prefix)) this.journalCache.delete(key);
          }
        }
        this.liveMetaCache.delete(runId);
        this.runIdToLiveDir.delete(runId);
        this.emit('run_removed', { runId });
      }
    }
  }

  /**
   * Walk projects/<projHash>/<sessionUuid>/ for both run sources:
   *   - completion files: `workflows/wf_*.json`
   *   - in-flight runs:   `subagents/workflows/wf_<id>/` (transcript dirs)
   * Returns the dirs to chokidar-watch (so a new run/file is caught sub-poll).
   */
  private async discover(): Promise<{
    files: DiscoveredRun[];
    liveDirs: DiscoveredLiveRun[];
    watchDirs: Set<string>;
  }> {
    const files: DiscoveredRun[] = [];
    const liveDirs: DiscoveredLiveRun[] = [];
    const watchDirs = new Set<string>();

    let projectHashes: string[];
    try {
      projectHashes = await readdir(this.projectsDir);
    } catch {
      return { files, liveDirs, watchDirs };
    }

    for (const projectHash of projectHashes) {
      let sessions: string[];
      try {
        sessions = await readdir(join(this.projectsDir, projectHash));
      } catch {
        continue;
      }
      for (const sessionUuid of sessions) {
        const sessionDir = join(this.projectsDir, projectHash, sessionUuid);

        // (1) Completion artifacts: workflows/wf_*.json
        const workflowsDir = join(sessionDir, WORKFLOWS_SUBDIR);
        try {
          const names = await readdir(workflowsDir);
          let hasRun = false;
          for (const name of names) {
            if (!name.startsWith(RUN_FILE_PREFIX) || !name.endsWith(RUN_FILE_SUFFIX)) continue;
            hasRun = true;
            files.push({
              filePath: join(workflowsDir, name),
              projectHash,
              sessionUuid,
              runId: name.slice(0, -RUN_FILE_SUFFIX.length),
            });
          }
          if (hasRun) watchDirs.add(workflowsDir);
        } catch {
          // no workflows dir for this session — normal
        }

        // (2) In-flight runs: subagents/workflows/wf_*/
        const liveParent = join(sessionDir, SUBAGENTS_SUBDIR, WORKFLOWS_SUBDIR);
        try {
          const names = await readdir(liveParent);
          let hasLive = false;
          for (const name of names) {
            if (!name.startsWith(RUN_FILE_PREFIX) || name.endsWith(RUN_FILE_SUFFIX)) continue; // wf_<id> dir, not a file
            hasLive = true;
            liveDirs.push({
              dirPath: join(liveParent, name),
              projectHash,
              sessionUuid,
              runId: name,
            });
          }
          if (hasLive) watchDirs.add(liveParent);
        } catch {
          // no subagents/workflows dir for this session — normal
        }
      }
    }
    return { files, liveDirs, watchDirs };
  }

  private async maybeParse(file: DiscoveredRun): Promise<void> {
    let mtime: number;
    try {
      mtime = (await stat(file.filePath)).mtimeMs;
    } catch {
      return; // vanished between discover and stat
    }
    if (this.fileMtimes.get(file.filePath) === mtime) return;
    this.fileMtimes.set(file.filePath, mtime);

    const info = await this.parseFile(file);
    if (!info) return;

    const existed = this.runs.has(info.runId);
    this.runs.set(info.runId, info);
    this.runIdToPath.set(info.runId, file.filePath);
    this.emit(existed ? 'run_updated' : 'run_discovered', info);
  }

  /**
   * Re-synthesize an in-flight run from its transcript dir. Cheap pass first: stat
   * the dir members and skip entirely when the newest mtime is unchanged, so an idle
   * poll never reads a single (large) transcript. Only on a real change do we parse —
   * and even then per-transcript stats come from an mtime-keyed cache, so only the
   * transcripts that actually grew are re-read.
   */
  private async maybeParseLive(live: DiscoveredLiveRun): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(live.dirPath);
    } catch {
      return; // vanished between discover and read
    }

    // Cheap pass: newest member mtime + the agent-file set (no transcript reads yet).
    let newestMtime = 0;
    let journalPath: string | null = null;
    let journalMtime = 0;
    const agentFiles = new Map<string, LiveAgentFile>();
    for (const name of entries) {
      if (name !== LIVE_JOURNAL_FILE && !name.startsWith(LIVE_AGENT_PREFIX)) continue;
      const full = join(live.dirPath, name);
      let m = 0;
      try {
        m = (await stat(full)).mtimeMs;
      } catch {
        continue; // entry vanished — ignore
      }
      if (m > newestMtime) newestMtime = m;
      if (name === LIVE_JOURNAL_FILE) {
        journalPath = full;
        journalMtime = m;
        continue;
      }
      // agent-<stem>.jsonl (transcript) or agent-<stem>.meta.json (queued-slot marker)
      const stem = name.slice(LIVE_AGENT_PREFIX.length).replace(/\.(meta\.json|jsonl)$/, '');
      if (!stem) continue;
      const slot = agentFiles.get(stem) || { agentId: stem };
      if (name.endsWith(LIVE_TRANSCRIPT_SUFFIX)) {
        slot.transcriptPath = full;
        slot.transcriptMtime = m;
      }
      agentFiles.set(stem, slot);
    }
    if (agentFiles.size === 0) return; // nothing to show yet

    // Skip the expensive parse when nothing changed since the last synthesis.
    if (this.liveDirMtimes.get(live.dirPath) === newestMtime) return;
    this.liveDirMtimes.set(live.dirPath, newestMtime);

    const info = await this.parseLiveDir(live, agentFiles, journalPath, journalMtime, newestMtime);
    if (!info) return;

    const existed = this.runs.has(info.runId);
    this.runs.set(info.runId, info);
    this.runIdToLiveDir.set(info.runId, live.dirPath);
    this.emit(existed ? 'run_updated' : 'run_discovered', info);
  }

  /**
   * Build an ACTIVE WorkflowRunInfo from a live transcript dir, ENRICHED so the
   * floating window / panel show real data mid-run rather than empty slots:
   *   - per-agent tokens + tool-calls + model + last tool, parsed from each
   *     `agent-<id>.jsonl` (mtime-cached — only changed transcripts are re-read);
   *   - per-agent state: 'done' once the journal logs a `result` (→ green badge),
   *     'progress' once it logs `started` or a transcript exists (→ yellow), else 'start';
   *   - run name/summary/phases from the live `workflows/scripts/<name>-<runId>.js`
   *     (the completion wf_<id>.json, which carries these, only lands at the end);
   *   - run totals = sums of the per-agent stats.
   */
  private async parseLiveDir(
    live: DiscoveredLiveRun,
    agentFiles: Map<string, LiveAgentFile>,
    journalPath: string | null,
    journalMtime: number,
    newestMtime: number
  ): Promise<WorkflowRunInfo | null> {
    const { startedOrder, doneIds } = journalPath
      ? await this.readJournal(journalPath, journalMtime)
      : { startedOrder: [] as string[], doneIds: new Set<string>() };
    const startIndex = new Map<string, number>();
    startedOrder.forEach((id, i) => startIndex.set(id, i));

    // Order agents by journal launch order; not-yet-started ones trail (sorted by id).
    const ids = Array.from(agentFiles.keys()).sort((a, b) => {
      const ia = startIndex.has(a) ? (startIndex.get(a) as number) : Number.MAX_SAFE_INTEGER;
      const ib = startIndex.has(b) ? (startIndex.get(b) as number) : Number.MAX_SAFE_INTEGER;
      if (ia !== ib) return ia - ib;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    let totalTokens = 0;
    let totalToolCalls = 0;
    let defaultModel = '';
    const agents: WorkflowAgentInfo[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const file = agentFiles.get(id) as LiveAgentFile;
      const stats = file.transcriptPath
        ? await this.agentTranscriptStats(file.transcriptPath, file.transcriptMtime || 0)
        : null;
      const state = doneIds.has(id) ? 'done' : startIndex.has(id) || file.transcriptPath ? 'progress' : 'start';
      if (stats) {
        totalTokens += stats.tokens;
        totalToolCalls += stats.toolCalls;
        if (stats.model && !defaultModel) defaultModel = stats.model;
      }
      agents.push({
        index: i + 1,
        label: `agent ${i + 1}`,
        phaseIndex: 1,
        phaseTitle: '',
        model: stats?.model || '',
        state,
        agentId: id,
        tokens: stats ? stats.tokens : undefined,
        toolCalls: stats ? stats.toolCalls : undefined,
        lastToolName: stats?.lastToolName,
        promptPreview: stats?.promptPreview,
      });
    }

    // Script meta is immutable for the life of a run, so derive it at most once.
    // Re-derive only while we still lack a name (the script can land a poll or two
    // after the first transcripts, which seed the run before the script exists).
    let meta = this.liveMetaCache.get(live.runId);
    if (!meta || !meta.workflowName) {
      meta = await this.deriveLiveWorkflowMeta(live);
      this.liveMetaCache.set(live.runId, meta);
    }

    return {
      runId: live.runId,
      workflowName: meta.workflowName,
      summary: meta.summary,
      status: 'running',
      agentCount: agents.length,
      totalTokens,
      totalToolCalls,
      defaultModel: defaultModel || undefined,
      phases: meta.phases,
      agents,
      sessionUuid: live.sessionUuid,
      projectHash: live.projectHash,
      lastActivityAt: newestMtime || 0,
    };
  }

  /** Parse one agent transcript for token/tool stats; cached on the file's mtime. */
  private async agentTranscriptStats(path: string, mtimeMs: number): Promise<AgentTranscriptStats | null> {
    // peek (not get) on the hit-check so a cache HIT doesn't churn the LRU — every
    // active agent is looked up each poll, and get() would delete+reinsert each time.
    const cached = this.agentStatCache.peek(path);
    if (cached && cached.mtimeMs === mtimeMs) return cached.stats;
    let text: string;
    try {
      text = await readFile(path, 'utf-8');
    } catch {
      return null; // vanished mid-poll
    }
    let tokens = 0;
    let toolCalls = 0;
    let model = '';
    let lastToolName: string | undefined;
    let promptPreview: string | undefined;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let entry: { type?: string; message?: unknown };
      try {
        entry = JSON.parse(line) as { type?: string; message?: unknown };
      } catch {
        continue; // tolerate a partially-written trailing line
      }
      const msg = entry.message as
        | {
            model?: string;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            content?: Array<{ type?: string; name?: string; text?: string }> | string;
          }
        | undefined;
      if (!promptPreview && entry.type === 'user' && msg) {
        promptPreview = truncate(extractMessageText(msg.content), PROMPT_PREVIEW_MAX);
      }
      if (!msg || typeof msg !== 'object') continue;
      if (typeof msg.model === 'string' && msg.model) model = msg.model;
      const u = msg.usage;
      if (u) {
        const total =
          (u.input_tokens || 0) +
          (u.output_tokens || 0) +
          (u.cache_read_input_tokens || 0) +
          (u.cache_creation_input_tokens || 0);
        // Anthropic usage already reflects cumulative context, so the agent's running
        // token total ≈ its LATEST usage-bearing message — last non-zero wins.
        if (total > 0) tokens = total;
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && block.type === 'tool_use' && typeof block.name === 'string') {
            toolCalls++;
            lastToolName = block.name;
          }
        }
      }
    }
    const stats: AgentTranscriptStats = { tokens, toolCalls, model, lastToolName, promptPreview };
    this.agentStatCache.set(path, { mtimeMs, stats });
    return stats;
  }

  /**
   * Read the run journal: agent ids in `started` order plus the set that already
   * logged a terminal `result`. (`started` lines appear in launch order.)
   */
  private async readJournal(
    journalPath: string,
    mtimeMs: number
  ): Promise<{ startedOrder: string[]; doneIds: Set<string> }> {
    const cached = this.journalCache.get(journalPath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.parsed;
    const startedOrder: string[] = [];
    const seenStarted = new Set<string>();
    const doneIds = new Set<string>();
    let text: string;
    try {
      text = await readFile(journalPath, 'utf-8');
    } catch {
      return { startedOrder, doneIds }; // journal not written yet
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as { type?: string; agentId?: string };
        if (!ev || typeof ev.agentId !== 'string') continue;
        if (ev.type === 'started' && !seenStarted.has(ev.agentId)) {
          seenStarted.add(ev.agentId);
          startedOrder.push(ev.agentId);
        } else if (ev.type === 'result') {
          doneIds.add(ev.agentId);
        }
      } catch {
        // tolerate a partially-written trailing line
      }
    }
    const parsed = { startedOrder, doneIds };
    this.journalCache.set(journalPath, { mtimeMs, parsed });
    return parsed;
  }

  /**
   * Derive name/summary/phases for a live run from its persisted script file
   * `…/workflows/scripts/<name>-<runId>.js`. The filename yields a reliable name;
   * `meta.description`/`meta.phases` are best-effort regex extractions (the script is
   * JS we must not eval), so any parse miss simply leaves those optional fields absent.
   */
  private async deriveLiveWorkflowMeta(live: DiscoveredLiveRun): Promise<LiveWorkflowMeta> {
    const empty: LiveWorkflowMeta = { phases: [] };
    const scriptsDir = join(this.projectsDir, live.projectHash, live.sessionUuid, WORKFLOWS_SUBDIR, SCRIPTS_SUBDIR);
    let names: string[];
    try {
      names = await readdir(scriptsDir);
    } catch {
      return empty;
    }
    const suffix = `-${live.runId}.js`;
    const fileName = names.find((n) => n.endsWith(suffix)) || names.find((n) => n.includes(live.runId));
    if (!fileName) return empty;
    const nameFromFile = fileName.endsWith(suffix) ? fileName.slice(0, -suffix.length) : fileName.replace(/\.js$/, '');
    let body = '';
    try {
      body = (await readFile(join(scriptsDir, fileName), 'utf-8')).slice(0, SCRIPT_READ_MAX_BYTES);
    } catch {
      return { workflowName: nameFromFile || undefined, phases: [] };
    }
    // Scope name/summary/phases parsing to the `meta` literal so later script
    // declarations (schemas, prose) can't be mistaken for it.
    const metaBlock = extractMetaBlock(body) || body;
    return {
      workflowName: nameFromFile || extractMetaString(metaBlock, 'name') || undefined,
      summary: extractMetaString(metaBlock, 'description') || undefined,
      phases: extractMetaPhases(metaBlock),
    };
  }

  /**
   * Parse a wf_<runId>.json into WorkflowRunInfo, STRIPPING the heavyweight
   * `script`/`scriptPath`/`result`/`logs` fields (the embedded script alone is
   * 15–660KB) so they never reach the cache, SSE, or routes.
   */
  private async parseFile(file: DiscoveredRun): Promise<WorkflowRunInfo | null> {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(file.filePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      return null; // mid-write or malformed — next mtime change re-parses
    }
    if (!raw || typeof raw !== 'object') return null;

    const progress = Array.isArray(raw.workflowProgress) ? (raw.workflowProgress as RawProgressEntry[]) : [];
    const agents: WorkflowAgentInfo[] = progress
      .filter((e) => e && e.type === 'workflow_agent')
      .map((e) => this.toAgent(e));

    const phases: WorkflowRunPhase[] = Array.isArray(raw.phases)
      ? (raw.phases as Array<Record<string, unknown>>).map((p) => ({
          title: typeof p.title === 'string' ? p.title : '',
          detail: typeof p.detail === 'string' ? p.detail : '',
        }))
      : [];

    let lastProgress = 0;
    for (const a of agents) {
      if (typeof a.lastProgressAt === 'number' && a.lastProgressAt > lastProgress) lastProgress = a.lastProgressAt;
    }
    const startTime = typeof raw.startTime === 'number' ? raw.startTime : undefined;
    const lastActivityAt = lastProgress || startTime || 0;

    return {
      runId: typeof raw.runId === 'string' ? raw.runId : file.runId,
      workflowName: typeof raw.workflowName === 'string' ? raw.workflowName : undefined,
      status: typeof raw.status === 'string' ? raw.status : undefined,
      summary: typeof raw.summary === 'string' ? raw.summary : undefined,
      agentCount: typeof raw.agentCount === 'number' ? raw.agentCount : undefined,
      totalTokens: typeof raw.totalTokens === 'number' ? raw.totalTokens : undefined,
      totalToolCalls: typeof raw.totalToolCalls === 'number' ? raw.totalToolCalls : undefined,
      durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : undefined,
      startTime,
      timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : undefined,
      defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : undefined,
      taskId: typeof raw.taskId === 'string' ? raw.taskId : undefined,
      error: typeof raw.error === 'string' ? raw.error : undefined,
      phases,
      agents,
      sessionUuid: file.sessionUuid,
      projectHash: file.projectHash,
      lastActivityAt,
    };
  }

  private toAgent(e: RawProgressEntry): WorkflowAgentInfo {
    return {
      index: typeof e.index === 'number' ? e.index : 0,
      label: typeof e.label === 'string' ? e.label : '',
      phaseIndex: typeof e.phaseIndex === 'number' ? e.phaseIndex : 0,
      phaseTitle: typeof e.phaseTitle === 'string' ? e.phaseTitle : '',
      model: typeof e.model === 'string' ? e.model : '',
      state: typeof e.state === 'string' ? e.state : 'start',
      queuedAt: e.queuedAt,
      lastProgressAt: e.lastProgressAt,
      promptPreview: truncate(e.promptPreview, PROMPT_PREVIEW_MAX),
      agentId: e.agentId,
      startedAt: e.startedAt,
      attempt: e.attempt,
      tokens: e.tokens,
      toolCalls: e.toolCalls,
      lastToolName: e.lastToolName,
      lastToolSummary: truncate(e.lastToolSummary, RESULT_PREVIEW_MAX),
      durationMs: e.durationMs,
      resultPreview: truncate(e.resultPreview, RESULT_PREVIEW_MAX),
    };
  }

  private ensureDirWatcher(workflowsDir: string): void {
    if (this.dirWatchers.has(workflowsDir)) return;
    try {
      const watcher = chokidarWatch(workflowsDir, {
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 200 },
        ignoreInitial: true,
        persistent: false,
      });
      const handler = () => this.poll();
      watcher.on('add', handler);
      watcher.on('change', handler);
      watcher.on('unlink', handler);
      // subagents/workflows/ children are wf_<id>/ DIRS — catch their add/remove too.
      watcher.on('addDir', handler);
      watcher.on('unlinkDir', handler);
      // chokidar surfaced an error for this dir — drop the watcher; poll still covers it.
      closeWatcherOnError(watcher, () => this.dirWatchers.delete(workflowsDir));
      this.dirWatchers.set(workflowsDir, watcher);
    } catch {
      // Watch setup failed — periodic poll still discovers changes.
    }
  }

  private removeDirWatcher(workflowsDir: string): void {
    const watcher = this.dirWatchers.get(workflowsDir);
    if (watcher) {
      watcher.close().catch(() => {});
      this.dirWatchers.delete(workflowsDir);
    }
  }
}

/** Process-wide singleton (mirrors subagentWatcher / imageWatcher). */
export const workflowRunWatcher = new WorkflowRunWatcher();
