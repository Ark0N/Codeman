/**
 * @fileoverview Tests for src/local-model/paths.ts: where the local model lives on disk.
 *
 * Pinned: every path sits under the data dir (so a second Codeman instance has its own),
 * everything but the state file sits inside the one folder uninstall owns, a version string
 * can never add a path segment, and the inside-the-folder check resolves `..` first.
 *
 * Port: N/A (pure functions; the data dir is the temp HOME test/setup.ts gives each file).
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDataDir } from '../src/config/instance.js';
import { isInsideLocalModelRoot, localModelPaths } from '../src/local-model/paths.js';

describe('localModelPaths', () => {
  it('builds every path from the data dir', () => {
    const data = getDataDir();
    expect(localModelPaths('0.40.15')).toEqual({
      root: join(data, 'local-model'),
      runtimeRoot: join(data, 'local-model', 'runtime'),
      runtimeDir: join(data, 'local-model', 'runtime', 'ollama-0.40.15'),
      binary: join(data, 'local-model', 'runtime', 'ollama-0.40.15', 'ollama'),
      archivePartial: join(data, 'local-model', 'runtime', 'ollama-0.40.15.tgz.partial'),
      unpackDir: join(data, 'local-model', 'runtime', 'ollama-0.40.15.unpack'),
      modelsDir: join(data, 'local-model', 'models'),
      homeDir: join(data, 'local-model', 'home'),
      stateFile: join(data, 'local-model.json'),
    });
  });

  it('keeps everything but the state file inside the one folder', () => {
    const paths = localModelPaths('0.40.15');
    const { root, stateFile, ...inside } = paths;
    for (const path of Object.values(inside)) expect(isInsideLocalModelRoot(path, root)).toBe(true);
    expect(isInsideLocalModelRoot(root, root)).toBe(true);
    expect(isInsideLocalModelRoot(stateFile, root)).toBe(false);
  });

  it('refuses a version that is not digits and dots', () => {
    for (const version of ['', '0', '../x', '0.40.15/..', '0.40.15-rc1', 'v0.40.15', '0..1', '1.2.3.4.5']) {
      expect(() => localModelPaths(version)).toThrow(/Not a runtime version/);
    }
    expect(() => localModelPaths('1.2')).not.toThrow();
    expect(() => localModelPaths('1.2.3.4')).not.toThrow();
  });
});

describe('isInsideLocalModelRoot', () => {
  const root = '/data/local-model';

  it('accepts the folder and what lies in it', () => {
    expect(isInsideLocalModelRoot('/data/local-model', root)).toBe(true);
    expect(isInsideLocalModelRoot('/data/local-model/', root)).toBe(true);
    expect(isInsideLocalModelRoot('/data/local-model/models/blobs/x', root)).toBe(true);
  });

  it('refuses a sibling, a parent and a path that climbs out', () => {
    expect(isInsideLocalModelRoot('/data/local-model.json', root)).toBe(false);
    expect(isInsideLocalModelRoot('/data/local-model-2/x', root)).toBe(false);
    expect(isInsideLocalModelRoot('/data', root)).toBe(false);
    expect(isInsideLocalModelRoot('/data/local-model/../settings.json', root)).toBe(false);
    expect(isInsideLocalModelRoot('/data/local-model/models/../../../etc', root)).toBe(false);
  });

  it('defaults to the folder under the data dir', () => {
    expect(isInsideLocalModelRoot(join(getDataDir(), 'local-model', 'home'))).toBe(true);
    expect(isInsideLocalModelRoot(join(getDataDir(), 'settings.json'))).toBe(false);
  });
});
