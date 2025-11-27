/**
 * Test command - Atomic browser testing (no fixing, no linting)
 *
 * This command:
 * 1. Loads a ticket OR uses custom prompt
 * 2. Runs a single test with Stagehand (AI-driven browser automation)
 * 3. Returns result (success/failure) with logs
 *
 * NOTE: This is ATOMIC - no retries, no fixing, no linting
 * For iterative test+fix, use: kosuke ship --test
 *
 * Usage:
 *   kosuke test --ticket=FRONTEND-1                    # Test with ticket
 *   kosuke test --prompt="Test user login flow"        # Test with custom prompt
 *   kosuke test --ticket=FRONTEND-1 --url=http://localhost:4000
 *   kosuke test --prompt="..." --verbose               # Enable verbose output
 *   kosuke test --prompt="..." --headless              # Run in headless mode (invisible)
 */

import { Stagehand } from '@browserbasehq/stagehand';
import { join } from 'path';
import type { TestOptions, TestResult, Ticket } from '../types.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';
import { generateTestPrompt } from '../utils/prompt-generator.js';
import { findTicket, loadTicketsFile } from '../utils/tickets-manager.js';

/**
 * Core test logic (atomic - single execution, no retries, no fixes)
 */
export async function testCore(options: TestOptions): Promise<TestResult> {
  const {
    ticket: ticketId,
    prompt: customPrompt,
    url = 'http://localhost:3000',
    headless = false,
    verbose = false,
    ticketsFile = 'tickets.json',
    directory,
  } = options;

  const cwd = directory || process.cwd();
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

  // Validate ANTHROPIC_API_KEY
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required');
  }

  let ticket: Ticket | undefined;
  let testPrompt: string;
  let testIdentifier = '';

  try {
    // 1. Load ticket or create from custom prompt
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
      testPrompt = generateTestPrompt(ticket);
      console.log(`   ✅ Loaded: ${ticket.id} - ${ticket.title}\n`);
    } else {
      // Use custom prompt directly
      console.log('📋 Using custom prompt...');
      testIdentifier = `custom-${Date.now()}`;
      testPrompt = customPrompt!;
      console.log(`   ✅ Prompt: ${testPrompt}\n`);
    }

    // 2. Initialize Stagehand
    console.log(`${'='.repeat(60)}`);
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

    // 3. Navigate to URL
    const page = stagehand.context.pages()[0];
    console.log(`🌐 Navigating to ${url}...`);
    await page.goto(url);
    console.log('✅ Navigation complete\n');

    // 4. Create agent with system prompt
    const agent = stagehand.agent({
      systemPrompt: `You are a helpful testing assistant that can control a web browser.
Execute the given instructions step by step.
Be thorough and wait for elements to load when necessary.
Do not ask follow-up questions, trust your judgement to complete the task.`,
    });

    // 5. Execute test instruction
    console.log('🤖 Agent starting execution...\n');
    const result = await agent.execute({
      instruction: testPrompt,
    });

    // 6. Close browser
    console.log('\n🔒 Closing browser session...');
    await stagehand.close();
    console.log('✅ Browser closed\n');

    // 7. Calculate cost from token usage
    const cost = result.usage ? calculateCost(result.usage) : 0;

    // 8. Return TestResult
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
      ticketId: testIdentifier || ticketId || customPrompt || 'unknown',
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
  const { ticket: ticketId, prompt: customPrompt, noLogs = false } = options;

  const testDescription = ticketId
    ? `Ticket: ${ticketId}`
    : `Prompt: "${customPrompt?.substring(0, 60)}${customPrompt && customPrompt.length > 60 ? '...' : ''}"`;

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
    console.log('ℹ️  To test with automatic fixing, use: kosuke ship --test');
  }
}
