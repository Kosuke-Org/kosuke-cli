/**
 * Test command - Atomic testing (web or database, no fixing, no linting)
 *
 * This command:
 * 1. Accepts a test prompt with optional ticket context
 * 2. Runs a single test (web E2E or database validation)
 * 3. Returns result (success/failure) with logs
 *
 * Test types:
 * - web-test: Browser E2E testing with Stagehand
 * - db-test: Database schema validation with Claude Code
 *
 * NOTE: This is ATOMIC - no retries, no fixing, no linting
 * For iterative test+fix, use: kosuke build
 *
 * Usage:
 *   kosuke test --prompt="Test user login" --type=web-test
 *   kosuke test --prompt="Validate users table exists" --type=db-test
 *   kosuke test --prompt="..." --url=http://localhost:4000
 *   kosuke test --prompt="..." --db-url=postgres://...
 *   kosuke test --prompt="..." --verbose                # Enable verbose output
 *   kosuke test --prompt="..." --headless               # Run in headless mode (web-test only)
 *
 * Programmatic usage (from build command):
 *   const result = await testCore({
 *     prompt: "Test login functionality",
 *     type: "web-test",
 *     context: { ticketId, ticketTitle, ticketDescription },
 *   });
 */

import { Stagehand } from '@browserbasehq/stagehand';
import type { DBTestResult, TestOptions, TestResult } from '../types.js';
import { formatCostBreakdown, runAgent } from '../utils/claude-agent.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';

/**
 * Build system prompt for DB schema validation with Claude Code
 */
function buildDBTestPrompt(testPrompt: string, dbUrl: string): string {
  return `You are a database testing expert validating database schema.

**Your Task:**
${testPrompt}

**Database Connection:**
- Database URL: ${dbUrl}
- Use the \`postgres\` npm package to connect and query the database
- Connection is already available via environment (use POSTGRES_URL)

**Critical Instructions:**
1. Connect to the PostgreSQL database using the URL provided
2. Query the database to check if the expected tables exist
3. Validate table existence based on the test requirements
4. Report success if all expected tables are found
5. Report failure with specific missing tables if validation fails
6. Use terminal commands to run database queries (e.g., \`POSTGRES_URL="${dbUrl}" psql -c "\\dt"\`)
7. Alternatively, write and run a Node.js script to validate schema

**Success Criteria:**
- All expected tables from the test prompt exist in the database
- No errors during database connection
- Clear validation output showing which tables were checked

Begin by connecting to the database and validating the schema requirements.`;
}

/**
 * Run database schema validation test with Claude Code
 */
async function runDBTest(
  testPrompt: string,
  dbUrl: string,
  cwd: string
): Promise<DBTestResult & { tokensUsed: TestResult['tokensUsed']; cost: number }> {
  console.log('🗄️  Running database validation with Claude Code...\n');

  const systemPrompt = buildDBTestPrompt(testPrompt, dbUrl);

  const result = await runAgent('Validate database schema according to test requirements', {
    systemPrompt,
    cwd,
    maxTurns: 15,
    verbosity: 'normal',
  });

  console.log(`\n✨ Database validation completed`);
  console.log(`💰 Validation cost: ${formatCostBreakdown(result)}`);

  // Parse validation result from agent output
  // Success if agent completed without errors
  const success = result.fixCount === 0 || result.response.toLowerCase().includes('success');

  return {
    success,
    tablesValidated: [], // Agent handles validation internally
    errors: success ? [] : ['Database validation failed - see agent output above'],
    tokensUsed: result.tokensUsed,
    cost: result.cost,
  };
}

/**
 * Core test logic (atomic - single execution, no retries, no fixes)
 */
export async function testCore(options: TestOptions): Promise<TestResult> {
  const {
    prompt: testPrompt,
    type: manualType,
    context,
    url = 'http://localhost:3000',
    dbUrl = 'postgres://postgres:postgres@localhost:5432/postgres',
    headless = false,
    verbose = false,
    directory,
  } = options;

  const cwd = directory || process.cwd();

  // Validate: prompt is required
  if (!testPrompt || testPrompt.trim().length === 0) {
    throw new Error(
      'Test prompt is required\n' +
        'Examples:\n' +
        '  kosuke test --prompt="Test user login" --type=web-test\n' +
        '  kosuke test --prompt="Validate users table exists" --type=db-test'
    );
  }

  // Auto-detect test type from context or use manual type
  let testType: 'web-test' | 'db-test';
  if (manualType) {
    testType = manualType;
  } else if (context?.ticketId.startsWith('DB-TEST-')) {
    testType = 'db-test';
  } else if (context?.ticketId.startsWith('WEB-TEST-')) {
    testType = 'web-test';
  } else {
    // Default to web-test if no clear indication
    testType = 'web-test';
  }

  // Validate ANTHROPIC_API_KEY (required for both test types now)
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
  console.log(`🎯 Test Type: ${testType}\n`);

  try {
    // 2. Run appropriate test based on type
    if (testType === 'db-test') {
      // Database validation test with Claude Code
      console.log(`${'='.repeat(60)}`);
      console.log(`🧪 Running Database Validation Test`);
      console.log(`${'='.repeat(60)}\n`);

      console.log(`🗄️  Database URL: ${dbUrl.replace(/:[^:@]+@/, ':****@')}\n`); // Hide password

      const dbResult = await runDBTest(testPrompt, dbUrl, cwd);

      return {
        ticketId: testIdentifier,
        testType: 'db-test',
        success: dbResult.success,
        output: dbResult.success
          ? `✅ Database validation passed`
          : `❌ Database validation failed\nErrors:\n${dbResult.errors.join('\n')}`,
        logs: {
          console: [],
          errors: dbResult.errors,
        },
        tokensUsed: dbResult.tokensUsed,
        cost: dbResult.cost,
        error: dbResult.success ? undefined : dbResult.errors.join('\n'),
      };
    } else {
      // Web E2E test with Stagehand
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
        testType: 'web-test',
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
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Test execution failed: ${errorMessage}`);

    return {
      ticketId: testIdentifier,
      testType,
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
    console.log('ℹ️  To test with automatic fixing, use: kosuke ship --test');
  }
}
