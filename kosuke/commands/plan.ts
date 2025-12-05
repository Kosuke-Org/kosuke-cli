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

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';
import type { PlanOptions, Ticket } from '../types.js';
import { formatCostBreakdown, runAgent } from '../utils/claude-agent.js';
import { askQuestion } from '../utils/interactive-input.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';
import { processAndWriteTickets } from '../utils/tickets-manager.js';

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
  success: boolean;
  ticketsFile: string | null;
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  cost: number;
  sessionId?: string; // Session ID for resuming later
  error?: string;
}

function createPlanMcpServer(ticketsPath: string, cwd: string) {
  return createSdkMcpServer({
    name: 'kosuke-plan',
    version: '1.0.0',
    tools: [
      tool(
        'write_tickets',
        'Create tickets.json file with implementation tickets. Use this when all clarification questions have been answered and you have enough information to create actionable tickets.',
        {
          tickets: z
            .array(
              z.object({
                id: z
                  .string()
                  .describe(
                    'Ticket ID with prefix: PLAN-SCHEMA- for database, PLAN-ENGINE- for Python microservice, PLAN-BACKEND- for API, PLAN-FRONTEND- for UI, PLAN-WEB-TEST- for E2E tests'
                  ),
                title: z.string().describe('Short descriptive title'),
                description: z
                  .string()
                  .describe(
                    'Detailed description with acceptance criteria, implementation notes, and technical requirements based on codebase analysis'
                  ),
                type: z
                  .enum(['schema', 'engine', 'backend', 'frontend', 'test'])
                  .describe(
                    'Ticket type: schema (database), engine (Python microservice), backend (API), frontend (UI), test (E2E)'
                  ),
                estimatedEffort: z.number().describe('Effort estimate 1-10'),
                category: z
                  .string()
                  .optional()
                  .describe('Feature category (e.g., auth, billing, tasks, ui)'),
              })
            )
            .describe('Array of tickets to create'),
        },
        async (args) => {
          try {
            // Transform to full Ticket objects
            const tickets: Ticket[] = args.tickets.map((t) => ({
              id: t.id,
              title: t.title,
              description: t.description,
              type: t.type,
              estimatedEffort: t.estimatedEffort,
              status: 'Todo' as const,
              category: t.category,
            }));

            // Validate and write tickets IMMEDIATELY
            console.log(`\n✅ Generated ${tickets.length} ticket(s)`);
            const { tickets: validatedTickets } = await processAndWriteTickets(
              tickets,
              ticketsPath,
              cwd,
              { displaySummary: true }
            );

            // Get relative path for cleaner output
            const relativeTicketsPath = ticketsPath.replace(cwd + '/', '');

            return {
              content: [
                {
                  type: 'text',
                  text: `✅ Successfully saved ${validatedTickets.length} tickets to ${relativeTicketsPath}. Your job is complete.`,
                },
              ],
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error(`\n❌ Failed to create tickets: ${errorMessage}`);
            return {
              content: [
                {
                  type: 'text',
                  text: `Error: ${errorMessage}`,
                },
              ],
              isError: true,
            };
          }
        }
      ),
    ],
  });
}

/**
 * Session state for interactive mode
 */
interface PlanSession {
  prompt: string;
  sessionId?: string; // Track session ID for multi-turn conversation
}

/**
 * Build system prompt for plan command
 * @param noTest - If true, exclude WEB-TEST tickets from generation
 */
function buildPlanSystemPrompt(noTest: boolean = false): string {
  return `You are Kosuke Planning Assistant - Your job is to create implementation tickets, NOT to implement features.

**YOUR WORKFLOW (3 STEPS):**

**STEP 1: Explore Codebase (MANDATORY - ALWAYS DO THIS FIRST)**
⚠️ You MUST explore the codebase BEFORE asking clarification questions
- Use glob_file_search to find relevant files (pages, components, APIs)
- Use read_file to understand existing patterns and conventions
- Use grep/codebase_search to find related implementations
- This helps you ask INFORMED questions and generate ACCURATE tickets

**STEP 2: Ask Clarification Questions (MANDATORY)**
⚠️  You MUST ask clarification questions BEFORE creating tickets - DO NOT SKIP THIS STEP

**Question Rules:**
- Ask ONLY about: user experience, business logic, data display, behavior, scope
- NEVER ask about: technical implementation, libraries, architecture, database, APIs, UI placement, styling
- YOU decide all technical details - users decide business requirements

**Good Questions (User Experience & Business Logic):**
✅ "Should the report show all data or only filtered data?"
✅ "What happens if there are no results?"
✅ "Should this be per-user or per-organization?"
✅ "What information should be included?"

**Bad Questions (Technical - Never Ask These):**
❌ "Should we use library X or Y?"
❌ "Should this be client-side or server-side?"
❌ "Where should the button be placed?"
❌ "Should we cache this?"
❌ "What file format (landscape/portrait)?"

**Output Format (use exactly):**

---
## Understanding Your Request

[2-3 sentences summarizing what you understood]

## Clarification Questions

1. **[Topic - e.g., "Data Scope"]**
   - Question: [Non-technical user question]
   - 💡 Recommendation: [Simple default choice]

2. **[Topic - e.g., "Empty States"]**
   - Question: [Non-technical user question]
   - 💡 Recommendation: [Simple default choice]

(Add as many questions as needed - all must be non-technical)

**Quick Option:** Reply "go with recommendations" to accept all defaults.
---

**STEP 3: Create Tickets (Only After User Responds)**
⚠️  **CRITICAL: Call write_tickets ONCE, then STOP IMMEDIATELY**

- Wait for user to answer your questions
- Call write_tickets tool ONE TIME with all tickets in the array
- After the tool returns success, STOP - do not call ANY other tools
- DO NOT write explanations or summaries after write_tickets
- The tool response is your final output

**Ticket Types & Prefixes:**
- \`PLAN-SCHEMA-N\`: Database schema changes (Drizzle ORM migrations)
- \`PLAN-ENGINE-N\`: Python microservice (FastAPI endpoints)
- \`PLAN-BACKEND-N\`: API/server-side logic (tRPC, server actions)
- \`PLAN-FRONTEND-N\`: UI components and pages (React, Next.js)

**When to use ENGINE vs BACKEND:**
- **Use BACKEND (Next.js)** for: CRUD operations, auth logic, business rules, anything TypeScript handles well (90% of features)
- **Use ENGINE (Python)** for: ML/AI, data science (numpy/pandas), complex algorithms, PDF/document parsing, image processing, or when Python libraries are required${
    noTest
      ? ''
      : `
- \`PLAN-WEB-TEST-N\`: E2E tests (Playwright, browser testing)`
  }

**Ticket Order (build system processes in this order):**
1. PLAN-SCHEMA tickets first (database changes)
2. PLAN-ENGINE tickets (Python microservice - so backend can call it)
3. PLAN-BACKEND tickets (API layer)
4. PLAN-FRONTEND tickets (UI layer)${
    noTest
      ? ''
      : `
5. PLAN-WEB-TEST tickets last (validate everything works)

**WEB TEST TICKETS - Playwright MCP E2E Tests:**

Web test tickets are executed by Playwright MCP with Claude AI. Follow these guidelines:

**Test User Discovery:**
- Read seed files (lib/db/seed.ts or src/lib/db/seed.ts) to find test users
- Pattern: Any email ending with "+kosuke_test@example.com" uses OTP code "424242"
- Example: john+kosuke_test@example.com → OTP: 424242

**Each Web Test Ticket MUST Include:**
1. **Test User Credentials** (at the top)
   - Email addresses of test users
   - OTP code: 424242
   - User roles if applicable

2. **Test Steps** (numbered, detailed natural language)
   - Navigation: "Navigate to /sign-in"
   - Interactions: "Click button labeled 'New Task'"
   - Inputs: "Enter 'Test Task' in title field"
   - Expected outcomes: "Expected: Task appears in list"
   - Use CLEAR element descriptions (button text, labels)

3. **Acceptance Criteria**
   - Final expected state
   - Data validation points

**Authentication Steps Template:**
1. Navigate to /sign-in
2. Enter email: {test_user}+kosuke_test@example.com
3. Click "Send Code" button
4. Enter OTP: 424242
5. Click "Verify" button
6. Expected: Redirected to main app`
  }

**Ticket Generation Rules:**
- Generate only the tickets actually needed
- Ensure tickets are atomic and independently implementable
- Include clear acceptance criteria in each ticket description

**HOW TO OUTPUT TICKETS (CRITICAL - READ CAREFULLY):**
⚠️  Once user responds, call write_tickets ONCE with all tickets
⚠️  After calling write_tickets, STOP IMMEDIATELY - do NOT call ANY other tools
⚠️  DO NOT call: Task, ExitPlanMode, Subagent - these are BLOCKED
⚠️  DO NOT write summaries or explanations after write_tickets - the tool output is final
⚠️  The system automatically validates, saves to tickets/{timestamp}.tickets.json, and displays results

**CRITICAL:** write_tickets is your LAST action. Once called, you are DONE. No other tool calls allowed.

**Example Tickets (Full JSON):**
[
  {
    "id": "PLAN-SCHEMA-1",
    "title": "Create tasks schema",
    "description": "Create database schema for tasks feature:\\n- Create taskStatusEnum: 'todo', 'in_progress', 'done'\\n- Create tasks table with userId foreign key\\n- Export inferred types\\n\\n**Acceptance Criteria:**\\n- Tasks table created\\n- Enums defined at database level\\n- Migrations generated\\n\\n**Technical Notes:**\\n- Follow existing schema patterns in lib/db/schema/\\n- Use Drizzle ORM conventions",
    "type": "schema",
    "estimatedEffort": 4,
    "category": "tasks"
  },
  {
    "id": "PLAN-BACKEND-1",
    "title": "Create tasks tRPC router",
    "description": "Create backend API for tasks:\\n- Create lib/trpc/routers/tasks.ts\\n- Implement CRUD operations (list, create, update, delete)\\n- Server-side filtering by status\\n\\n**Acceptance Criteria:**\\n- All CRUD operations work\\n- Authorization enforced\\n- Type-safe implementation",
    "type": "backend",
    "estimatedEffort": 5,
    "category": "tasks"
  },
  {
    "id": "PLAN-FRONTEND-1",
    "title": "Create tasks page with list and filters",
    "description": "Create tasks management UI:\\n- Create app/(logged-in)/tasks/page.tsx\\n- Task list with status filters\\n- Add new task dialog\\n- Edit/delete actions\\n\\n**Acceptance Criteria:**\\n- Task list displays correctly\\n- Filters work\\n- CRUD operations functional\\n- Responsive design\\n\\n**Technical Notes:**\\n- Use existing UI components from components/ui/\\n- Follow page patterns from existing routes",
    "type": "frontend",
    "estimatedEffort": 6,
    "category": "tasks"
  },
  {
    "id": "PLAN-WEB-TEST-1",
    "title": "E2E: User creates and manages tasks",
    "description": "**Test User Credentials:**\\n- Email: john+kosuke_test@example.com\\n- OTP Code: 424242\\n\\n**Test Steps:**\\n\\n1. **Sign in**\\n   - Navigate to /sign-in\\n   - Enter email: john+kosuke_test@example.com\\n   - Click 'Send Code' button\\n   - Enter OTP: 424242\\n   - Click 'Verify'\\n   - Expected: Redirected to /tasks\\n\\n2. **Create task**\\n   - Click 'New Task' button\\n   - Enter title: 'Test Task'\\n   - Click 'Create'\\n   - Expected: Task appears in list\\n\\n3. **Delete task**\\n   - Click delete button on task\\n   - Confirm deletion\\n   - Expected: Task removed\\n\\n**Acceptance Criteria:**\\n- User authenticates successfully\\n- Task CRUD operations work\\n- UI provides feedback",
    "type": "test",
    "estimatedEffort": 4,
    "category": "tasks"
  }
]`;
}

/**
 * Interactive planning session
 */
async function interactivePlanSession(
  initialPrompt: string,
  cwd: string,
  ticketsPath: string,
  logContext?: ReturnType<typeof logger.createContext>,
  noTest: boolean = false,
  resumeSessionId?: string
): Promise<{
  ticketsPath: string | null;
  tokensUsed: { input: number; output: number; cacheCreation: number; cacheRead: number };
  cost: number;
  sessionId?: string;
}> {
  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                    Kosuke Plan - AI-Driven Ticket Planning                   ║
╚══════════════════════════════════════════════════════════════════════════════╝
  `);

  console.log(
    '💡 This tool will help you create implementation tickets from your feature/bug description.\n'
  );
  console.log('🤖 Claude will explore your codebase to understand patterns and conventions.\n');

  const systemPrompt = buildPlanSystemPrompt(noTest);

  console.log('✨ Tip: Enter to submit, Ctrl+J for new lines.\n');

  // Set up Ctrl+C handler
  const handleSigInt = async () => {
    console.log('\n\n👋 Exiting planning session...\n');
    if (logContext) {
      await logger.complete(logContext, 'cancelled');
    }
    process.exit(0);
  };
  process.on('SIGINT', handleSigInt);

  // Setup custom MCP server
  const planMcpServer = createPlanMcpServer(ticketsPath, cwd);

  const session: PlanSession = {
    prompt: initialPrompt,
    sessionId: resumeSessionId,
  };

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCost = 0;
  let createdTicketsPath: string | null = null;

  try {
    let continueConversation = true;
    let currentPrompt = initialPrompt;

    while (continueConversation) {
      console.log('\n🤔 Claude is analyzing...\n');

      // Run agent with custom MCP server
      const result = await runAgent(currentPrompt, {
        systemPrompt,
        cwd,
        verbosity: 'verbose', // Show all output for interactive planning
        mcpServers: {
          'kosuke-plan': planMcpServer,
        },
        ...(session.sessionId && { resume: session.sessionId }),
      });

      // Store session ID for conversation continuity
      if (result.sessionId) {
        session.sessionId = result.sessionId;
      }

      // Track costs
      totalInputTokens += result.tokensUsed.input;
      totalOutputTokens += result.tokensUsed.output;
      totalCacheCreationTokens += result.tokensUsed.cacheCreation;
      totalCacheReadTokens += result.tokensUsed.cacheRead;
      totalCost += result.cost;

      // Display cost
      console.log('\n' + '─'.repeat(90));
      console.log(`💰 Cost: ${formatCostBreakdown(result)}`);
      console.log('─'.repeat(90) + '\n');

      // Check if tickets file was created (saved immediately in MCP tool handler)
      if (existsSync(ticketsPath)) {
        createdTicketsPath = ticketsPath;

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
        // Get relative path for cleaner output
        const relativeTicketsPath = ticketsPath.replace(cwd + '/', '');
        console.log('\n🎉 Planning complete!\n');
        console.log('💡 Next steps:');
        console.log('   - Review tickets: cat "' + ticketsPath + '"');
        console.log(
          '   - Build tickets: kosuke build --directory="' +
            cwd +
            '" --tickets="' +
            relativeTicketsPath +
            '"'
        );
        console.log('   - List all tickets: ls ' + join(cwd, 'tickets'));
        if (session.sessionId) {
          console.log(`\n💾 Session ID: ${session.sessionId}`);
        }
        continueConversation = false;
        break;
      }

      // Ask for user response
      console.log('💬 Your response (type "exit" to quit):\n');
      const userResponse = await askQuestion('You: ');

      if (!userResponse) {
        console.log('\n⚠️  Empty response. Please provide an answer or type "exit".');
        continue;
      }

      if (userResponse.toLowerCase() === 'exit') {
        console.log('\n👋 Exiting planning session.\n');
        if (session.sessionId) {
          console.log('💾 Session ID (to resume later):');
          console.log(`   ${session.sessionId}\n`);
          console.log(
            '   Resume with: kosuke plan --prompt="continue" --resume=' + session.sessionId + '\n'
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
        continueConversation = false;
        break;
      }

      // Set next prompt for conversation continuity
      currentPrompt = userResponse;
    }
  } catch (error) {
    console.error('\n❌ Error during planning:', error);
    throw error;
  } finally {
    process.removeListener('SIGINT', handleSigInt);
  }

  return {
    ticketsPath: createdTicketsPath,
    tokensUsed: {
      input: totalInputTokens,
      output: totalOutputTokens,
      cacheCreation: totalCacheCreationTokens,
      cacheRead: totalCacheReadTokens,
    },
    cost: totalCost,
    sessionId: session.sessionId,
  };
}

/**
 * Core plan function for programmatic use
 */
export async function planCore(options: PlanOptions): Promise<PlanResult> {
  const { prompt, directory, noTest = false } = options;

  // Validate directory
  const cwd = directory ? resolve(directory) : process.cwd();

  if (!existsSync(cwd)) {
    return {
      success: false,
      ticketsFile: null,
      tokensUsed: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      cost: 0,
      error: `Directory not found: ${cwd}`,
    };
  }

  const stats = statSync(cwd);
  if (!stats.isDirectory()) {
    return {
      success: false,
      ticketsFile: null,
      tokensUsed: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      cost: 0,
      error: `Path is not a directory: ${cwd}`,
    };
  }

  const ticketsPath = generateTicketsPath(cwd);

  try {
    const result = await interactivePlanSession(
      prompt,
      cwd,
      ticketsPath,
      undefined,
      noTest,
      options.resume
    );

    return {
      success: result.ticketsPath !== null,
      ticketsFile: result.ticketsPath,
      tokensUsed: result.tokensUsed,
      cost: result.cost,
      sessionId: result.sessionId,
    };
  } catch (error) {
    return {
      success: false,
      ticketsFile: null,
      tokensUsed: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      cost: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Main plan command
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

    console.log(`📁 Using project directory: ${cwd}\n`);

    const ticketsPath = generateTicketsPath(cwd);

    // Run interactive session
    const sessionData = await interactivePlanSession(
      options.prompt,
      cwd,
      ticketsPath,
      logContext,
      options.noTest ?? false,
      options.resume
    );

    // Track metrics
    logger.trackTokens(logContext, sessionData.tokensUsed);

    // Log successful execution
    await logger.complete(logContext, 'success');
    cleanupHandler();
  } catch (error) {
    console.error('\n❌ Plan command failed:', error);

    await logger.complete(logContext, 'error', error as Error);
    cleanupHandler();

    throw error;
  }
}
