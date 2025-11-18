/**
 * Visual Tester - Visual regression testing with screenshot comparison
 *
 * Inspired by Subito.it's approach:
 * - Capture screenshots of pages
 * - Compare against baseline images
 * - Detect pixel differences above threshold
 * - Hide dynamic content (ads, analytics)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export interface VisualDiff {
  testName: string;
  diffPixels: number;
  diffPercentage: number;
  threshold: number;
  passed: boolean;
  baselinePath: string;
  currentPath: string;
  diffPath: string;
}

export interface VisualTestOptions {
  ticketId: string;
  testName: string;
  threshold?: number; // Percentage threshold (default: 0.01 = 1%)
  updateBaseline?: boolean;
}

/**
 * Visual Tester class for screenshot comparison
 */
export class VisualTester {
  private cwd: string;
  private diffs: VisualDiff[] = [];

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  /**
   * Hide dynamic content that shouldn't be tested
   */
  async hideDynamicContent(page: Page): Promise<void> {
    await page.addStyleTag({
      content: `
        /* Hide common dynamic content */
        .advertisement,
        .ad-banner,
        .analytics-widget,
        .third-party-banner,
        [class*="ad-"],
        [id*="ad-"],
        [class*="analytics"],
        [id*="analytics"] {
          display: none !important;
          visibility: hidden !important;
        }
      `,
    });
  }

  /**
   * Take a screenshot and compare with baseline
   */
  async captureAndCompare(page: Page, options: VisualTestOptions): Promise<VisualDiff> {
    const { ticketId, testName, threshold = 0.01, updateBaseline = false } = options;

    // Ensure visual test directories exist
    const baselineDir = join(this.cwd, '.kosuke', 'visual-tests', 'baselines', ticketId);
    const currentDir = join(this.cwd, '.kosuke', 'visual-tests', 'current', ticketId);
    const diffDir = join(this.cwd, '.kosuke', 'visual-tests', 'diffs', ticketId);

    this.ensureDir(baselineDir);
    this.ensureDir(currentDir);
    this.ensureDir(diffDir);

    const baselinePath = join(baselineDir, `${testName}.png`);
    const currentPath = join(currentDir, `${testName}.png`);
    const diffPath = join(diffDir, `${testName}.png`);

    // Hide dynamic content before taking screenshot
    await this.hideDynamicContent(page);

    // Wait for page to be stable
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
      // Ignore timeout - some pages never reach networkidle
    });

    // Take screenshot
    const screenshot = await page.screenshot({ fullPage: true });
    writeFileSync(currentPath, screenshot);

    // If no baseline exists or updateBaseline flag is set, create/update baseline
    if (!existsSync(baselinePath) || updateBaseline) {
      writeFileSync(baselinePath, screenshot);
      console.log(`   📸 ${updateBaseline ? 'Updated' : 'Created'} baseline: ${testName}`);

      const diff: VisualDiff = {
        testName,
        diffPixels: 0,
        diffPercentage: 0,
        threshold,
        passed: true,
        baselinePath,
        currentPath,
        diffPath,
      };

      this.diffs.push(diff);
      return diff;
    }

    // Compare with baseline
    const result = this.compareImages(baselinePath, currentPath, diffPath, threshold);

    this.diffs.push(result);
    return result;
  }

  /**
   * Compare two images and generate diff
   */
  private compareImages(
    baselinePath: string,
    currentPath: string,
    diffPath: string,
    threshold: number
  ): VisualDiff {
    const testName = baselinePath.split('/').pop()?.replace('.png', '') || 'unknown';

    try {
      const baseline = PNG.sync.read(readFileSync(baselinePath));
      const current = PNG.sync.read(readFileSync(currentPath));

      // Check if dimensions match
      if (baseline.width !== current.width || baseline.height !== current.height) {
        return {
          testName,
          diffPixels: baseline.width * baseline.height, // All pixels are different
          diffPercentage: 1,
          threshold,
          passed: false,
          baselinePath,
          currentPath,
          diffPath,
        };
      }

      // Create diff image
      const diff = new PNG({ width: baseline.width, height: baseline.height });

      // Compare pixels
      const diffPixels = pixelmatch(
        baseline.data,
        current.data,
        diff.data,
        baseline.width,
        baseline.height,
        { threshold: 0.1 } // Pixel sensitivity
      );

      const totalPixels = baseline.width * baseline.height;
      const diffPercentage = diffPixels / totalPixels;

      // Save diff image if there are differences
      if (diffPixels > 0) {
        writeFileSync(diffPath, PNG.sync.write(diff));
      }

      return {
        testName,
        diffPixels,
        diffPercentage,
        threshold,
        passed: diffPercentage <= threshold,
        baselinePath,
        currentPath,
        diffPath,
      };
    } catch (error) {
      console.error(`   ⚠️  Failed to compare images: ${error}`);
      return {
        testName,
        diffPixels: 0,
        diffPercentage: 0,
        threshold,
        passed: false,
        baselinePath,
        currentPath,
        diffPath,
      };
    }
  }

  /**
   * Get all visual diffs
   */
  getDiffs(): VisualDiff[] {
    return this.diffs;
  }

  /**
   * Get failed visual diffs
   */
  getFailedDiffs(): VisualDiff[] {
    return this.diffs.filter((diff) => !diff.passed);
  }

  /**
   * Check if there are any visual regressions
   */
  hasRegressions(): boolean {
    return this.getFailedDiffs().length > 0;
  }

  /**
   * Format visual diff report
   */
  formatReport(): string {
    if (this.diffs.length === 0) {
      return 'No visual tests run';
    }

    const failed = this.getFailedDiffs();
    const passed = this.diffs.filter((diff) => diff.passed);

    const lines: string[] = [];
    lines.push(`\n📸 Visual Regression Report:`);
    lines.push(`   ✅ Passed: ${passed.length}`);
    lines.push(`   ❌ Failed: ${failed.length}`);

    if (failed.length > 0) {
      lines.push('\n   Failed tests:');
      for (const diff of failed) {
        const percentage = (diff.diffPercentage * 100).toFixed(2);
        lines.push(
          `   - ${diff.testName}: ${percentage}% difference (threshold: ${diff.threshold * 100}%)`
        );
        lines.push(`     Diff image: ${diff.diffPath}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Clear all diffs
   */
  clear(): void {
    this.diffs = [];
  }

  /**
   * Ensure directory exists
   */
  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
