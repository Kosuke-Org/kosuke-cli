/**
 * Test command - Atomic web E2E testing (no fixing, no linting)
 *
 * This command:
 * 1. Accepts a test prompt with optional ticket context
 * 2. Runs a single web E2E test with Stagehand
 * 3. Returns result (success/failure) with logs
 *
 * Test type:
 * - web-test: Browser E2E testing with Stagehand + Claude AI
 *
 * NOTE: This is ATOMIC - no retries, no fixing, no linting
 * For iterative test+fix, use: kosuke build
 *
 * Usage:
 *   kosuke test --prompt="Test user login"
 *   kosuke test --prompt="..." --url=http://localhost:4000
 *   kosuke test --prompt="..." --verbose                # Enable verbose output
 *   kosuke test --prompt="..." --headless               # Run in headless mode
 *
 * Programmatic usage (from build command):
 *   const result = await testCore({
 *     prompt: "Test login functionality",
 *     type: "web-test",
 *     context: { ticketId, ticketTitle, ticketDescription },
 *   });
 */

import { Stagehand } from '@browserbasehq/stagehand';
import type { TestOptions, TestResult } from '../types.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';

/**
 * Core test logic (atomic - single execution, no retries, no fixes)
 */
export async function testCore(options: TestOptions): Promise<TestResult> {
  const {
    prompt: testPrompt,
    context,
    url = 'http://localhost:3000',
    headless = false,
    verbose = false,
  } = options;

  // Validate: prompt is required
  if (!testPrompt || testPrompt.trim().length === 0) {
    throw new Error(
      'Test prompt is required\n' +
        'Examples:\n' +
        '  kosuke test --prompt="Test user login"\n' +
        '  kosuke test --prompt="Test task creation flow"'
    );
  }

  // Validate ANTHROPIC_API_KEY (required for Stagehand)
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required for testing');
  }

  const testIdentifier = context?.ticketId || `test-${Date.now()}`;

  // Log context if provided
  if (context) {
    console.log(`🎫 Testing: ${context.ticketId} - ${context.ticketTitle}`);
  } else {
    console.log(`📋 Test: ${testPrompt.substring(0, 60)}${testPrompt.length > 60 ? '...' : ''}`);
  }

  try {
    // Run web E2E test with Stagehand
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🧪 Running Browser Test`);
    console.log(`${'='.repeat(60)}\n`);

    console.log(`🌐 URL: ${url}`);
    console.log(`🔍 Verbose: ${verbose ? 'enabled' : 'disabled'}`);
    console.log(`👁️  Headless: ${headless ? 'enabled' : 'disabled'}\n`);

    const stagehand = new Stagehand({
      env: 'LOCAL',
      verbose: verbose ? 2 : 1, // verbose flag → level 2, otherwise level 1
      localBrowserLaunchOptions: {
        headless,
      },
    });

    await stagehand.init();
    console.log('✅ Stagehand initialized\n');

    // Navigate to URL
    const page = stagehand.context.pages()[0];
    console.log(`🌐 Navigating to ${url}...`);
    await page.goto(url);
    console.log('✅ Navigation complete\n');

    // Create agent with system prompt
    const agent = stagehand.agent({
      systemPrompt: `You are a helpful testing assistant that can control a web browser.
Execute the given instructions step by step.
Be thorough and wait for elements to load when necessary.
Do not ask follow-up questions, trust your judgement to complete the task.`,
    });

    // Execute test instruction
    console.log('🤖 Agent starting execution...\n');
    const result = await agent.execute({
      instruction: testPrompt,
    });

    // Close browser
    console.log('\n🔒 Closing browser session...');
    await stagehand.close();
    console.log('✅ Browser closed\n');

    // Calculate cost from token usage
    const cost = result.usage ? calculateCost(result.usage) : 0;

    // Return TestResult
    return {
      ticketId: testIdentifier,
      success: result.success,
      output: result.message,
      logs: {
        console: [], // Stagehand doesn't expose browser console logs via agent
        errors: result.success ? [] : [result.message],
      },
      tokensUsed: {
        input: result.usage?.input_tokens || 0,
        output: result.usage?.output_tokens || 0,
        cacheCreation: 0, // Not exposed separately by Stagehand
        cacheRead: result.usage?.cached_input_tokens || 0,
      },
      cost,
      error: result.success ? undefined : result.message,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Test execution failed: ${errorMessage}`);

    return {
      ticketId: testIdentifier,
      success: false,
      output: `Test failed: ${errorMessage}`,
      logs: {
        console: [],
        errors: [errorMessage],
      },
      tokensUsed: {
        input: 0,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
      },
      cost: 0,
      error: errorMessage,
    };
  }
}

/**
 * Calculate cost from Stagehand token usage
 * Pricing (per million tokens):
 * - Input: $3.00
 * - Output: $15.00
 * - Cache read: $0.30
 */
function calculateCost(usage: {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  cached_input_tokens?: number;
  inference_time_ms: number;
}): number {
  const inputCost = (usage.input_tokens / 1_000_000) * 3.0;
  const outputCost = (usage.output_tokens / 1_000_000) * 15.0;
  const cacheReadCost = ((usage.cached_input_tokens || 0) / 1_000_000) * 0.3;

  return inputCost + outputCost + cacheReadCost;
}

/**
 * Main test command
 */
export async function testCommand(options: TestOptions): Promise<void> {
  const { prompt, context, noLogs = false } = options;

  const testDescription = context
    ? `${context.ticketId} - ${context.ticketTitle}`
    : `"${prompt.substring(0, 60)}${prompt.length > 60 ? '...' : ''}"`;

  console.log(`🧪 Testing ${testDescription}\n`);

  // Initialize logging context
  const logContext = logger.createContext('test', { noLogs });
  const cleanupHandler = setupCancellationHandler(logContext);

  try {
    // Run atomic test
    const result = await testCore(options);

    // Track metrics
    logger.trackTokens(logContext, result.tokensUsed);

    // Display summary
    displayTestSummary(result);

    // Log execution (success or error based on test result)
    await logger.complete(
      logContext,
      result.success ? 'success' : 'error',
      result.error ? new Error(result.error) : undefined
    );
    cleanupHandler();
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
function displayTestSummary(result: TestResult): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log('📊 Test Summary');
  console.log('='.repeat(60));

  if (result.success) {
    console.log('✅ Status: Test passed');
  } else {
    console.log('❌ Status: Test failed');
  }

  console.log(`📝 Output: ${result.output}`);
  console.log(`🔧 Console logs: ${result.logs.console.length}`);
  console.log(`❌ Errors: ${result.logs.errors.length}`);
  console.log(`💰 Cost: $${result.cost.toFixed(4)}`);

  console.log('='.repeat(60));

  if (result.success) {
    console.log('\n✅ Test completed successfully!');
  } else {
    console.log(`\n❌ Test failed: ${result.error || 'See output above for details'}`);
    console.log('\nℹ️  This is an atomic test command - it does not apply fixes.');
    console.log('ℹ️  To test with automatic fixing, use: kosuke build');
  }
}
