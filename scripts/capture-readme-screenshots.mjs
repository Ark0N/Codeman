#!/usr/bin/env node

/**
 * capture-readme-screenshots.mjs
 *
 * Captures deterministic README screenshots using Playwright + page.route() mock injection.
 * No real Claude CLI or server needed — all API responses are mocked.
 *
 * Usage:  node scripts/capture-readme-screenshots.mjs
 * Port:   3199 (static file server)
 * Output: docs/images/ and docs/screenshots/
 */

import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const PUBLIC_DIR = join(PROJECT_ROOT, 'src', 'web', 'public');
const PORT = 3199;
const VIEWPORT = { width: 1280, height: 720 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── MIME Types ──────────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

// ─── Static File Server ──────────────────────────────────────────────────────

function startStaticServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let urlPath = req.url.split('?')[0];
      if (urlPath === '/') urlPath = '/index.html';

      const filePath = join(PUBLIC_DIR, urlPath);

      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      try {
        const data = readFileSync(filePath);
        const ext = extname(filePath);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(data);
      } catch {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });

    server.listen(PORT, () => {
      console.log(`Static server on http://localhost:${PORT}`);
      resolve(server);
    });
  });
}

// ─── Mock Data ───────────────────────────────────────────────────────────────

const SESSION_IDS = {
  w1: 'sess-w1-0001',
  w3: 'sess-w3-0003',
  w4: 'sess-w4-0004',
  w5: 'sess-w5-0005',
  s1: 'sess-s1-0006',
  s2: 'sess-s2-0007',
  s3: 'sess-s3-0008',
};

const RALPH_SESSION_ID = 'sess-ralph-demo';
const RALPH_SHELL_ID = 'sess-ralph-shell';

function makeSession(id, name, mode, status, extra = {}) {
  return {
    id,
    pid: status === 'idle' ? null : 12345 + Math.floor(Math.random() * 10000),
    status,
    workingDir: '/home/arkon/claudeman-cases/testcase',
    currentTaskId: null,
    createdAt: Date.now() - 3600000,
    lastActivityAt: Date.now() - (status === 'idle' ? 60000 : 5000),
    name,
    mode,
    autoClearEnabled: false,
    autoClearThreshold: 140000,
    autoCompactEnabled: false,
    autoCompactThreshold: 110000,
    autoCompactPrompt: '',
    imageWatcherEnabled: false,
    totalCost: mode === 'claude' ? 0.12 : 0,
    inputTokens: mode === 'claude' ? 18000 : 0,
    outputTokens: mode === 'claude' ? 11500 : 0,
    ralphEnabled: false,
    niceEnabled: false,
    niceValue: 10,
    color: 'default',
    flickerFilterEnabled: false,
    cliVersion: '2.1.14',
    cliModel: 'Opus 4.5',
    cliAccountType: 'Claude Max',
    cliLatestVersion: '2.1.14',
    messageCount: mode === 'claude' ? 15 : 0,
    isWorking: status === 'busy',
    lastPromptTime: Date.now() - 30000,
    bufferStats: {
      terminalBufferSize: 4096,
      textOutputSize: 2048,
      messageCount: 15,
      maxTerminalBuffer: 2097152,
      maxTextOutput: 1048576,
      maxMessages: 1000,
    },
    taskStats: { total: 0, running: 0, completed: 0, failed: 0 },
    taskTree: [],
    tokens: {
      input: mode === 'claude' ? 18000 : 0,
      output: mode === 'claude' ? 11500 : 0,
      total: mode === 'claude' ? 29500 : 0,
    },
    autoClear: { enabled: false, threshold: 140000 },
    nice: { enabled: false, niceValue: 10 },
    ralphLoop: null,
    ralphTodos: [],
    ralphTodoStats: { total: 0, completed: 0, percentComplete: 0 },
    respawnEnabled: false,
    respawnConfig: null,
    respawn: null,
    claudeSessionId: `claude-${id}`,
    ...extra,
  };
}

// Standard 7-session set (matching existing screenshots)
const STANDARD_SESSIONS = [
  makeSession(SESSION_IDS.w1, 'w1-testcase', 'claude', 'busy'),
  makeSession(SESSION_IDS.w3, 'w3-testcase', 'claude', 'busy'),
  makeSession(SESSION_IDS.w4, 'w4-testcase', 'claude', 'idle'),
  makeSession(SESSION_IDS.w5, 'w5-testcase', 'claude', 'idle'),
  makeSession(SESSION_IDS.s1, 's1-testcase', 'shell', 'busy'),
  makeSession(SESSION_IDS.s2, 's2-testcase', 'shell', 'idle'),
  makeSession(SESSION_IDS.s3, 's3-testcase', 'shell', 'idle'),
];

// Ralph demo sessions (2 tabs)
const RALPH_SESSIONS = [
  makeSession(RALPH_SESSION_ID, 'ralph-8tasks-demo', 'claude', 'busy', {
    ralphEnabled: true,
    tokens: { input: 22000, output: 15300, total: 37300 },
    inputTokens: 22000,
    outputTokens: 15300,
    totalCost: 0.28,
    ralphLoop: {
      enabled: true,
      active: true,
      completionPhrase: 'ALL_TASKS_DONE',
      startedAt: Date.now() - 60000,
      cycleCount: 3,
      maxIterations: null,
      elapsedHours: null,
    },
    ralphTodos: [
      { id: '1', text: 'Add TypeScript types to all functions', status: 'completed' },
      { id: '2', text: 'Add input validation with proper error messages', status: 'completed' },
      { id: '3', text: 'Add JSDoc documentation to each function', status: 'completed' },
      { id: '4', text: 'Add unit tests for formatDate and parseJSON', status: 'in_progress' },
      { id: '5', text: 'Add unit tests for debounce and deepClone', status: 'pending' },
      { id: '6', text: 'Add unit tests for slugify and truncate', status: 'pending' },
      { id: '7', text: 'Add unit tests for randomId and groupBy', status: 'pending' },
      { id: '8', text: 'Create an index.ts that exports all utilities', status: 'pending' },
      { id: '9', text: 'Add TypeScript types to all functions', status: 'completed' },
    ],
    ralphTodoStats: { total: 9, completed: 4, percentComplete: 44 },
  }),
  makeSession(RALPH_SHELL_ID, 's1-demo-testing', 'shell', 'busy'),
];

// Mock mux (tmux) sessions for Monitor panel
const MUX_SESSIONS = [
  {
    sessionId: 'mux-w1',
    name: 'w1-testcase',
    muxName: 'w1-testcase',
    mode: 'claude',
    pid: 292239,
    stats: { memoryMB: 2.3, cpuPercent: 0, childCount: 1 },
  },
  {
    sessionId: 'mux-w3',
    name: 'w3-testcase',
    muxName: 'w3-testcase',
    mode: 'claude',
    pid: 292394,
    stats: { memoryMB: 2.4, cpuPercent: 0.1, childCount: 1 },
  },
  {
    sessionId: 'mux-w4',
    name: 'w4-testcase',
    muxName: 'w4-testcase',
    mode: 'claude',
    pid: 292497,
    stats: { memoryMB: 2.4, cpuPercent: 0, childCount: 1 },
  },
];

// Mock subagents for subagent-spawn screenshot
const MOCK_SUBAGENTS = [
  {
    agentId: 'agent-001',
    sessionId: 'claude-sess-w1-0001',
    projectHash: 'abc123',
    filePath: '/tmp/agent-001.jsonl',
    startedAt: new Date(Date.now() - 120000).toISOString(),
    lastActivityAt: Date.now() - 5000,
    status: 'active',
    toolCallCount: 12,
    entryCount: 45,
    fileSize: 32000,
    description: 'Find and document all API endpoints in src/',
    model: 'claude-haiku-4-5-20251001',
    modelShort: 'haiku',
    totalInputTokens: 15000,
    totalOutputTokens: 8000,
    parentSessionId: SESSION_IDS.w1,
  },
  {
    agentId: 'agent-002',
    sessionId: 'claude-sess-w1-0001',
    projectHash: 'abc123',
    filePath: '/tmp/agent-002.jsonl',
    startedAt: new Date(Date.now() - 90000).toISOString(),
    lastActivityAt: Date.now() - 3000,
    status: 'active',
    toolCallCount: 8,
    entryCount: 30,
    fileSize: 22000,
    description: 'Explore and understand test structure in test/',
    model: 'claude-haiku-4-5-20251001',
    modelShort: 'haiku',
    totalInputTokens: 12000,
    totalOutputTokens: 6000,
    parentSessionId: SESSION_IDS.w1,
  },
  {
    agentId: 'agent-003',
    sessionId: 'claude-sess-w1-0001',
    projectHash: 'abc123',
    filePath: '/tmp/agent-003.jsonl',
    startedAt: new Date(Date.now() - 60000).toISOString(),
    lastActivityAt: Date.now() - 8000,
    status: 'active',
    toolCallCount: 5,
    entryCount: 18,
    fileSize: 14000,
    description: 'Analyze TypeScript type definitions in src/types.ts',
    model: 'claude-haiku-4-5-20251001',
    modelShort: 'haiku',
    totalInputTokens: 8000,
    totalOutputTokens: 4000,
    parentSessionId: SESSION_IDS.w1,
  },
];

function buildInitPayload(sessions, subagents = []) {
  const respawnStatus = {};
  for (const s of sessions) {
    respawnStatus[s.id] = {
      state: 'idle',
      cycleCount: 0,
      lastActivityTime: Date.now(),
      timeSinceActivity: 0,
      promptDetected: false,
      workingDetected: false,
      detection: {},
      config: null,
    };
  }

  return {
    version: '0.1540',
    sessions,
    scheduledRuns: [],
    respawnStatus,
    globalStats: {
      totalInputTokens: 145000,
      totalOutputTokens: 87000,
      totalCost: 1.82,
      totalSessionsCreated: 12,
      firstRecordedAt: Date.now() - 86400000,
      lastUpdatedAt: Date.now(),
    },
    subagents,
    timestamp: Date.now(),
  };
}

// ─── Terminal Content (ANSI) ─────────────────────────────────────────────────

// Colors
const RST = '\x1b[0m';
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YEL = '\x1b[33m';
const BLU = '\x1b[34m';
const MAG = '\x1b[35m';
const CYN = '\x1b[36m';
const GRY = '\x1b[90m';
const WHT = '\x1b[37m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

// Claude Code init banner (matching the overview screenshot)
const TERMINAL_INIT = [
  '',
  `  ${RED}████${RST}    ${BOLD}Claude Code${RST} v2.1.14`,
  `  ${RED}████${RST}    ${GRY}Opus 4.5${RST} ${DIM}·${RST} ${GRY}Claude Max${RST}`,
  `  ${RED}██${RST} ${RED}██${RST}    ${GRY}~/claudeman-cases/testcase${RST}`,
  '',
  '',
  `${GRY}❯ Try "how do I log an error?"${RST}`,
  '',
  '',
  `${YEL}»»${RST} ${BOLD}bypass permissions on${RST} ${GRY}(shift+tab to cycle)${RST}`,
  `                                                                                                           ${BOLD}0 tokens${RST}`,
  `                                                                                   ${GRY}current: 2.1.14${RST} ${DIM}·${RST} ${GRY}latest: 2.1.14${RST}`,
].join('\r\n');

// Claude working output (for multi-session-dashboard / subagent-spawn)
const TERMINAL_WORKING = [
  '',
  `${GRN}●${RST} The codebase is essentially a template/scaffold with just a CLAUDE.md file and empty ${BOLD}src/${RST} directory. Since there's already a comprehensive`,
  `CLAUDE.md file present, let me read it fully and suggest improvements based on the /init command requirements:`,
  '',
  `${GRN}●${RST} ${BOLD}Read${RST}(/home/arkon/claudeman-cases/testcase/CLAUDE.md)`,
  `  ${GRY}░${RST} Read ${BOLD}407${RST} lines`,
  '',
  `${GRN}●${RST} Now I understand the situation. This is a ${BOLD}template CLAUDE.md file${RST} designed for the Claude Code framework with the "Ralph Loop" autonomous work`,
  `mode. The current file is very comprehensive for workflow instructions but lacks the key technical information that /init is supposed to generate:`,
  '',
  `1. ${BOLD}No build/test/lint commands${RST} - The file references npm test, npm run lint, npm run build but these are generic examples, not project-specific`,
  `2. ${BOLD}No architecture documentation${RST} - The session log mentions files that don't exist in the empty repo`,
  `3. ${BOLD}Placeholder tech stack${RST} - Still shows [TECHNOLOGIES_USED]`,
  `4. ${BOLD}Too much workflow/process documentation${RST} - Much of this duplicates Claude Code's built-in behavior`,
  '',
  `The /init command is asking me to create a CLAUDE.md focused on ${BOLD}codebase-specific guidance${RST} (commands, architecture), not workflow processes. Since`,
  `this is essentially an empty project, I should create a minimal CLAUDE.md that:`,
  `1. Has the required header`,
  `2. Notes that the project needs initialization`,
  `3. Removes the verbose workflow documentation that's either built-in to Claude Code or should be in separate docs`,
  '',
  `Let me create an improved, streamlined CLAUDE.md appropriate for this empty project state.`,
  '',
  `${MAG}✻${RST} ${YEL}Caramelizing...${RST} ${GRY}(${BOLD}esc${RST}${GRY} to interrupt · 54s · ↓ 2.1k tokens)${RST}`,
  '',
  '',
  `────────────────────────────────────────────────────────────────────────────────────────────────────────────────`,
  `${GRY}❯${RST} █`,
  '',
  `────────────────────────────────────────────────────────────────────────────────────────────────────────────────`,
  `  ${YEL}»»${RST} ${BOLD}bypass permissions on${RST} ${GRY}(shift+tab to cycle)${RST}`,
  `                                                                                                     ${BOLD}28163 tokens${RST}`,
  `                                                                                   ${GRY}current: 2.1.14${RST} ${DIM}·${RST} ${GRY}latest: 2.1.14${RST}`,
].join('\r\n');

// Ralph terminal content (matching ralph-tracker screenshot)
const TERMINAL_RALPH = [
  '',
  `${GRN}●${RST} ${BOLD}Search${RST}(pattern: "**/*.test.ts")`,
  `  ${GRY}░${RST} Found ${BOLD}0${RST} files`,
  '',
  `${GRN}●${RST} ${BOLD}Search${RST}(pattern: "**/test/**")`,
  `  ${GRY}░${RST} Found ${BOLD}0${RST} files`,
  '',
  `${GRN}●${RST} ${BOLD}Search${RST}(pattern: "**/package.json")`,
  `  ${GRY}░${RST} Found ${BOLD}0${RST} files`,
  '',
  `${MAG}✻${RST} ${YEL}Adding unit tests for formatDate and parseJSON...${RST} ${GRY}(${BOLD}esc${RST}${GRY} to interrupt · ${BOLD}ctrl+t${RST}${GRY} to hide todos · 1m 27s · ↓ 5.8k tokens · thinking)${RST}`,
  `  ${GRY}░${RST} ${GRY}☒${RST} Add TypeScript types to all functions`,
  `    ${GRY}☒${RST} Add input validation with proper error messages`,
  `    ${GRY}☒${RST} Add JSDoc documentation to each function`,
  `  ${GRY}░${RST} ${BOLD}Add unit tests for formatDate and parseJSON${RST}`,
  `  ${GRY}░${RST} ☐ Add unit tests for debounce and deepClone`,
  `  ${GRY}░${RST} ☐ Add unit tests for slugify and truncate`,
  `  ${GRY}░${RST} ☐ Add unit tests for randomId and groupBy`,
  `  ${GRY}░${RST} ☐ Create an index.ts that exports all utilities`,
  '',
  '',
  `────────────────────────────────────────────────────────────────────────────────────────────────────────────────`,
  `${GRY}❯${RST} █`,
  '',
  `────────────────────────────────────────────────────────────────────────────────────────────────────────────────`,
  `  ${YEL}»»${RST} ${BOLD}bypass permissions on${RST} ${GRY}(shift+tab to cycle)${RST}`,
  `                                                                                                    ${BOLD}37267 tokens${RST}`,
  `                                                                                   ${GRY}current: 2.1.14${RST} ${DIM}·${RST} ${GRY}latest: 2.1.14${RST}`,
].join('\r\n');

// Subagent window content (tool call activity)
const SUBAGENT_ACTIVITY = {
  'agent-001': [
    { type: 'tool', tool: 'Glob', input: { pattern: 'src/**/*.ts' }, timestamp: new Date().toISOString(), agentId: 'agent-001' },
    { type: 'tool', tool: 'Read', input: { file_path: '/home/arkon/claudeman/src/web/server.ts' }, timestamp: new Date().toISOString(), agentId: 'agent-001' },
    { type: 'tool', tool: 'Grep', input: { pattern: 'app\\.get|app\\.post|app\\.put|app\\.delete', path: 'src/' }, timestamp: new Date().toISOString(), agentId: 'agent-001' },
    { type: 'tool', tool: 'Read', input: { file_path: '/home/arkon/claudeman/src/web/schemas.ts' }, timestamp: new Date().toISOString(), agentId: 'agent-001' },
    { type: 'message', role: 'assistant', text: 'Found 47 API endpoints across server.ts. Documenting REST paths...', timestamp: new Date().toISOString(), agentId: 'agent-001' },
  ],
  'agent-002': [
    { type: 'tool', tool: 'Glob', input: { pattern: 'test/**/*.test.ts' }, timestamp: new Date().toISOString(), agentId: 'agent-002' },
    { type: 'tool', tool: 'Read', input: { file_path: '/home/arkon/claudeman/test/respawn-test-utils.ts' }, timestamp: new Date().toISOString(), agentId: 'agent-002' },
    { type: 'tool', tool: 'Read', input: { file_path: '/home/arkon/claudeman/vitest.config.ts' }, timestamp: new Date().toISOString(), agentId: 'agent-002' },
    { type: 'message', role: 'assistant', text: 'Analyzing test patterns: MockSession, unique ports, fileParallelism: false...', timestamp: new Date().toISOString(), agentId: 'agent-002' },
  ],
};

// Subagent spawn terminal content
const TERMINAL_SUBAGENT = [
  '',
  `${GRN}●${RST} Working on ${CYN}/home/arkon/claudeman-cases/testcase${RST} - I'll use the ${BOLD}Task tool${RST} to spawn parallel agents.`,
  '',
  `${GRN}●${RST} ${BOLD}Read${RST}(/home/arkon/claudeman-cases/testcase/CLAUDE.md)`,
  `  ${GRY}░${RST} Read ${BOLD}127${RST} lines ${GRY}│${RST} ${CYN}1.2KB${RST}`,
  '',
  `${GRN}●${RST} ${BOLD}Bash${RST}(find . -name "*.ts" -not -path "*/node_modules/*" | head -20)`,
  `  ${GRY}░${RST} ./src/index.ts`,
  `  ${GRY}░${RST} ./src/types.ts`,
  `  ${GRY}░${RST} ./src/session.ts`,
  `  ${GRY}░${RST} ./src/web/server.ts`,
  `  ${GRY}░${RST} ./src/web/schemas.ts`,
  `  ${GRY}░${RST} ./test/session.test.ts`,
  `  ${GRY}░${RST} ${GRY}... (14 more)${RST}`,
  '',
  `${GRN}●${RST} I'll spawn 3 parallel research agents to analyze different parts of the codebase simultaneously.`,
  '',
  `${GRN}●${RST} ${BOLD}Task${RST}(Find and document all API endpoints in src/)`,
  `  ${GRY}░${RST} Spawned ${CYN}agent-001${RST} ${GRY}(haiku)${RST}`,
  '',
  `${GRN}●${RST} ${BOLD}Task${RST}(Explore and understand test structure in test/)`,
  `  ${GRY}░${RST} Spawned ${CYN}agent-002${RST} ${GRY}(haiku)${RST}`,
  '',
  `${GRN}●${RST} ${BOLD}Task${RST}(Analyze TypeScript type definitions in src/types.ts)`,
  `  ${GRY}░${RST} Spawned ${CYN}agent-003${RST} ${GRY}(haiku)${RST}`,
  '',
  `${MAG}✻${RST} ${YEL}Waiting for agents...${RST} ${GRY}(${BOLD}esc${RST}${GRY} to interrupt · 32s · ↓ 1.7k tokens · thinking)${RST}`,
  '',
  `  ${GRN}●${RST} ${CYN}agent-001${RST}: ${GRY}12 tool calls${RST} — Glob, Read(server.ts), Grep(endpoints)...`,
  `  ${GRN}●${RST} ${CYN}agent-002${RST}: ${GRY}8 tool calls${RST} — Glob, Read(test-utils), Read(vitest.config)...`,
  `  ${GRN}●${RST} ${CYN}agent-003${RST}: ${GRY}5 tool calls${RST} — Read(types.ts), Grep(interface)...`,
  '',
  `${GRN}●${RST} ${DIM}171.8k, 13s │ 1.7k tokens │ thinking${RST}`,
  '',
  '',
  `  ${YEL}»»${RST} ${BOLD}bypass permissions on${RST} ${GRY}(shift+tab to cycle)${RST}`,
  `                                                                                   ${GRY}current: 2.1.14${RST} ${DIM}·${RST} ${GRY}latest: 2.1.14${RST}`,
].join('\r\n');

// ─── Route Interceptors ──────────────────────────────────────────────────────

async function setupRoutes(page, initPayload, terminalContent) {
  // CRITICAL: Block SSE entirely to prevent reconnection loops that clear state.
  // We'll inject data directly via page.evaluate() instead.
  await page.route('**/api/events', async (route) => {
    await route.abort();
  });

  // Terminal buffer endpoint — used by selectSession()
  await page.route('**/api/sessions/*/terminal**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        terminalBuffer: terminalContent,
        status: 'busy',
        fullSize: terminalContent.length,
        truncated: false,
      }),
    });
  });

  // Mux sessions (subpath routes before base route)
  await page.route('**/api/mux-sessions/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });

  await page.route('**/api/mux-sessions', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessions: MUX_SESSIONS, muxAvailable: true }),
    });
  });

  // Settings
  await page.route('**/api/settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        showSubagents: true,
        subagentTrackingEnabled: true,
        subagentActiveTabOnly: false,
        showMonitor: true,
      }),
    });
  });

  // Subagent window states (restore)
  await page.route('**/api/subagent-window-states', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  // Subagent parents (restore)
  await page.route('**/api/subagent-parents', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  // Session-specific subagents
  await page.route('**/api/sessions/*/subagents', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: initPayload.subagents || [] }),
    });
  });

  // Interactive attach (no-op)
  await page.route('**/api/sessions/*/interactive', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });

  // Resize (no-op)
  await page.route('**/api/sessions/*/resize', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });

  // Catch-all for any remaining API endpoints
  await page.route('**/api/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });
}

/**
 * Inject mock state into the app and render.
 * Bypasses SSE entirely — calls handleInit directly, then selects a session
 * and writes terminal content.
 */
async function injectState(page, initPayload, terminalContent, activeSessionId) {
  // Wait for app to be ready
  await page.waitForFunction(() => window.app && window.app.terminal, { timeout: 10000 });

  // Cancel the SSE fallback timer and inject state directly
  await page.evaluate((payload) => {
    const app = window.app;
    // Cancel the init fallback timer (prevents double handleInit)
    if (app._initFallbackTimer) {
      clearTimeout(app._initFallbackTimer);
      app._initFallbackTimer = null;
    }
    // Inject state
    app.handleInit(payload);
  }, initPayload);

  await sleep(500);

  // Select the target session (this triggers terminal fetch via our mocked route)
  if (activeSessionId) {
    await page.evaluate((sid) => {
      window.app.activeSessionId = null; // Force re-select
      window.app.selectSession(sid);
    }, activeSessionId);
    await sleep(800);
  }

  // Write terminal content directly as backup (in case fetch didn't work)
  await page.evaluate((content) => {
    const app = window.app;
    if (app.terminal) {
      // Only write if terminal is still empty
      const buf = app.terminal.buffer?.active;
      const hasContent = buf && buf.length > 2 && buf.getLine(1)?.translateToString().trim();
      if (!hasContent) {
        app.terminal.clear();
        app.terminal.reset();
        app.terminal.write(content);
        app.terminal.scrollToBottom();
      }
    }
  }, terminalContent);

  // Clean up UI elements that look wrong in screenshots
  await page.evaluate(() => {
    // Hide connection indicator (SSE is blocked so it shows "Reconnecting...")
    const indicator = document.getElementById('connectionIndicator');
    if (indicator) indicator.style.display = 'none';

    // Hide respawn banner (shows "idle" state which isn't needed in screenshots)
    const respawnBanner = document.getElementById('respawnBanner');
    if (respawnBanner) respawnBanner.style.display = 'none';

    // Fix system stats display (CPU/MEM) — inject mock values
    const statsEl = document.getElementById('headerSystemStats');
    if (statsEl) {
      statsEl.innerHTML = `
        <span class="stat-label">CPU</span>
        <div class="stat-bar"><div class="stat-bar-fill cpu-bar" style="width: 24%"></div></div>
        <span class="stat-value">24%</span>
        <span class="stat-label">MEM</span>
        <div class="stat-bar"><div class="stat-bar-fill mem-bar" style="width: 51%"></div></div>
        <span class="stat-value">16.9G</span>
      `;
    }

    // Hide subagents panel by default (will be shown per-scenario)
    const subagentsPanel = document.getElementById('subagentsPanel');
    if (subagentsPanel) subagentsPanel.style.display = 'none';

    // Ensure monitor panel is closed by default (will be opened per-scenario)
    const monitorPanel = document.getElementById('monitorPanel');
    if (monitorPanel) monitorPanel.classList.remove('open');

    // Update token display to show per-session tokens (not globalStats)
    const app = window.app;
    if (app && app.activeSessionId) {
      const session = app.sessions.get(app.activeSessionId);
      if (session) {
        const tokens = (session.tokens?.total || 0);
        const tokenEl = document.getElementById('headerTokens');
        if (tokenEl) {
          const formatted = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
          tokenEl.innerHTML = `<span class="token-icon">⊙</span> <span class="token-count">${formatted} tokens</span>`;
        }
      }
    }
  });

  await sleep(300);
}

// ─── Screenshot Scenarios ────────────────────────────────────────────────────

async function captureOverview(page) {
  console.log('\n1/5 Capturing claude-overview.png...');

  const initPayload = buildInitPayload(STANDARD_SESSIONS);
  await setupRoutes(page, initPayload, TERMINAL_INIT);

  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
  await injectState(page, initPayload, TERMINAL_INIT, SESSION_IDS.w4);

  // Open Monitor panel and populate mux sessions
  await page.evaluate((muxSessions) => {
    const app = window.app;
    if (!app) return;
    app.muxSessions = muxSessions;
    const panel = document.getElementById('monitorPanel');
    if (panel) {
      panel.classList.add('open');
      app._renderMuxSessionsImmediate();
    }
  }, MUX_SESSIONS);
  await sleep(500);

  await page.screenshot({
    path: join(PROJECT_ROOT, 'docs', 'images', 'claude-overview.png'),
    fullPage: false,
  });
  console.log('  Saved: docs/images/claude-overview.png');
}

async function captureSubagentSpawn(page) {
  console.log('\n2/5 Capturing subagent-spawn.png...');

  const initPayload = buildInitPayload(STANDARD_SESSIONS, MOCK_SUBAGENTS);
  await setupRoutes(page, initPayload, TERMINAL_SUBAGENT);

  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
  await injectState(page, initPayload, TERMINAL_SUBAGENT, SESSION_IDS.w1);

  // Open subagent windows and populate activity
  await page.evaluate((activity) => {
    const app = window.app;
    if (!app) return;

    // Populate subagent activity data
    for (const [agentId, entries] of Object.entries(activity)) {
      app.subagentActivity.set(agentId, entries);
    }

    // Open subagent windows (first two for cleaner screenshot)
    app.openSubagentWindow('agent-001');
    app.openSubagentWindow('agent-002');
  }, SUBAGENT_ACTIVITY);
  await sleep(800);

  // Position windows nicely (matching existing screenshot layout)
  await page.evaluate(() => {
    const app = window.app;
    if (!app) return;

    const windows = Array.from(app.subagentWindows.values());
    if (windows.length >= 2) {
      const w1 = windows[0].element;
      w1.style.left = '420px';
      w1.style.top = '40px';
      w1.style.width = '420px';
      w1.style.height = '320px';

      const w2 = windows[1].element;
      w2.style.left = '850px';
      w2.style.top = '40px';
      w2.style.width = '420px';
      w2.style.height = '320px';
    }
  });
  await sleep(500);

  await page.screenshot({
    path: join(PROJECT_ROOT, 'docs', 'images', 'subagent-spawn.png'),
    fullPage: false,
  });
  console.log('  Saved: docs/images/subagent-spawn.png');
}

async function captureRalphTracker(page) {
  console.log('\n3/5 Capturing ralph-tracker-8tasks-44percent.png...');

  const initPayload = buildInitPayload(RALPH_SESSIONS);
  await setupRoutes(page, initPayload, TERMINAL_RALPH);

  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
  await injectState(page, initPayload, TERMINAL_RALPH, RALPH_SESSION_ID);

  // Ensure Ralph state panel is visible and expanded
  await page.evaluate((sessionId) => {
    const app = window.app;
    if (!app) return;

    const session = app.sessions.get(sessionId);
    if (session) {
      app.ralphStates.set(sessionId, {
        loop: session.ralphLoop,
        todos: session.ralphTodos || [],
      });
      app.ralphStatePanelCollapsed = false;
      app.ralphClosedSessions.delete(sessionId);
      app._renderRalphStatePanelImmediate();
    }
  }, RALPH_SESSION_ID);
  await sleep(500);

  await page.screenshot({
    path: join(PROJECT_ROOT, 'docs', 'images', 'ralph-tracker-8tasks-44percent.png'),
    fullPage: false,
  });
  console.log('  Saved: docs/images/ralph-tracker-8tasks-44percent.png');
}

async function captureMultiSessionDashboard(page) {
  console.log('\n4/5 Capturing multi-session-dashboard.png...');

  const initPayload = buildInitPayload(STANDARD_SESSIONS);
  await setupRoutes(page, initPayload, TERMINAL_WORKING);

  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
  await injectState(page, initPayload, TERMINAL_WORKING, SESSION_IDS.w3);

  await page.screenshot({
    path: join(PROJECT_ROOT, 'docs', 'screenshots', 'multi-session-dashboard.png'),
    fullPage: false,
  });
  console.log('  Saved: docs/screenshots/multi-session-dashboard.png');
}

async function captureMultiSessionMonitor(page) {
  console.log('\n5/5 Capturing multi-session-monitor.png...');

  const initPayload = buildInitPayload(STANDARD_SESSIONS);
  await setupRoutes(page, initPayload, TERMINAL_INIT);

  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
  await injectState(page, initPayload, TERMINAL_INIT, SESSION_IDS.w4);

  // Open Monitor panel and populate mux sessions
  await page.evaluate((muxSessions) => {
    const app = window.app;
    if (!app) return;
    app.muxSessions = muxSessions;
    const panel = document.getElementById('monitorPanel');
    if (panel) {
      panel.classList.add('open');
      app._renderMuxSessionsImmediate();
    }
  }, MUX_SESSIONS);
  await sleep(500);

  await page.screenshot({
    path: join(PROJECT_ROOT, 'docs', 'screenshots', 'multi-session-monitor.png'),
    fullPage: false,
  });
  console.log('  Saved: docs/screenshots/multi-session-monitor.png');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('Claudeman README Screenshot Capture');
  console.log('='.repeat(60));
  console.log(`Port: ${PORT} | Viewport: ${VIEWPORT.width}x${VIEWPORT.height}`);
  console.log('');

  const server = await startStaticServer();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    // Each scenario gets its own fresh page to avoid route conflicts
    for (const scenario of [
      captureOverview,
      captureSubagentSpawn,
      captureRalphTracker,
      captureMultiSessionDashboard,
      captureMultiSessionMonitor,
    ]) {
      const context = await browser.newContext({ viewport: VIEWPORT });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);

      try {
        await scenario(page);
      } catch (err) {
        console.error(`  ERROR: ${err.message}`);
      } finally {
        await context.close();
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('All screenshots captured!');
    console.log('='.repeat(60));
    console.log('\nOutput files:');
    console.log('  docs/images/claude-overview.png');
    console.log('  docs/images/subagent-spawn.png');
    console.log('  docs/images/ralph-tracker-8tasks-44percent.png');
    console.log('  docs/screenshots/multi-session-dashboard.png');
    console.log('  docs/screenshots/multi-session-monitor.png');
  } catch (err) {
    console.error('\nFatal error:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
    console.log('\nDone.');
  }
}

// Handle interrupts
process.on('SIGINT', () => {
  console.log('\nInterrupted.');
  process.exit(1);
});

main();
