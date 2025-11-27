/**
 * Test runner utility for build command
 *
 * Handles iterative testing with retry logic and error analysis.
 * Separated from ship command to allow build command to control testing phase.
 */

import type { TestRunnerOptions, TestRunnerResult } from '../types.js';
import { testCore } from '../commands/test.js';
import { generateDBTestPrompt, generateWebTestPrompt } from './prompt-generator.js';
import { LogCollector } from './log-collector.js';
import { analyzeAndFix } from './error-analyzer.js';

/**
 * Run tests with automatic retry and error fixing
 *
 * @param options - Test runner configuration
 * @returns Result with success status, attempts, fixes applied, and costs
 */
export async function runTestsWithRetry(options: TestRunnerOptions): Promise<TestRunnerResult> {
  const { ticket, cwd, url, headless, verbose, maxRetries = 3 } = options;

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCost = 0;
  let totalFixesApplied = 0;
  let testsPassing = false;
  let attempts = 0;

  // Generate test prompt from ticket
  const testPrompt =
    ticket.type === 'db-test' ? generateDBTestPrompt(ticket) : generateWebTestPrompt(ticket);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    attempts = attempt;
    console.log(`\n🧪 Test Attempt ${attempt}/${maxRetries}\n`);

    try {
      // Run atomic test
      const testResult = await testCore({
        prompt: testPrompt,
        type: ticket.type === 'db-test' ? 'db-test' : 'web-test',
        context: {
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          ticketDescription: ticket.description,
        },
        url,
        headless,
        verbose,
        directory: cwd,
      });

      totalInputTokens += testResult.tokensUsed.input;
      totalOutputTokens += testResult.tokensUsed.output;
      totalCacheCreationTokens += testResult.tokensUsed.cacheCreation;
      totalCacheReadTokens += testResult.tokensUsed.cacheRead;
      totalCost += testResult.cost;

      if (testResult.success) {
        testsPassing = true;
        console.log('\n✅ Tests passed!');
        break;
      }

      // If not last attempt, analyze and fix
      if (attempt < maxRetries) {
        console.log('\n🔍 Analyzing test failures...');

        // Collect Docker logs for backend debugging
        const logCollector = new LogCollector();
        await logCollector.collectDockerLogs('30s');
        const dockerLogs = logCollector.getErrors();

        // Analyze errors and apply fixes
        const fixResult = await analyzeAndFix(
          ticket,
          testResult.output,
          testResult.logs,
          dockerLogs,
          cwd
        );

        totalFixesApplied += fixResult.fixesApplied;
        totalInputTokens += fixResult.tokensUsed.input;
        totalOutputTokens += fixResult.tokensUsed.output;
        totalCacheCreationTokens += fixResult.tokensUsed.cacheCreation;
        totalCacheReadTokens += fixResult.tokensUsed.cacheRead;
        totalCost += fixResult.cost;

        console.log(`\n🔧 Applied ${fixResult.fixesApplied} fixes`);
        console.log(`💰 Fix cost: $${fixResult.cost.toFixed(4)}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`\n❌ Test attempt ${attempt} failed: ${errorMessage}`);

      // If last attempt, throw
      if (attempt === maxRetries) {
        throw new Error(`Tests failed after ${maxRetries} attempts: ${errorMessage}`);
      }

      // Otherwise, continue to next attempt
      console.log(`\n⚠️  Retrying... (${maxRetries - attempt} attempts remaining)`);
    }
  }

  if (!testsPassing) {
    throw new Error(`Tests failed after ${maxRetries} attempts`);
  }

  return {
    success: testsPassing,
    attempts,
    fixesApplied: totalFixesApplied,
    tokensUsed: {
      input: totalInputTokens,
      output: totalOutputTokens,
      cacheCreation: totalCacheCreationTokens,
      cacheRead: totalCacheReadTokens,
    },
    cost: totalCost,
  };
}
