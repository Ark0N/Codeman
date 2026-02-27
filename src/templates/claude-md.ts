/**
 * @fileoverview CLAUDE.md template generation
 *
 * Generates CLAUDE.md configuration files for new Codeman projects.
 * Reads the bundled case-template.md and performs placeholder substitution.
 * Supports custom templates via settings.json override.
 *
 * @module templates/claude-md
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_TEMPLATE_PATH = join(__dirname, 'case-template.md');

const MINIMAL_FALLBACK = `# CLAUDE.md - Project Configuration

## Project Overview
- **Project Name**: [PROJECT_NAME]
- **Description**: [PROJECT_DESCRIPTION]
- **Last Updated**: [DATE]

## Session Log

| Date | Tasks Completed | Files Changed | Notes |
|------|-----------------|---------------|-------|
| [DATE] | Project created | CLAUDE.md | Initial setup |
`;

/**
 * Generates a CLAUDE.md configuration file for a new project.
 *
 * Priority order for template resolution:
 * 1. Custom template via `templatePath` parameter (from settings.json)
 * 2. Bundled `case-template.md` (shipped with the project)
 * 3. Minimal fallback (if bundled template is missing)
 *
 * Placeholders replaced: [PROJECT_NAME], [PROJECT_DESCRIPTION], [DATE]
 *
 * @param caseName - The project/case name to use in the template
 * @param description - Optional project description (defaults to "A new project")
 * @param templatePath - Optional path to a custom template file (from settings.json)
 * @returns The generated CLAUDE.md content
 */
export function generateClaudeMd(
  caseName: string,
  description: string = '',
  templatePath?: string
): string {
  const date = new Date().toISOString().split('T')[0];

  // 1. Try custom template from settings.json
  if (templatePath && existsSync(templatePath)) {
    try {
      const template = readFileSync(templatePath, 'utf-8');
      return replacePlaceholders(template, caseName, description, date);
    } catch (err) {
      console.error(`Failed to read custom template from ${templatePath}:`, err);
    }
  }

  // 2. Try bundled template
  if (existsSync(BUNDLED_TEMPLATE_PATH)) {
    try {
      const template = readFileSync(BUNDLED_TEMPLATE_PATH, 'utf-8');
      return replacePlaceholders(template, caseName, description, date);
    } catch (err) {
      console.error(`Failed to read bundled template from ${BUNDLED_TEMPLATE_PATH}:`, err);
    }
  }

  // 3. Minimal fallback
  return replacePlaceholders(MINIMAL_FALLBACK, caseName, description, date);
}

function replacePlaceholders(
  template: string,
  caseName: string,
  description: string,
  date: string
): string {
  return template
    .replace(/\[PROJECT_NAME\]/g, caseName)
    .replace(/\[PROJECT_DESCRIPTION\]/g, description || 'A new project')
    .replace(/\[DATE\]/g, date);
}
