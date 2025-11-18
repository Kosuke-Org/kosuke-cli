/**
 * Playwright Agent - Test execution orchestration
 *
 * Executes Playwright tests with logging and visual regression
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { TestFailure } from './error-analyzer.js';

export interface PlaywrightResult {
  success: boolean;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  failures: TestFailure[];
  tracePath: string;
  duration: number;
}

export interface PlaywrightOptions {
  testFile: string;
  baseUrl: string;
  headed?: boolean;
  debug?: boolean;
  cwd?: string;
}

/**
 * Run Playwright tests
 */
export async function runPlaywrightTests(options: PlaywrightOptions): Promise<PlaywrightResult> {
  const { testFile, baseUrl, headed = false, debug = false, cwd = process.cwd() } = options;

  // Ensure test results directory exists
  const resultsDir = join(cwd, 'test-results');
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }

  const ticketId = testFile.split('/').pop()?.replace('.spec.ts', '') || 'unknown';
  const tracePath = join(resultsDir, `trace-${ticketId}.zip`);

  // Build Playwright command
  const args = [
    'playwright',
    'test',
    testFile,
    `--config=${join(cwd, 'playwright.config.ts')}`,
    '--reporter=json',
  ];

  if (headed) {
    args.push('--headed');
  }

  if (debug) {
    args.push('--debug');
  }

  // Set environment variables
  const env = {
    ...process.env,
    BASE_URL: baseUrl,
    PLAYWRIGHT_TRACE: 'on',
  };

  console.log(`   🎯 Running Playwright tests...`);
  const startTime = Date.now();

  try {
    // Run Playwright using npx (works with any package manager)
    const output = execSync(`npx ${args.join(' ')}`, {
      cwd,
      env,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'], // Capture all output
    });

    const duration = Date.now() - startTime;
    const result = parsePlaywrightOutput(output, tracePath, duration);

    return result;
  } catch (error) {
    // Playwright exits with non-zero code when tests fail
    const duration = Date.now() - startTime;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = error instanceof Error && 'stdout' in error ? (error as any).stdout : '';
    const result = parsePlaywrightOutput(output, tracePath, duration);

    return result;
  }
}

/**
 * Parse Playwright JSON output
 */
function parsePlaywrightOutput(
  output: string,
  tracePath: string,
  duration: number
): PlaywrightResult {
  try {
    // Try to parse JSON output
    const jsonMatch = output.match(/\{[\s\S]*"suites"[\s\S]*\}/);
    if (jsonMatch) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = JSON.parse(jsonMatch[0]) as any;
      return parsePlaywrightJson(json, tracePath, duration);
    }
  } catch {
    // If JSON parsing fails, fall back to text parsing
  }

  // Fallback: parse text output
  return parsePlaywrightText(output, tracePath, duration);
}

/**
 * Parse Playwright JSON report
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parsePlaywrightJson(json: any, tracePath: string, duration: number): PlaywrightResult {
  const failures: TestFailure[] = [];
  let testsRun = 0;
  let testsPassed = 0;
  let testsFailed = 0;

  // Parse test results
  for (const suite of json.suites || []) {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        testsRun++;
        const result = test.results?.[0];

        if (result?.status === 'passed') {
          testsPassed++;
        } else {
          testsFailed++;
          failures.push({
            testName: spec.title || 'Unknown test',
            errorMessage: result?.error?.message || 'Test failed',
            expected: extractExpected(result?.error?.message),
            received: extractReceived(result?.error?.message),
          });
        }
      }
    }
  }

  return {
    success: testsFailed === 0,
    testsRun,
    testsPassed,
    testsFailed,
    failures,
    tracePath,
    duration,
  };
}

/**
 * Parse Playwright text output (fallback)
 */
function parsePlaywrightText(
  output: string,
  tracePath: string,
  duration: number
): PlaywrightResult {
  const failures: TestFailure[] = [];

  // Look for test failures in output
  const failureMatches = output.matchAll(/✘ (.+?)\n[\s\S]*?Error: (.+?)(?:\n|$)/g);
  for (const match of failureMatches) {
    failures.push({
      testName: match[1].trim(),
      errorMessage: match[2].trim(),
    });
  }

  // Count tests
  const passedMatch = output.match(/(\d+) passed/);
  const failedMatch = output.match(/(\d+) failed/);
  const testsPassed = passedMatch ? parseInt(passedMatch[1]) : 0;
  const testsFailed = failedMatch ? parseInt(failedMatch[1]) : failures.length;
  const testsRun = testsPassed + testsFailed;

  return {
    success: testsFailed === 0,
    testsRun,
    testsPassed,
    testsFailed,
    failures,
    tracePath,
    duration,
  };
}

/**
 * Extract expected value from error message
 */
function extractExpected(errorMessage?: string): string | undefined {
  if (!errorMessage) return undefined;
  const match = errorMessage.match(/Expected:?\s*(.+?)(?:\n|Received)/i);
  return match ? match[1].trim() : undefined;
}

/**
 * Extract received value from error message
 */
function extractReceived(errorMessage?: string): string | undefined {
  if (!errorMessage) return undefined;
  const match = errorMessage.match(/Received:?\s*(.+?)(?:\n|$)/i);
  return match ? match[1].trim() : undefined;
}

/**
 * Check if Playwright is installed
 */
export function isPlaywrightInstalled(cwd: string = process.cwd()): boolean {
  try {
    execSync('npx playwright --version', {
      cwd,
      encoding: 'utf-8',
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Install Playwright
 */
export async function installPlaywright(cwd: string = process.cwd()): Promise<void> {
  console.log('📦 Installing Playwright...');

  try {
    // Install @playwright/test
    execSync('npm install --save-dev @playwright/test', {
      cwd,
      encoding: 'utf-8',
      stdio: 'inherit',
    });

    // Install browsers
    execSync('npx playwright install chromium', {
      cwd,
      encoding: 'utf-8',
      stdio: 'inherit',
    });

    console.log('   ✅ Playwright installed\n');
  } catch (error) {
    throw new Error(`Failed to install Playwright: ${error}`);
  }
}

/**
 * Ensure Playwright config exists
 */
export function ensurePlaywrightConfig(cwd: string = process.cwd()): void {
  const configPath = join(cwd, 'playwright.config.ts');

  if (existsSync(configPath)) {
    return; // Config already exists
  }

  console.log('📝 Creating playwright.config.ts...');

  const configContent = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './.kosuke/tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
`;

  writeFileSync(configPath, configContent, 'utf-8');
  console.log('   ✅ Config created\n');
}
