/**
 * Test command - Automated E2E testing with iterative fixing
 *
 * This command:
 * 1. Loads a ticket and generates/locates Playwright tests
 * 2. Runs tests with visual regression, console/network/docker log collection
 * 3. If tests fail: analyzes errors and applies fixes
 * 4. Re-runs tests until passing or max retries reached
 * 5. Runs linting after tests pass
 *
 * Usage:
 *   kosuke test --ticket=FRONTEND-1                    # Test with auto-fix
 *   kosuke test --ticket=FRONTEND-1 --url=http://localhost:4000
 *   kosuke test --ticket=FRONTEND-1 --headed           # Show browser
 *   kosuke test --ticket=FRONTEND-1 --update-baseline  # Update visual baselines
 *   kosuke test --ticket=FRONTEND-1 --pr               # Create PR with fixes
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { generateTest } from '../utils/test-generator.js';
import {
  runPlaywrightTests,
  isPlaywrightInstalled,
  installPlaywright,
  ensurePlaywrightConfig,
} from '../utils/playwright-agent.js';
import { LogCollector } from '../utils/log-collector.js';
import { VisualTester } from '../utils/visual-tester.js';
import { analyzeAndFix } from '../utils/error-analyzer.js';
import { runComprehensiveLinting } from '../utils/validator.js';
import { runWithPR } from '../utils/pr-orchestrator.js';
import type { TestOptions, TestResult, Ticket } from '../types.js';

interface TicketsFile {
  generatedAt: string;
  totalTickets: number;
  tickets: Ticket[];
}

/**
 * Load tickets from file
 */
function loadTicketsFile(ticketsPath: string): TicketsFile {
  if (!existsSync(ticketsPath)) {
    throw new Error(
      `Tickets file not found: ${ticketsPath}\n` +
        `Please generate tickets first using: kosuke tickets`
    );
  }

  try {
    const content = readFileSync(ticketsPath, 'utf-8');
    return JSON.parse(content) as TicketsFile;
  } catch (error) {
    throw new Error(
      `Failed to parse tickets file: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Find ticket by ID
 */
function findTicket(ticketsData: TicketsFile, ticketId: string): Ticket | undefined {
  return ticketsData.tickets.find((t) => t.id === ticketId);
}

/**
 * Core test logic (git-agnostic, reusable)
 */
export async function testCore(options: TestOptions): Promise<TestResult> {
  const {
    ticket: ticketId,
    url = 'http://localhost:3000',
    headed = false,
    debug = false,
    maxRetries = 3,
    ticketsFile = 'tickets.json',
  } = options;

  const cwd = process.cwd();
  const ticketsPath = join(cwd, ticketsFile);

  // Track metrics
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCost = 0;
  let totalFixesApplied = 0;
  let iterations = 0;
  let testsRun = 0;
  let testsPassed = 0;
  let testsFailed = 0;
  let visualDiffs = 0;
  let testFilePath = '';
  let tracePath = '';

  try {
    // 1. Load and validate ticket
    console.log('📋 Loading ticket...');
    const ticketsData = loadTicketsFile(ticketsPath);
    const ticket = findTicket(ticketsData, ticketId);

    if (!ticket) {
      throw new Error(
        `Ticket ${ticketId} not found in ${ticketsFile}\n` +
          `Available tickets: ${ticketsData.tickets.map((t) => t.id).join(', ')}`
      );
    }

    if (ticket.status !== 'Done' && ticket.status !== 'InProgress') {
      throw new Error(
        `Ticket ${ticketId} status is "${ticket.status}".\n` +
          `Tests should only be run on tickets that have been implemented (Done or InProgress).`
      );
    }

    console.log(`   ✅ Loaded: ${ticket.id} - ${ticket.title}\n`);

    // 2. Ensure Playwright is set up
    console.log('🎭 Checking Playwright setup...');
    if (!isPlaywrightInstalled(cwd)) {
      console.log('   ℹ️  Playwright not found, installing...');
      await installPlaywright(cwd);
    } else {
      console.log('   ✅ Playwright is installed\n');
    }

    ensurePlaywrightConfig(cwd);

    // 3. Generate or locate test
    console.log('🎭 Checking for existing tests...');
    testFilePath = join(cwd, '.kosuke', 'tests', `${ticketId}.spec.ts`);

    if (!existsSync(testFilePath)) {
      console.log('   ℹ️  No test found, generating new test...');
      const genResult = await generateTest(ticket, url, cwd);
      testFilePath = genResult.filePath;
      totalInputTokens += genResult.tokensUsed.input;
      totalOutputTokens += genResult.tokensUsed.output;
      totalCacheCreationTokens += genResult.tokensUsed.cacheCreation;
      totalCacheReadTokens += genResult.tokensUsed.cacheRead;
      totalCost += genResult.cost;
    } else {
      console.log('   ✅ Test found:', testFilePath);
    }

    // 4. Test execution loop
    let testsPassing = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      iterations = attempt;

      console.log(`\n${'='.repeat(60)}`);
      console.log(`🧪 Test Execution (Attempt ${attempt}/${maxRetries})`);
      console.log(`${'='.repeat(60)}\n`);

      // Initialize log collector and visual tester
      const logCollector = new LogCollector();
      const visualTester = new VisualTester(cwd);

      // Run tests with Playwright
      const testResult = await runPlaywrightTests({
        testFile: testFilePath,
        baseUrl: url,
        headed,
        debug,
        cwd,
      });

      testsRun = testResult.testsRun;
      testsPassed = testResult.testsPassed;
      testsFailed = testResult.testsFailed;
      tracePath = testResult.tracePath;

      // Collect Docker logs
      await logCollector.collectDockerLogs('30s');

      // Get visual diffs
      visualDiffs = visualTester.getFailedDiffs().length;

      // Display results
      console.log(`\n📊 Test Results:`);
      console.log(`   ✅ Passed: ${testResult.testsPassed}`);
      console.log(`   ❌ Failed: ${testResult.testsFailed}`);
      console.log(`   📸 Visual diffs: ${visualDiffs}`);
      console.log(`   ⏱️  Duration: ${(testResult.duration / 1000).toFixed(2)}s`);

      // Check if all tests passed
      if (testResult.success && !visualTester.hasRegressions()) {
        testsPassing = true;
        console.log('\n✅ All tests passed!');
        break;
      }

      // If this is the last attempt, don't try to fix
      if (attempt === maxRetries) {
        console.log(`\n❌ Max retries (${maxRetries}) reached. Tests still failing.`);
        break;
      }

      // 5. Analyze errors and apply fixes
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🔍 Phase ${attempt}: Error Analysis & Fixing`);
      console.log(`${'='.repeat(60)}\n`);

      console.log('📝 Collecting logs...');
      const logs = logCollector.getErrors();
      console.log(`   🔧 Console errors: ${logs.console.length}`);
      console.log(`   🔧 Network failures: ${logs.network.length}`);
      console.log(`   🔧 Docker logs: ${logs.docker.length}`);

      // Analyze and fix
      const analysisResult = await analyzeAndFix(
        ticket,
        testResult.failures,
        logs,
        testResult.tracePath,
        cwd
      );

      totalFixesApplied += analysisResult.fixesApplied;
      totalInputTokens += analysisResult.tokensUsed.input;
      totalOutputTokens += analysisResult.tokensUsed.output;
      totalCacheCreationTokens += analysisResult.tokensUsed.cacheCreation;
      totalCacheReadTokens += analysisResult.tokensUsed.cacheRead;
      totalCost += analysisResult.cost;

      console.log(`\n   🔧 Applied ${analysisResult.fixesApplied} fixes`);
      console.log(`   💰 Cost: $${analysisResult.cost.toFixed(4)}`);

      // Continue to next iteration
      console.log(`\n🔄 Re-running tests in next iteration...`);
    }

    // 6. Linting phase (if tests passed)
    if (testsPassing) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🔧 Linting & Quality Checks`);
      console.log(`${'='.repeat(60)}\n`);

      const lintResult = await runComprehensiveLinting();
      console.log(`\n✅ Linting completed (${lintResult.fixCount} fixes applied)`);

      // Return success result
      return {
        ticketId,
        success: true,
        testsRun,
        testsPassed,
        testsFailed: 0,
        visualDiffs: 0,
        fixesApplied: totalFixesApplied,
        lintFixCount: lintResult.fixCount,
        iterations,
        tokensUsed: {
          input: totalInputTokens,
          output: totalOutputTokens,
          cacheCreation: totalCacheCreationTokens,
          cacheRead: totalCacheReadTokens,
        },
        cost: totalCost,
        testFilePath,
        tracePath,
      };
    } else {
      // Return failure result
      return {
        ticketId,
        success: false,
        testsRun,
        testsPassed,
        testsFailed,
        visualDiffs,
        fixesApplied: totalFixesApplied,
        lintFixCount: 0,
        iterations,
        tokensUsed: {
          input: totalInputTokens,
          output: totalOutputTokens,
          cacheCreation: totalCacheCreationTokens,
          cacheRead: totalCacheReadTokens,
        },
        cost: totalCost,
        testFilePath,
        tracePath,
        error: 'Tests failed after maximum retry attempts',
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Test execution failed: ${errorMessage}`);

    return {
      ticketId,
      success: false,
      testsRun,
      testsPassed,
      testsFailed,
      visualDiffs,
      fixesApplied: totalFixesApplied,
      lintFixCount: 0,
      iterations,
      tokensUsed: {
        input: totalInputTokens,
        output: totalOutputTokens,
        cacheCreation: totalCacheCreationTokens,
        cacheRead: totalCacheReadTokens,
      },
      cost: totalCost,
      testFilePath,
      tracePath,
      error: errorMessage,
    };
  }
}

/**
 * Main test command
 */
export async function testCommand(options: TestOptions): Promise<void> {
  const { ticket: ticketId, pr = false } = options;
  console.log(`🧪 Testing Ticket: ${ticketId}\n`);

  try {
    // Validate environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    if (pr && !process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN environment variable is required for --pr flag');
    }

    // If --pr flag is provided, wrap with PR workflow
    if (pr) {
      const { result: testResult, prInfo } = await runWithPR(
        {
          branchPrefix: `test/fix-${ticketId}`,
          baseBranch: options.baseBranch,
          commitMessage: `test: fix issues found in ${ticketId}`,
          prTitle: `test: Fix issues in ${ticketId}`,
          prBody: `## 🧪 Test Fixes for ${ticketId}

This PR contains automated fixes for issues found during E2E testing of ticket ${ticketId}.

### 📊 Test Results
- Tests run: ${0} (will be filled by result)
- Fixes applied: ${0}
- Iterations: ${0}

---

🤖 *Generated by Kosuke CLI (\`kosuke test --ticket=${ticketId} --pr\`)*`,
        },
        async () => testCore(options)
      );

      // Display summary
      displayTestSummary(testResult, prInfo.prUrl);
    } else {
      // Run core logic without PR
      const result = await testCore(options);
      displayTestSummary(result);
    }
  } catch (error) {
    console.error('\n❌ Test command failed:', error);
    throw error;
  }
}

/**
 * Display test summary
 */
function displayTestSummary(result: TestResult, prUrl?: string): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log('📊 Test Summary');
  console.log('='.repeat(60));

  if (result.success) {
    console.log('✅ Status: All tests passed');
  } else {
    console.log('❌ Status: Tests failed');
  }

  console.log(
    `🧪 Tests: ${result.testsPassed} passed, ${result.testsFailed} failed (${result.testsRun} total)`
  );
  console.log(`📸 Visual: ${result.visualDiffs} regressions found`);
  console.log(`🔧 Fixes: ${result.fixesApplied} applied`);
  console.log(`🧹 Lint: ${result.lintFixCount} fixes applied`);
  console.log(`🔄 Iterations: ${result.iterations}`);
  console.log(`💰 Total cost: $${result.cost.toFixed(4)}`);
  console.log(`🎭 Test file: ${result.testFilePath}`);
  console.log(`📊 Trace: ${result.tracePath}`);

  if (prUrl) {
    console.log(`🔗 PR: ${prUrl}`);
  }

  console.log('='.repeat(60));

  if (result.success) {
    console.log('\n✅ Testing completed successfully!');
  } else {
    console.log(`\n❌ Testing failed: ${result.error || 'Unknown error'}`);
    if (!prUrl) {
      console.log('ℹ️  Review the logs and trace file above for more details.');
    }
  }
}
