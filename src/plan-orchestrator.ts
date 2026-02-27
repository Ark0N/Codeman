/**
 * @fileoverview Simplified plan generation with 2 agents instead of 9.
 *
 * Previous architecture (removed):
 * - 4 parallel analysis agents (requirements, architecture, testing, risks)
 * - Synthesis phase
 * - Verification agent
 * - Execution optimizer agent (output was ignored anyway)
 * - Final review agent
 *
 * New architecture:
 * 1. Research Agent - gather context (optional, can fail)
 * 2. Planner Agent - single agent generates complete TDD plan
 *
 * @module plan-orchestrator
 */

import { Session } from './session.js';
import type { TerminalMultiplexer } from './mux-interface.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESEARCH_AGENT_PROMPT, PLANNER_PROMPT } from './prompts/index.js';
import { PlanTaskStatus, TddPhase } from './types.js';

// ============================================================================
// Types
// ============================================================================

/** Development phase in TDD cycle (alias for TddPhase) */
export type PlanPhase = TddPhase;

/**
 * Plan item with TDD structure.
 */
export interface PlanItem {
  id?: string;
  content: string;
  priority: 'P0' | 'P1' | 'P2' | null;
  source?: string;
  rationale?: string;
  verificationCriteria?: string;
  testCommand?: string;
  dependencies?: string[];
  status?: PlanTaskStatus;
  attempts?: number;
  lastError?: string;
  completedAt?: number;
  complexity?: 'low' | 'medium' | 'high';
  tddPhase?: PlanPhase;
  pairedWith?: string;
  reviewChecklist?: string[];
}

export interface ResearchResult {
  success: boolean;
  findings: {
    externalResources: Array<{
      type: 'github' | 'documentation' | 'tutorial' | 'article' | 'stackoverflow';
      url?: string;
      title: string;
      relevance: string;
      keyInsights: string[];
    }>;
    codebasePatterns: Array<{
      pattern: string;
      location: string;
      relevance: string;
    }>;
    technicalRecommendations: string[];
    potentialChallenges: string[];
    recommendedTools: Array<{
      name: string;
      purpose: string;
      reason: string;
    }>;
  };
  enrichedTaskDescription: string;
  error?: string;
  durationMs: number;
}

export interface PlannerResult {
  items: PlanItem[];
  gaps: string[];
  warnings: string[];
}

export interface DetailedPlanResult {
  success: boolean;
  items?: PlanItem[];
  costUsd?: number;
  metadata?: {
    researchResult?: ResearchResult;
    plannerGaps: string[];
    plannerWarnings: string[];
    totalDurationMs: number;
  };
  error?: string;
}

export type ProgressCallback = (phase: string, detail: string) => void;

export interface PlanSubagentEvent {
  type: 'started' | 'progress' | 'completed' | 'failed';
  agentId: string;
  agentType: 'research' | 'planner';
  model: string;
  status: string;
  detail?: string;
  itemCount?: number;
  durationMs?: number;
  error?: string;
}

export type SubagentCallback = (event: PlanSubagentEvent) => void;

// ============================================================================
// JSON Repair Helper
// ============================================================================

function tryParseJSON(jsonString: string): { success: boolean; data?: unknown; error?: string } {
  try {
    return { success: true, data: JSON.parse(jsonString) };
  } catch (firstError) {
    let repaired = jsonString;
    repaired = repaired.replace(/,(\s*[\]}])/g, '$1');
    repaired = repaired.replace(/"([^"\\]|\\.)*"/g, (match) => {
      return match.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    });

    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;
    for (let i = 0; i < openBraces - closeBraces; i++) {
      repaired = repaired.replace(/,\s*$/, '') + '}';
    }

    try {
      return { success: true, data: JSON.parse(repaired) };
    } catch {
      const errMsg = firstError instanceof Error ? firstError.message : String(firstError);
      return { success: false, error: errMsg };
    }
  }
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MODEL = 'opus';

// ============================================================================
// Main Orchestrator Class
// ============================================================================

export class PlanOrchestrator {
  private mux: TerminalMultiplexer;
  private workingDir: string;
  private outputDir?: string;
  private runningSessions: Set<Session> = new Set();
  private cancelled = false;
  private taskDescription = '';
  private researchModel: string;
  private plannerModel: string;

  constructor(
    mux: TerminalMultiplexer,
    workingDir: string = process.cwd(),
    outputDir?: string,
    modelConfig?: { defaultModel?: string; agentTypeOverrides?: Record<string, string> }
  ) {
    this.mux = mux;
    this.workingDir = workingDir;
    this.outputDir = outputDir;
    this.researchModel =
      modelConfig?.agentTypeOverrides?.explore || modelConfig?.defaultModel || DEFAULT_MODEL;
    this.plannerModel =
      modelConfig?.agentTypeOverrides?.review || modelConfig?.defaultModel || DEFAULT_MODEL;
  }

  private saveAgentOutput(
    agentType: string,
    prompt: string,
    result: unknown,
    durationMs: number
  ): void {
    if (!this.outputDir) return;

    try {
      if (!existsSync(this.outputDir)) {
        mkdirSync(this.outputDir, { recursive: true });
      }

      const agentDir = join(this.outputDir, agentType);
      if (!existsSync(agentDir)) {
        mkdirSync(agentDir, { recursive: true });
      }

      const promptPath = join(agentDir, 'prompt.md');
      writeFileSync(
        promptPath,
        `# ${agentType} Agent Prompt\n\nGenerated: ${new Date().toISOString()}\nDuration: ${(durationMs / 1000).toFixed(1)}s\n\n## Task\n${this.taskDescription}\n\n## Prompt\n${prompt}\n`,
        'utf-8'
      );

      const resultPath = join(agentDir, 'result.json');
      writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[PlanOrchestrator] Failed to save ${agentType} output:`, err);
    }
  }

  private saveFinalResult(result: DetailedPlanResult): void {
    if (!this.outputDir) return;

    try {
      if (!existsSync(this.outputDir)) {
        mkdirSync(this.outputDir, { recursive: true });
      }

      // Save final result JSON
      const resultPath = join(this.outputDir, 'final-result.json');
      writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf-8');

      // Save human-readable summary
      if (result.success && result.items) {
        const summaryPath = join(this.outputDir, 'summary.md');
        const summary = this.generateSummary(result);
        writeFileSync(summaryPath, summary, 'utf-8');
      }
    } catch (err) {
      console.warn('[PlanOrchestrator] Failed to save final result:', err);
    }
  }

  private generateSummary(result: DetailedPlanResult): string {
    const items = result.items || [];
    const p0 = items.filter((i) => i.priority === 'P0');
    const p1 = items.filter((i) => i.priority === 'P1');
    const p2 = items.filter((i) => i.priority === 'P2');

    let md = `# Plan Summary\n\n`;
    md += `Generated: ${new Date().toISOString()}\n`;
    md += `Total Tasks: ${items.length} (P0: ${p0.length}, P1: ${p1.length}, P2: ${p2.length})\n\n`;

    md += `## Task\n${this.taskDescription}\n\n`;

    const addSection = (title: string, tasks: PlanItem[]) => {
      if (tasks.length === 0) return;
      md += `## ${title}\n\n`;
      for (const t of tasks) {
        const phase = t.tddPhase ? ` [${t.tddPhase}]` : '';
        md += `- **${t.id}**${phase}: ${t.content}\n`;
        if (t.verificationCriteria) md += `  - Verify: ${t.verificationCriteria}\n`;
      }
      md += '\n';
    };

    addSection('P0 - Critical', p0);
    addSection('P1 - Required', p1);
    addSection('P2 - Enhancement', p2);

    if (result.metadata?.plannerWarnings?.length) {
      md += `## Warnings\n\n`;
      for (const w of result.metadata.plannerWarnings) {
        md += `- ${w}\n`;
      }
    }

    return md;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    // Stop all running sessions and await cleanup to prevent PTY process leaks
    const stopPromises: Promise<void>[] = [];
    for (const session of this.runningSessions) {
      stopPromises.push(
        session.stop().catch((err) => {
          console.error('[PlanOrchestrator] Failed to stop session during cancel:', err);
        })
      );
    }
    await Promise.all(stopPromises);
    this.runningSessions.clear();
  }

  /**
   * Generate a detailed TDD plan.
   *
   * Flow:
   * 1. Research Agent (optional - failures don't block)
   * 2. Planner Agent (generates complete TDD plan)
   */
  async generateDetailedPlan(
    taskDescription: string,
    onProgress?: ProgressCallback,
    onSubagent?: SubagentCallback
  ): Promise<DetailedPlanResult> {
    const startTime = Date.now();
    let totalCost = 0;

    this.taskDescription = taskDescription;

    try {
      // Phase 1: Research (optional)
      onProgress?.('research', 'Running research agent...');
      const researchResult = await this.runResearchAgent(taskDescription, onProgress, onSubagent);
      totalCost += researchResult.success ? 0.01 : 0;

      const effectiveTaskDescription = researchResult.success
        ? researchResult.enrichedTaskDescription
        : taskDescription;

      const researchContext = this.formatResearchContext(researchResult);

      // Phase 2: Planner (main agent)
      onProgress?.('planning', 'Running planner agent...');
      const plannerResult = await this.runPlannerAgent(
        effectiveTaskDescription,
        researchContext,
        onProgress,
        onSubagent
      );

      if (!plannerResult.success) {
        return {
          success: false,
          error: plannerResult.error || 'Planner failed',
        };
      }

      totalCost += 0.01;

      const totalDurationMs = Date.now() - startTime;

      const result: DetailedPlanResult = {
        success: true,
        items: plannerResult.items,
        costUsd: totalCost,
        metadata: {
          researchResult: researchResult.success ? researchResult : undefined,
          plannerGaps: plannerResult.gaps || [],
          plannerWarnings: plannerResult.warnings || [],
          totalDurationMs,
        },
      };

      this.saveFinalResult(result);
      return result;
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private formatResearchContext(research: ResearchResult): string {
    if (!research.success) return '';

    const parts: string[] = ['## Research Context\n'];

    if (research.findings.externalResources.length > 0) {
      parts.push('### External Resources');
      for (const r of research.findings.externalResources.slice(0, 5)) {
        parts.push(`- ${r.title}${r.url ? ` (${r.url})` : ''}`);
        if (r.keyInsights.length > 0) {
          parts.push(`  Key insights: ${r.keyInsights.slice(0, 3).join(', ')}`);
        }
      }
      parts.push('');
    }

    if (research.findings.codebasePatterns.length > 0) {
      parts.push('### Existing Codebase Patterns');
      for (const p of research.findings.codebasePatterns.slice(0, 5)) {
        parts.push(`- ${p.pattern} at ${p.location}`);
      }
      parts.push('');
    }

    if (research.findings.technicalRecommendations.length > 0) {
      parts.push('### Recommendations');
      for (const r of research.findings.technicalRecommendations.slice(0, 5)) {
        parts.push(`- ${r}`);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  private async runResearchAgent(
    taskDescription: string,
    _onProgress?: ProgressCallback,
    onSubagent?: SubagentCallback
  ): Promise<ResearchResult> {
    const agentId = `research-${Date.now()}`;
    const startTime = Date.now();

    if (this.cancelled) {
      return {
        success: false,
        findings: {
          externalResources: [],
          codebasePatterns: [],
          technicalRecommendations: [],
          potentialChallenges: [],
          recommendedTools: [],
        },
        enrichedTaskDescription: taskDescription,
        error: 'Cancelled',
        durationMs: 0,
      };
    }

    onSubagent?.({
      type: 'started',
      agentId,
      agentType: 'research',
      model: this.researchModel,
      status: 'running',
      detail: 'Researching...',
    });

    const session = new Session({
      workingDir: this.workingDir,
      mux: this.mux,
      useMux: false,
      mode: 'claude',
    });

    this.runningSessions.add(session);

    const prompt = RESEARCH_AGENT_PROMPT.replace('{TASK}', taskDescription).replace(
      '{WORKING_DIR}',
      this.workingDir
    );

    // Start progress interval before try block to ensure cleanup in finally
    const progressInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      onSubagent?.({
        type: 'progress',
        agentId,
        agentType: 'research',
        model: this.researchModel,
        status: 'running',
        detail: `${elapsed}s elapsed`,
      });
    }, 30000);

    try {
      const { result: response } = await session.runPrompt(prompt, { model: this.researchModel });

      this.runningSessions.delete(session);

      const durationMs = Date.now() - startTime;

      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        onSubagent?.({
          type: 'failed',
          agentId,
          agentType: 'research',
          model: this.researchModel,
          status: 'failed',
          error: 'No JSON found',
          durationMs,
        });
        return {
          success: false,
          findings: {
            externalResources: [],
            codebasePatterns: [],
            technicalRecommendations: [],
            potentialChallenges: [],
            recommendedTools: [],
          },
          enrichedTaskDescription: taskDescription,
          error: 'No JSON in response',
          durationMs,
        };
      }

      const parsed = tryParseJSON(jsonMatch[0]);
      if (!parsed.success) {
        onSubagent?.({
          type: 'failed',
          agentId,
          agentType: 'research',
          model: this.researchModel,
          status: 'failed',
          error: parsed.error,
          durationMs,
        });
        return {
          success: false,
          findings: {
            externalResources: [],
            codebasePatterns: [],
            technicalRecommendations: [],
            potentialChallenges: [],
            recommendedTools: [],
          },
          enrichedTaskDescription: taskDescription,
          error: parsed.error,
          durationMs,
        };
      }

      const data = parsed.data as Record<string, unknown>;
      const result: ResearchResult = {
        success: true,
        findings: {
          externalResources: Array.isArray(data.externalResources) ? data.externalResources : [],
          codebasePatterns: Array.isArray(data.codebasePatterns) ? data.codebasePatterns : [],
          technicalRecommendations: Array.isArray(data.technicalRecommendations)
            ? data.technicalRecommendations
            : [],
          potentialChallenges: Array.isArray(data.potentialChallenges)
            ? data.potentialChallenges
            : [],
          recommendedTools: Array.isArray(data.recommendedTools) ? data.recommendedTools : [],
        },
        enrichedTaskDescription:
          typeof data.enrichedTaskDescription === 'string'
            ? data.enrichedTaskDescription
            : taskDescription,
        durationMs,
      };

      this.saveAgentOutput('research', prompt, result, durationMs);
      onSubagent?.({
        type: 'completed',
        agentId,
        agentType: 'research',
        model: this.researchModel,
        status: 'completed',
        durationMs,
      });

      return result;
    } catch (err) {
      this.runningSessions.delete(session);
      const durationMs = Date.now() - startTime;
      const error = err instanceof Error ? err.message : String(err);
      onSubagent?.({
        type: 'failed',
        agentId,
        agentType: 'research',
        model: this.researchModel,
        status: 'failed',
        error,
        durationMs,
      });
      return {
        success: false,
        findings: {
          externalResources: [],
          codebasePatterns: [],
          technicalRecommendations: [],
          potentialChallenges: [],
          recommendedTools: [],
        },
        enrichedTaskDescription: taskDescription,
        error,
        durationMs,
      };
    } finally {
      // Always clear the progress interval to prevent memory leaks
      clearInterval(progressInterval);
    }
  }

  private async runPlannerAgent(
    taskDescription: string,
    researchContext: string,
    onProgress?: ProgressCallback,
    onSubagent?: SubagentCallback
  ): Promise<{
    success: boolean;
    items?: PlanItem[];
    gaps?: string[];
    warnings?: string[];
    error?: string;
  }> {
    const agentId = `planner-${Date.now()}`;
    const startTime = Date.now();

    if (this.cancelled) {
      return { success: false, error: 'Cancelled' };
    }

    onSubagent?.({
      type: 'started',
      agentId,
      agentType: 'planner',
      model: this.plannerModel,
      status: 'running',
      detail: 'Generating plan...',
    });

    const session = new Session({
      workingDir: this.workingDir,
      mux: this.mux,
      useMux: false,
      mode: 'claude',
    });

    this.runningSessions.add(session);

    const prompt = PLANNER_PROMPT.replace('{TASK}', taskDescription).replace(
      '{RESEARCH_CONTEXT}',
      researchContext || ''
    );

    // Start progress interval before try block to ensure cleanup in finally
    const progressInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      onSubagent?.({
        type: 'progress',
        agentId,
        agentType: 'planner',
        model: this.plannerModel,
        status: 'running',
        detail: `${elapsed}s elapsed`,
      });
    }, 30000);

    try {
      const { result: response } = await session.runPrompt(prompt, { model: this.plannerModel });

      this.runningSessions.delete(session);

      const durationMs = Date.now() - startTime;

      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        onSubagent?.({
          type: 'failed',
          agentId,
          agentType: 'planner',
          model: this.plannerModel,
          status: 'failed',
          error: 'No JSON found',
          durationMs,
        });
        return { success: false, error: 'No JSON in response' };
      }

      const parsed = tryParseJSON(jsonMatch[0]);
      if (!parsed.success) {
        onSubagent?.({
          type: 'failed',
          agentId,
          agentType: 'planner',
          model: this.plannerModel,
          status: 'failed',
          error: parsed.error,
          durationMs,
        });
        return { success: false, error: parsed.error };
      }

      const data = parsed.data as Record<string, unknown>;
      const items: PlanItem[] = Array.isArray(data.items) ? data.items : [];
      const gaps: string[] = Array.isArray(data.gaps) ? data.gaps : [];
      const warnings: string[] = Array.isArray(data.warnings) ? data.warnings : [];

      this.saveAgentOutput('planner', prompt, { items, gaps, warnings }, durationMs);
      onSubagent?.({
        type: 'completed',
        agentId,
        agentType: 'planner',
        model: this.plannerModel,
        status: 'completed',
        itemCount: items.length,
        durationMs,
      });

      onProgress?.('planning', `Generated ${items.length} tasks`);

      return { success: true, items, gaps, warnings };
    } catch (err) {
      this.runningSessions.delete(session);
      const durationMs = Date.now() - startTime;
      const error = err instanceof Error ? err.message : String(err);
      onSubagent?.({
        type: 'failed',
        agentId,
        agentType: 'planner',
        model: this.plannerModel,
        status: 'failed',
        error,
        durationMs,
      });
      return { success: false, error };
    } finally {
      // Always clear the progress interval to prevent memory leaks
      clearInterval(progressInterval);
    }
  }
}
