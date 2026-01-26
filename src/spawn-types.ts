/**
 * @fileoverview Type definitions for the spawn1337 Autonomous Agent Protocol.
 *
 * Defines all types for the agent spawning system including:
 * - Task specifications (what the parent writes)
 * - Agent progress reporting
 * - Result delivery format
 * - Bidirectional messaging
 * - Orchestrator state tracking
 *
 * Also includes a simple YAML frontmatter parser and factory functions.
 *
 * @module spawn-types
 */

// ========== Agent Task Specification ==========

/** Priority levels for spawn tasks */
export type SpawnPriority = 'low' | 'normal' | 'high' | 'critical';

/** How results should be delivered */
export type SpawnResultDelivery = 'file' | 'notify' | 'both';

/** Agent execution status */
export type SpawnStatus = 'queued' | 'initializing' | 'running' | 'completing' | 'completed' | 'failed' | 'timeout' | 'cancelled';

/**
 * Task specification parsed from the .md file's YAML frontmatter.
 * This is the contract for what the parent LLM writes.
 */
export interface SpawnTaskSpec {
  // === Identity ===
  /** Unique agent identifier (auto-generated if not provided) */
  agentId: string;
  /** Human-readable name for this agent */
  name: string;
  /** Task type/category */
  type: 'explore' | 'implement' | 'test' | 'review' | 'refactor' | 'research' | 'generate' | 'fix' | 'general';

  // === Scheduling ===
  /** Priority for queue ordering */
  priority: SpawnPriority;
  /** Dependencies - other agentIds that must complete first */
  dependsOn?: string[];

  // === Environment ===
  /** Working directory (relative to parent, or absolute) */
  workingDir?: string;
  /** Files to copy/symlink into agent workspace as context */
  contextFiles?: string[];
  /** Whether the agent can modify files in the parent's directory */
  canModifyParentFiles: boolean;
  /** Additional environment variables for the agent */
  env?: Record<string, string>;

  // === Resource Governance ===
  /** Maximum token budget (input + output combined) */
  maxTokens?: number;
  /** Maximum cost in USD */
  maxCost?: number;
  /** Timeout in minutes */
  timeoutMinutes: number;

  // === Communication ===
  /** How to deliver results */
  resultDelivery: SpawnResultDelivery;
  /** Completion phrase for RalphTracker (auto-generated if not set) */
  completionPhrase: string;
  /** How often the agent should report progress (seconds, 0 = no progress) */
  progressIntervalSeconds: number;

  // === Output ===
  /** Expected output format */
  outputFormat: 'markdown' | 'json' | 'code' | 'structured' | 'freeform';
  /** Success criteria (included in agent's CLAUDE.md) */
  successCriteria: string;
}

/**
 * The full parsed task (spec + instructions body).
 */
export interface SpawnTask {
  spec: SpawnTaskSpec;
  /** The markdown body - actual instructions for the agent */
  instructions: string;
  /** Source file path */
  sourceFile: string;
  /** Parent session ID that requested this spawn */
  parentSessionId: string;
  /** Spawn depth (0 = direct child of user) */
  depth: number;
}

// ========== Agent Communication ==========

/**
 * Progress report written by agent to spawn-comms/progress.json
 */
export interface AgentProgress {
  /** Current phase/step description */
  phase: string;
  /** Completion percentage (0-100) */
  percentComplete: number;
  /** What the agent is currently doing */
  currentAction: string;
  /** Todos/subtasks the agent is tracking */
  subtasks?: Array<{
    description: string;
    status: 'pending' | 'in_progress' | 'completed';
  }>;
  /** Timestamp of last update */
  updatedAt: number;
  /** Files modified so far */
  filesModified: string[];
  /** Tokens used so far */
  tokensUsed: number;
  /** Cost so far */
  costSoFar: number;
}

/**
 * Result delivered by agent on completion.
 * Written to spawn-comms/result.md as YAML frontmatter + body.
 */
export interface SpawnResult {
  // === Status ===
  /** Final execution status */
  status: 'completed' | 'failed' | 'timeout' | 'cancelled';
  /** Error message if failed */
  error?: string;

  // === Metrics ===
  /** Total execution duration in ms */
  durationMs: number;
  /** Token usage breakdown */
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  /** Total cost in USD */
  cost: number;

  // === Output ===
  /** Executive summary (1-3 sentences) */
  summary: string;
  /** Full structured output */
  output: string;
  /** Files modified or created */
  filesChanged: Array<{
    path: string;
    action: 'created' | 'modified' | 'deleted';
    summary?: string;
  }>;
  /** Any artifacts produced (data files, diagrams, etc.) */
  artifacts?: Array<{
    name: string;
    path: string;
    type: string;
    description: string;
  }>;

  // === Metadata ===
  /** Agent ID */
  agentId: string;
  /** Completion timestamp */
  completedAt: number;
  /** Number of respawn cycles if agent used Ralph loop */
  cycleCount?: number;
}

/**
 * Message in the bidirectional communication channel.
 * Written to spawn-comms/messages/NNN-{sender}.md
 */
export interface SpawnMessage {
  /** Sequential message number */
  sequence: number;
  /** Who sent it */
  sender: 'parent' | 'agent';
  /** Message content (markdown) */
  content: string;
  /** Timestamp */
  sentAt: number;
  /** Whether it's been read by the recipient */
  read: boolean;
}

/**
 * Status report for UI display and API responses.
 */
export interface AgentStatusReport {
  agentId: string;
  name: string;
  type: string;
  status: SpawnStatus;
  priority: SpawnPriority;
  parentSessionId: string;
  childSessionId: string | null;
  depth: number;
  startedAt: number | null;
  elapsedMs: number;
  progress: AgentProgress | null;
  tokensUsed: number;
  costSoFar: number;
  tokenBudget: number | null;
  costBudget: number | null;
  timeoutMinutes: number;
  timeRemainingMs: number;
  completionPhrase: string;
  dependsOn: string[];
  dependencyStatus: 'waiting' | 'ready' | 'n/a';
}

// ========== Tracker State (for SpawnOrchestrator) ==========

export interface SpawnTrackerState {
  enabled: boolean;
  activeCount: number;
  queuedCount: number;
  totalSpawned: number;
  totalCompleted: number;
  totalFailed: number;
  maxDepthReached: number;
  agents: AgentStatusReport[];
}

// ========== Orchestrator Configuration ==========

export interface SpawnOrchestratorConfig {
  /** Max concurrent agent sessions (default: 5) */
  maxConcurrentAgents: number;
  /** Base directory for agent cases (default: ~/claudeman-cases/) */
  casesDir: string;
  /** Default timeout in minutes (default: 30) */
  defaultTimeoutMinutes: number;
  /** Max timeout allowed in minutes (default: 120) */
  maxTimeoutMinutes: number;
  /** Max agent tree depth (prevent infinite recursion) (default: 3) */
  maxSpawnDepth: number;
  /** Progress poll interval in ms (default: 5000) */
  progressPollIntervalMs: number;
}

// ========== Agent Context (internal orchestrator state) ==========

export interface AgentContext {
  /** The parsed task specification */
  task: SpawnTask;
  /** The spawned session ID (set after session creation) */
  sessionId: string | null;
  /** Resolved working directory for this agent */
  workingDir: string;
  /** Communication directory path */
  commsDir: string;
  /** Parent session ID */
  parentSessionId: string;
  /** Depth in the spawn tree (0 = direct child of user session) */
  depth: number;
  /** Timeout timer handle */
  timeoutTimer: NodeJS.Timeout | null;
  /** Warning timer handle (fires at 90% of timeout) */
  warningTimer: NodeJS.Timeout | null;
  /** Progress poll timer handle */
  progressTimer: NodeJS.Timeout | null;
  /** Current status */
  status: SpawnStatus;
  /** When the agent started working */
  startedAt: number | null;
  /** Token budget remaining (null = unlimited) */
  tokenBudget: number | null;
  /** Cost budget remaining (null = unlimited) */
  costBudget: number | null;
}

// ========== Persisted State ==========

export interface SpawnPersistedState {
  config: SpawnOrchestratorConfig;
  agents: Record<string, {
    agentId: string;
    status: SpawnStatus;
    parentSessionId: string;
    childSessionId: string | null;
    depth: number;
    startedAt: number | null;
    commsDir: string;
    workingDir: string;
    completionPhrase: string;
    timeoutMinutes: number;
  }>;
}

// ========== Constants ==========

/** Maximum concurrent agents */
export const MAX_CONCURRENT_AGENTS = 5;
/** Default timeout in minutes */
export const DEFAULT_TIMEOUT_MINUTES = 30;
/** Maximum timeout in minutes */
export const MAX_TIMEOUT_MINUTES = 120;
/** Maximum spawn depth */
export const MAX_SPAWN_DEPTH = 3;
/** Progress poll interval in ms */
export const PROGRESS_POLL_INTERVAL_MS = 5000;
/** Maximum task file size (2MB) */
export const MAX_TASK_FILE_SIZE = 2 * 1024 * 1024;
/** Maximum context file size (100KB each) */
export const MAX_CONTEXT_FILE_SIZE = 100 * 1024;
/** Maximum number of context files */
export const MAX_CONTEXT_FILES = 20;
/** Maximum queue length */
export const MAX_QUEUE_LENGTH = 50;
/** Budget warning threshold (80%) */
export const BUDGET_WARNING_THRESHOLD = 0.8;
/** Budget grace period in seconds */
export const BUDGET_GRACE_PERIOD_S = 60;
/** Agent name max length */
export const AGENT_NAME_MAX_LENGTH = 64;
/** Message max size (50KB) */
export const MESSAGE_MAX_SIZE = 50 * 1024;
/** Max messages per channel */
export const MAX_MESSAGES_PER_CHANNEL = 100;
/** Max tracked agents (LRU) */
export const MAX_TRACKED_AGENTS = 200;

// ========== Factory Functions ==========

/**
 * Creates a default SpawnTaskSpec with sensible defaults.
 */
export function createDefaultSpawnTaskSpec(agentId: string): SpawnTaskSpec {
  return {
    agentId,
    name: agentId,
    type: 'general',
    priority: 'normal',
    canModifyParentFiles: false,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    resultDelivery: 'both',
    completionPhrase: `AGENT_${agentId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_DONE`,
    progressIntervalSeconds: 30,
    outputFormat: 'markdown',
    successCriteria: '',
  };
}

/**
 * Creates an empty AgentProgress object.
 */
export function createEmptyAgentProgress(): AgentProgress {
  return {
    phase: 'initializing',
    percentComplete: 0,
    currentAction: '',
    subtasks: [],
    updatedAt: Date.now(),
    filesModified: [],
    tokensUsed: 0,
    costSoFar: 0,
  };
}

/**
 * Creates initial SpawnTrackerState.
 */
export function createInitialSpawnTrackerState(): SpawnTrackerState {
  return {
    enabled: false,
    activeCount: 0,
    queuedCount: 0,
    totalSpawned: 0,
    totalCompleted: 0,
    totalFailed: 0,
    maxDepthReached: 0,
    agents: [],
  };
}

/**
 * Creates default orchestrator config.
 */
export function createDefaultOrchestratorConfig(): SpawnOrchestratorConfig {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return {
    maxConcurrentAgents: MAX_CONCURRENT_AGENTS,
    casesDir: `${homeDir}/claudeman-cases`,
    defaultTimeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    maxTimeoutMinutes: MAX_TIMEOUT_MINUTES,
    maxSpawnDepth: MAX_SPAWN_DEPTH,
    progressPollIntervalMs: PROGRESS_POLL_INTERVAL_MS,
  };
}

// ========== YAML Frontmatter Parser ==========

/**
 * Simple YAML frontmatter parser for task spec files.
 * Handles: strings, numbers, booleans, arrays (block and inline), one-level nested objects.
 * Does NOT handle: multi-line strings, anchors, aliases, complex nesting.
 */
export function parseYamlFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const lines = content.split('\n');

  // Must start with ---
  if (lines[0].trim() !== '---') return null;

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) return null;

  const yamlLines = lines.slice(1, endIndex);
  const body = lines.slice(endIndex + 1).join('\n').trim();
  const frontmatter: Record<string, unknown> = {};

  let currentKey: string | null = null;
  let currentArray: unknown[] | null = null;
  let currentObject: Record<string, unknown> | null = null;

  for (const line of yamlLines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;

    // Array item (indented with -)
    if (indent >= 2 && line.trim().startsWith('- ')) {
      const value = line.trim().slice(2).trim();
      if (currentArray && currentKey) {
        // Check if it's a key: value pair within an array item
        const kvMatch = value.match(/^(\w+):\s*(.+)$/);
        if (kvMatch && currentArray.length > 0 && typeof currentArray[currentArray.length - 1] === 'object') {
          // Add to existing object in array
          (currentArray[currentArray.length - 1] as Record<string, unknown>)[kvMatch[1]] = parseYamlValue(kvMatch[2]);
        } else if (kvMatch && value.includes(':')) {
          // New object in array
          const obj: Record<string, unknown> = {};
          obj[kvMatch[1]] = parseYamlValue(kvMatch[2]);
          currentArray.push(obj);
        } else {
          currentArray.push(parseYamlValue(value));
        }
      }
      continue;
    }

    // Indented key: value (nested object or additional array object fields)
    if (indent >= 2 && currentKey && !line.trim().startsWith('- ')) {
      const kvMatch = line.trim().match(/^(\w+):\s*(.*)$/);
      if (kvMatch) {
        // Switch from array mode to object mode if array is empty
        if (currentArray && currentArray.length === 0 && !currentObject) {
          currentArray = null;
          currentObject = {};
        }
        if (!currentObject) {
          currentObject = {};
        }
        currentObject[kvMatch[1]] = parseYamlValue(kvMatch[2]);
      }
      continue;
    }

    // Top-level key: value
    const topMatch = line.match(/^(\w+):\s*(.*)$/);
    if (topMatch) {
      // Save previous array/object
      if (currentKey && currentArray) {
        frontmatter[currentKey] = currentArray;
      } else if (currentKey && currentObject) {
        frontmatter[currentKey] = currentObject;
      }

      currentKey = topMatch[1];
      const value = topMatch[2].trim();

      if (value === '' || value === '[]') {
        // Could be start of array or object
        currentArray = [];
        currentObject = null;
        if (value === '[]') {
          frontmatter[currentKey] = [];
          currentKey = null;
          currentArray = null;
        }
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array
        const items = value.slice(1, -1).split(',').map(s => parseYamlValue(s.trim()));
        frontmatter[currentKey] = items;
        currentKey = null;
        currentArray = null;
        currentObject = null;
      } else {
        frontmatter[currentKey] = parseYamlValue(value);
        currentKey = null;
        currentArray = null;
        currentObject = null;
      }
    }
  }

  // Save last pending array/object
  if (currentKey && currentArray) {
    frontmatter[currentKey] = currentArray;
  } else if (currentKey && currentObject) {
    frontmatter[currentKey] = currentObject;
  }

  return { frontmatter, body };
}

/**
 * Parse a single YAML value string into the appropriate JS type.
 */
function parseYamlValue(value: string): unknown {
  if (!value || value === '~' || value === 'null') return null;

  // Remove surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // Booleans
  if (value === 'true' || value === 'yes') return true;
  if (value === 'false' || value === 'no') return false;

  // Numbers
  const num = Number(value);
  if (!isNaN(num) && value !== '') return num;

  return value;
}

/**
 * Parse a task spec file content into a SpawnTaskSpec.
 * Returns null if parsing fails.
 */
export function parseTaskSpecFile(content: string, fallbackAgentId: string): { spec: SpawnTaskSpec; instructions: string } | null {
  const parsed = parseYamlFrontmatter(content);
  if (!parsed) return null;

  const { frontmatter, body } = parsed;
  const defaults = createDefaultSpawnTaskSpec(fallbackAgentId);

  const spec: SpawnTaskSpec = {
    agentId: String(frontmatter.agentId ?? defaults.agentId),
    name: String(frontmatter.name ?? defaults.name),
    type: validateType(frontmatter.type) ?? defaults.type,
    priority: validatePriority(frontmatter.priority) ?? defaults.priority,
    dependsOn: Array.isArray(frontmatter.dependsOn) ? frontmatter.dependsOn.map(String) : undefined,
    workingDir: frontmatter.workingDir != null ? String(frontmatter.workingDir) : undefined,
    contextFiles: Array.isArray(frontmatter.contextFiles) ? frontmatter.contextFiles.map(String) : undefined,
    canModifyParentFiles: Boolean(frontmatter.canModifyParentFiles ?? defaults.canModifyParentFiles),
    env: isStringRecord(frontmatter.env) ? frontmatter.env : undefined,
    maxTokens: typeof frontmatter.maxTokens === 'number' ? frontmatter.maxTokens : undefined,
    maxCost: typeof frontmatter.maxCost === 'number' ? frontmatter.maxCost : undefined,
    timeoutMinutes: typeof frontmatter.timeoutMinutes === 'number' ? frontmatter.timeoutMinutes : defaults.timeoutMinutes,
    resultDelivery: validateResultDelivery(frontmatter.resultDelivery) ?? defaults.resultDelivery,
    completionPhrase: String(frontmatter.completionPhrase ?? defaults.completionPhrase),
    progressIntervalSeconds: typeof frontmatter.progressIntervalSeconds === 'number' ? frontmatter.progressIntervalSeconds : defaults.progressIntervalSeconds,
    outputFormat: validateOutputFormat(frontmatter.outputFormat) ?? defaults.outputFormat,
    successCriteria: String(frontmatter.successCriteria ?? defaults.successCriteria),
  };

  // Validate agent name length
  if (spec.name.length > AGENT_NAME_MAX_LENGTH) {
    spec.name = spec.name.slice(0, AGENT_NAME_MAX_LENGTH);
  }

  return { spec, instructions: body };
}

// ========== Validation Helpers ==========

const VALID_TYPES = ['explore', 'implement', 'test', 'review', 'refactor', 'research', 'generate', 'fix', 'general'] as const;
const VALID_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
const VALID_RESULT_DELIVERIES = ['file', 'notify', 'both'] as const;
const VALID_OUTPUT_FORMATS = ['markdown', 'json', 'code', 'structured', 'freeform'] as const;

function validateType(value: unknown): SpawnTaskSpec['type'] | null {
  return VALID_TYPES.includes(value as typeof VALID_TYPES[number]) ? value as SpawnTaskSpec['type'] : null;
}

function validatePriority(value: unknown): SpawnPriority | null {
  return VALID_PRIORITIES.includes(value as typeof VALID_PRIORITIES[number]) ? value as SpawnPriority : null;
}

function validateResultDelivery(value: unknown): SpawnResultDelivery | null {
  return VALID_RESULT_DELIVERIES.includes(value as typeof VALID_RESULT_DELIVERIES[number]) ? value as SpawnResultDelivery : null;
}

function validateOutputFormat(value: unknown): SpawnTaskSpec['outputFormat'] | null {
  return VALID_OUTPUT_FORMATS.includes(value as typeof VALID_OUTPUT_FORMATS[number]) ? value as SpawnTaskSpec['outputFormat'] : null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).every(v => typeof v === 'string');
}

/**
 * Serialize a SpawnResult to YAML frontmatter + markdown body.
 */
export function serializeSpawnResult(result: SpawnResult): string {
  const lines: string[] = ['---'];
  lines.push(`status: ${result.status}`);
  if (result.error) lines.push(`error: "${result.error.replace(/"/g, '\\"')}"`);
  lines.push(`summary: "${result.summary.replace(/"/g, '\\"')}"`);
  lines.push(`durationMs: ${result.durationMs}`);
  lines.push(`cost: ${result.cost}`);
  lines.push(`agentId: ${result.agentId}`);
  lines.push(`completedAt: ${result.completedAt}`);
  if (result.cycleCount != null) lines.push(`cycleCount: ${result.cycleCount}`);

  if (result.filesChanged.length > 0) {
    lines.push('filesChanged:');
    for (const file of result.filesChanged) {
      lines.push(`  - path: ${file.path}`);
      lines.push(`    action: ${file.action}`);
      if (file.summary) lines.push(`    summary: "${file.summary.replace(/"/g, '\\"')}"`);
    }
  } else {
    lines.push('filesChanged: []');
  }

  if (result.artifacts && result.artifacts.length > 0) {
    lines.push('artifacts:');
    for (const artifact of result.artifacts) {
      lines.push(`  - name: ${artifact.name}`);
      lines.push(`    path: ${artifact.path}`);
      lines.push(`    type: ${artifact.type}`);
      lines.push(`    description: "${artifact.description.replace(/"/g, '\\"')}"`);
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(result.output);

  return lines.join('\n');
}

/**
 * Parse a result.md file into a SpawnResult.
 */
export function parseSpawnResult(content: string, agentId: string, fallbackDurationMs: number): SpawnResult | null {
  const parsed = parseYamlFrontmatter(content);
  if (!parsed) return null;

  const { frontmatter, body } = parsed;

  return {
    status: (['completed', 'failed', 'timeout', 'cancelled'].includes(String(frontmatter.status))
      ? String(frontmatter.status) as SpawnResult['status']
      : 'completed'),
    error: frontmatter.error != null ? String(frontmatter.error) : undefined,
    durationMs: typeof frontmatter.durationMs === 'number' ? frontmatter.durationMs : fallbackDurationMs,
    tokens: {
      input: 0,
      output: 0,
      total: 0,
    },
    cost: typeof frontmatter.cost === 'number' ? frontmatter.cost : 0,
    summary: String(frontmatter.summary ?? 'No summary provided'),
    output: body,
    filesChanged: Array.isArray(frontmatter.filesChanged)
      ? frontmatter.filesChanged.map((f: unknown) => {
          if (typeof f === 'object' && f !== null) {
            const obj = f as Record<string, unknown>;
            return {
              path: String(obj.path ?? ''),
              action: (['created', 'modified', 'deleted'].includes(String(obj.action)) ? String(obj.action) : 'modified') as 'created' | 'modified' | 'deleted',
              summary: obj.summary != null ? String(obj.summary) : undefined,
            };
          }
          return { path: String(f), action: 'modified' as const };
        })
      : [],
    artifacts: Array.isArray(frontmatter.artifacts)
      ? frontmatter.artifacts.map((a: unknown) => {
          const obj = a as Record<string, unknown>;
          return {
            name: String(obj.name ?? ''),
            path: String(obj.path ?? ''),
            type: String(obj.type ?? 'unknown'),
            description: String(obj.description ?? ''),
          };
        })
      : undefined,
    agentId,
    completedAt: typeof frontmatter.completedAt === 'number' ? frontmatter.completedAt : Date.now(),
    cycleCount: typeof frontmatter.cycleCount === 'number' ? frontmatter.cycleCount : undefined,
  };
}
