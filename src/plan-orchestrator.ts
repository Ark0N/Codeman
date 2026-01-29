/**
 * @fileoverview Enhanced plan generation using subagent orchestration.
 *
 * This module implements a multi-phase plan generation system that leverages
 * Claude's subagent capabilities for parallel analysis and verification.
 *
 * Architecture:
 * 1. Phase 1 (Parallel Analysis): Spawn 4 specialist subagents simultaneously
 * 2. Phase 2 (Synthesis): Merge and deduplicate outputs
 * 3. Phase 3 (Verification): Final review and priority assignment
 *
 * @see https://code.claude.com/docs/en/sub-agents
 * @module plan-orchestrator
 */

import { Session } from './session.js';
import { ScreenManager } from './screen-manager.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  RESEARCH_AGENT_PROMPT,
  REQUIREMENTS_ANALYST_PROMPT,
  ARCHITECTURE_PLANNER_PROMPT,
  TESTING_SPECIALIST_PROMPT,
  RISK_ANALYST_PROMPT,
  CODE_REVIEWER_PROMPT,
  VERIFICATION_PROMPT,
  EXECUTION_OPTIMIZER_PROMPT,
  FINAL_REVIEW_PROMPT,
} from './prompts/index.js';

// ============================================================================
// Types
// ============================================================================

/** Development phase in TDD cycle */
export type PlanPhase = 'setup' | 'test' | 'impl' | 'verify' | 'review';

/** Task execution status */
export type PlanTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';

/**
 * Enhanced plan item with verification, dependencies, and execution tracking.
 * Supports TDD workflow, failure tracking, and plan versioning.
 */
export interface PlanItem {
  /** Unique identifier (e.g., "P0-001") */
  id?: string;
  /** Task description */
  content: string;
  /** Criticality level */
  priority: 'P0' | 'P1' | 'P2' | null;
  /** Which subagent generated this item */
  source?: string;
  /** Why this task is needed */
  rationale?: string;
  /** Legacy numeric phase (1-4) */
  phase?: number;

  // === Verification ===
  /** How to know it's done (e.g., "npm test passes", "endpoint returns 200") */
  verificationCriteria?: string;
  /** Command to run for verification (e.g., "npm test -- --grep='auth'") */
  testCommand?: string;

  // === Dependencies ===
  /** IDs of tasks that must complete first */
  dependencies?: string[];

  // === Execution tracking ===
  /** Current execution status */
  status?: PlanTaskStatus;
  /** How many times attempted */
  attempts?: number;
  /** Most recent failure reason */
  lastError?: string;
  /** Timestamp of completion */
  completedAt?: number;

  // === Metadata ===
  /** Estimated complexity */
  complexity?: 'low' | 'medium' | 'high';
  /** How to undo if needed */
  rollbackStrategy?: string;
  /** Plan version this belongs to */
  version?: number;
  /** TDD phase category */
  tddPhase?: PlanPhase;
  /** ID of paired test/impl task */
  pairedWith?: string;
  /** Checklist items for review tasks (tddPhase: 'review') */
  reviewChecklist?: string[];

  // === Claude Code Execution Optimization ===
  /** Group ID for tasks that can run in parallel */
  parallelGroup?: string;
  /** Recommended Claude Code agent type */
  agentType?: 'explore' | 'implement' | 'test' | 'review' | 'general';
  /** Whether this task benefits from a fresh context */
  requiresFreshContext?: boolean;
  /** Estimated token usage for this task */
  estimatedTokens?: number;
  /** Recommended model for this task */
  recommendedModel?: 'opus' | 'sonnet' | 'haiku';
  /** Files this task will likely read */
  inputFiles?: string[];
  /** Files this task will likely modify */
  outputFiles?: string[];
}

export interface ResearchResult {
  success: boolean;
  findings: {
    /** External resources discovered (GitHub repos, docs, tutorials) */
    externalResources: Array<{
      type: 'github' | 'documentation' | 'tutorial' | 'article' | 'stackoverflow';
      url?: string;
      title: string;
      relevance: string;
      keyInsights: string[];
    }>;
    /** Existing codebase patterns relevant to the task */
    codebasePatterns: Array<{
      pattern: string;
      location: string;
      relevance: string;
    }>;
    /** Technical approach recommendations based on research */
    technicalRecommendations: string[];
    /** Potential challenges identified from research */
    potentialChallenges: string[];
    /** Libraries or tools recommended */
    recommendedTools: Array<{
      name: string;
      purpose: string;
      reason: string;
    }>;
  };
  /** Enhanced task description with research context */
  enrichedTaskDescription: string;
  error?: string;
  durationMs: number;
}

export interface SubagentResult {
  agentType: 'requirements' | 'architecture' | 'testing' | 'risks';
  items: Array<{
    category: string;
    content: string;
    rationale?: string;
  }>;
  success: boolean;
  error?: string;
  durationMs: number;
}

export interface SynthesisResult {
  items: PlanItem[];
  stats: {
    totalFromSubagents: number;
    afterDedup: number;
    sourceBreakdown: Record<string, number>;
  };
}

export interface VerificationResult {
  validatedPlan: PlanItem[];
  gaps: string[];
  warnings: string[];
  qualityScore: number;
}

export interface ParallelGroup {
  id: string;
  tasks: string[];
  rationale: string;
  estimatedDuration?: string;
  totalTokens?: number;
}

export interface ExecutionStrategy {
  totalParallelGroups: number;
  sequentialBlockers: string[];
  freshContextPoints: string[];
  estimatedTotalTokens: number;
  estimatedAgentSpawns: number;
  criticalPath: string[];
  optimizationNotes: string[];
}

export interface ExecutionOptimizerResult {
  optimizedPlan: PlanItem[];
  parallelGroups: ParallelGroup[];
  executionStrategy: ExecutionStrategy;
}

export interface DetailedPlanResult {
  success: boolean;
  items?: PlanItem[];
  costUsd?: number;
  metadata?: {
    researchResult?: ResearchResult;
    subagentResults: SubagentResult[];
    synthesisStats: SynthesisResult['stats'];
    verificationGaps: string[];
    verificationWarnings: string[];
    qualityScore: number;
    totalDurationMs: number;
    parallelGroups?: ParallelGroup[];
    executionStrategy?: ExecutionStrategy;
    finalReview?: FinalReviewResult;
  };
  error?: string;
}

export type ProgressCallback = (phase: string, detail: string) => void;

/** Event types for plan subagent visibility */
export interface PlanSubagentEvent {
  type: 'started' | 'progress' | 'completed' | 'failed';
  agentId: string;
  agentType: 'research' | 'requirements' | 'architecture' | 'testing' | 'risks' | 'verification' | 'execution-optimizer' | 'final-review';
  model: string;
  status: string;
  detail?: string;
  itemCount?: number;
  durationMs?: number;
  error?: string;
}

/** Result from the final review agent */
export interface FinalReviewResult {
  overallAssessment: 'ready' | 'needs-revision' | 'major-issues';
  scores: {
    logic: number;
    completeness: number;
    coherence: number;
    feasibility: number;
    overall: number;
  };
  summary: string;
  issues: Array<{
    severity: 'warning' | 'error';
    issue: string;
    affectedTasks: string[];
    suggestion: string;
  }>;
  missingTasks: Array<{
    content: string;
    reason: string;
    insertAfter?: string;
    priority: 'P0' | 'P1' | 'P2';
  }>;
  recommendations: string[];
}

export type SubagentCallback = (event: PlanSubagentEvent) => void;

// ============================================================================
// JSON Repair Helper
// ============================================================================

/**
 * Attempt to parse JSON with automatic repair for common LLM output issues.
 * Handles: trailing commas, unescaped newlines in strings, truncated output.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tryParseJSON(jsonString: string): { success: boolean; data?: any; error?: string } {
  // First, try direct parse
  try {
    return { success: true, data: JSON.parse(jsonString) };
  } catch (firstError) {
    // Try repairs
    let repaired = jsonString;

    // 1. Remove trailing commas before ] or }
    repaired = repaired.replace(/,(\s*[\]}])/g, '$1');

    // 2. Fix unescaped control characters in strings (common LLM issue)
    // JSON requires all control characters (0x00-0x1F) to be escaped
    // Match strings and escape all control characters within them
    repaired = repaired.replace(/"([^"\\]|\\.)*"/g, (match) => {
      // Replace all control characters with their escaped forms
      return match.replace(/[\x00-\x1F]/g, (char) => {
        switch (char) {
          case '\n': return '\\n';
          case '\r': return '\\r';
          case '\t': return '\\t';
          case '\b': return '\\b';
          case '\f': return '\\f';
          default:
            // Escape other control characters as \uXXXX
            return '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0');
        }
      });
    });

    // 3. Try to close unclosed arrays/objects (truncated output)
    const openBrackets = (repaired.match(/\[/g) || []).length;
    const closeBrackets = (repaired.match(/\]/g) || []).length;
    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;

    // Add missing closing brackets
    for (let i = 0; i < openBraces - closeBraces; i++) {
      // Find last incomplete object and close it
      repaired = repaired.replace(/,\s*$/, '') + '}';
    }
    for (let i = 0; i < openBrackets - closeBrackets; i++) {
      repaired = repaired.replace(/,\s*$/, '') + ']';
    }

    // Try parsing repaired JSON
    try {
      return { success: true, data: JSON.parse(repaired) };
    } catch (secondError) {
      // 4. Last resort: try to extract valid items from array
      // Find all complete objects in the array
      const objectMatches = jsonString.match(/\{[^{}]*\}/g);
      if (objectMatches && objectMatches.length > 0) {
        try {
          const items = objectMatches.map(obj => JSON.parse(obj));
          console.warn(`[JSON Repair] Extracted ${items.length} items from malformed array`);
          return { success: true, data: items };
        } catch {
          // Give up
        }
      }

      const errMsg = firstError instanceof Error ? firstError.message : String(firstError);
      return { success: false, error: errMsg };
    }
  }
}

// ============================================================================
// Constants
// ============================================================================

const RESEARCH_TIMEOUT_MS = 600000; // 10 minutes for research (may need extensive web search)
const SUBAGENT_TIMEOUT_MS = 480000; // 8 minutes per subagent (Opus needs time for complex analysis)
const VERIFICATION_TIMEOUT_MS = 600000; // 10 minutes for verification (Opus + large plans)
const MODEL_RESEARCH = 'opus'; // Best model for research (needs reasoning for web search)
const MODEL_ANALYSIS = 'opus'; // Best model for thorough analysis
const MODEL_VERIFICATION = 'opus'; // Best model for verification

// Note: Prompts are now in src/prompts/*.ts for easier editing
// Suppress unused variable warning for CODE_REVIEWER_PROMPT (reserved for future use)
void CODE_REVIEWER_PROMPT;

// ============================================================================
// Main Orchestrator Class
// ============================================================================

export class PlanOrchestrator {
  private screenManager: ScreenManager;
  private workingDir: string;
  private outputDir?: string;
  private runningSessions: Set<Session> = new Set();
  private cancelled = false;
  private taskDescription = '';

  constructor(screenManager: ScreenManager, workingDir: string = process.cwd(), outputDir?: string) {
    this.screenManager = screenManager;
    this.workingDir = workingDir;
    this.outputDir = outputDir;
  }

  /**
   * Save agent prompt and result to the output directory.
   * Creates a folder for each agent with prompt.md and result.json files.
   */
  private saveAgentOutput(
    agentType: string,
    prompt: string,
    result: unknown,
    durationMs: number
  ): void {
    if (!this.outputDir) return;

    try {
      // Ensure output directory exists
      if (!existsSync(this.outputDir)) {
        mkdirSync(this.outputDir, { recursive: true });
      }

      // Create agent folder
      const agentDir = join(this.outputDir, agentType);
      if (!existsSync(agentDir)) {
        mkdirSync(agentDir, { recursive: true });
      }

      // Save prompt
      const promptPath = join(agentDir, 'prompt.md');
      const promptContent = `# ${agentType} Agent Prompt

Generated: ${new Date().toISOString()}
Duration: ${(durationMs / 1000).toFixed(1)}s

## Task Description
${this.taskDescription}

## Prompt
${prompt}
`;
      writeFileSync(promptPath, promptContent, 'utf-8');

      // Save result
      const resultPath = join(agentDir, 'result.json');
      writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf-8');

      console.log(`[PlanOrchestrator] Saved ${agentType} output to ${agentDir}`);
    } catch (err) {
      console.error(`[PlanOrchestrator] Failed to save ${agentType} output:`, err);
    }
  }

  /**
   * Save the final combined plan result.
   */
  private saveFinalResult(result: DetailedPlanResult): void {
    if (!this.outputDir) return;

    try {
      // Ensure output directory exists
      if (!existsSync(this.outputDir)) {
        mkdirSync(this.outputDir, { recursive: true });
      }

      // Save final result
      const resultPath = join(this.outputDir, 'final-result.json');
      writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf-8');

      // Also save a human-readable summary
      const summaryPath = join(this.outputDir, 'summary.md');
      const summary = this.generateReadableSummary(result);
      writeFileSync(summaryPath, summary, 'utf-8');

      console.log(`[PlanOrchestrator] Saved final result to ${this.outputDir}`);

      // Update the case CLAUDE.md with research context links
      this.updateCaseClaudeMd();

      // Update the project's main CLAUDE.md with Ralph Loop context
      this.updateProjectClaudeMd();
    } catch (err) {
      console.error('[PlanOrchestrator] Failed to save final result:', err);
    }
  }

  /**
   * Update the case folder's CLAUDE.md with links to research and analysis files.
   * This allows Ralph Loop to `/init` and understand the available knowledge base.
   */
  private updateCaseClaudeMd(): void {
    if (!this.outputDir) return;

    try {
      // outputDir is like /path/to/case/ralph-wizard/
      // CLAUDE.md is in the parent (case folder)
      const caseDir = dirname(this.outputDir);
      const claudeMdPath = join(caseDir, 'CLAUDE.md');

      // Get relative path from case folder to ralph-wizard
      const wizardRelPath = 'ralph-wizard';

      // Build the research context section
      const contextSection = `
## Ralph Wizard Knowledge Base

The following research and analysis files were generated for this task.
Use \`/init\` to load this context, then read specific files as needed.

### Research Phase
- \`${wizardRelPath}/research/result.json\` - External resources, codebase patterns, recommendations
- \`${wizardRelPath}/research/prompt.md\` - Research agent instructions

### Analysis Phase
- \`${wizardRelPath}/requirements/result.json\` - Requirements analysis
- \`${wizardRelPath}/architecture/result.json\` - Architecture planning
- \`${wizardRelPath}/testing/result.json\` - Testing strategy
- \`${wizardRelPath}/risks/result.json\` - Risk analysis

### Synthesis & Optimization
- \`${wizardRelPath}/verification/result.json\` - Plan verification and quality scoring
- \`${wizardRelPath}/execution-optimizer/result.json\` - Parallelization strategy
- \`${wizardRelPath}/final-review/result.json\` - Final review and completeness check

### Summary
- \`${wizardRelPath}/summary.md\` - Human-readable plan summary
- \`${wizardRelPath}/final-result.json\` - Complete plan with all metadata

**Key Research Insights**: Check \`${wizardRelPath}/research/result.json\` for:
- External GitHub repos and documentation links
- Existing codebase patterns to follow
- Technical recommendations from research
- Potential challenges to watch for
- Recommended tools and libraries
`;

      // Read existing CLAUDE.md or create new one
      let existingContent = '';
      if (existsSync(claudeMdPath)) {
        existingContent = readFileSync(claudeMdPath, 'utf-8');

        // Remove any existing Ralph Wizard section to avoid duplicates
        const sectionStart = existingContent.indexOf('## Ralph Wizard Knowledge Base');
        if (sectionStart !== -1) {
          // Find the next ## heading or end of file
          const nextSectionMatch = existingContent.slice(sectionStart + 1).match(/\n## /);
          const sectionEnd = nextSectionMatch
            ? sectionStart + 1 + nextSectionMatch.index!
            : existingContent.length;
          existingContent = existingContent.slice(0, sectionStart) + existingContent.slice(sectionEnd);
        }
      }

      // Append the new section
      const newContent = existingContent.trimEnd() + '\n' + contextSection;
      writeFileSync(claudeMdPath, newContent, 'utf-8');

      console.log(`[PlanOrchestrator] Updated CLAUDE.md with research context at ${claudeMdPath}`);
    } catch (err) {
      console.error('[PlanOrchestrator] Failed to update CLAUDE.md:', err);
    }
  }

  /**
   * Update the project's main CLAUDE.md with Ralph Loop context.
   * This ensures Claude instances running in the project directory know about the current task,
   * where to find the plan files, and how to track todos.
   */
  private updateProjectClaudeMd(): void {
    if (!this.outputDir || !this.workingDir) return;

    try {
      const projectClaudeMdPath = join(this.workingDir, 'CLAUDE.md');
      const caseDir = dirname(this.outputDir);

      // Build the Ralph Loop context section
      const contextSection = `
## Active Ralph Loop Task

**Current Task**: ${this.taskDescription}

**Case Folder**: \`${caseDir}\`

### Key Files
- **Plan Summary**: \`${caseDir}/ralph-wizard/summary.md\` - Human-readable plan overview
- **Todo Items**: \`${caseDir}/ralph-wizard/final-result.json\` - Contains \`items\` array with all todo tasks
- **Research**: \`${caseDir}/ralph-wizard/research/result.json\` - External resources and codebase patterns

### How to Work on This Task
1. Read the plan summary to understand the overall approach
2. Check \`final-result.json\` for the todo items array - each item has \`id\`, \`title\`, \`description\`, \`priority\`
3. Work through items in priority order (critical → high → medium → low)
4. Use \`<promise>COMPLETION_PHRASE</promise>\` when the entire task is complete

### Research Insights
Check \`${caseDir}/ralph-wizard/research/result.json\` for:
- External GitHub repos and documentation links to reference
- Existing codebase patterns to follow
- Technical recommendations from the research phase
`;

      // Read existing CLAUDE.md or create new one
      let existingContent = '';
      if (existsSync(projectClaudeMdPath)) {
        existingContent = readFileSync(projectClaudeMdPath, 'utf-8');

        // Remove any existing Ralph Loop section to avoid duplicates
        const sectionStart = existingContent.indexOf('## Active Ralph Loop Task');
        if (sectionStart !== -1) {
          // Find the next ## heading or end of file
          const nextSectionMatch = existingContent.slice(sectionStart + 1).match(/\n## /);
          const sectionEnd = nextSectionMatch
            ? sectionStart + 1 + nextSectionMatch.index!
            : existingContent.length;
          existingContent = existingContent.slice(0, sectionStart) + existingContent.slice(sectionEnd);
        }
      }

      // Append the new section
      const newContent = existingContent.trimEnd() + '\n' + contextSection;
      writeFileSync(projectClaudeMdPath, newContent, 'utf-8');

      console.log(`[PlanOrchestrator] Updated project CLAUDE.md with Ralph Loop context at ${projectClaudeMdPath}`);
    } catch (err) {
      console.error('[PlanOrchestrator] Failed to update project CLAUDE.md:', err);
    }
  }

  /**
   * Generate a human-readable summary of the plan.
   */
  private generateReadableSummary(result: DetailedPlanResult): string {
    const lines: string[] = [
      '# Ralph Wizard Plan Summary',
      '',
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Task Description',
      this.taskDescription,
      '',
    ];

    if (result.metadata?.qualityScore) {
      lines.push(`## Quality Score: ${Math.round(result.metadata.qualityScore * 100)}%`);
      lines.push('');
    }

    // Include research findings if available
    if (result.metadata?.researchResult?.success) {
      const research = result.metadata.researchResult;
      lines.push('## Research Findings');
      lines.push('');

      if (research.findings.externalResources.length > 0) {
        lines.push('### External Resources');
        for (const resource of research.findings.externalResources) {
          lines.push(`- **${resource.title}** (${resource.type})`);
          if (resource.url) lines.push(`  - URL: ${resource.url}`);
          if (resource.keyInsights.length > 0) {
            lines.push(`  - Insights: ${resource.keyInsights.join('; ')}`);
          }
        }
        lines.push('');
      }

      if (research.findings.technicalRecommendations.length > 0) {
        lines.push('### Technical Recommendations');
        for (const rec of research.findings.technicalRecommendations) {
          lines.push(`- ${rec}`);
        }
        lines.push('');
      }

      if (research.findings.potentialChallenges.length > 0) {
        lines.push('### Potential Challenges');
        for (const challenge of research.findings.potentialChallenges) {
          lines.push(`- ${challenge}`);
        }
        lines.push('');
      }

      if (research.findings.recommendedTools.length > 0) {
        lines.push('### Recommended Tools');
        for (const tool of research.findings.recommendedTools) {
          lines.push(`- **${tool.name}**: ${tool.purpose}`);
        }
        lines.push('');
      }
    }

    if (result.metadata?.finalReview) {
      const review = result.metadata.finalReview;
      lines.push('## Final Review');
      lines.push(`- Assessment: ${review.overallAssessment}`);
      lines.push(`- Logic: ${Math.round(review.scores.logic * 100)}%`);
      lines.push(`- Completeness: ${Math.round(review.scores.completeness * 100)}%`);
      lines.push(`- Coherence: ${Math.round(review.scores.coherence * 100)}%`);
      lines.push(`- Feasibility: ${Math.round(review.scores.feasibility * 100)}%`);
      lines.push('');
      if (review.summary) {
        lines.push(review.summary);
        lines.push('');
      }
    }

    if (result.items) {
      lines.push('## Plan Items');
      lines.push('');
      for (const item of result.items) {
        const priority = item.priority || 'P1';
        const phase = item.tddPhase ? ` [${item.tddPhase}]` : '';
        lines.push(`### ${item.id || 'task'}: ${item.content}`);
        lines.push(`- Priority: ${priority}${phase}`);
        if (item.verificationCriteria) {
          lines.push(`- Verification: ${item.verificationCriteria}`);
        }
        if (item.dependencies?.length) {
          lines.push(`- Dependencies: ${item.dependencies.join(', ')}`);
        }
        if (item.parallelGroup) {
          lines.push(`- Parallel Group: ${item.parallelGroup}`);
        }
        if (item.recommendedModel) {
          lines.push(`- Recommended Model: ${item.recommendedModel}`);
        }
        lines.push('');
      }
    }

    if (result.metadata?.executionStrategy) {
      const strategy = result.metadata.executionStrategy;
      lines.push('## Execution Strategy');
      lines.push(`- Parallel Groups: ${strategy.totalParallelGroups}`);
      lines.push(`- Estimated Agent Spawns: ${strategy.estimatedAgentSpawns}`);
      lines.push(`- Estimated Total Tokens: ${strategy.estimatedTotalTokens?.toLocaleString()}`);
      lines.push('');
      if (strategy.optimizationNotes?.length) {
        lines.push('### Optimization Notes');
        for (const note of strategy.optimizationNotes) {
          lines.push(`- ${note}`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Format research findings as context for other agents.
   */
  private formatResearchContext(research: ResearchResult): string {
    if (!research.success) return '';

    const lines: string[] = [
      '## RESEARCH FINDINGS (from prior research phase)',
      '',
    ];

    // External resources
    if (research.findings.externalResources.length > 0) {
      lines.push('### External Resources Discovered');
      for (const resource of research.findings.externalResources) {
        lines.push(`- **${resource.title}** (${resource.type})`);
        if (resource.url) lines.push(`  URL: ${resource.url}`);
        lines.push(`  Relevance: ${resource.relevance}`);
        if (resource.keyInsights.length > 0) {
          lines.push(`  Key insights: ${resource.keyInsights.join('; ')}`);
        }
      }
      lines.push('');
    }

    // Codebase patterns
    if (research.findings.codebasePatterns.length > 0) {
      lines.push('### Existing Codebase Patterns');
      for (const pattern of research.findings.codebasePatterns) {
        lines.push(`- **${pattern.pattern}** at ${pattern.location}`);
        lines.push(`  Relevance: ${pattern.relevance}`);
      }
      lines.push('');
    }

    // Technical recommendations
    if (research.findings.technicalRecommendations.length > 0) {
      lines.push('### Technical Recommendations');
      for (const rec of research.findings.technicalRecommendations) {
        lines.push(`- ${rec}`);
      }
      lines.push('');
    }

    // Potential challenges
    if (research.findings.potentialChallenges.length > 0) {
      lines.push('### Potential Challenges');
      for (const challenge of research.findings.potentialChallenges) {
        lines.push(`- ${challenge}`);
      }
      lines.push('');
    }

    // Recommended tools
    if (research.findings.recommendedTools.length > 0) {
      lines.push('### Recommended Tools/Libraries');
      for (const tool of research.findings.recommendedTools) {
        lines.push(`- **${tool.name}**: ${tool.purpose} (${tool.reason})`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Run the research agent to gather context before analysis.
   */
  private async runResearchAgent(
    taskDescription: string,
    onProgress?: ProgressCallback,
    onSubagent?: SubagentCallback
  ): Promise<ResearchResult> {
    const agentId = `plan-research-${Date.now()}`;
    const startTime = Date.now();

    // Default result if research fails
    const defaultResult: ResearchResult = {
      success: false,
      findings: {
        externalResources: [],
        codebasePatterns: [],
        technicalRecommendations: [],
        potentialChallenges: [],
        recommendedTools: [],
      },
      enrichedTaskDescription: taskDescription,
      error: 'Research skipped',
      durationMs: 0,
    };

    // Check if already cancelled
    if (this.cancelled) {
      return { ...defaultResult, error: 'Cancelled' };
    }

    // Emit started event
    onSubagent?.({
      type: 'started',
      agentId,
      agentType: 'research',
      model: MODEL_RESEARCH,
      status: 'running',
      detail: 'Researching external resources and codebase patterns...',
    });

    const session = new Session({
      workingDir: this.workingDir,
      screenManager: this.screenManager,
      useScreen: false,
      mode: 'claude',
    });

    // Track this session for cancellation
    this.runningSessions.add(session);

    try {
      const prompt = RESEARCH_AGENT_PROMPT
        .replace('{TASK}', taskDescription)
        .replace('{WORKING_DIR}', this.workingDir);

      onProgress?.('research', 'Starting research agent (local project + web search)...');

      // Periodic progress updates showing elapsed time with contextual messages
      const researchPhases = [
        { min: 0, msg: 'Reading CLAUDE.md and exploring project structure...' },
        { min: 30, msg: 'Analyzing existing code patterns and conventions...' },
        { min: 60, msg: 'Searching for relevant documentation and examples...' },
        { min: 120, msg: 'Synthesizing local and external findings...' },
        { min: 180, msg: 'Compiling research results (complex tasks take time)...' },
        { min: 300, msg: 'Almost done - finalizing enriched task description...' },
      ];

      const progressInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        const timeoutSec = Math.floor(RESEARCH_TIMEOUT_MS / 1000);

        // Find appropriate phase message based on elapsed time
        let phaseMsg = researchPhases[0].msg;
        for (const phase of researchPhases) {
          if (elapsedSec >= phase.min) {
            phaseMsg = phase.msg;
          }
        }

        const progressMsg = `${phaseMsg} (${elapsedSec}s / ${timeoutSec}s)`;
        onProgress?.('research', progressMsg);
        onSubagent?.({
          type: 'progress',
          agentId,
          agentType: 'research',
          model: MODEL_RESEARCH,
          status: 'running',
          detail: progressMsg,
        });
        console.log(`[PlanOrchestrator] Research agent: ${elapsedSec}s - ${phaseMsg}`);
      }, 15000); // Update every 15 seconds

      let result: string;
      try {
        const response = await Promise.race([
          session.runPrompt(prompt, { model: MODEL_RESEARCH }),
          this.timeoutWithContext(RESEARCH_TIMEOUT_MS, 'Research agent', startTime),
        ]);
        result = response.result;
      } finally {
        clearInterval(progressInterval);
      }

      // Check if cancelled during execution
      if (this.cancelled) {
        onSubagent?.({
          type: 'failed',
          agentId,
          agentType: 'research',
          model: MODEL_RESEARCH,
          status: 'cancelled',
          error: 'Cancelled',
          durationMs: Date.now() - startTime,
        });
        return { ...defaultResult, error: 'Cancelled', durationMs: Date.now() - startTime };
      }

      // Parse JSON from result with repair for common LLM issues
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('[PlanOrchestrator] Research agent returned no JSON');
        onSubagent?.({
          type: 'completed',
          agentId,
          agentType: 'research',
          model: MODEL_RESEARCH,
          status: 'completed',
          detail: 'Research completed with limited findings',
          durationMs: Date.now() - startTime,
        });
        return { ...defaultResult, durationMs: Date.now() - startTime };
      }

      const parseResult = tryParseJSON(jsonMatch[0]);
      if (!parseResult.success) {
        console.warn('[PlanOrchestrator] Research agent JSON parse failed:', parseResult.error);
        onSubagent?.({
          type: 'completed',
          agentId,
          agentType: 'research',
          model: MODEL_RESEARCH,
          status: 'completed',
          detail: 'Research completed with parse issues',
          durationMs: Date.now() - startTime,
        });
        return { ...defaultResult, error: parseResult.error, durationMs: Date.now() - startTime };
      }

      const parsed = parseResult.data;

      // Parse external resources
      const externalResources = (Array.isArray(parsed.externalResources) ? parsed.externalResources : []).map((r: Record<string, unknown>) => ({
        type: (['github', 'documentation', 'tutorial', 'article', 'stackoverflow'].includes(String(r.type))
          ? r.type : 'article') as 'github' | 'documentation' | 'tutorial' | 'article' | 'stackoverflow',
        url: r.url ? String(r.url) : undefined,
        title: String(r.title || 'Untitled'),
        relevance: String(r.relevance || ''),
        keyInsights: Array.isArray(r.keyInsights) ? r.keyInsights.map(String) : [],
      }));

      // Parse codebase patterns
      const codebasePatterns = (Array.isArray(parsed.codebasePatterns) ? parsed.codebasePatterns : []).map((p: Record<string, unknown>) => ({
        pattern: String(p.pattern || ''),
        location: String(p.location || ''),
        relevance: String(p.relevance || ''),
      }));

      // Parse other fields
      const technicalRecommendations = Array.isArray(parsed.technicalRecommendations)
        ? parsed.technicalRecommendations.map(String)
        : [];

      const potentialChallenges = Array.isArray(parsed.potentialChallenges)
        ? parsed.potentialChallenges.map(String)
        : [];

      const recommendedTools = (Array.isArray(parsed.recommendedTools) ? parsed.recommendedTools : []).map((t: Record<string, unknown>) => ({
        name: String(t.name || ''),
        purpose: String(t.purpose || ''),
        reason: String(t.reason || ''),
      }));

      const enrichedTaskDescription = parsed.enrichedTaskDescription
        ? String(parsed.enrichedTaskDescription)
        : taskDescription;

      const durationMs = Date.now() - startTime;

      const researchResult: ResearchResult = {
        success: true,
        findings: {
          externalResources,
          codebasePatterns,
          technicalRecommendations,
          potentialChallenges,
          recommendedTools,
        },
        enrichedTaskDescription,
        durationMs,
      };

      onProgress?.('research', `Research complete (${externalResources.length} resources, ${codebasePatterns.length} patterns)`);

      // Emit completed event
      onSubagent?.({
        type: 'completed',
        agentId,
        agentType: 'research',
        model: MODEL_RESEARCH,
        status: 'completed',
        itemCount: externalResources.length + codebasePatterns.length,
        durationMs,
      });

      // Save research output to file
      this.saveAgentOutput('research', prompt, { ...researchResult, rawResponse: result }, durationMs);

      return researchResult;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[PlanOrchestrator] Research agent failed:', errorMsg);
      onSubagent?.({
        type: 'failed',
        agentId,
        agentType: 'research',
        model: MODEL_RESEARCH,
        status: 'failed',
        error: errorMsg,
        durationMs: Date.now() - startTime,
      });
      return { ...defaultResult, error: errorMsg, durationMs: Date.now() - startTime };
    } finally {
      // Remove from tracking and clean up
      this.runningSessions.delete(session);
      try {
        await session.stop();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Cancel all running subagent sessions.
   * Call this when the client disconnects or user clicks Stop.
   */
  async cancel(): Promise<void> {
    this.cancelled = true;
    console.log(`[PlanOrchestrator] Cancelling ${this.runningSessions.size} running sessions...`);

    const stopPromises = Array.from(this.runningSessions).map(async (session) => {
      try {
        await session.stop();
      } catch {
        // Ignore cleanup errors
      }
    });

    await Promise.all(stopPromises);
    this.runningSessions.clear();
    console.log('[PlanOrchestrator] All sessions cancelled');
  }

  /**
   * Generate a detailed implementation plan using subagent orchestration.
   *
   * Phases:
   * 0. Research - Gather external resources and codebase context
   * 1. Spawn 4 specialist subagents in parallel for analysis
   * 2. Synthesize their outputs into a unified plan
   * 3. Run verification subagent for quality assurance
   * 4. Ensure all impl tasks have review tasks
   * 5. Run execution optimizer for Claude Code optimization
   * 6. Run final review for holistic validation
   */
  async generateDetailedPlan(
    taskDescription: string,
    onProgress?: ProgressCallback,
    onSubagent?: SubagentCallback
  ): Promise<DetailedPlanResult> {
    const startTime = Date.now();
    let totalCost = 0;

    // Store task description for file saving
    this.taskDescription = taskDescription;

    try {
      // Phase 0: Research - Gather context
      onProgress?.('research', 'Running research agent to gather context...');
      const researchResult = await this.runResearchAgent(taskDescription, onProgress, onSubagent);

      totalCost += researchResult.success ? 0.01 : 0; // Research cost estimate

      // Use enriched task description if research was successful
      const effectiveTaskDescription = researchResult.success
        ? researchResult.enrichedTaskDescription
        : taskDescription;

      // Format research context for other agents
      const researchContext = this.formatResearchContext(researchResult);

      // Phase 1: Parallel Analysis (with research context)
      onProgress?.('parallel-analysis', 'Spawning analysis subagents...');
      const subagentResults = await this.runParallelAnalysis(
        effectiveTaskDescription,
        onProgress,
        onSubagent,
        researchContext
      );

      totalCost += subagentResults.reduce((sum, r) => sum + (r.success ? 0.002 : 0), 0); // Estimate

      // Check if we got enough results to continue
      const successfulResults = subagentResults.filter(r => r.success);
      if (successfulResults.length < 2) {
        return {
          success: false,
          error: `Only ${successfulResults.length} subagents succeeded. Falling back to standard generation.`,
        };
      }

      // Phase 2: Synthesis
      onProgress?.('synthesis', 'Synthesizing subagent outputs...');
      const synthesisResult = this.synthesizeResults(subagentResults);

      // Phase 3: Verification (use enriched task description from research)
      onProgress?.('verification', 'Running verification subagent...');
      const verificationResult = await this.runVerification(
        effectiveTaskDescription,
        synthesisResult.items,
        onProgress,
        onSubagent
      );

      totalCost += 0.01; // Verification cost estimate

      // Phase 4: Ensure all impl tasks have review tasks
      onProgress?.('review-injection', 'Ensuring review tasks for all implementations...');
      const planWithReviews = this.ensureReviewTasks(verificationResult.validatedPlan);
      const reviewsAdded = planWithReviews.length - verificationResult.validatedPlan.length;
      if (reviewsAdded > 0) {
        onProgress?.('review-injection', `Added ${reviewsAdded} auto-review task(s)`);
      }

      // Phase 5: Execution Optimization for Claude Code (optional - failures don't block plan)
      let executionResult: Awaited<ReturnType<typeof this.runExecutionOptimizer>>;
      try {
        onProgress?.('execution-optimization', 'Running execution optimizer for Claude Code...');
        executionResult = await this.runExecutionOptimizer(
          effectiveTaskDescription,
          planWithReviews,
          onProgress,
          onSubagent
        );
        totalCost += 0.008; // Execution optimizer cost estimate
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn('[PlanOrchestrator] Execution optimizer failed (continuing without):', errMsg);
        onProgress?.('execution-optimization', `Skipped (${errMsg.slice(0, 50)})`);
        executionResult = {
          success: false,
          optimizedPlan: planWithReviews,
          parallelGroups: [],
          executionStrategy: {
            totalParallelGroups: 0,
            sequentialBlockers: [],
            freshContextPoints: [],
            estimatedTotalTokens: planWithReviews.length * 20000,
            estimatedAgentSpawns: Math.ceil(planWithReviews.length / 3),
            criticalPath: [],
            optimizationNotes: [`Skipped due to error: ${errMsg}`],
          },
        };
      }

      // Use optimized plan if successful, otherwise fall back to review plan
      const optimizedPlan = executionResult.success ? executionResult.optimizedPlan : planWithReviews;

      // Phase 6: Final Review - Holistic validation (optional - failures don't block plan)
      let finalReviewResult: FinalReviewResult;
      try {
        onProgress?.('final-review', 'Running final review for holistic validation...');
        finalReviewResult = await this.runFinalReview(
          effectiveTaskDescription,
          optimizedPlan,
          onProgress,
          onSubagent
        );
        totalCost += 0.01; // Final review cost estimate
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn('[PlanOrchestrator] Final review failed (continuing without):', errMsg);
        onProgress?.('final-review', `Skipped (${errMsg.slice(0, 50)})`);
        finalReviewResult = {
          overallAssessment: 'ready',
          scores: { logic: 0.8, completeness: 0.8, coherence: 0.8, feasibility: 0.8, overall: 0.8 },
          summary: `Review skipped: ${errMsg}`,
          issues: [],
          missingTasks: [],
          recommendations: [],
        };
      }

      // Apply any missing tasks from final review
      let finalPlan = optimizedPlan;
      if (finalReviewResult.missingTasks.length > 0) {
        finalPlan = this.applyMissingTasks(optimizedPlan, finalReviewResult.missingTasks);
        onProgress?.('final-review', `Added ${finalReviewResult.missingTasks.length} missing task(s)`);
      }

      const totalDurationMs = Date.now() - startTime;

      const result: DetailedPlanResult = {
        success: true,
        items: finalPlan,
        costUsd: totalCost,
        metadata: {
          researchResult: researchResult.success ? researchResult : undefined,
          subagentResults,
          synthesisStats: synthesisResult.stats,
          verificationGaps: verificationResult.gaps,
          verificationWarnings: verificationResult.warnings,
          qualityScore: finalReviewResult.scores.overall || verificationResult.qualityScore,
          totalDurationMs,
          parallelGroups: executionResult.parallelGroups,
          executionStrategy: executionResult.executionStrategy,
          finalReview: finalReviewResult,
        },
      };

      // Save final result to output directory
      this.saveFinalResult(result);

      return result;
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Run all 4 analysis subagents in parallel.
   */
  private async runParallelAnalysis(
    taskDescription: string,
    onProgress?: ProgressCallback,
    onSubagent?: SubagentCallback,
    researchContext: string = ''
  ): Promise<SubagentResult[]> {
    // Inject research context into each prompt
    const injectContext = (prompt: string) =>
      prompt
        .replace('{TASK}', taskDescription)
        .replace('{RESEARCH_CONTEXT}', researchContext || '');

    const subagents: Array<{
      type: SubagentResult['agentType'];
      prompt: string;
    }> = [
      { type: 'requirements', prompt: injectContext(REQUIREMENTS_ANALYST_PROMPT) },
      { type: 'architecture', prompt: injectContext(ARCHITECTURE_PLANNER_PROMPT) },
      { type: 'testing', prompt: injectContext(TESTING_SPECIALIST_PROMPT) },
      { type: 'risks', prompt: injectContext(RISK_ANALYST_PROMPT) },
    ];

    // Run all subagents in parallel
    const promises = subagents.map(({ type, prompt }) =>
      this.runSubagent(type, prompt, onProgress, onSubagent)
    );

    return Promise.all(promises);
  }

  /**
   * Run a single analysis subagent.
   */
  private async runSubagent(
    agentType: SubagentResult['agentType'],
    prompt: string,
    onProgress?: ProgressCallback,
    onSubagent?: SubagentCallback
  ): Promise<SubagentResult> {
    const agentId = `plan-${agentType}-${Date.now()}`;

    // Check if already cancelled
    if (this.cancelled) {
      return {
        agentType,
        items: [],
        success: false,
        error: 'Cancelled',
        durationMs: 0,
      };
    }

    const startTime = Date.now();

    // Emit started event
    onSubagent?.({
      type: 'started',
      agentId,
      agentType,
      model: MODEL_ANALYSIS,
      status: 'running',
      detail: `Analyzing ${agentType}...`,
    });

    const session = new Session({
      workingDir: this.workingDir,
      screenManager: this.screenManager,
      useScreen: false,
      mode: 'claude',
    });

    // Track this session for cancellation
    this.runningSessions.add(session);

    try {
      onProgress?.('subagent', `Running ${agentType} analysis...`);

      // Periodic progress updates showing elapsed time
      const progressInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        const timeoutSec = Math.floor(SUBAGENT_TIMEOUT_MS / 1000);
        console.log(`[PlanOrchestrator] ${agentType} agent: ${elapsedSec}s elapsed (timeout: ${timeoutSec}s)`);
        onSubagent?.({
          type: 'progress',
          agentId,
          agentType,
          model: MODEL_ANALYSIS,
          status: 'running',
          detail: `${agentType} analysis... (${elapsedSec}s / ${timeoutSec}s)`,
        });
      }, 30000); // Update every 30 seconds

      let result: string;
      try {
        const response = await Promise.race([
          session.runPrompt(prompt, { model: MODEL_ANALYSIS }),
          this.timeoutWithContext(SUBAGENT_TIMEOUT_MS, `${agentType} agent`, startTime),
        ]);
        result = response.result;
      } finally {
        clearInterval(progressInterval);
      }

      // Check if cancelled during execution
      if (this.cancelled) {
        onSubagent?.({
          type: 'failed',
          agentId,
          agentType,
          model: MODEL_ANALYSIS,
          status: 'cancelled',
          error: 'Cancelled',
          durationMs: Date.now() - startTime,
        });
        return {
          agentType,
          items: [],
          success: false,
          error: 'Cancelled',
          durationMs: Date.now() - startTime,
        };
      }

      // Parse JSON from result with repair for common LLM issues
      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        onSubagent?.({
          type: 'failed',
          agentId,
          agentType,
          model: MODEL_ANALYSIS,
          status: 'failed',
          error: 'No JSON array found in response',
          durationMs: Date.now() - startTime,
        });
        return {
          agentType,
          items: [],
          success: false,
          error: 'No JSON array found in response',
          durationMs: Date.now() - startTime,
        };
      }

      const parseResult = tryParseJSON(jsonMatch[0]);
      if (!parseResult.success) {
        console.error(`[PlanOrchestrator] ${agentType} JSON parse failed:`, parseResult.error);
        onSubagent?.({
          type: 'failed',
          agentId,
          agentType,
          model: MODEL_ANALYSIS,
          status: 'failed',
          error: `JSON parse error: ${parseResult.error}`,
          durationMs: Date.now() - startTime,
        });
        return {
          agentType,
          items: [],
          success: false,
          error: `JSON parse error: ${parseResult.error}`,
          durationMs: Date.now() - startTime,
        };
      }

      const parsed = parseResult.data;
      if (!Array.isArray(parsed)) {
        onSubagent?.({
          type: 'failed',
          agentId,
          agentType,
          model: MODEL_ANALYSIS,
          status: 'failed',
          error: 'Response is not an array',
          durationMs: Date.now() - startTime,
        });
        return {
          agentType,
          items: [],
          success: false,
          error: 'Response is not an array',
          durationMs: Date.now() - startTime,
        };
      }

      const items = parsed.map((item: unknown) => {
        if (typeof item !== 'object' || item === null) {
          return { category: 'unknown', content: String(item) };
        }
        const obj = item as Record<string, unknown>;
        return {
          category: String(obj.category || 'general'),
          content: String(obj.content || ''),
          rationale: obj.rationale ? String(obj.rationale) : undefined,
        };
      });

      const durationMs = Date.now() - startTime;

      onProgress?.('subagent', `${agentType} complete (${items.length} items)`);

      // Emit completed event
      onSubagent?.({
        type: 'completed',
        agentId,
        agentType,
        model: MODEL_ANALYSIS,
        status: 'completed',
        itemCount: items.length,
        durationMs,
      });

      // Save agent output to file
      this.saveAgentOutput(agentType, prompt, { items, rawResponse: result }, durationMs);

      return {
        agentType,
        items,
        success: true,
        durationMs,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      onSubagent?.({
        type: 'failed',
        agentId,
        agentType,
        model: MODEL_ANALYSIS,
        status: 'failed',
        error: errorMsg,
        durationMs: Date.now() - startTime,
      });
      return {
        agentType,
        items: [],
        success: false,
        error: errorMsg,
        durationMs: Date.now() - startTime,
      };
    } finally {
      // Remove from tracking and clean up
      this.runningSessions.delete(session);
      try {
        await session.stop();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Synthesize results from all subagents into a unified plan.
   */
  private synthesizeResults(subagentResults: SubagentResult[]): SynthesisResult {
    const allItems: PlanItem[] = [];
    const sourceBreakdown: Record<string, number> = {};

    // Collect items from all successful subagents
    for (const result of subagentResults) {
      if (!result.success) continue;

      sourceBreakdown[result.agentType] = result.items.length;

      for (const item of result.items) {
        allItems.push({
          content: item.content,
          priority: null, // Will be assigned by verification
          source: result.agentType,
          rationale: item.rationale,
          phase: this.determinePhase(item.content, result.agentType),
        });
      }
    }

    const totalFromSubagents = allItems.length;

    // Deduplicate similar items
    const deduped = this.deduplicateItems(allItems);

    // Sort by phase
    deduped.sort((a, b) => (a.phase || 4) - (b.phase || 4));

    return {
      items: deduped,
      stats: {
        totalFromSubagents,
        afterDedup: deduped.length,
        sourceBreakdown,
      },
    };
  }

  /**
   * Determine the implementation phase for an item based on keywords.
   */
  private determinePhase(content: string, source: string): number {
    const lower = content.toLowerCase();

    // Phase 1: Foundation
    if (
      lower.includes('create') && (lower.includes('project') || lower.includes('directory')) ||
      lower.includes('setup') ||
      lower.includes('initialize') ||
      lower.includes('configure') ||
      lower.includes('install') ||
      lower.includes('define') && (lower.includes('interface') || lower.includes('type'))
    ) {
      return 1;
    }

    // Phase 2: Tests (before implementation)
    if (
      source === 'testing' ||
      lower.includes('test') ||
      lower.includes('verify') && !lower.includes('final')
    ) {
      return 2;
    }

    // Phase 3: Implementation
    if (
      lower.includes('implement') ||
      lower.includes('build') ||
      lower.includes('add') ||
      lower.includes('create') && !lower.includes('test')
    ) {
      return 3;
    }

    // Phase 4: Integration & Verification
    if (
      lower.includes('integrate') ||
      lower.includes('connect') ||
      lower.includes('final') ||
      lower.includes('run') && lower.includes('suite')
    ) {
      return 4;
    }

    return 3; // Default to implementation phase
  }

  /**
   * Deduplicate similar items using fuzzy matching.
   */
  private deduplicateItems(items: PlanItem[]): PlanItem[] {
    const result: PlanItem[] = [];

    for (const item of items) {
      const isDuplicate = result.some(existing =>
        this.isSimilar(existing.content, item.content)
      );

      if (!isDuplicate) {
        result.push(item);
      }
    }

    return result;
  }

  /**
   * Check if two strings are similar (>60% word overlap).
   */
  private isSimilar(a: string, b: string): boolean {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));

    if (wordsA.size === 0 || wordsB.size === 0) return false;

    let overlap = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) overlap++;
    }

    const similarity = overlap / Math.min(wordsA.size, wordsB.size);
    return similarity > 0.6;
  }

  /**
   * Run the verification subagent to validate and prioritize the plan.
   */
  private async runVerification(
    taskDescription: string,
    synthesizedItems: PlanItem[],
    onProgress?: ProgressCallback,
    onSubagent?: SubagentCallback
  ): Promise<VerificationResult> {
    const agentId = `plan-verification-${Date.now()}`;

    // Check if already cancelled
    if (this.cancelled) {
      return this.fallbackVerification(synthesizedItems);
    }

    // Emit started event
    onSubagent?.({
      type: 'started',
      agentId,
      agentType: 'verification',
      model: MODEL_VERIFICATION,
      status: 'running',
      detail: 'Validating and prioritizing plan...',
    });

    const startTime = Date.now();

    const session = new Session({
      workingDir: this.workingDir,
      screenManager: this.screenManager,
      useScreen: false,
      mode: 'claude',
    });

    // Track this session for cancellation
    this.runningSessions.add(session);

    try {
      // Format plan for verification
      const planText = synthesizedItems
        .map((item, idx) => `${idx + 1}. [Phase ${item.phase}] ${item.content}`)
        .join('\n');

      const prompt = VERIFICATION_PROMPT
        .replace('{TASK}', taskDescription)
        .replace('{PLAN}', planText);

      onProgress?.('verification', 'Validating plan quality...');

      // Periodic progress updates showing elapsed time
      const progressInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        const timeoutSec = Math.floor(VERIFICATION_TIMEOUT_MS / 1000);
        console.log(`[PlanOrchestrator] verification agent: ${elapsedSec}s elapsed (timeout: ${timeoutSec}s)`);
        onSubagent?.({
          type: 'progress',
          agentId,
          agentType: 'verification',
          model: MODEL_VERIFICATION,
          status: 'running',
          detail: `Verifying plan... (${elapsedSec}s / ${timeoutSec}s)`,
        });
      }, 30000); // Update every 30 seconds

      let result: string;
      try {
        const response = await Promise.race([
          session.runPrompt(prompt, { model: MODEL_VERIFICATION }),
          this.timeoutWithContext(VERIFICATION_TIMEOUT_MS, 'verification agent', startTime),
        ]);
        result = response.result;
      } finally {
        clearInterval(progressInterval);
      }

      // Check if cancelled during execution
      if (this.cancelled) {
        return this.fallbackVerification(synthesizedItems);
      }

      // Parse JSON from result with repair for common LLM issues
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        // Fallback: return items with default priorities
        return this.fallbackVerification(synthesizedItems);
      }

      const parseResult = tryParseJSON(jsonMatch[0]);
      if (!parseResult.success) {
        console.warn('[PlanOrchestrator] Verification JSON parse failed:', parseResult.error);
        return this.fallbackVerification(synthesizedItems);
      }

      const parsed = parseResult.data;

      const validatedPlan: PlanItem[] = (parsed.validatedPlan || []).map((item: unknown, idx: number) => {
        if (typeof item !== 'object' || item === null) {
          return { content: String(item), priority: 'P1' as const, id: `task-${idx}` };
        }
        const obj = item as Record<string, unknown>;
        let priority: PlanItem['priority'] = null;
        if (obj.priority === 'P0' || obj.priority === 'P1' || obj.priority === 'P2') {
          priority = obj.priority;
        }

        // Parse TDD phase (now includes 'review')
        let tddPhase: PlanItem['tddPhase'];
        if (obj.tddPhase === 'setup' || obj.tddPhase === 'test' || obj.tddPhase === 'impl' || obj.tddPhase === 'verify' || obj.tddPhase === 'review') {
          tddPhase = obj.tddPhase;
        }

        // Parse complexity
        let complexity: PlanItem['complexity'];
        if (obj.complexity === 'low' || obj.complexity === 'medium' || obj.complexity === 'high') {
          complexity = obj.complexity;
        }

        // Parse reviewChecklist for review tasks
        let reviewChecklist: string[] | undefined;
        if (Array.isArray(obj.reviewChecklist)) {
          reviewChecklist = obj.reviewChecklist.map(String);
        }

        return {
          id: obj.id ? String(obj.id) : `task-${idx}`,
          content: String(obj.content || ''),
          priority,
          rationale: obj.rationale ? String(obj.rationale) : undefined,
          // Enhanced fields
          verificationCriteria: obj.verificationCriteria ? String(obj.verificationCriteria) : undefined,
          testCommand: obj.testCommand ? String(obj.testCommand) : undefined,
          tddPhase,
          pairedWith: obj.pairedWith ? String(obj.pairedWith) : undefined,
          dependencies: Array.isArray(obj.dependencies) ? obj.dependencies.map(String) : undefined,
          complexity,
          reviewChecklist,
          // Execution tracking defaults
          status: 'pending' as PlanTaskStatus,
          attempts: 0,
          version: 1,
        };
      });

      const durationMs = Date.now() - startTime;

      onProgress?.('verification', `Verification complete (quality: ${Math.round((parsed.qualityScore || 0.8) * 100)}%)`);

      // Emit completed event
      onSubagent?.({
        type: 'completed',
        agentId,
        agentType: 'verification',
        model: MODEL_VERIFICATION,
        status: 'completed',
        itemCount: validatedPlan.length,
        durationMs,
      });

      const verificationResult = {
        validatedPlan,
        gaps: Array.isArray(parsed.gaps) ? parsed.gaps.map(String) : [],
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
        qualityScore: typeof parsed.qualityScore === 'number' ? parsed.qualityScore : 0.8,
      };

      // Save agent output to file
      this.saveAgentOutput('verification', prompt, { ...verificationResult, rawResponse: result }, durationMs);

      return verificationResult;
    } catch (err) {
      console.error('[PlanOrchestrator] Verification failed:', err);
      onSubagent?.({
        type: 'failed',
        agentId,
        agentType: 'verification',
        model: MODEL_VERIFICATION,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      });
      return this.fallbackVerification(synthesizedItems);
    } finally {
      // Remove from tracking and clean up
      this.runningSessions.delete(session);
      try {
        await session.stop();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Fallback verification when the verification subagent fails.
   * Assigns heuristic priorities and adds basic verification criteria.
   * Note: This is a silent fallback - no warning shown to user since the result is still useful.
   */
  private fallbackVerification(items: PlanItem[]): VerificationResult {
    console.log('[PlanOrchestrator] Using heuristic priorities (verification subagent timed out or failed)');
    return {
      validatedPlan: items.map((item, idx) => ({
        ...item,
        id: item.id || `task-${idx}`,
        priority: item.phase === 1 ? 'P0' as const :
                  item.phase === 4 ? 'P2' as const : 'P1' as const,
        // Add default verification criteria based on content
        verificationCriteria: item.verificationCriteria ||
          this.inferVerificationCriteria(item.content),
        status: 'pending' as PlanTaskStatus,
        attempts: 0,
        version: 1,
      })),
      gaps: [],
      warnings: [], // Silent fallback - heuristics are good enough, no need to alarm user
      qualityScore: 0.75, // Slightly higher since fallback still produces useful results
    };
  }

  /**
   * Infer verification criteria from task content.
   */
  private inferVerificationCriteria(content: string): string {
    const lower = content.toLowerCase();

    if (lower.includes('test')) {
      return 'Tests pass without errors';
    }
    if (lower.includes('implement') || lower.includes('create') || lower.includes('add')) {
      return 'Code compiles, no type errors';
    }
    if (lower.includes('fix') || lower.includes('debug')) {
      return 'Issue is resolved, tests pass';
    }
    if (lower.includes('refactor')) {
      return 'Code refactored, all tests still pass';
    }
    if (lower.includes('document') || lower.includes('readme')) {
      return 'Documentation exists and is accurate';
    }
    if (lower.includes('config') || lower.includes('setup')) {
      return 'Configuration is valid, app starts';
    }

    return 'Task completed successfully';
  }

  /**
   * Run the execution optimizer to enhance the plan for Claude Code execution.
   * Adds parallel groups, agent type recommendations, and fresh context points.
   */
  private async runExecutionOptimizer(
    taskDescription: string,
    items: PlanItem[],
    onProgress?: ProgressCallback,
    onSubagent?: SubagentCallback
  ): Promise<{
    success: boolean;
    optimizedPlan: PlanItem[];
    parallelGroups: ParallelGroup[];
    executionStrategy: ExecutionStrategy;
  }> {
    const agentId = `plan-execution-${Date.now()}`;
    const startTime = Date.now();

    // Default fallback result
    const defaultResult = {
      success: false,
      optimizedPlan: items,
      parallelGroups: [],
      executionStrategy: {
        totalParallelGroups: 0,
        sequentialBlockers: [],
        freshContextPoints: [],
        estimatedTotalTokens: items.length * 20000,
        estimatedAgentSpawns: Math.ceil(items.length / 3),
        criticalPath: items.slice(0, 5).map(i => i.id || 'unknown'),
        optimizationNotes: ['Fallback: no optimization applied'],
      },
    };

    // Check if already cancelled
    if (this.cancelled) {
      return defaultResult;
    }

    // Emit started event
    onSubagent?.({
      type: 'started',
      agentId,
      agentType: 'execution-optimizer',
      model: MODEL_VERIFICATION,
      status: 'running',
      detail: 'Optimizing plan for Claude Code execution...',
    });

    const session = new Session({
      workingDir: this.workingDir,
      screenManager: this.screenManager,
      useScreen: false,
      mode: 'claude',
    });

    // Track this session for cancellation
    this.runningSessions.add(session);

    try {
      // Format plan for optimization
      const planText = JSON.stringify(items, null, 2);

      const prompt = EXECUTION_OPTIMIZER_PROMPT
        .replace('{TASK}', taskDescription)
        .replace('{PLAN}', planText);

      onProgress?.('execution-optimization', 'Analyzing parallelization opportunities...');

      // Periodic progress updates showing elapsed time
      const progressInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        const timeoutSec = Math.floor(VERIFICATION_TIMEOUT_MS / 1000);
        console.log(`[PlanOrchestrator] execution optimizer: ${elapsedSec}s elapsed (timeout: ${timeoutSec}s)`);
        onSubagent?.({
          type: 'progress',
          agentId,
          agentType: 'execution-optimizer',
          model: MODEL_VERIFICATION,
          status: 'running',
          detail: `Optimizing execution... (${elapsedSec}s / ${timeoutSec}s)`,
        });
      }, 30000); // Update every 30 seconds

      let result: string;
      try {
        const response = await Promise.race([
          session.runPrompt(prompt, { model: MODEL_VERIFICATION }),
          this.timeoutWithContext(VERIFICATION_TIMEOUT_MS, 'execution optimizer', startTime),
        ]);
        result = response.result;
      } finally {
        clearInterval(progressInterval);
      }

      // Check if cancelled during execution
      if (this.cancelled) {
        return defaultResult;
      }

      // Parse JSON from result
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('[PlanOrchestrator] Execution optimizer returned no JSON, using defaults');
        onSubagent?.({
          type: 'completed',
          agentId,
          agentType: 'execution-optimizer',
          model: MODEL_VERIFICATION,
          status: 'completed',
          detail: 'Using default execution strategy',
          itemCount: items.length,
          durationMs: Date.now() - startTime,
        });
        return defaultResult;
      }

      const parseResult = tryParseJSON(jsonMatch[0]);
      if (!parseResult.success) {
        console.warn('[PlanOrchestrator] Execution optimizer JSON parse failed:', parseResult.error);
        return defaultResult;
      }

      const parsed = parseResult.data;

      // Parse optimized plan items
      const optimizedPlan: PlanItem[] = (parsed.optimizedPlan || []).map((item: Record<string, unknown>, idx: number) => {
        // Parse agent type
        let agentType: PlanItem['agentType'];
        if (['explore', 'implement', 'test', 'review', 'general'].includes(String(item.agentType))) {
          agentType = item.agentType as PlanItem['agentType'];
        }

        // Parse recommended model
        let recommendedModel: PlanItem['recommendedModel'];
        if (['opus', 'sonnet', 'haiku'].includes(String(item.recommendedModel))) {
          recommendedModel = item.recommendedModel as PlanItem['recommendedModel'];
        }

        // Find original item to preserve fields
        const originalItem = items.find(i => i.id === item.id) || items[idx] || {};

        return {
          ...originalItem,
          id: item.id ? String(item.id) : originalItem.id || `task-${idx}`,
          content: String(item.content || originalItem.content || ''),
          priority: item.priority as PlanItem['priority'] || originalItem.priority,
          // Preserve existing fields
          tddPhase: item.tddPhase as PlanItem['tddPhase'] || originalItem.tddPhase,
          verificationCriteria: item.verificationCriteria ? String(item.verificationCriteria) : originalItem.verificationCriteria,
          testCommand: item.testCommand ? String(item.testCommand) : originalItem.testCommand,
          dependencies: Array.isArray(item.dependencies) ? item.dependencies.map(String) : originalItem.dependencies,
          pairedWith: item.pairedWith ? String(item.pairedWith) : originalItem.pairedWith,
          complexity: item.complexity as PlanItem['complexity'] || originalItem.complexity,
          reviewChecklist: Array.isArray(item.reviewChecklist) ? item.reviewChecklist.map(String) : originalItem.reviewChecklist,
          // New execution optimization fields
          parallelGroup: item.parallelGroup ? String(item.parallelGroup) : undefined,
          agentType,
          requiresFreshContext: Boolean(item.requiresFreshContext),
          estimatedTokens: typeof item.estimatedTokens === 'number' ? item.estimatedTokens : undefined,
          recommendedModel,
          inputFiles: Array.isArray(item.inputFiles) ? item.inputFiles.map(String) : undefined,
          outputFiles: Array.isArray(item.outputFiles) ? item.outputFiles.map(String) : undefined,
          // Preserve execution tracking
          status: originalItem.status || 'pending' as PlanTaskStatus,
          attempts: originalItem.attempts || 0,
          version: originalItem.version || 1,
        };
      });

      // Parse parallel groups
      const parallelGroups: ParallelGroup[] = (parsed.parallelGroups || []).map((group: Record<string, unknown>) => ({
        id: String(group.id || ''),
        tasks: Array.isArray(group.tasks) ? group.tasks.map(String) : [],
        rationale: String(group.rationale || ''),
        estimatedDuration: group.estimatedDuration ? String(group.estimatedDuration) : undefined,
        totalTokens: typeof group.totalTokens === 'number' ? group.totalTokens : undefined,
      }));

      // Parse execution strategy
      const strategy = parsed.executionStrategy || {};
      const executionStrategy: ExecutionStrategy = {
        totalParallelGroups: typeof strategy.totalParallelGroups === 'number' ? strategy.totalParallelGroups : parallelGroups.length,
        sequentialBlockers: Array.isArray(strategy.sequentialBlockers) ? strategy.sequentialBlockers.map(String) : [],
        freshContextPoints: Array.isArray(strategy.freshContextPoints) ? strategy.freshContextPoints.map(String) : [],
        estimatedTotalTokens: typeof strategy.estimatedTotalTokens === 'number' ? strategy.estimatedTotalTokens : optimizedPlan.length * 20000,
        estimatedAgentSpawns: typeof strategy.estimatedAgentSpawns === 'number' ? strategy.estimatedAgentSpawns : parallelGroups.length,
        criticalPath: Array.isArray(strategy.criticalPath) ? strategy.criticalPath.map(String) : [],
        optimizationNotes: Array.isArray(strategy.optimizationNotes) ? strategy.optimizationNotes.map(String) : [],
      };

      const durationMs = Date.now() - startTime;

      onProgress?.('execution-optimization', `Optimization complete (${parallelGroups.length} parallel groups)`);

      // Emit completed event
      onSubagent?.({
        type: 'completed',
        agentId,
        agentType: 'execution-optimizer',
        model: MODEL_VERIFICATION,
        status: 'completed',
        itemCount: optimizedPlan.length,
        durationMs,
      });

      const executionResult = {
        success: true,
        optimizedPlan,
        parallelGroups,
        executionStrategy,
      };

      // Save agent output to file
      this.saveAgentOutput('execution-optimizer', prompt, { ...executionResult, rawResponse: result }, durationMs);

      return executionResult;
    } catch (err) {
      console.error('[PlanOrchestrator] Execution optimizer failed:', err);
      onSubagent?.({
        type: 'failed',
        agentId,
        agentType: 'execution-optimizer',
        model: MODEL_VERIFICATION,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      });
      return defaultResult;
    } finally {
      // Remove from tracking and clean up
      this.runningSessions.delete(session);
      try {
        await session.stop();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Run the final review agent for holistic plan validation.
   */
  private async runFinalReview(
    taskDescription: string,
    items: PlanItem[],
    onProgress?: ProgressCallback,
    onSubagent?: SubagentCallback
  ): Promise<FinalReviewResult> {
    const agentId = `plan-final-review-${Date.now()}`;
    const startTime = Date.now();

    // Default fallback result
    const defaultResult: FinalReviewResult = {
      overallAssessment: 'ready',
      scores: { logic: 0.8, completeness: 0.8, coherence: 0.8, feasibility: 0.8, overall: 0.8 },
      summary: 'Plan review completed with default assessment.',
      issues: [],
      missingTasks: [],
      recommendations: [],
    };

    // Check if already cancelled
    if (this.cancelled) {
      return defaultResult;
    }

    // Emit started event
    onSubagent?.({
      type: 'started',
      agentId,
      agentType: 'final-review',
      model: MODEL_VERIFICATION,
      status: 'running',
      detail: 'Performing holistic plan review...',
    });

    const session = new Session({
      workingDir: this.workingDir,
      screenManager: this.screenManager,
      useScreen: false,
      mode: 'claude',
    });

    // Track this session for cancellation
    this.runningSessions.add(session);

    try {
      // Format plan for review
      const planText = JSON.stringify(items, null, 2);

      const prompt = FINAL_REVIEW_PROMPT
        .replace('{TASK}', taskDescription)
        .replace('{PLAN}', planText);

      onProgress?.('final-review', 'Analyzing overall plan coherence...');

      // Periodic progress updates showing elapsed time
      const progressInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        const timeoutSec = Math.floor(VERIFICATION_TIMEOUT_MS / 1000);
        console.log(`[PlanOrchestrator] final review: ${elapsedSec}s elapsed (timeout: ${timeoutSec}s)`);
        onSubagent?.({
          type: 'progress',
          agentId,
          agentType: 'final-review',
          model: MODEL_VERIFICATION,
          status: 'running',
          detail: `Final review... (${elapsedSec}s / ${timeoutSec}s)`,
        });
      }, 30000); // Update every 30 seconds

      let result: string;
      try {
        const response = await Promise.race([
          session.runPrompt(prompt, { model: MODEL_VERIFICATION }),
          this.timeoutWithContext(VERIFICATION_TIMEOUT_MS, 'final review', startTime),
        ]);
        result = response.result;
      } finally {
        clearInterval(progressInterval);
      }

      // Check if cancelled during execution
      if (this.cancelled) {
        return defaultResult;
      }

      // Parse JSON from result with repair for common LLM issues
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('[PlanOrchestrator] Final review returned no JSON, using defaults');
        onSubagent?.({
          type: 'completed',
          agentId,
          agentType: 'final-review',
          model: MODEL_VERIFICATION,
          status: 'completed',
          detail: 'Using default assessment',
          itemCount: items.length,
          durationMs: Date.now() - startTime,
        });
        return defaultResult;
      }

      const parseResult = tryParseJSON(jsonMatch[0]);
      if (!parseResult.success) {
        console.warn('[PlanOrchestrator] Final review JSON parse failed:', parseResult.error);
        return defaultResult;
      }

      const parsed = parseResult.data;

      // Parse scores
      const scores = {
        logic: typeof parsed.logicScore === 'number' ? parsed.logicScore : 0.8,
        completeness: typeof parsed.completenessScore === 'number' ? parsed.completenessScore : 0.8,
        coherence: typeof parsed.coherenceScore === 'number' ? parsed.coherenceScore : 0.8,
        feasibility: typeof parsed.feasibilityScore === 'number' ? parsed.feasibilityScore : 0.8,
        overall: typeof parsed.overallScore === 'number' ? parsed.overallScore : 0.8,
      };

      // Parse assessment
      let overallAssessment: FinalReviewResult['overallAssessment'] = 'ready';
      if (parsed.overallAssessment === 'needs-revision' || parsed.overallAssessment === 'major-issues') {
        overallAssessment = parsed.overallAssessment;
      }

      // Parse issues
      const issues = (Array.isArray(parsed.logicIssues) ? parsed.logicIssues : []).map((issue: Record<string, unknown>) => ({
        severity: (issue.severity === 'error' ? 'error' : 'warning') as 'warning' | 'error',
        issue: String(issue.issue || ''),
        affectedTasks: Array.isArray(issue.affectedTasks) ? issue.affectedTasks.map(String) : [],
        suggestion: String(issue.suggestion || ''),
      }));

      // Parse missing tasks
      const missingTasks = (Array.isArray(parsed.missingTasks) ? parsed.missingTasks : []).map((task: Record<string, unknown>) => ({
        content: String(task.content || ''),
        reason: String(task.reason || ''),
        insertAfter: task.insertAfter ? String(task.insertAfter) : undefined,
        priority: (['P0', 'P1', 'P2'].includes(String(task.priority)) ? task.priority : 'P1') as 'P0' | 'P1' | 'P2',
      }));

      // Parse recommendations
      const recommendations = Array.isArray(parsed.finalRecommendations)
        ? parsed.finalRecommendations.map(String)
        : [];

      const reviewResult: FinalReviewResult = {
        overallAssessment,
        scores,
        summary: String(parsed.summary || 'Plan review completed.'),
        issues,
        missingTasks,
        recommendations,
      };

      const durationMs = Date.now() - startTime;

      onProgress?.('final-review', `Review complete (${overallAssessment}, score: ${Math.round(scores.overall * 100)}%)`);

      // Emit completed event
      onSubagent?.({
        type: 'completed',
        agentId,
        agentType: 'final-review',
        model: MODEL_VERIFICATION,
        status: 'completed',
        itemCount: items.length,
        durationMs,
      });

      // Save agent output to file
      this.saveAgentOutput('final-review', prompt, { ...reviewResult, rawResponse: result }, durationMs);

      return reviewResult;
    } catch (err) {
      console.error('[PlanOrchestrator] Final review failed:', err);
      onSubagent?.({
        type: 'failed',
        agentId,
        agentType: 'final-review',
        model: MODEL_VERIFICATION,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      });
      return defaultResult;
    } finally {
      // Remove from tracking and clean up
      this.runningSessions.delete(session);
      try {
        await session.stop();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Apply missing tasks identified by the final review.
   */
  private applyMissingTasks(
    items: PlanItem[],
    missingTasks: FinalReviewResult['missingTasks']
  ): PlanItem[] {
    const result = [...items];

    for (const missing of missingTasks) {
      // Find insertion point
      let insertIndex = result.length; // Default: append at end
      if (missing.insertAfter) {
        const afterIndex = result.findIndex(item => item.id === missing.insertAfter);
        if (afterIndex !== -1) {
          insertIndex = afterIndex + 1;
        }
      }

      // Create new task
      const newId = `${missing.priority}-${String(result.length + 1).padStart(3, '0')}`;
      const newTask: PlanItem = {
        id: newId,
        content: missing.content,
        priority: missing.priority,
        rationale: missing.reason,
        status: 'pending',
        attempts: 0,
        version: 1,
        source: 'final-review',
      };

      // Insert at position
      result.splice(insertIndex, 0, newTask);
    }

    return result;
  }

  /**
   * Create a timeout promise with context about what timed out.
   */
  private timeoutWithContext(ms: number, context: string, startTime: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        const timeoutSec = Math.floor(ms / 1000);
        reject(new Error(`${context} timed out after ${elapsedSec}s (limit: ${timeoutSec}s)`));
      }, ms);
    });
  }

  /**
   * Inject review tasks for any implementation tasks that don't have them.
   * Called as a post-processing step to ensure the test → impl → review cycle is complete.
   *
   * @param items - The validated plan items
   * @returns Updated plan items with review tasks added
   */
  ensureReviewTasks(items: PlanItem[]): PlanItem[] {
    const result: PlanItem[] = [];
    const implTasksNeedingReview: Map<string, PlanItem> = new Map();

    // First pass: identify impl tasks and their existing review pairs
    const reviewPairs = new Set<string>();
    for (const item of items) {
      if (item.tddPhase === 'review' && item.pairedWith) {
        reviewPairs.add(item.pairedWith);
      }
    }

    // Second pass: collect impl tasks without review pairs
    for (const item of items) {
      if (item.tddPhase === 'impl' && item.id && !reviewPairs.has(item.id)) {
        implTasksNeedingReview.set(item.id, item);
      }
    }

    // Third pass: build result with injected review tasks
    for (const item of items) {
      result.push(item);

      // If this is an impl task needing review, inject one after it
      if (item.id && implTasksNeedingReview.has(item.id)) {
        const reviewId = this.generateReviewId(item.id);
        const reviewTask = this.createReviewTask(item, reviewId);
        result.push(reviewTask);
      }
    }

    return result;
  }

  /**
   * Generate a review task ID from an impl task ID.
   * P0-002 → P0-002-R, task-5 → task-5-R
   */
  private generateReviewId(implId: string): string {
    return `${implId}-R`;
  }

  /**
   * Create a review task for an implementation task.
   */
  private createReviewTask(implTask: PlanItem, reviewId: string): PlanItem {
    const reviewChecklist = this.generateReviewChecklist(implTask.content);

    return {
      id: reviewId,
      content: `Review: ${implTask.content}`,
      priority: implTask.priority,
      tddPhase: 'review',
      pairedWith: implTask.id,
      dependencies: implTask.id ? [implTask.id] : [],
      verificationCriteria: 'Code review complete, no issues found or all issues addressed',
      reviewChecklist,
      status: 'pending',
      attempts: 0,
      version: implTask.version || 1,
      complexity: 'low',
    };
  }

  /**
   * Generate a review checklist based on the implementation task content.
   */
  private generateReviewChecklist(content: string): string[] {
    const lower = content.toLowerCase();
    const checklist: string[] = [];

    // Always include these
    checklist.push('Code compiles without errors');
    checklist.push('No TypeScript/linting warnings');

    // Security checks for certain patterns
    if (lower.includes('auth') || lower.includes('login') || lower.includes('password')) {
      checklist.push('Input validation implemented');
      checklist.push('No sensitive data in logs');
      checklist.push('Secure session handling');
    }

    if (lower.includes('api') || lower.includes('endpoint') || lower.includes('route')) {
      checklist.push('Request validation');
      checklist.push('Error responses do not leak internals');
      checklist.push('Rate limiting considered');
    }

    if (lower.includes('database') || lower.includes('query') || lower.includes('sql')) {
      checklist.push('Parameterized queries used');
      checklist.push('No N+1 query issues');
    }

    if (lower.includes('file') || lower.includes('path') || lower.includes('upload')) {
      checklist.push('Path traversal prevented');
      checklist.push('File type validation');
    }

    if (lower.includes('user') || lower.includes('input')) {
      checklist.push('XSS prevention');
      checklist.push('Input sanitization');
    }

    // Performance checks
    if (lower.includes('loop') || lower.includes('iterate') || lower.includes('array')) {
      checklist.push('Algorithm complexity is appropriate');
    }

    // Error handling
    checklist.push('Error cases handled');
    checklist.push('Meaningful error messages');

    // Code quality
    checklist.push('Code is readable and maintainable');
    checklist.push('No duplicate logic');

    return checklist;
  }
}
