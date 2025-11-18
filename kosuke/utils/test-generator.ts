/**
 * Test Generator - AI-powered Playwright test generation
 *
 * Uses Claude to generate Playwright tests from ticket descriptions
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runAgent } from './claude-agent.js';
import type { Ticket } from '../types.js';

export interface GeneratedTest {
  filePath: string;
  content: string;
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  cost: number;
}

/**
 * Generate Playwright test from ticket description
 */
export async function generateTest(
  ticket: Ticket,
  baseUrl: string,
  cwd: string = process.cwd()
): Promise<GeneratedTest> {
  const testDir = join(cwd, '.kosuke', 'tests');
  const testFilePath = join(testDir, `${ticket.id}.spec.ts`);

  // Ensure test directory exists
  if (!existsSync(testDir)) {
    mkdirSync(testDir, { recursive: true });
  }

  // Check if test already exists
  if (existsSync(testFilePath)) {
    console.log(`   ✅ Test already exists: ${testFilePath}`);
    return {
      filePath: testFilePath,
      content: '',
      tokensUsed: {
        input: 0,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
      },
      cost: 0,
    };
  }

  console.log(`   🤖 Generating test using Claude...`);

  const systemPrompt = buildTestGenerationPrompt(ticket, baseUrl);

  const result = await runAgent(`Generate Playwright test for ticket ${ticket.id}`, {
    systemPrompt,
    cwd,
    maxTurns: 15,
    verbosity: 'minimal',
  });

  // Extract test code from response
  const testContent = extractTestCode(result.response, ticket, baseUrl);

  // Save test file
  writeFileSync(testFilePath, testContent, 'utf-8');

  console.log(`   ✅ Test generated: ${testFilePath}`);

  return {
    filePath: testFilePath,
    content: testContent,
    tokensUsed: result.tokensUsed,
    cost: result.cost,
  };
}

/**
 * Build system prompt for test generation
 */
function buildTestGenerationPrompt(ticket: Ticket, baseUrl: string): string {
  return `You are an expert QA engineer creating Playwright end-to-end tests.

**Your Task:**
Generate a comprehensive Playwright test file for the following ticket.

**Ticket Information:**
- ID: ${ticket.id}
- Title: ${ticket.title}
- Description:
${ticket.description}

**Application URL:** ${baseUrl}

**Test Requirements:**
1. Create a complete Playwright test file in TypeScript
2. Include multiple test cases covering:
   - Happy path (main functionality)
   - Edge cases (validation, errors)
   - Visual regression test (one screenshot)
3. Use proper Playwright selectors (prefer getByRole, getByLabel, getByText)
4. Include proper assertions with expect()
5. Add comments explaining what each test does
6. Follow Playwright best practices

**Test Structure:**
\`\`\`typescript
import { test, expect } from '@playwright/test';

test.describe('${ticket.id}: ${ticket.title}', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the relevant page
    await page.goto('${baseUrl}/...');
  });

  test('should [describe main functionality]', async ({ page }) => {
    // Test implementation
  });

  test('should handle [edge case]', async ({ page }) => {
    // Test implementation
  });

  test('visual regression: [page/component] renders correctly', async ({ page }) => {
    // Wait for page to be stable
    await page.waitForLoadState('networkidle');
    
    // Take screenshot
    const screenshot = await page.screenshot({ fullPage: true });
    
    // Compare with baseline (handled by visual tester)
    expect(screenshot).toBeDefined();
  });
});
\`\`\`

**Critical Instructions:**
1. Analyze the ticket description to understand what features to test
2. Determine the correct URL paths based on the feature
3. Generate realistic test data (emails, names, etc.)
4. Include proper waits (waitForLoadState, waitForSelector)
5. Test both success and failure scenarios
6. Add one visual regression test at the end
7. Output ONLY the test code - no explanations outside the code

Generate the complete test file now:`;
}

/**
 * Extract test code from Claude's response
 */
function extractTestCode(response: string, ticket: Ticket, baseUrl: string): string {
  // Look for code blocks in the response
  const codeBlockMatch = response.match(/```(?:typescript|ts)?\n([\s\S]+?)\n```/);

  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // If no code block found, try to use the whole response
  // or generate a basic template
  if (response.includes('import') && response.includes('test(')) {
    return response.trim();
  }

  // Fallback: generate basic template
  console.log('   ⚠️  Could not extract test code, generating basic template');
  return generateBasicTemplate(ticket, baseUrl);
}

/**
 * Generate a basic test template as fallback
 */
function generateBasicTemplate(ticket: Ticket, baseUrl: string): string {
  return `import { test, expect } from '@playwright/test';

test.describe('${ticket.id}: ${ticket.title}', () => {
  test.beforeEach(async ({ page }) => {
    // TODO: Update this URL to the correct path for the feature
    await page.goto('${baseUrl}');
  });

  test('should load the page', async ({ page }) => {
    // TODO: Add assertions to verify the page loaded correctly
    await expect(page.locator('body')).toBeVisible();
  });

  test('should interact with main feature', async ({ page }) => {
    // TODO: Add test steps for the main functionality
    // Example:
    // await page.getByRole('button', { name: 'Submit' }).click();
    // await expect(page.getByText('Success')).toBeVisible();
  });

  test('visual regression: page renders correctly', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    const screenshot = await page.screenshot({ fullPage: true });
    expect(screenshot).toBeDefined();
  });
});
`;
}
