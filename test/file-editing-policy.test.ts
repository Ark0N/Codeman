/**
 * @fileoverview Unit tests for the File Viewer edit-mode policy module.
 *
 * Pure functions only — no IO, no server.
 * Port: N/A (no server)
 */

import { describe, it, expect } from 'vitest';
import { TEXT_ATTACHMENT_EXTENSIONS } from '../src/attachment-registry.js';
import {
  EDITABLE_EXTENSIONS,
  MAX_EDITABLE_BYTES,
  applyEol,
  detectEol,
  isDeniedEditRelativePath,
  isEditableFileName,
} from '../src/config/file-editing.js';

describe('file-editing policy', () => {
  describe('shared text extensions', () => {
    it('excludes env from TEXT_ATTACHMENT_EXTENSIONS', () => {
      expect(TEXT_ATTACHMENT_EXTENSIONS.has('env')).toBe(false);
    });

    it('excludes env from EDITABLE_EXTENSIONS', () => {
      expect(EDITABLE_EXTENSIONS.has('env')).toBe(false);
    });

    it('shares the same set between attachment and editor extensions', () => {
      expect(TEXT_ATTACHMENT_EXTENSIONS).toBe(EDITABLE_EXTENSIONS);
    });
  });

  describe('isEditableFileName', () => {
    it('allows common text extensions', () => {
      for (const name of ['a.ts', 'b.md', 'c.json', 'd.py', 'style.css', 'notes.txt', 'x.yml', 'Q.SQL']) {
        expect(isEditableFileName(name), name).toBe(true);
      }
    });

    it('allows well-known basenames regardless of case', () => {
      for (const name of ['Dockerfile', 'Makefile', 'LICENSE', '.gitignore', '.editorconfig', '.nvmrc']) {
        expect(isEditableFileName(name), name).toBe(true);
      }
    });

    it('rejects binary/media/document extensions', () => {
      for (const name of ['a.png', 'b.pdf', 'c.docx', 'd.zip', 'e.woff2', 'f.mp4', 'g.exe']) {
        expect(isEditableFileName(name), name).toBe(false);
      }
    });

    it('rejects svg (deliberate exclusion)', () => {
      expect(isEditableFileName('image.svg')).toBe(false);
    });

    it.each([
      '.env',
      '.env.local',
      '.env.production',
      '.env.development.local',
      '.env.example',
      '.env.template',
      '.env.sample',
      '.ENV',
      '.Env.Local',
      'config.env',
      'prod.env',
      'docker.ENV',
    ])('allows dotenv filename %s', (name) => {
      expect(isEditableFileName(name)).toBe(true);
    });

    it.each(['.envrc', 'env', '.environment', 'environment', '.env-local', 'foo.envrc', 'envfile'])(
      'rejects dotenv lookalike %s',
      (name) => {
        expect(isEditableFileName(name)).toBe(false);
      }
    );

    it('rejects extensionless and unknown-dotfile names not on the basename list', () => {
      expect(isEditableFileName('somebinary')).toBe(false);
      expect(isEditableFileName('.bashrc')).toBe(false);
      expect(isEditableFileName('archive.xyz')).toBe(false);
    });
  });

  describe('isDeniedEditRelativePath', () => {
    it('denies anything inside a .git directory at any depth', () => {
      expect(isDeniedEditRelativePath('.git/config')).toBe(true);
      expect(isDeniedEditRelativePath('.git/hooks/pre-commit')).toBe(true);
      expect(isDeniedEditRelativePath('sub/module/.git/HEAD')).toBe(true);
    });

    it('allows non-.git paths, including names merely containing "git"', () => {
      expect(isDeniedEditRelativePath('src/index.ts')).toBe(false);
      expect(isDeniedEditRelativePath('.github/workflows/ci.yml')).toBe(false);
      expect(isDeniedEditRelativePath('digits/file.md')).toBe(false);
      expect(isDeniedEditRelativePath('.gitignore')).toBe(false);
    });
  });

  describe('detectEol / applyEol', () => {
    it('detects LF, CRLF, and defaults to LF for single-line text', () => {
      expect(detectEol('a\nb\nc')).toBe('lf');
      expect(detectEol('a\r\nb\r\nc')).toBe('crlf');
      expect(detectEol('no newline at all')).toBe('lf');
      expect(detectEol('')).toBe('lf');
    });

    it('picks the dominant style for mixed-EOL text', () => {
      expect(detectEol('a\r\nb\r\nc\nd')).toBe('crlf');
      expect(detectEol('a\nb\nc\r\nd')).toBe('lf');
    });

    it('applyEol round-trips a textarea-normalized (LF) buffer back to CRLF', () => {
      const original = 'line1\r\nline2\r\nline3';
      const textareaValue = original.replace(/\r\n/g, '\n');
      expect(applyEol(textareaValue, detectEol(original))).toBe(original);
    });

    it('applyEol is idempotent and never doubles CR', () => {
      expect(applyEol('a\r\nb', 'crlf')).toBe('a\r\nb');
      expect(applyEol('a\r\nb', 'lf')).toBe('a\nb');
      expect(applyEol('a\nb', 'lf')).toBe('a\nb');
    });

    it('preserves a UTF-8 BOM through the EOL rewrite', () => {
      const withBom = '﻿hello\nworld';
      expect(applyEol(withBom, 'crlf')).toBe('﻿hello\r\nworld');
    });
  });

  it('exposes a sane editable-bytes cap', () => {
    expect(MAX_EDITABLE_BYTES).toBe(512 * 1024);
  });
});
