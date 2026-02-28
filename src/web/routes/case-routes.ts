/**
 * @fileoverview Case management routes.
 * Handles CRUD for cases (directories under ~/codeman-cases and linked folders),
 * fix-plan reading, and ralph-wizard file serving.
 */

import { FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type { ApiResponse, CaseInfo } from '../../types.js';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';
import { CreateCaseSchema, LinkCaseSchema } from '../schemas.js';
import { generateClaudeMd } from '../../templates/claude-md.js';
import { writeHooksConfig } from '../../hooks-config.js';
import type { EventPort, ConfigPort } from '../ports/index.js';

const casesDir = join(homedir(), 'codeman-cases');

export function registerCaseRoutes(app: FastifyInstance, ctx: EventPort & ConfigPort): void {
  // ============ Case CRUD ============

  app.get('/api/cases', async (): Promise<CaseInfo[]> => {
    const cases: CaseInfo[] = [];

    // Get cases from casesDir
    try {
      const entries = await fs.readdir(casesDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          cases.push({
            name: e.name,
            path: join(casesDir, e.name),
            hasClaudeMd: existsSync(join(casesDir, e.name, 'CLAUDE.md')),
          });
        }
      }
    } catch {
      // casesDir may not exist yet
    }

    // Get linked cases
    const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
    try {
      const linkedCases: Record<string, string> = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
      for (const [name, path] of Object.entries(linkedCases)) {
        // Only add if not already in cases (avoid duplicates) and path exists
        if (!cases.some((c) => c.name === name) && existsSync(path)) {
          cases.push({
            name,
            path,
            hasClaudeMd: existsSync(join(path, 'CLAUDE.md')),
          });
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[Server] Failed to read linked cases:', err);
      }
    }

    return cases;
  });

  app.post('/api/cases', async (req): Promise<ApiResponse<{ case: { name: string; path: string } }>> => {
    const result = CreateCaseSchema.safeParse(req.body);
    if (!result.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
    }
    const { name, description } = result.data;

    const casePath = join(casesDir, name);

    // Security: Path traversal protection - use relative path check
    const resolvedPath = resolve(casePath);
    const resolvedBase = resolve(casesDir);
    const relPath = relative(resolvedBase, resolvedPath);
    if (relPath.startsWith('..') || isAbsolute(relPath)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');
    }

    if (existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
    }

    try {
      mkdirSync(casePath, { recursive: true });
      mkdirSync(join(casePath, 'src'), { recursive: true });

      // Read settings to get custom template path
      const templatePath = await ctx.getDefaultClaudeMdPath();
      const claudeMd = generateClaudeMd(name, description || '', templatePath);
      writeFileSync(join(casePath, 'CLAUDE.md'), claudeMd);

      // Write .claude/settings.local.json with hooks for desktop notifications
      await writeHooksConfig(casePath);

      ctx.broadcast('case:created', { name, path: casePath });

      return { success: true, data: { case: { name, path: casePath } } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // Link an existing folder as a case
  app.post('/api/cases/link', async (req): Promise<ApiResponse<{ case: { name: string; path: string } }>> => {
    const lcResult = LinkCaseSchema.safeParse(req.body);
    if (!lcResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const { name, path: folderPath } = lcResult.data;

    // Expand ~ to home directory
    const expandedPath = folderPath.startsWith('~') ? join(homedir(), folderPath.slice(1)) : folderPath;

    // Validate the folder exists
    if (!existsSync(expandedPath)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Folder not found: ${expandedPath}`);
    }

    // Check if case name already exists in casesDir
    const casePath = join(casesDir, name);
    if (existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'A case with this name already exists in codeman-cases.');
    }

    // Load existing linked cases
    const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
    let linkedCases: Record<string, string> = {};
    try {
      linkedCases = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[Server] Failed to read linked cases:', err);
      }
    }

    // Check if name is already linked
    if (linkedCases[name]) {
      return createErrorResponse(
        ApiErrorCode.ALREADY_EXISTS,
        `Case "${name}" is already linked to ${linkedCases[name]}`
      );
    }

    // Save the linked case
    linkedCases[name] = expandedPath;
    try {
      const codemanDir = join(homedir(), '.codeman');
      if (!existsSync(codemanDir)) {
        mkdirSync(codemanDir, { recursive: true });
      }
      await fs.writeFile(linkedCasesFile, JSON.stringify(linkedCases, null, 2));
      ctx.broadcast('case:linked', { name, path: expandedPath });
      return { success: true, data: { case: { name, path: expandedPath } } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  app.get('/api/cases/:name', async (req) => {
    const { name } = req.params as { name: string };

    // First check linked cases
    const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
    try {
      const linkedCases: Record<string, string> = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
      if (linkedCases[name]) {
        const linkedPath = linkedCases[name];
        return {
          name,
          path: linkedPath,
          hasClaudeMd: existsSync(join(linkedPath, 'CLAUDE.md')),
          linked: true,
        };
      }
    } catch {
      // ENOENT or parse errors - fall through to casesDir check
    }

    // Then check casesDir
    const casePath = join(casesDir, name);

    if (!existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
    }

    return {
      name,
      path: casePath,
      hasClaudeMd: existsSync(join(casePath, 'CLAUDE.md')),
    };
  });

  // Read @fix_plan.md from a case directory (for wizard to detect existing plans)
  app.get('/api/cases/:name/fix-plan', async (req) => {
    const { name } = req.params as { name: string };

    // Get case path (check linked cases first, then casesDir)
    let casePath: string | null = null;

    const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
    try {
      const linkedCases: Record<string, string> = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
      if (linkedCases[name]) {
        casePath = linkedCases[name];
      }
    } catch {
      // ENOENT or parse errors - fall through to casesDir
    }

    if (!casePath) {
      casePath = join(casesDir, name);
    }

    const fixPlanPath = join(casePath, '@fix_plan.md');

    if (!existsSync(fixPlanPath)) {
      return { success: true, exists: false, content: null, todos: [] };
    }

    try {
      const content = await fs.readFile(fixPlanPath, 'utf-8');

      // Parse todos from the content (similar to ralph-tracker's importFixPlanMarkdown)
      const todos: Array<{
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        priority: string | null;
      }> = [];
      const todoPattern = /^-\s*\[([ xX-])\]\s*(.+)$/;
      const p0HeaderPattern = /^##\s*(High Priority|Critical|P0|Critical Path)/i;
      const p1HeaderPattern = /^##\s*(Standard|P1|Medium Priority)/i;
      const p2HeaderPattern = /^##\s*(Nice to Have|P2|Low Priority)/i;
      const completedHeaderPattern = /^##\s*Completed/i;

      let currentPriority: string | null = null;
      let inCompletedSection = false;

      for (const line of content.split('\n')) {
        const trimmed = line.trim();

        if (p0HeaderPattern.test(trimmed)) {
          currentPriority = 'P0';
          inCompletedSection = false;
          continue;
        }
        if (p1HeaderPattern.test(trimmed)) {
          currentPriority = 'P1';
          inCompletedSection = false;
          continue;
        }
        if (p2HeaderPattern.test(trimmed)) {
          currentPriority = 'P2';
          inCompletedSection = false;
          continue;
        }
        if (completedHeaderPattern.test(trimmed)) {
          inCompletedSection = true;
          continue;
        }

        const match = trimmed.match(todoPattern);
        if (match) {
          const [, checkboxState, taskContent] = match;
          let status: 'pending' | 'in_progress' | 'completed';

          if (inCompletedSection || checkboxState === 'x' || checkboxState === 'X') {
            status = 'completed';
          } else if (checkboxState === '-') {
            status = 'in_progress';
          } else {
            status = 'pending';
          }

          todos.push({
            content: taskContent.trim(),
            status,
            priority: inCompletedSection ? null : currentPriority,
          });
        }
      }

      // Calculate stats in a single pass for better performance
      let pending = 0,
        inProgress = 0,
        completed = 0;
      for (const t of todos) {
        if (t.status === 'pending') pending++;
        else if (t.status === 'in_progress') inProgress++;
        else if (t.status === 'completed') completed++;
      }
      const stats = { total: todos.length, pending, inProgress, completed };

      return {
        success: true,
        exists: true,
        content,
        todos,
        stats,
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read @fix_plan.md: ${err}`);
    }
  });

  // ============ Ralph Wizard File Endpoints ============

  app.get('/api/cases/:caseName/ralph-wizard/files', async (req) => {
    const { caseName } = req.params as { caseName: string };
    let casePath = join(casesDir, caseName);

    // Security: Path traversal protection - use relative path check
    const resolvedCase = resolve(casePath);
    const resolvedBase = resolve(casesDir);
    const relPath = relative(resolvedBase, resolvedCase);
    if (relPath.startsWith('..') || isAbsolute(relPath)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    // Check linked cases if path doesn't exist
    if (!existsSync(casePath)) {
      const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
      try {
        const linkedCases: Record<string, string> = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
        if (linkedCases[caseName]) {
          casePath = linkedCases[caseName];
        }
      } catch {
        // No linked cases file
      }
    }

    const wizardDir = join(casePath, 'ralph-wizard');

    if (!existsSync(wizardDir)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Ralph wizard directory not found');
    }

    // List all subdirectories and their files
    const files: Array<{ agentType: string; promptFile?: string; resultFile?: string }> = [];
    const entries = readdirSync(wizardDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const agentDir = join(wizardDir, entry.name);
        const agentFiles: { agentType: string; promptFile?: string; resultFile?: string } = {
          agentType: entry.name,
        };

        if (existsSync(join(agentDir, 'prompt.md'))) {
          agentFiles.promptFile = `${entry.name}/prompt.md`;
        }
        if (existsSync(join(agentDir, 'result.json'))) {
          agentFiles.resultFile = `${entry.name}/result.json`;
        }

        if (agentFiles.promptFile || agentFiles.resultFile) {
          files.push(agentFiles);
        }
      }
    }

    return { success: true, data: { files, caseName } };
  });

  // Read a specific ralph-wizard file
  // Cache disabled to ensure fresh prompts when starting new plan generations
  app.get('/api/cases/:caseName/ralph-wizard/file/:filePath', async (req, reply) => {
    const { caseName, filePath } = req.params as { caseName: string; filePath: string };
    let casePath = join(casesDir, caseName);

    // Prevent browser caching - prompts change between plan generations
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');

    // Security: Path traversal protection for case name - use relative path check
    const resolvedCase = resolve(casePath);
    const resolvedBase = resolve(casesDir);
    const relPath = relative(resolvedBase, resolvedCase);
    if (relPath.startsWith('..') || isAbsolute(relPath)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    // Check linked cases if path doesn't exist
    if (!existsSync(casePath)) {
      const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
      try {
        const linkedCases: Record<string, string> = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
        if (linkedCases[caseName]) {
          casePath = linkedCases[caseName];
        }
      } catch {
        // No linked cases file
      }
    }

    const wizardDir = join(casePath, 'ralph-wizard');

    // Decode the file path (it may be URL encoded)
    const decodedPath = decodeURIComponent(filePath);
    const fullPath = join(wizardDir, decodedPath);

    // Security: ensure path is within wizard directory
    const resolvedPath = resolve(fullPath);
    const resolvedWizard = resolve(wizardDir);
    if (!resolvedPath.startsWith(resolvedWizard)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid file path');
    }

    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found');
      }
      throw err;
    }
    const isJson = filePath.endsWith('.json');

    // Parse JSON content safely (may contain invalid JSON or unescaped control characters)
    let parsed: unknown = null;
    if (isJson) {
      try {
        parsed = JSON.parse(content);
      } catch {
        // Try repairing common JSON issues (unescaped control characters, trailing commas)
        try {
          let repaired = content;
          // Fix trailing commas before closing brackets
          repaired = repaired.replace(/,(\s*[\]}])/g, '$1');
          // Fix unescaped control characters within JSON strings
          repaired = repaired.replace(/"([^"\\]|\\.)*"/g, (match) => {
            return match
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r')
              .replace(/\t/g, '\\t')
              .replace(
                // eslint-disable-next-line no-control-regex
                /[\x00-\x1f]/g,
                (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
              );
          });
          parsed = JSON.parse(repaired);
        } catch {
          // Still invalid - return null for parsed, content available as raw string
        }
      }
    }

    return {
      success: true,
      data: {
        content,
        filePath: decodedPath,
        isJson,
        parsed,
      },
    };
  });
}
