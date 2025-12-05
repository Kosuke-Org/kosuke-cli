/**
 * Plan command - AI-driven ticket planning from feature/bug descriptions
 *
 * This command takes a prompt describing a feature or bug and an existing codebase,
 * asks clarification questions (non-technical, user-focused), and generates tickets.json
 * that can be processed by the build command.
 *
 * Features:
 * - Analyzes existing codebase to understand patterns
 * - Asks AI-generated clarification questions (non-technical)
 * - Auto-detects ticket types (SCHEMA-, BACKEND-, FRONTEND-, WEB-TEST-)
 * - Generates tickets.json compatible with build command
 *
 * Usage:
 *   kosuke plan --prompt="Add dark mode toggle" --directory=./my-project
 *   kosuke plan --prompt="Fix login timeout bug" --dir=./app
 *   kosuke plan --prompt="Add notes feature" --no-test  # Skip WEB-TEST tickets
 */

import { existsSync, mkdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import type { PlanOptions } from '../types.js';
import type { AgentConfig, ClaudeMessage } from '../utils/claude-agent.js';
import {
  calculateCost,
  formatCostBreakdown,
  runAgent,
  runAgentStream,
} from '../utils/claude-agent.js';
import { askQuestion } from '../utils/interactive-input.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';
import { parseTickets, sortTicketsByOrder, writeTicketsFile } from '../utils/tickets-manager.js';

/**
 * Generate timestamp-based tickets path in tickets/ folder
 * Creates the tickets/ folder if it doesn't exist
 */
function generateTicketsPath(cwd: string): string {
  const ticketsDir = join(cwd, 'tickets');

  // Create tickets folder if it doesn't exist
  if (!existsSync(ticketsDir)) {
    mkdirSync(ticketsDir, { recursive: true });
  }

  // Generate timestamp: YYYY-MM-DD-HH-mm-ss
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[T:]/g, '-')
    .replace(/\.\d{3}Z$/, '');

  return join(ticketsDir, `${timestamp}.tickets.json`);
}

/**
 * Result from programmatic plan execution
 */
export interface PlanResult {
  status: 'input_required' | 'success' | 'error';
  ticketsFile: string | null;
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  cost: number;
  sessionId?: string;
  message?: string; // Claude's response (clarification questions or final message)
  error?: string;
}

/**
 * Stream event from plan core stream
 */
export type PlanStreamEvent =
  | { type: 'message'; data: ClaudeMessage } // Claude SDK message
  | { type: 'done'; data: PlanResult }; // Final result

/**
 * Build system prompt for plan command
 *
 * Two-phase workflow:
 * - Phase 1: Ask clarification questions (non-technical, user-focused)
 * - Phase 2: Generate tickets via write_tickets tool
 *
 * @param noTest - If true, exclude WEB-TEST tickets from generation
 */
function buildPlanSystemPrompt(noTest: boolean = false): string {
  const testGuidelines = noTest
    ? ''
    : `

**E2E Test Tickets:**
- Find test users in seed files (\`lib/db/seed.ts\`)
- Pattern: \`*+kosuke_test@example.com\` → OTP: \`424242\`
- Required: Test credentials, numbered steps, clear element descriptions, acceptance criteria`;

  return `# ROLE: TICKET PLANNER (NOT IMPLEMENTER)

YOU ARE A PLANNER, NOT AN IMPLEMENTER.
YOU CREATE TICKETS. YOU DO NOT WRITE CODE. YOU DO NOT IMPLEMENT FEATURES.

## YOUR ONLY JOB

**Phase 1:** Ask clarification questions (non-technical, user-focused)
**Phase 2:** Output raw JSON tickets array (NO CODE, NO IMPLEMENTATION)

## ABSOLUTELY FORBIDDEN

❌ NEVER SAY:
- "Now I'll implement"
- "Let me create"
- "Let me build"
- "I'll update the files"
- "Let's start implementing"
- "Implementation Plan:"
- Any language that suggests you will write code

❌ NEVER DO:
- Write, edit, or create files
- Install packages
- Run commands
- Use Task tool for implementation
- Output implementation plans

✅ YOUR ONLY ACTIONS:
- Read files to understand codebase (Phase 1 ONLY)
- Ask business/UX questions (Phase 1)
- Output raw JSON tickets array (Phase 2 ONLY)

## Phase 1: Ask Clarification Questions

Explore codebase (Read/Grep/Glob), then ask **ONLY business/UX questions**.

**Example of GOOD questions:**
- "Should the report include all orders or only completed ones?"
- "What happens if there are no orders matching the filters?"
- "Should users with 'viewer' role be able to generate reports?"

**Example of BAD questions (FORBIDDEN):**
- "Should we use jsPDF or PDFKit for PDF generation?" ❌ (You decide based on codebase)
- "Should this be a tRPC endpoint or REST API?" ❌ (You decide based on existing patterns)
- "Should we generate PDFs client-side or server-side?" ❌ (You decide based on architecture)

**Your first response MUST use this exact format:**
\`\`\`
## Understanding Your Request
[Business summary - what the user wants, NOT how you'll implement it]

## Clarification Questions

1. **[Topic]**
   - Question: [Non-technical user question]
   - 💡 Recommendation: [Default choice]

2. **[Topic]**  
   - Question: [Non-technical user question]
   - 💡 Recommendation: [Default choice]

(Add as many questions as needed)

**Reply "go with recommendations" to proceed.**
\`\`\`

⚠️ **NEVER say**: "I'll implement", "Let me implement", "Now I'll build", "Let's start"
✅ **INSTEAD say**: "I'll create tickets for", "The tickets will include"

**ALLOWED QUESTIONS (User/Business Focus):**
- What data to show/hide
- Empty state behavior
- Error messages the user sees
- Permission rules (who can do what)
- User workflow and steps

**FORBIDDEN QUESTIONS (Technical Implementation):**
- Which library to use (jsPDF, PDFKit, Puppeteer)
- Backend vs client-side generation
- API design (REST, tRPC, GraphQL)
- File paths or code organization
- Database queries or ORM choice
- Component structure or styling approach
- Performance optimization techniques

**YOU decide all technical choices** based on the existing codebase.

## Phase 2: Generate Tickets (NOT IMPLEMENTATION)

⚠️ ⚠️ ⚠️ **CRITICAL: YOU ARE NOT IMPLEMENTING ANYTHING** ⚠️ ⚠️ ⚠️

**WHEN USER CONFIRMS/ANSWERS QUESTIONS:**

DO NOT say "Now I'll implement", "Let me create the files", "Implementation Plan:", or ANY implementation language.

DO NOT read more files. DO NOT use Task tool. DO NOT search for packages.

IMMEDIATELY output ONLY a valid JSON array of tickets. No markdown, no code blocks, no explanations, no plans.

**Required JSON Format:**
[
  {
    "id": "PLAN-BACKEND-1",
    "title": "Add PDF export endpoint to orders router",
    "description": "Create tRPC endpoint that generates PDF.\\n\\n**Acceptance Criteria:**\\n- Accepts filter parameters\\n- Returns PDF file\\n- Respects filters",
    "type": "backend",
    "estimatedEffort": 5,
    "status": "Todo",
    "category": "orders"
  },
  {
    "id": "PLAN-FRONTEND-1",
    "title": "Add PDF export button to orders table",
    "description": "Add button to toolbar.\\n\\n**Acceptance Criteria:**\\n- Button visible\\n- Downloads PDF\\n- Shows loading state",
    "type": "frontend",
    "estimatedEffort": 4,
    "status": "Todo",
    "category": "orders"
  }${
    noTest
      ? ''
      : `,
  {
    "id": "PLAN-WEB-TEST-1",
    "title": "E2E: Test PDF export with filters",
    "description": "**Test User:** john+kosuke_test@example.com (OTP: 424242)\\n\\n**Steps:**\\n1. Sign in\\n2. Apply filters\\n3. Click PDF export\\n4. Verify download\\n\\n**Acceptance Criteria:**\\n- PDF downloads\\n- Contains filtered data",
    "type": "test",
    "estimatedEffort": 3,
    "status": "Todo",
    "category": "orders"
  }`
  }
]

**CRITICAL - Exact Ticket ID Format (MUST MATCH):**
- PLAN-SCHEMA-1, PLAN-SCHEMA-2, ... → type: "schema"
- PLAN-ENGINE-1, PLAN-ENGINE-2, ... → type: "engine"
- PLAN-BACKEND-1, PLAN-BACKEND-2, ... → type: "backend"
- PLAN-FRONTEND-1, PLAN-FRONTEND-2, ... → type: "frontend"${noTest ? '' : '\n- PLAN-WEB-TEST-1, PLAN-WEB-TEST-2, ... → type: "test"'}

**Required Fields (every ticket):**
- id: Exact format above (NOT "PLAN-TEST-1", use "PLAN-WEB-TEST-1")
- title: Short descriptive title
- description: Details with **Acceptance Criteria:** section (use \\n for newlines)
- type: MUST be one of: "schema", "engine", "backend", "frontend"${noTest ? '' : ', "test"'}
- estimatedEffort: Integer from 1 to 10
- status: ALWAYS "Todo"
- category: Optional (e.g., "orders", "auth", "billing")

**Dependency order:** SCHEMA → ENGINE → BACKEND → FRONTEND${noTest ? '' : ' → WEB-TEST'}
${testGuidelines}

🚨 **WHEN USER SAYS "go with recommendations" OR ANSWERS YOUR QUESTIONS:**

YOU ARE NOW IN PHASE 2. EXPLORATION IS OVER.

DO NOT:
- Read more files
- Search for packages
- Say "Now I'll implement" or "Let me create"
- Use Task tool
- Show "Implementation Plan"
- Add any text before or after the JSON

IMMEDIATELY OUTPUT THE JSON ARRAY. Your ENTIRE response = JSON array starting with "[" and ending with "]".

❌ **WRONG RESPONSES TO "go with recommendations":**

\`\`\`
Perfect! Now I'll implement the PDF export feature.

## Implementation Plan:
1. Update schema...
2. Install packages...

Let me start:
📄 Reading package.json
\`\`\`

OR

\`\`\`
Great! I'll create the implementation tickets.

\\\`\\\`\\\`json
[...]
\\\`\\\`\\\`
\`\`\`

OR

\`\`\`
Now I'll update the files:
[...]
\`\`\`

✅ **CORRECT RESPONSE TO "go with recommendations":**

\`\`\`
[
  {
    "id": "PLAN-BACKEND-1",
    "title": "Add PDF export endpoint",
    "description": "...",
    "type": "backend",
    "estimatedEffort": 5,
    "status": "Todo",
    "category": "orders"
  }
]
\`\`\`

NO explanatory text. NO "Now I'll implement". NO markdown wrapping. JUST THE JSON ARRAY.`;
}
/**
 * Shared setup for plan agent configuration
 */
function createPlanAgentConfig(options: PlanOptions):
  | {
      config: AgentConfig;
      ticketsPath: string;
      cwd: string;
      prompt: string;
    }
  | { error: string } {
  const { prompt, directory, noTest = false, resume } = options;

  // Validate directory
  const cwd = directory ? resolve(directory) : process.cwd();

  if (!existsSync(cwd)) {
    return { error: `Directory not found: ${cwd}` };
  }

  const stats = statSync(cwd);
  if (!stats.isDirectory()) {
    return { error: `Path is not a directory: ${cwd}` };
  }

  const ticketsPath = generateTicketsPath(cwd);
  const systemPrompt = buildPlanSystemPrompt(noTest);

  const config: AgentConfig = {
    systemPrompt,
    cwd,
    maxTurns: 40, // Increased for complex planning sessions with multiple files to analyze
    verbosity: 'verbose',
    permissionMode: 'bypassPermissions',
    // Restrict to read-only tools only
    // Block all code editing, execution, task management, and agent control tools
    disallowedTools: [
      'Edit', // File editing
      'Write', // File creation
      'Delete', // File deletion
      'NotebookEdit', // Notebook editing
      'Bash', // Shell execution
      'Task', // Sub-agent spawning (prevents implementation subtasks)
      'TodoWrite', // Task management (implementation mode)
      'ExitPlanMode', // Mode transitions
    ],
    ...(resume && { resume }),
  };

  return { config, ticketsPath, cwd, prompt };
}

/**
 * Plan core stream for server (async generator, no logging)
 */
export async function* planCoreStream(
  options: PlanOptions
): AsyncGenerator<PlanStreamEvent, void, void> {
  const setup = createPlanAgentConfig(options);

  if ('error' in setup) {
    yield {
      type: 'done',
      data: {
        status: 'error',
        ticketsFile: null,
        tokensUsed: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        cost: 0,
        error: setup.error,
      },
    };
    return;
  }

  const { config, ticketsPath, prompt } = setup;

  try {
    const stream = runAgentStream(prompt, config);

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let sessionId: string | undefined;
    let fullResponse = '';

    // Yield raw Claude messages
    for await (const message of stream) {
      const claudeMessage = message as ClaudeMessage;
      yield { type: 'message', data: claudeMessage };

      // Track session ID
      if (claudeMessage.session_id) {
        sessionId = claudeMessage.session_id;
      }

      // Accumulate response text from assistant messages
      if (claudeMessage.type === 'assistant' && claudeMessage.message) {
        const msg = claudeMessage.message as {
          content?: Array<{ type: string; text?: string }>;
        };
        if (msg.content && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              fullResponse += block.text;
            }
          }
        }
      }

      // Track tokens
      if (
        claudeMessage.type === 'result' &&
        claudeMessage.subtype === 'success' &&
        claudeMessage.usage
      ) {
        const usage = claudeMessage.usage;
        inputTokens += usage.input_tokens || 0;
        outputTokens += usage.output_tokens || 0;
        cacheCreationTokens += usage.cache_creation_input_tokens || 0;
        cacheReadTokens += usage.cache_read_input_tokens || 0;
      }
    }

    const cost = calculateCost(inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens);

    // Try to parse tickets from response (Phase 2)
    try {
      let tickets = parseTickets(fullResponse);
      tickets = sortTicketsByOrder(tickets);
      writeTicketsFile(ticketsPath, tickets);

      yield {
        type: 'done',
        data: {
          status: 'success',
          ticketsFile: ticketsPath,
          tokensUsed: {
            input: inputTokens,
            output: outputTokens,
            cacheCreation: cacheCreationTokens,
            cacheRead: cacheReadTokens,
          },
          cost,
          sessionId,
        },
      };
    } catch (parseError) {
      const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);

      // Check if this is a parse/validation error or just Phase 1
      if (errorMsg.includes('No JSON array found')) {
        // This is Phase 1 (clarification questions)
        yield {
          type: 'done',
          data: {
            status: 'input_required',
            ticketsFile: null,
            tokensUsed: {
              input: inputTokens,
              output: outputTokens,
              cacheCreation: cacheCreationTokens,
              cacheRead: cacheReadTokens,
            },
            cost,
            sessionId,
          },
        };
      } else {
        // Actual validation error
        yield {
          type: 'done',
          data: {
            status: 'error',
            ticketsFile: null,
            tokensUsed: {
              input: inputTokens,
              output: outputTokens,
              cacheCreation: cacheCreationTokens,
              cacheRead: cacheReadTokens,
            },
            cost: 0,
            error: errorMsg,
          },
        };
      }
    }
  } catch (error) {
    yield {
      type: 'done',
      data: {
        status: 'error',
        ticketsFile: null,
        tokensUsed: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        cost: 0,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Plan interactive session for CLI (single turn with logging)
 */
async function planInteractiveSession(options: PlanOptions): Promise<PlanResult> {
  const setup = createPlanAgentConfig(options);

  if ('error' in setup) {
    return {
      status: 'error',
      ticketsFile: null,
      tokensUsed: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      cost: 0,
      error: setup.error,
    };
  }

  const { config, ticketsPath, prompt } = setup;

  try {
    console.log('\n🤔 Claude is analyzing...\n');

    // Run agent with logging
    const result = await runAgent(prompt, config);

    // Display cost
    console.log('\n' + '─'.repeat(90));
    console.log(`💰 Cost: ${formatCostBreakdown(result)}`);
    console.log('─'.repeat(90) + '\n');

    // Try to parse tickets from response (Phase 2)
    try {
      const tickets = parseTickets(result.response);

      // Validate ticket ID format matches type
      for (const ticket of tickets) {
        const idPrefix = ticket.id.split('-').slice(0, 2).join('-'); // PLAN-SCHEMA, PLAN-BACKEND, etc.
        const expectedPrefix = `PLAN-${ticket.type === 'test' ? 'WEB-TEST' : ticket.type.toUpperCase()}`;

        if (idPrefix !== expectedPrefix) {
          throw new Error(
            `Invalid ticket ID format: "${ticket.id}". Expected prefix "${expectedPrefix}" for type "${ticket.type}". ` +
              `Example: ${expectedPrefix}-1, ${expectedPrefix}-2, etc.`
          );
        }
      }

      // Successfully parsed and validated - write to file
      writeTicketsFile(ticketsPath, tickets);

      console.log(`\n✅ Successfully created ${tickets.length} tickets: ${ticketsPath}\n`);

      return {
        status: 'success',
        ticketsFile: ticketsPath,
        tokensUsed: result.tokensUsed,
        cost: result.cost,
        sessionId: result.sessionId,
        message: result.response,
      };
    } catch (parseError) {
      const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);

      // Check if this is a parse/validation error or just Phase 1
      if (errorMsg.includes('No JSON array found')) {
        // This is Phase 1 (clarification questions)
        return {
          status: 'input_required',
          ticketsFile: null,
          tokensUsed: result.tokensUsed,
          cost: result.cost,
          sessionId: result.sessionId,
          message: result.response,
        };
      }

      // Actual validation error - show it
      console.error(`\n❌ Ticket validation failed: ${errorMsg}\n`);
      return {
        status: 'error',
        ticketsFile: null,
        tokensUsed: result.tokensUsed,
        cost: result.cost,
        error: errorMsg,
      };
    }
  } catch (error) {
    return {
      status: 'error',
      ticketsFile: null,
      tokensUsed: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      cost: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Main plan command (interactive CLI wrapper)
 */
export async function planCommand(options: PlanOptions): Promise<void> {
  // Initialize logging
  const logContext = logger.createContext('plan', { noLogs: options.noLogs ?? false });
  const cleanupHandler = setupCancellationHandler(logContext);

  try {
    // Validate environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    // Validate prompt
    if (!options.prompt) {
      throw new Error(
        'Prompt is required. Use --prompt="Your feature or bug description"\n' +
          'Example: kosuke plan --prompt="Add dark mode toggle" --directory=./my-project'
      );
    }

    // Resolve directory
    const cwd = options.directory ? resolve(options.directory) : process.cwd();

    if (!existsSync(cwd)) {
      throw new Error(`Directory not found: ${cwd}`);
    }

    const stats = statSync(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${cwd}`);
    }

    console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                    Kosuke Plan - AI-Driven Ticket Planning                   ║
╚══════════════════════════════════════════════════════════════════════════════╝
  `);

    console.log(
      '💡 This tool will help you create implementation tickets from your feature/bug description.\n'
    );
    console.log('🤖 Claude will explore your codebase to understand patterns and conventions.\n');
    console.log('✨ Tip: Enter to submit, Ctrl+J for new lines.\n');

    console.log(`📁 Using project directory: ${cwd}\n`);

    // Set up Ctrl+C handler
    const handleSigInt = async () => {
      console.log('\n\n👋 Exiting planning session...\n');
      await logger.complete(logContext, 'cancelled');
      cleanupHandler();
      process.exit(0);
    };
    process.on('SIGINT', handleSigInt);

    let currentPrompt = options.prompt;
    let sessionId = options.resume;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCost = 0;

    try {
      // Interactive loop
      while (true) {
        const result = await planInteractiveSession({
          prompt: currentPrompt,
          directory: cwd,
          noTest: options.noTest,
          resume: sessionId,
        });

        // Track cumulative costs
        totalInputTokens += result.tokensUsed.input;
        totalOutputTokens += result.tokensUsed.output;
        totalCacheCreationTokens += result.tokensUsed.cacheCreation;
        totalCacheReadTokens += result.tokensUsed.cacheRead;
        totalCost += result.cost;

        sessionId = result.sessionId;

        if (result.status === 'success') {
          // Planning complete
          console.log('═'.repeat(90));
          console.log('📊 Total Session Cost:');
          console.log(
            `💰 ${formatCostBreakdown({
              tokensUsed: {
                input: totalInputTokens,
                output: totalOutputTokens,
                cacheCreation: totalCacheCreationTokens,
                cacheRead: totalCacheReadTokens,
              },
              cost: totalCost,
              response: '',
              fixCount: 0,
              filesReferenced: new Set(),
            })}`
          );
          console.log('═'.repeat(90));

          const relativeTicketsPath = result.ticketsFile!.replace(cwd + '/', '');
          console.log('\n🎉 Planning complete!\n');
          console.log('💡 Next steps:');
          console.log('   - Review tickets: cat "' + result.ticketsFile + '"');
          console.log(
            '   - Build tickets: kosuke build --directory="' +
              cwd +
              '" --tickets="' +
              relativeTicketsPath +
              '"'
          );
          console.log('   - List all tickets: ls ' + join(cwd, 'tickets'));
          if (sessionId) {
            console.log(`\n💾 Session ID: ${sessionId}`);
          }

          logger.trackTokens(logContext, {
            input: totalInputTokens,
            output: totalOutputTokens,
            cacheCreation: totalCacheCreationTokens,
            cacheRead: totalCacheReadTokens,
          });
          await logger.complete(logContext, 'success');
          break;
        } else if (result.status === 'input_required') {
          // Ask for user response
          console.log('💬 Your response (type "exit" to quit):\n');
          const userResponse = await askQuestion('You: ');

          if (!userResponse) {
            console.log('\n⚠️  Empty response. Please provide an answer or type "exit".');
            continue;
          }

          if (userResponse.toLowerCase() === 'exit') {
            console.log('\n👋 Exiting planning session.\n');
            if (sessionId) {
              console.log('💾 Session ID (to resume later):');
              console.log(`   ${sessionId}\n`);
              console.log(
                '   Resume with: kosuke plan --prompt="continue" --resume=' + sessionId + '\n'
              );
            }
            console.log('═'.repeat(90));
            console.log('📊 Session Cost:');
            console.log(
              `💰 ${formatCostBreakdown({
                tokensUsed: {
                  input: totalInputTokens,
                  output: totalOutputTokens,
                  cacheCreation: totalCacheCreationTokens,
                  cacheRead: totalCacheReadTokens,
                },
                cost: totalCost,
                response: '',
                fixCount: 0,
                filesReferenced: new Set(),
              })}`
            );
            console.log('═'.repeat(90) + '\n');
            await logger.complete(logContext, 'cancelled');
            break;
          }

          currentPrompt = userResponse;
        } else {
          // Error
          throw new Error(result.error || 'Unknown error during planning');
        }
      }
    } finally {
      process.removeListener('SIGINT', handleSigInt);
    }

    cleanupHandler();
  } catch (error) {
    console.error('\n❌ Plan command failed:', error);

    await logger.complete(logContext, 'error', error as Error);
    cleanupHandler();

    throw error;
  }
}
