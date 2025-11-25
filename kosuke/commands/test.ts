/**
 * Test command - Automated E2E testing with iterative fixing
 *
 * This command:
 * 1. Loads a ticket OR uses custom prompt to generate Playwright tests
 * 2. Runs tests with visual regression, console/network/docker log collection
 * 3. If tests fail: analyzes errors and applies fixes
 * 4. Re-runs tests until passing or max retries reached
 * 5. Runs linting after tests pass
 *
 * Usage:
 *   kosuke test --ticket=FRONTEND-1                    # Test with ticket
 *   kosuke test --prompt="Test user login flow"        # Test with custom prompt
 *   kosuke test --ticket=FRONTEND-1 --url=http://localhost:4000
 *   kosuke test --prompt="..." --headed                # Show browser (visible window)
 *   kosuke test --ticket=FRONTEND-1 --update-baseline  # Update visual baselines
 *   kosuke test --ticket=FRONTEND-1 --pr               # Create PR with fixes
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { TestOptions, TestResult, Ticket } from '../types.js';
import { analyzeAndFix } from '../utils/error-analyzer.js';
import { LogCollector } from '../utils/log-collector.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';
import {
  ensurePlaywrightConfig,
  installPlaywright,
  isPlaywrightInstalled,
  runPlaywrightTests,
} from '../utils/playwright-agent.js';
import { runWithPR } from '../utils/pr-orchestrator.js';
import { generateTest } from '../utils/test-generator.js';
import { runComprehensiveLinting } from '../utils/validator.js';
import { VisualTester } from '../utils/visual-tester.js';

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
    prompt: customPrompt,
    url = 'http://localhost:3000',
    headed = false,
    debug = false,
    maxRetries = 3,
    ticketsFile = 'tickets.json',
  } = options;

  const cwd = process.cwd();
  const ticketsPath = join(cwd, ticketsFile);

  // Validate: must provide either ticket OR prompt (not both)
  if (!ticketId && !customPrompt) {
    throw new Error(
      'Either --ticket or --prompt must be provided\n' +
        'Examples:\n' +
        '  kosuke test --ticket=FRONTEND-1\n' +
        '  kosuke test --prompt="Test user login flow"'
    );
  }

  if (ticketId && customPrompt) {
    throw new Error('Cannot provide both --ticket and --prompt. Please use one or the other.');
  }

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
  let testIdentifier = '';

  try {
    // 1. Load ticket or create from custom prompt
    let ticket: Ticket;

    if (ticketId) {
      // Load ticket from file
      console.log('📋 Loading ticket...');
      const ticketsData = loadTicketsFile(ticketsPath);
      const foundTicket = findTicket(ticketsData, ticketId);

      if (!foundTicket) {
        throw new Error(
          `Ticket ${ticketId} not found in ${ticketsFile}\n` +
            `Available tickets: ${ticketsData.tickets.map((t) => t.id).join(', ')}`
        );
      }

      if (foundTicket.status !== 'Done' && foundTicket.status !== 'InProgress') {
        throw new Error(
          `Ticket ${ticketId} status is "${foundTicket.status}".\n` +
            `Tests should only be run on tickets that have been implemented (Done or InProgress).`
        );
      }

      ticket = foundTicket;
      testIdentifier = ticketId;
      console.log(`   ✅ Loaded: ${ticket.id} - ${ticket.title}\n`);
    } else {
      // Create synthetic ticket from custom prompt
      console.log('📋 Using custom prompt...');
      testIdentifier = `custom-${Date.now()}`;
      ticket = {
        id: testIdentifier,
        title: customPrompt!.substring(0, 80), // Truncate for title
        description: customPrompt!,
        estimatedEffort: 5, // Medium effort
        status: 'InProgress',
      };
      console.log(`   ✅ Created test: ${testIdentifier}\n`);
    }

    // 2. Ensure Playwright is set up
    console.log('🎭 Checking Playwright setup...');
    if (!isPlaywrightInstalled(cwd)) {
      console.log('   ℹ️  Playwright not found, installing...');
      await installPlaywright(cwd);
    } else {
      console.log('   ✅ Playwright is installed');

      // Check if browsers are installed
      const { areBrowsersInstalled, installBrowsers } = await import(
        '../utils/playwright-agent.js'
      );
      if (!areBrowsersInstalled()) {
        console.log('   ℹ️  Browsers not found, installing...');
        await installBrowsers();
      } else {
        console.log('   ✅ Browsers are installed\n');
      }
    }

    ensurePlaywrightConfig(cwd);

    // 3. Generate or locate test
    console.log('🎭 Checking for existing tests...');
    testFilePath = join(cwd, '.kosuke', 'tests', `${testIdentifier}.spec.ts`);

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
        ticketId: testIdentifier,
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
        ticketId: testIdentifier,
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
      ticketId: testIdentifier || ticketId || customPrompt || 'unknown',
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
  const { ticket: ticketId, prompt: customPrompt, pr = false, noLogs = false } = options;

  const testDescription = ticketId
    ? `Ticket: ${ticketId}`
    : `Prompt: "${customPrompt?.substring(0, 60)}${customPrompt && customPrompt.length > 60 ? '...' : ''}"`;

  console.log(`🧪 Testing ${testDescription}\n`);

  // Initialize logging context
  const logContext = logger.createContext('test', { noLogs });
  const cleanupHandler = setupCancellationHandler(logContext);

  try {
    // Validate environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    if (pr && !process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN environment variable is required for --pr flag');
    }

    // Determine identifier for branch/PR naming
    const identifier = ticketId || `custom-${Date.now()}`;
    const displayName = ticketId || 'custom prompt';

    // If --pr flag is provided, wrap with PR workflow
    if (pr) {
      const { result: testResult, prInfo } = await runWithPR(
        {
          branchPrefix: `test/fix-${identifier}`,
          baseBranch: options.baseBranch,
          commitMessage: `test: fix issues found in ${displayName}`,
          prTitle: `test: Fix issues in ${displayName}`,
          prBody: `## 🧪 Test Fixes for ${displayName}

This PR contains automated fixes for issues found during E2E testing${ticketId ? ` of ticket ${ticketId}` : ''}.

${customPrompt ? `### 📝 Custom Test Prompt\n${customPrompt}\n` : ''}

### 📊 Test Results
- Tests run: ${0} (will be filled by result)
- Fixes applied: ${0}
- Iterations: ${0}

---

🤖 *Generated by Kosuke CLI (\`kosuke test ${ticketId ? `--ticket=${ticketId}` : '--prompt="..."'} --pr\`)*`,
        },
        async () => {
          const result = await testCore(options);

          // Track metrics
          logger.trackTokens(logContext, result.tokensUsed);
          logContext.testsRun = result.testsRun;
          logContext.testsPassed = result.testsPassed;
          logContext.testsFailed = result.testsFailed;
          logContext.fixesApplied = result.fixesApplied;
          logContext.iterations = result.iterations;

          return result;
        }
      );

      // Display summary
      displayTestSummary(testResult, prInfo.prUrl);

      // Log successful execution
      await logger.complete(logContext, 'success');
      cleanupHandler();
    } else {
      // Run core logic without PR
      const result = await testCore(options);

      // Track metrics
      logger.trackTokens(logContext, result.tokensUsed);
      logContext.testsRun = result.testsRun;
      logContext.testsPassed = result.testsPassed;
      logContext.testsFailed = result.testsFailed;
      logContext.fixesApplied = result.fixesApplied;
      logContext.iterations = result.iterations;

      displayTestSummary(result);

      // Log execution (success or error based on test result)
      await logger.complete(
        logContext,
        result.success ? 'success' : 'error',
        result.error ? new Error(result.error) : undefined
      );
      cleanupHandler();
    }
  } catch (error) {
    console.error('\n❌ Test command failed:', error);

    // Log failed execution
    await logger.complete(logContext, 'error', error as Error);
    cleanupHandler();

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
