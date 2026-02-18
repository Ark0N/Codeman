import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { Page } from 'playwright';
import { VISUAL } from './constants.js';

export interface CompareOptions {
  /** Pixel matching threshold (0-1, lower = stricter). Default: 0.1 */
  threshold?: number;
  /** Max allowed percentage of differing pixels. Default: 0.5 */
  maxDiffPercent?: number;
  /** Custom snapshot directory */
  snapshotDir?: string;
}

export interface CompareResult {
  /** Whether comparison passed (or baseline was created) */
  passed: boolean;
  /** Was this a new baseline? */
  isNewBaseline: boolean;
  /** Number of differing pixels */
  diffPixels?: number;
  /** Percentage of differing pixels */
  diffPercent?: number;
  /** Path to diff image (only on failure) */
  diffPath?: string;
}

/** Compare a page screenshot against a stored baseline.
 *  If no baseline exists, creates one and passes. */
export async function compareScreenshot(
  page: Page,
  name: string,
  options: CompareOptions = {},
): Promise<CompareResult> {
  const threshold = options.threshold ?? VISUAL.DEFAULT_THRESHOLD;
  const maxDiffPercent = options.maxDiffPercent ?? VISUAL.MAX_DIFF_PERCENT;
  const snapshotDir = options.snapshotDir ?? join(process.cwd(), VISUAL.SNAPSHOT_DIR);

  const baselinePath = join(snapshotDir, `${name}.png`);
  const actualPath = join(snapshotDir, `${name}.actual.png`);
  const diffPath = join(snapshotDir, `${name}.diff.png`);

  // Ensure snapshot directory exists
  if (!existsSync(snapshotDir)) {
    mkdirSync(snapshotDir, { recursive: true });
  }

  const actualBuffer = await page.screenshot({ fullPage: false });

  // First run: save as baseline
  if (!existsSync(baselinePath)) {
    writeFileSync(baselinePath, actualBuffer);
    return { passed: true, isNewBaseline: true };
  }

  const baseline = PNG.sync.read(readFileSync(baselinePath));
  const actual = PNG.sync.read(actualBuffer);

  // Handle dimension mismatch
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    writeFileSync(actualPath, actualBuffer);
    throw new Error(
      `Dimension mismatch for "${name}": ` +
      `baseline ${baseline.width}x${baseline.height} vs ` +
      `actual ${actual.width}x${actual.height}. ` +
      `Actual saved to ${actualPath}`,
    );
  }

  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const numDiffPixels = pixelmatch(
    baseline.data,
    actual.data,
    diff.data,
    baseline.width,
    baseline.height,
    { threshold },
  );

  const totalPixels = baseline.width * baseline.height;
  const diffPercent = (numDiffPixels / totalPixels) * 100;

  if (diffPercent > maxDiffPercent) {
    writeFileSync(actualPath, actualBuffer);
    writeFileSync(diffPath, PNG.sync.write(diff));
    return {
      passed: false,
      isNewBaseline: false,
      diffPixels: numDiffPixels,
      diffPercent,
      diffPath,
    };
  }

  // Clean up old failure artifacts if test now passes
  cleanupArtifact(actualPath);
  cleanupArtifact(diffPath);

  return {
    passed: true,
    isNewBaseline: false,
    diffPixels: numDiffPixels,
    diffPercent,
  };
}

/** Assert screenshot matches baseline, throwing on failure */
export async function assertScreenshotMatch(
  page: Page,
  name: string,
  options: CompareOptions = {},
): Promise<void> {
  const result = await compareScreenshot(page, name, options);
  if (!result.passed) {
    throw new Error(
      `Visual regression: "${name}" has ${result.diffPercent!.toFixed(2)}% pixel diff ` +
      `(max ${options.maxDiffPercent ?? VISUAL.MAX_DIFF_PERCENT}%). ` +
      `See ${result.diffPath}`,
    );
  }
}

function cleanupArtifact(path: string): void {
  try {
    if (existsSync(path)) {
      const { unlinkSync } = require('fs');
      unlinkSync(path);
    }
  } catch {
    // Ignore cleanup errors
  }
}
