/**
 * @fileoverview Where everything of the local model lives on disk. One pure function, so the
 * runtime, the install job and uninstall all name the same folders.
 *
 * Layout, all under the data dir (`dataPath()`, so a second Codeman instance has its own):
 *
 * ```
 * local-model.json                          the state file (mode 0600)
 * local-model/
 *   runtime/ollama-<version>.tgz.partial    the runtime archive while it downloads
 *   runtime/ollama-<version>.unpack/        where the archive is unpacked, before the rename
 *   runtime/ollama-<version>/               the unpacked runtime; its binary is `ollama`
 *   models/                                 the runtime's model store
 *   home/                                   the runtime's private HOME (its key pair lands here)
 * ```
 *
 * Rules:
 *  - `root` is the ONE folder this feature owns. Nothing is written or deleted outside it,
 *    except the state file beside it and the two writes of the connect step (the endpoint
 *    record and the settings flag), which have their own writers.
 *  - Every path comes from here. None is ever read back from the state file, so a state file
 *    cannot point a delete anywhere else. `isInsideLocalModelRoot()` is the check a delete
 *    makes before it runs.
 *  - Pure apart from `dataPath()`, which resolves (and creates) the data dir.
 */

import { join, resolve, sep } from 'node:path';
import { dataPath } from '../config/instance.js';

/** A runtime version as it may appear in a folder name: digits and dots only ('0.40.15'). */
const VERSION_PATTERN = /^\d+(?:\.\d+){1,3}$/;

export interface LocalModelPaths {
  /** `<data dir>/local-model`: the one folder this feature owns. */
  root: string;
  /** `<root>/runtime`: the archive and every unpacked version. */
  runtimeRoot: string;
  /** `<root>/runtime/ollama-<version>`: the unpacked runtime. */
  runtimeDir: string;
  /** The runtime's binary: `<runtimeDir>/ollama`. */
  binary: string;
  /** `<root>/runtime/ollama-<version>.tgz.partial`: the archive while it downloads. */
  archivePartial: string;
  /** `<root>/runtime/ollama-<version>.unpack`: the temporary folder the archive is unpacked into. */
  unpackDir: string;
  /** `<root>/models`: the runtime's model store. */
  modelsDir: string;
  /** `<root>/home`: the runtime's private HOME. */
  homeDir: string;
  /** `<data dir>/local-model.json`: the state file. */
  stateFile: string;
}

/**
 * The paths of the local model for one runtime version. Throws on a version that is not
 * digits and dots, so a version string can never add a path segment.
 */
export function localModelPaths(version: string): LocalModelPaths {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Not a runtime version: ${JSON.stringify(version)}`);
  }
  const root = dataPath('local-model');
  const runtimeRoot = join(root, 'runtime');
  const runtimeDir = join(runtimeRoot, `ollama-${version}`);
  return {
    root,
    runtimeRoot,
    runtimeDir,
    binary: join(runtimeDir, 'ollama'),
    archivePartial: join(runtimeRoot, `ollama-${version}.tgz.partial`),
    unpackDir: join(runtimeRoot, `ollama-${version}.unpack`),
    modelsDir: join(root, 'models'),
    homeDir: join(root, 'home'),
    stateFile: dataPath('local-model.json'),
  };
}

/**
 * The binary of another unpacked runtime version beside the pinned one: `<runtimeRoot>/
 * ollama-<version>/ollama`. For an installed model whose runtime was unpacked by an earlier
 * build with another pin: it keeps running the version it was installed with. Throws on a
 * version that is not digits and dots, like `localModelPaths()`. Pure.
 */
export function runtimeBinaryForVersion(paths: LocalModelPaths, version: string): string {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Not a runtime version: ${JSON.stringify(version)}`);
  }
  return join(paths.runtimeRoot, `ollama-${version}`, 'ollama');
}

/**
 * Whether `path` is the local model folder itself or lies inside it, judged on the resolved
 * text (no filesystem access, so a symlink is not followed: a caller that deletes checks the
 * real path first). `..` segments are resolved before the comparison.
 */
export function isInsideLocalModelRoot(path: string, root: string = dataPath('local-model')): boolean {
  const base = resolve(root);
  const target = resolve(path);
  return target === base || target.startsWith(base + sep);
}
