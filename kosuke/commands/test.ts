/**
 * Test command - Atomic web E2E testing with Playwright MCP
 *
 * This command:
 * 1. Accepts a test prompt with optional ticket context
 * 2. Runs a single web E2E test using Playwright MCP + Claude AI
 * 3. Returns result (success/failure) with logs and trace files
 *
 * Test type:
 * - web-test: Browser E2E testing with Playwright MCP + Claude AI
 *
 * NOTE: This is ATOMIC - no retries, no fixing, no linting
 * For iterative test+fix, use: kosuke build
 *
 * Usage:
 *   kosuke test --prompt="Test user login"
 *   kosuke test --prompt="..." --url=http://localhost:4000
 *   kosuke test --prompt="..." --verbose                # Enable verbose output
 *   kosuke test --prompt="..." --headless               # Run in headless mode
 *   kosuke test --prompt="..." --trace                  # Enable trace recording
 *
 * Programmatic usage (from build command):
 *   const result = await testCore({
 *     prompt: "Test login functionality",
 *     context: { ticketId, ticketTitle, ticketDescription },
 *   });
 */

import Anthropic from '@anthropic-ai/sdk';
import type { TestOptions, TestResult } from '../types.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';
import { PlaywrightMCPClient } from '../utils/playwright-mcp-client.js';

/**
 * Calculate cost from text generation token usage
 * Pricing (per million tokens):
 * - Input: $3.00
 * - Output: $15.00
 * - Cache creation: $3.75
 * - Cache read: $0.30
 */
function calculateTextGenerationCost(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}): number {
  const inputCost = (usage.input_tokens / 1_000_000) * 3.0;
  const outputCost = (usage.output_tokens / 1_000_000) * 15.0;
  const cacheCreationCost = (usage.cache_creation_tokens / 1_000_000) * 3.75;
  const cacheReadCost = (usage.cache_read_tokens / 1_000_000) * 0.3;

  return inputCost + outputCost + cacheCreationCost + cacheReadCost;
}

/**
 * Execute test using Playwright MCP mode
 */
async function executeWithPlaywrightMCP(params: {
  testPrompt: string;
  context?: { ticketId: string; ticketTitle: string; ticketDescription?: string };
  testIdentifier: string;
  url: string;
  headless: boolean;
  verbose: boolean;
  trace?: boolean;
}): Promise<TestResult> {
  const { testPrompt, context, testIdentifier, url, headless, verbose, trace } = params;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🧪 Running Browser Test`);
  console.log(`${'='.repeat(60)}\n`);

  console.log(`🌐 URL: ${url}`);
  console.log(`🔍 Verbose: ${verbose ? 'enabled' : 'disabled'}`);
  console.log(`👁️  Headless: ${headless ? 'enabled' : 'disabled'}`);
  console.log(`🎭 Browser: chromium (forced)`);
  console.log(`📹 Tracing: ${trace ? 'enabled (video/screenshots will be saved)' : 'disabled'}\n`);

  // Validate ANTHROPIC_API_KEY
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required');
  }

  // Initialize MCP client
  const mcpClient = new PlaywrightMCPClient();

  try {
    // Connect to MCP server
    console.log('🔌 Connecting to Playwright MCP server...');
    await mcpClient.connect({ verbose, trace });

    // Get MCP tools
    const mcpTools = mcpClient.getTools();

    // Start tracing if enabled
    if (trace) {
      console.log('📹 Starting trace recording...');
      try {
        await mcpClient.executeTool('browser_start_tracing', {});
        console.log('✅ Trace recording started\n');
      } catch (error) {
        console.warn(
          `⚠️  Failed to start tracing: ${error instanceof Error ? error.message : String(error)}`
        );
        console.warn('⚠️  Continuing without tracing...\n');
      }
    }

    // Initialize Anthropic client
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    // Prepare system prompt
    const systemPrompt = `You are a browser testing assistant using Playwright tools.

Execute the test instructions step by step using the available Playwright MCP tools.

REQUIREMENTS:
- Use chromium browser (already configured)
- Headless mode: ${headless ? 'enabled' : 'disabled'}
- Target URL: ${url}
- Be thorough and wait for elements to load when necessary
- Report success or failure clearly

${context ? `\nTest Context:\n- Ticket: ${context.ticketId}\n- Title: ${context.ticketTitle}\n${context.ticketDescription ? `- Description: ${context.ticketDescription}\n` : ''}` : ''}`;

    // Build messages
    let messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: testPrompt,
      },
    ];

    console.log('🤖 Starting test execution with Claude + Playwright MCP...\n');

    // Track tokens and cost
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreation = 0;
    let totalCacheRead = 0;

    // Execute test loop (max 20 turns)
    let turnCount = 0;
    const maxTurns = 20;
    let responseText = '';
    let testSuccess = false;

    while (turnCount < maxTurns) {
      turnCount++;

      // Truncate old tool results to prevent token overflow
      // Keep only last 3 tool result exchanges (6 messages: 3 assistant + 3 user with results)
      if (messages.length > 13) {
        // Keep initial user message + last 6 messages (3 exchanges)
        const initialMessage = messages[0];
        const recentMessages = messages.slice(-6);
        messages = [initialMessage, ...recentMessages];

        if (verbose) {
          console.log(
            `\n🔄 Truncated message history (keeping last 3 exchanges to prevent token overflow)`
          );
        }
      }

      // Stream response
      const stream = await anthropic.messages.stream({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        tools: mcpTools,
        messages,
      });

      let currentText = '';
      const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

      // Process stream
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const delta = event.delta.text;
          currentText += delta;
          if (verbose) {
            process.stdout.write(delta);
          }
        }
      }

      responseText += currentText;

      // Get final message
      const finalMessage = await stream.finalMessage();

      // Track tokens
      const usage = finalMessage.usage as unknown as {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      totalInputTokens += usage.input_tokens;
      totalOutputTokens += usage.output_tokens;
      totalCacheCreation += usage.cache_creation_input_tokens || 0;
      totalCacheRead += usage.cache_read_input_tokens || 0;

      // Extract tool uses
      for (const block of finalMessage.content) {
        if (block.type === 'tool_use') {
          toolUses.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
        }
      }

      // Add assistant message to history
      messages.push({ role: 'assistant', content: finalMessage.content });

      // If no tools called, test is complete
      if (toolUses.length === 0) {
        testSuccess =
          responseText.toLowerCase().includes('success') ||
          responseText.toLowerCase().includes('passed');
        break;
      }

      // Execute tools and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUses) {
        if (verbose) {
          console.log(`\n🔧 Executing: ${toolUse.name}`);
        }

        try {
          const result = await mcpClient.executeTool(toolUse.name, toolUse.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error: ${errorMsg}`,
            is_error: true,
          });
        }
      }

      // Add tool results to messages
      messages.push({ role: 'user', content: toolResults });
    }

    // Stop tracing if enabled
    if (trace) {
      console.log('\n📹 Stopping trace recording...');
      try {
        const traceResult = await mcpClient.executeTool('browser_stop_tracing', {});
        console.log('✅ Trace recording stopped\n');

        // Parse trace result to find output paths
        let traceText = '';
        if (Array.isArray(traceResult)) {
          const textContent = traceResult.find(
            (item: { type?: string; text?: string }) => item.type === 'text'
          );
          if (textContent?.text) {
            traceText = textContent.text;
          }
        } else if (typeof traceResult === 'string') {
          traceText = traceResult;
        } else if (traceResult && typeof traceResult === 'object' && 'text' in traceResult) {
          traceText = (traceResult as { text: string }).text;
        }

        if (traceText) {
          // Extract paths from MCP response
          const actionLogMatch = traceText.match(/Action log:\s*(.+\.trace)/);
          const networkLogMatch = traceText.match(/Network log:\s*(.+\.network)/);
          const resourcesMatch = traceText.match(/Resources.*:\s*(.+resources)/);

          if (actionLogMatch) {
            const tracePath = actionLogMatch[1];
            const networkPath = networkLogMatch ? networkLogMatch[1] : null;
            const resourcesPath = resourcesMatch ? resourcesMatch[1] : null;

            console.log('📁 Trace files:');
            console.log(`   📹 Action log: ${tracePath}`);
            if (networkPath) {
              console.log(`   🌐 Network log: ${networkPath}`);
            }
            if (resourcesPath) {
              console.log(`   📦 Resources: ${resourcesPath}`);
            }
            console.log(`\n🎬 View trace (with video): npx playwright show-trace ${tracePath}`);
            console.log('   ℹ️  Video is embedded in the trace file and will play in the viewer');
          } else {
            console.log('✅ Trace saved (paths not parsed)');
            console.log(`Raw result: ${traceText}`);
          }
        } else {
          console.log('⚠️  Trace saved but location not returned by MCP server');
        }
      } catch (error) {
        console.warn(
          `⚠️  Failed to stop tracing: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Get MCP tool usage
    const toolUsage = mcpClient.getToolUsage();

    // Calculate costs
    const textGenerationCost = calculateTextGenerationCost({
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      cache_creation_tokens: totalCacheCreation,
      cache_read_tokens: totalCacheRead,
    });

    // MCP tool calls cost (estimated: $0.01 per tool call)
    const toolCallCost = toolUsage.total * 0.01;
    const totalCost = textGenerationCost + toolCallCost;

    // Close MCP client
    console.log('\n🔒 Closing MCP connection...');
    await mcpClient.close();
    console.log('✅ MCP connection closed\n');

    return {
      ticketId: testIdentifier,
      success: testSuccess,
      output: responseText,
      logs: {
        console: [],
        errors: testSuccess ? [] : [responseText],
      },
      tokensUsed: {
        input: totalInputTokens,
        output: totalOutputTokens,
        cacheCreation: totalCacheCreation,
        cacheRead: totalCacheRead,
      },
      cost: totalCost,
      mcpToolUsage: {
        navigations: toolUsage.navigations,
        clicks: toolUsage.clicks,
        types: toolUsage.types,
        extracts: toolUsage.extracts,
        other: toolUsage.other,
      },
      mcpToolCost: toolCallCost,
      error: testSuccess ? undefined : 'Test did not complete successfully',
    };
  } catch (error) {
    await mcpClient.close();

    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Playwright MCP test failed: ${errorMessage}`);

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
 * Core test logic (atomic - single execution, no retries, no fixes)
 */
export async function testCore(options: TestOptions): Promise<TestResult> {
  const {
    prompt: testPrompt,
    context,
    url = 'http://localhost:3000',
    headless = false,
    verbose = false,
    trace = false,
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

  // Validate ANTHROPIC_API_KEY (required for Playwright MCP)
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

  // Execute with Playwright MCP
  return await executeWithPlaywrightMCP({
    testPrompt,
    context,
    testIdentifier,
    url,
    headless,
    verbose,
    trace,
  });
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

  // Display MCP tool usage
  if (result.mcpToolUsage) {
    console.log(`\n🎭 Playwright Tool Usage:`);
    console.log(`   🌐 Navigations: ${result.mcpToolUsage.navigations}`);
    console.log(`   🖱️  Clicks: ${result.mcpToolUsage.clicks}`);
    console.log(`   ⌨️  Types: ${result.mcpToolUsage.types}`);
    console.log(`   📤 Extracts: ${result.mcpToolUsage.extracts}`);
    console.log(`   🔧 Other: ${result.mcpToolUsage.other}`);

    const totalTools =
      result.mcpToolUsage.navigations +
      result.mcpToolUsage.clicks +
      result.mcpToolUsage.types +
      result.mcpToolUsage.extracts +
      result.mcpToolUsage.other;
    console.log(`   📊 Total: ${totalTools}`);
  }

  // Display cost breakdown
  if (result.mcpToolCost !== undefined) {
    console.log(`\n💰 Cost Breakdown:`);
    console.log(`   💬 Text generation: $${(result.cost - result.mcpToolCost).toFixed(4)}`);
    console.log(`   🎭 Playwright tool calls: $${result.mcpToolCost.toFixed(4)}`);
    console.log(`   📊 Total: $${result.cost.toFixed(4)}`);
  } else {
    console.log(`💰 Cost: $${result.cost.toFixed(4)}`);
  }

  console.log('='.repeat(60));

  if (result.success) {
    console.log('\n✅ Test completed successfully!');
  } else {
    console.log(`\n❌ Test failed: ${result.error || 'See output above for details'}`);
    console.log('\nℹ️  This is an atomic test command - it does not apply fixes.');
    console.log('ℹ️  To test with automatic fixing, use: kosuke build');
  }
}
