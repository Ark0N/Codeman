/**
 * @fileoverview Tests for template generation functions
 *
 * Tests the CLAUDE.md template generation including
 * default template and custom template loading.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateClaudeMd } from '../src/templates/claude-md.js';

describe('generateClaudeMd', () => {
  const testDir = join(tmpdir(), 'claudeman-template-test-' + Date.now());

  beforeEach(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  describe('default template', () => {
    it('should generate template with case name', () => {
      const result = generateClaudeMd('my-project');

      expect(result).toContain('**Project Name**: my-project');
    });

    it('should generate template with description', () => {
      const result = generateClaudeMd('my-project', 'A test project description');

      expect(result).toContain('**Description**: A test project description');
    });

    it('should use default description when not provided', () => {
      const result = generateClaudeMd('my-project');

      expect(result).toContain('**Description**: A new project');
    });

    it('should include current date', () => {
      const today = new Date().toISOString().split('T')[0];
      const result = generateClaudeMd('my-project');

      expect(result).toContain(`**Last Updated**: ${today}`);
    });

    it('should include Claudeman environment section', () => {
      const result = generateClaudeMd('my-project');

      expect(result).toContain('## Claudeman Environment');
      expect(result).toContain('CLAUDEMAN_MUX=1');
    });

    it('should include work principles', () => {
      const result = generateClaudeMd('my-project');

      expect(result).toContain('## Work Principles');
      expect(result).toContain('### Autonomy');
      expect(result).toContain('### Git Discipline');
    });

    it('should include TodoWrite guidance', () => {
      const result = generateClaudeMd('my-project');

      expect(result).toContain('### Task Tracking (TodoWrite)');
      expect(result).toContain('**ALWAYS use TodoWrite**');
    });

    it('should include Ralph Wiggum Loop section', () => {
      const result = generateClaudeMd('my-project');

      expect(result).toContain('## Ralph Wiggum Loop');
      expect(result).toContain('/ralph-loop:ralph-loop');
      expect(result).toContain('/ralph-loop:cancel-ralph');
    });

    it('should include planning mode section', () => {
      const result = generateClaudeMd('my-project');

      expect(result).toContain('## Planning Mode');
      expect(result).toContain('Multi-file changes');
    });

    it('should include session log table', () => {
      const result = generateClaudeMd('my-project');

      expect(result).toContain('## Session Log');
      expect(result).toContain('| Date | Tasks Completed | Files Changed | Notes |');
    });
  });

  describe('custom template', () => {
    it('should use custom template when provided and exists', () => {
      const templatePath = join(testDir, 'custom-template.md');
      writeFileSync(templatePath, `
# [PROJECT_NAME]

Description: [PROJECT_DESCRIPTION]
Date: [DATE]

Custom content here.
      `);

      const result = generateClaudeMd('my-project', 'Test desc', templatePath);

      expect(result).toContain('# my-project');
      expect(result).toContain('Description: Test desc');
      expect(result).toContain('Custom content here.');
    });

    it('should replace all placeholder occurrences', () => {
      const templatePath = join(testDir, 'multi-placeholder.md');
      writeFileSync(templatePath, `
[PROJECT_NAME] is a project.
The name is [PROJECT_NAME].
About [PROJECT_NAME]: [PROJECT_DESCRIPTION]
      `);

      const result = generateClaudeMd('awesome-app', 'Cool stuff', templatePath);

      expect(result).toContain('awesome-app is a project.');
      expect(result).toContain('The name is awesome-app.');
      expect(result).toContain('About awesome-app: Cool stuff');
    });

    it('should use default description in template when not provided', () => {
      const templatePath = join(testDir, 'desc-template.md');
      writeFileSync(templatePath, 'Description: [PROJECT_DESCRIPTION]');

      const result = generateClaudeMd('my-project', '', templatePath);

      expect(result).toContain('Description: A new project');
    });

    it('should fall back to default template if custom file does not exist', () => {
      const result = generateClaudeMd('my-project', 'desc', '/nonexistent/template.md');

      // Should get default template content
      expect(result).toContain('## Claudeman Environment');
      expect(result).toContain('**Project Name**: my-project');
    });

    it('should fall back to default template if custom path is empty', () => {
      const result = generateClaudeMd('my-project', 'desc', '');

      expect(result).toContain('## Claudeman Environment');
    });

    it('should fall back to default template if custom path is undefined', () => {
      const result = generateClaudeMd('my-project', 'desc', undefined);

      expect(result).toContain('## Claudeman Environment');
    });
  });
});
