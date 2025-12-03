/**
 * Granular Test Generator - Generate Stagehand test scripts from prompts
 *
 * Uses Claude to convert natural language test prompts into executable
 * TypeScript scripts using Stagehand primitives (act, extract, observe).
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { GranularTestScript, GranularTestStep, TestContext } from '../types.js';
import { runAgent, type AgentResult } from './claude-agent.js';

export interface ScriptConfig {
  url: string;
  headless: boolean;
  verbose: boolean;
}

/**
 * Generate granular test script from prompt using Claude
 *
 * @param prompt - Test prompt/instructions
 * @param config - Script configuration (URL, headless, verbose)
 * @param context - Optional ticket context
 * @param directory - Optional directory path for context-aware generation
 */
export async function generateGranularTestScript(
  prompt: string,
  config: ScriptConfig,
  context?: TestContext,
  directory?: string
): Promise<{ script: GranularTestScript; tokensUsed: AgentResult['tokensUsed']; cost: number }> {
  if (directory) {
    console.log(`🤖 Generating granular test script with repository context (${directory})...\n`);
  } else {
    console.log('🤖 Generating granular test script (standalone mode)...\n');
  }

  const systemPrompt = buildSystemPrompt(directory, config);

  const fullPrompt = buildGenerationPrompt(prompt, context);

  const result = await runAgent(fullPrompt, {
    systemPrompt,
    maxTurns: 10,
    verbosity: 'normal',
    cwd: directory, // Use specified directory or default cwd
    settingSources: directory ? ['project'] : [], // Load CLAUDE.md only if directory provided
  });

  const script = parseGeneratedScript(result.response, config);

  console.log(`✅ Generated ${script.steps.length} test steps\n`);

  return {
    script,
    tokensUsed: result.tokensUsed,
    cost: result.cost,
  };
}

/**
 * Build system prompt with Stagehand primitives documentation
 *
 * @param directory - If provided, enables repository-aware mode
 * @param config - Script configuration
 */
function buildSystemPrompt(directory: string | undefined, config: ScriptConfig): string {
  const basePrompt = `You are a Stagehand test script generator expert.

${
  directory
    ? `You have access to the codebase in ${directory}. Use file exploration tools to understand the application structure, routing, and UI components before generating the test script.`
    : `You are working in STANDALONE MODE. DO NOT explore files or read the codebase. Generate test scripts based ONLY on the test prompt and general web testing knowledge. Focus on common UI patterns and generic element selectors.`
}

The script will test the application at: ${config.url}
`;

  return (
    basePrompt +
    `


Your job is to generate executable TypeScript test scripts using Stagehand primitives.

## STAGEHAND PRIMITIVES

### 1. act() - Execute browser actions
Execute user interactions like clicks, typing, scrolling using stagehand.act().

**IMPORTANT:** Each act() call should be a SINGLE, complete action. Do NOT split actions.

\`\`\`typescript
// ✅ CORRECT - Single comprehensive actions (instruction is a direct string parameter)
await stagehand.act("type 'user@example.com' into the email field");
await stagehand.act("type 'password123' into the password field");
await stagehand.act("click the Login button");
await stagehand.act("scroll to the bottom of the page");

// ❌ WRONG - Do NOT split into multiple steps
// await stagehand.act("click on the email field");  // ❌ Don't do this
// await stagehand.act("type 'user@example.com'");   // ❌ Then type
\`\`\`

### 2. extract() - Extract structured data
Extract and validate data from the page using Zod schemas with stagehand.extract().

**API:** extract(instruction: string, schema: ZodSchema, options?: ExtractOptions)

\`\`\`typescript
const userData = await stagehand.extract(
  "extract the user's profile information",
  z.object({
    username: z.string(),
    email: z.string().email(),
    role: z.string()
  })
);

console.log('Extracted user data:', userData);
\`\`\`

### 3. observe() - Find and verify elements
Locate elements using stagehand.observe():

\`\`\`typescript
const submitButton = await stagehand.observe("find the submit button");
const errorMessage = await stagehand.observe("find any error messages on the page");
\`\`\`

## BEST PRACTICES

1. **Be Specific with Element Descriptions**: Use clear, descriptive action instructions that disambiguate similar elements
   - **CRITICAL**: Pages often have multiple similar buttons/links (e.g., "Login" in header AND "Sign In" in form)
   - Always specify LOCATION and CONTEXT to avoid clicking the wrong element
   - ✅ await stagehand.act("click the Sign In button in the form");
   - ✅ await stagehand.act("click the submit button at the bottom of the login form");
   - ✅ await stagehand.act("click the Create button in the navigation header");
   - ❌ await stagehand.act("click the login button"); // TOO VAGUE - multiple "login" elements exist
   - ❌ await stagehand.act("click button"); // TOO VAGUE - no context

2. **Extract for Validation**: Use extract() to verify test success
   - Extract data after actions to confirm changes
   - Use Zod schemas to validate structure
   - API: stagehand.extract(instruction, schema)

3. **Validate Extracted Data**: ALWAYS verify extracted data meets expectations
   - Check boolean flags after actions (e.g., isLoggedIn must be true)
   - Verify required fields are not empty strings
   - Throw descriptive errors when validation fails
   - Use if statements to check critical data before proceeding to next step
   - Example: if (!user.isLoggedIn) { throw new Error('Login failed!'); }

4. **Log Everything**: Add console.log() statements for visibility
   - Log extracted data
   - Log before and after critical actions
   - Use descriptive messages

5. **Handle Timing**: Add delays between actions for stability
   - Use await new Promise(resolve => setTimeout(resolve, 1000)) for explicit waits
   - Wait for DOM loaded: await page.waitForLoadState('domcontentloaded') (faster, more reliable than networkidle)
   - Add 1-2 second delays after major actions (login, navigation, form submission)
   - AVOID networkidle - it often times out with modern web apps (websockets, polling, etc.)

6. **Error Handling**: Use try-catch for critical sections
   - Throw descriptive errors when validation fails
   - Log error context for debugging

## CRITICAL REQUIREMENTS

**REQUIRED - Generate a complete, standalone, executable script:**

- ✅ Import Stagehand and zod at the top: import { Stagehand } from '@browserbasehq/stagehand';
- ✅ Create async runTest() function that wraps all test logic
- ✅ Initialize Stagehand with env, verbose, and localBrowserLaunchOptions (NOT debugDom)
- ✅ Call stagehand.init() before tests
- ✅ Get browser page with: const page = stagehand.context.pages()[0];
- ✅ Call stagehand.close() in finally block
- ✅ Use try-catch-finally for proper cleanup
- ✅ Throw errors in catch block and close browser in finally
- ✅ Call runTest().catch((error) => { console.error(error); process.exit(1); }) at the end
- ✅ Clear step comments and console.log() statements
- ✅ Use await new Promise(resolve => setTimeout(resolve, ms)) for delays
- ✅ Use await page.waitForLoadState('networkidle') after navigation
- ✅ Use stagehand.act(), stagehand.extract(), stagehand.observe() for AI actions
- ✅ Use page for navigation and waits (page.goto, page.waitForLoadState)
- ✅ Add validation checks after EVERY extract() call with if statements and throw errors

## OUTPUT FORMAT

Generate a COMPLETE, SELF-CONTAINED script that can be run with \`tsx script.ts\`.

**CORRECT Example (Complete Standalone Script):**

\`\`\`typescript
import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';

async function runTest() {
  const stagehand = new Stagehand({
    env: 'LOCAL',
    verbose: 1,
    localBrowserLaunchOptions: {
      headless: false,
    },
  });

  try {
    await stagehand.init();

    // Get the browser page for navigation
    const page = stagehand.context.pages()[0];
    console.log('🌐 Navigating to application...');
    await page.goto('http://localhost:3000');
    await page.waitForLoadState('domcontentloaded');

    // Step 1: Verify login page loaded
    console.log('Step 1: Verifying login page...');
    const pageData = await stagehand.extract(
      "extract the page title",
      z.object({ title: z.string() })
    );
    console.log('Page title:', pageData.title);

    // Step 2: Fill login form
    console.log('Step 2: Entering credentials...');
    await stagehand.act("type 'user@test.com' into email field");
    await new Promise(resolve => setTimeout(resolve, 1000));
    await stagehand.act("type 'password' into password field");
    await new Promise(resolve => setTimeout(resolve, 1000));
    await stagehand.act("click the Login button");
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 3: Verify login success
    console.log('Step 3: Verifying login...');
    const user = await stagehand.extract(
      "extract the logged-in user information",
      z.object({
        email: z.string(),
        username: z.string(),
        isLoggedIn: z.boolean()
      })
    );
    console.log('Extracted user data:', user);

    // Validate login was successful
    if (!user.isLoggedIn || !user.email) {
      throw new Error(\`Login failed! Expected isLoggedIn=true, got: \${JSON.stringify(user)}\`);
    }

    console.log('✅ Login successful! User:', user);

  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  } finally {
    await stagehand.close();
  }
}

runTest().catch((error) => {
  console.error(error);
  process.exit(1);
});
\`\`\`

**VALIDATION EXAMPLE - Always Check Extracted Data:**

\`\`\`typescript
// ✅ CORRECT - Extract and validate
const loginStatus = await stagehand.extract(
  "check if user is logged in",
  z.object({
    isLoggedIn: z.boolean(),
    userEmail: z.string()
  })
);
console.log('Login status:', loginStatus);

// Validate before proceeding
if (!loginStatus.isLoggedIn) {
  throw new Error(\`Login failed! User not logged in. Got: \${JSON.stringify(loginStatus)}\`);
}

if (!loginStatus.userEmail || loginStatus.userEmail === '') {
  throw new Error(\`Login failed! No user email found. Got: \${JSON.stringify(loginStatus)}\`);
}

console.log('✅ Login validation passed!');

// ❌ WRONG - Extract without validation
const loginStatus = await stagehand.extract("check login", z.object({ isLoggedIn: z.boolean() }));
console.log('Login successful!'); // ❌ NO! You didn't check if isLoggedIn is true!
\`\`\`

**CRITICAL - Stagehand v3 API Usage:**
- AI actions called DIRECTLY on stagehand:
  - stagehand.act(), stagehand.extract(), stagehand.observe()
- Navigation/waits use page from context:
  - const page = stagehand.context.pages()[0]
  - page.goto(), page.waitForTimeout(), page.waitForLoadState()
- **Config:** Use localBrowserLaunchOptions: { headless: boolean }, NOT debugDom
\`\`\`

**WRONG Example (DO NOT DO THIS):**

\`\`\`typescript
// ❌ Missing imports
// ❌ Wrong API usage
// ❌ Wrong config options
// ❌ Missing error handling

const stagehand = new Stagehand({
  debugDom: true  // ❌ doesn't exist in v3, use localBrowserLaunchOptions
});

const page = await stagehand.page();  // ❌ page() method doesn't exist
await page.act("click button");  // ❌ act() is on stagehand, not page

await stagehand.extract({  // ❌ wrong signature
  instruction: "get data",
  schema: z.object({...})
});

// ❌ WRONG - Doesn't exit with error code on failure
runTest().catch(console.error);  // ❌ Script exits with code 0 even on error!

// ✅ CORRECT - Exit with code 1 on failure
runTest().catch((error) => {
  console.error(error);
  process.exit(1);
});
\`\`\`

Generate a complete, runnable TypeScript file. It MUST include imports, initialization, proper error handling, and cleanup.`
  );
}

/**
 * Build generation prompt with test requirements
 */
function buildGenerationPrompt(prompt: string, context?: TestContext): string {
  let fullPrompt = `Generate a browser test script using Stagehand primitives (act, extract, observe).

Test requirement: ${prompt}`;

  if (context) {
    fullPrompt += `

Ticket context:
- ID: ${context.ticketId}
- Title: ${context.ticketTitle}
- Description: ${context.ticketDescription}`;
  }

  fullPrompt += `

Requirements:
1. Generate a COMPLETE script with imports, initialization, and cleanup
2. Initialize Stagehand with env: 'LOCAL', verbose, and localBrowserLaunchOptions (NO debugDom)
3. After stagehand.init(), get browser page with: const page = stagehand.context.pages()[0];
4. Navigate to the application URL with await page.goto(url) and await page.waitForLoadState('domcontentloaded')
5. Use await new Promise(resolve => setTimeout(resolve, ms)) for delays (prefer explicit delays over networkidle waits)
6. Use await stagehand.act("instruction string") for all user interactions
7. Use await stagehand.extract("instruction", z.object({...})) for data validation
8. **CRITICAL**: After EVERY extract() call, add validation logic with if statements
   - Check boolean flags are true when expected (e.g., isLoggedIn, formVisible)
   - Verify required fields are not empty strings
   - Throw descriptive errors with actual vs expected values
   - Example: if (!data.isLoggedIn) { throw new Error(\`Login failed! Got: \${JSON.stringify(data)}\`); }
9. Use await stagehand.observe("instruction string") for element verification when needed
10. Add console.log() statements to show test progress AND extracted data
11. Use descriptive variable names and step comments
12. Include proper error handling with try-catch-finally
13. In catch block: log error and re-throw it
14. Call stagehand.close() in finally block (always runs)
15. At end of script: runTest().catch((error) => { console.error(error); process.exit(1); })
16. Validate test success by extracting and checking final state with proper assertions

CRITICAL - Stagehand v3 API:
- Get browser page: const page = stagehand.context.pages()[0];
- AI actions: stagehand.act(), stagehand.extract(), stagehand.observe() (called directly on stagehand)
- Navigation/waits: Use page from stagehand.context.pages()[0]
- extract() signature: extract(instruction: string, schema: ZodSchema) - TWO parameters, NOT an object
- act() and observe() take a STRING directly: stagehand.act("click button")

Output ONLY the executable TypeScript code inside a code block. No explanations.`;

  return fullPrompt;
}

/**
 * Parse generated script from Claude response and inject config
 */
function parseGeneratedScript(response: string, config: ScriptConfig): GranularTestScript {
  // Extract code from markdown code blocks
  const codeBlockRegex = /```(?:typescript|ts)?\n([\s\S]*?)```/;
  const match = response.match(codeBlockRegex);

  let fullCode = match ? match[1].trim() : response.trim();

  // Remove any remaining backticks or markdown artifacts
  fullCode = fullCode.replace(/^```[\w]*\n?/gm, '').replace(/\n?```$/gm, '');

  // Remove common unwanted patterns
  fullCode = cleanGeneratedCode(fullCode);

  // Inject config into Stagehand initialization
  fullCode = injectConfig(fullCode, config);

  // Parse individual steps from the code
  const steps = extractSteps(fullCode);

  return {
    steps,
    fullCode,
  };
}

/**
 * Inject configuration into generated script
 */
function injectConfig(code: string, config: ScriptConfig): string {
  // Replace Stagehand initialization with our config
  let injected = code.replace(
    /new Stagehand\(\{[\s\S]*?\}\)/,
    `new Stagehand({
    env: 'LOCAL',
    verbose: ${config.verbose ? 2 : 1},
    localBrowserLaunchOptions: {
      headless: ${config.headless},
    },
  })`
  );

  // Replace page.goto() URL with our config URL
  injected = injected.replace(/page\.goto\(['"`][^'"`]+['"`]\)/, `page.goto('${config.url}')`);

  return injected;
}

/**
 * Clean generated code - minimal cleanup since we want complete scripts now
 */
function cleanGeneratedCode(code: string): string {
  let cleaned = code;

  // Only clean up excessive blank lines (more than 2 in a row)
  cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n');

  // Trim leading/trailing whitespace
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Extract individual test steps from generated code
 */
function extractSteps(code: string): GranularTestStep[] {
  const steps: GranularTestStep[] = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Match act() calls
    if (line.includes('.act(')) {
      const actionMatch = line.match(/action:\s*["']([^"']+)["']/);
      steps.push({
        type: 'act',
        description: actionMatch ? actionMatch[1] : 'Browser action',
        code: line,
      });
    }
    // Match extract() calls
    else if (line.includes('.extract(')) {
      const instructionMatch = line.match(/instruction:\s*["']([^"']+)["']/);
      steps.push({
        type: 'extract',
        description: instructionMatch ? instructionMatch[1] : 'Extract data',
        code: line,
      });
    }
    // Match observe() calls
    else if (line.includes('.observe(')) {
      const instructionMatch = line.match(/instruction:\s*["']([^"']+)["']/);
      steps.push({
        type: 'observe',
        description: instructionMatch ? instructionMatch[1] : 'Observe element',
        code: line,
      });
    }
  }

  return steps;
}

/**
 * Save test script to .tmp/test-scripts/ directory
 */
export function saveTestScript(script: GranularTestScript, testId: string): string {
  const dir = join(process.cwd(), '.tmp', 'test-scripts');
  mkdirSync(dir, { recursive: true });

  const timestamp = Date.now();
  const filename = `${testId}-${timestamp}.ts`;
  const filepath = join(dir, filename);

  // Create standalone, runnable script
  const scriptWithHeader = `/**
 * Generated Test Script
 *
 * Test ID: ${testId}
 * Generated at: ${new Date().toISOString()}
 * Steps: ${script.steps.length}
 *
 * This is a complete, standalone script that can be run directly:
 *
 *   tsx ${filename}
 *
 * Or executed programmatically by importing runTest().
 */

${script.fullCode}
`;

  writeFileSync(filepath, scriptWithHeader, 'utf-8');
  console.log(`💾 Script saved: ${filepath}\n`);

  return filepath;
}
