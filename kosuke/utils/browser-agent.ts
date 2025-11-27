/**
 * Browser Agent - Stagehand-powered browser automation
 *
 * Uses Stagehand with Anthropic Claude for AI-driven browser testing.
 * Provides simple boolean success/failure results with logs.
 */

import { Stagehand } from '@browserbasehq/stagehand';

interface BrowserTestOptions {
  url: string;
  task: string;
  headed?: boolean;
  debug?: boolean;
}

interface BrowserTestResult {
  success: boolean;
  output: string; // Human-readable test result
  logs: {
    console: string[];
    errors: string[];
  };
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  cost: number;
}

/**
 * Run browser test using Stagehand
 */
export async function runBrowserTest(options: BrowserTestOptions): Promise<BrowserTestResult> {
  const { url, task, headed = false, debug = false } = options;

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required for Stagehand');
  }

  console.log(`🌐 Navigating to: ${url}`);
  console.log(`🎯 Task: ${task}\n`);

  const stagehand = new Stagehand({
    env: 'LOCAL',
    apiKey: process.env.ANTHROPIC_API_KEY,
    headless: !headed,
    debugDom: debug,
    modelName: (process.env.STAGEHAND_MODEL ||
      'claude-3-5-sonnet-20240620') as 'claude-3-5-sonnet-20240620',
    modelClientOptions: {
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
  });

  const consoleLogs: string[] = [];
  const errors: string[] = [];

  try {
    // Initialize Stagehand
    await stagehand.init();

    // Set up log collectors
    stagehand.page.on('console', (msg) => {
      const text = msg.text();
      consoleLogs.push(`[${msg.type()}] ${text}`);

      // Track errors
      if (msg.type() === 'error') {
        errors.push(text);
      }
    });

    stagehand.page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    // Navigate to URL
    await stagehand.page.goto(url, { waitUntil: 'networkidle' });

    // Execute task with Stagehand
    console.log('🤖 Executing task with Claude...');
    const result = await stagehand.act({ action: task });

    // Close browser
    await stagehand.close();

    // Convert result to string for processing
    const resultText = typeof result === 'string' ? result : JSON.stringify(result);

    // Determine success based on result
    const success =
      !resultText.toLowerCase().includes('error') &&
      !resultText.toLowerCase().includes('failed') &&
      errors.length === 0;

    const output = success
      ? `✅ Test passed: ${resultText}`
      : `❌ Test failed: ${resultText}${errors.length > 0 ? `\n\nErrors found:\n${errors.join('\n')}` : ''}`;

    console.log(`\n${output}\n`);

    return {
      success,
      output,
      logs: {
        console: consoleLogs,
        errors,
      },
      tokensUsed: {
        input: 0, // Stagehand doesn't expose this yet
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
      },
      cost: 0, // Will be added later when Stagehand exposes metrics
    };
  } catch (error) {
    // Ensure browser is closed on error
    await stagehand.close();

    const errorMessage = error instanceof Error ? error.message : String(error);
    errors.push(errorMessage);

    console.error(`\n❌ Browser test failed: ${errorMessage}\n`);

    return {
      success: false,
      output: `❌ Test failed with error: ${errorMessage}`,
      logs: {
        console: consoleLogs,
        errors,
      },
      tokensUsed: {
        input: 0,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
      },
      cost: 0,
    };
  }
}
