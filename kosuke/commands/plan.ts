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

import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { glob } from 'glob';
import type { PlanOptions, Ticket } from '../types.js';
import { calculateCost } from '../utils/claude-agent.js';
import { askQuestion } from '../utils/interactive-input.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';
import { processAndWriteTickets, sortTicketsByOrder } from '../utils/ticket-writer.js';

/**
 * Result from programmatic plan execution
 */
export interface PlanResult {
  success: boolean;
  tickets: Ticket[];
  ticketsFile: string;
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  cost: number;
  error?: string;
}

/**
 * Session state for interactive mode
 */
interface PlanSession {
  prompt: string;
  messages: Anthropic.MessageParam[];
}

/**
 * Tool definitions for planning - includes file exploration and ticket generation
 */
const PLAN_TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description:
      'Read the contents of a file. Use this to explore the codebase and understand existing patterns, conventions, and implementations.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to read (relative to project root)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description:
      'List files and directories in a given path. Use this to explore the project structure.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the directory to list (relative to project root, use "." for root)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'glob_search',
    description:
      'Find files matching a glob pattern. Use this to find specific file types or locate files by name pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match (e.g., "**/*.ts", "lib/db/**/*.ts", "**/schema*.ts")',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'write_tickets',
    description:
      'Create tickets.json file with implementation tickets. Use this when all clarification questions have been answered and you have enough information to create actionable tickets.',
    input_schema: {
      type: 'object',
      properties: {
        tickets: {
          type: 'array',
          description: 'Array of tickets to create',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description:
                  'Ticket ID with prefix: PLAN-SCHEMA- for database, PLAN-BACKEND- for API, PLAN-FRONTEND- for UI, PLAN-WEB-TEST- for E2E tests',
              },
              title: {
                type: 'string',
                description: 'Short descriptive title',
              },
              description: {
                type: 'string',
                description:
                  'Detailed description with acceptance criteria, implementation notes, and technical requirements based on codebase analysis',
              },
              type: {
                type: 'string',
                enum: ['schema', 'backend', 'frontend', 'test'],
                description:
                  'Ticket type: schema (database), backend (API), frontend (UI), test (E2E)',
              },
              estimatedEffort: {
                type: 'number',
                description: 'Effort estimate 1-10',
              },
              category: {
                type: 'string',
                description: 'Feature category (e.g., auth, billing, tasks, ui)',
              },
            },
            required: ['id', 'title', 'description', 'type', 'estimatedEffort'],
          },
        },
      },
      required: ['tickets'],
    },
  },
];

/**
 * Read CLAUDE.md from project directory if it exists
 */
function readClaudeMd(cwd: string): string | null {
  const claudeMdPath = join(cwd, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    try {
      return readFileSync(claudeMdPath, 'utf-8');
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build system prompt for plan command
 * @param claudeMdContent - Content of CLAUDE.md file if it exists
 * @param noTest - If true, exclude WEB-TEST tickets from generation
 */
function buildPlanSystemPrompt(claudeMdContent: string | null, noTest: boolean = false): string {
  const claudeSection = claudeMdContent
    ? `

**PROJECT CONTEXT (from CLAUDE.md):**

${claudeMdContent}

---
`
    : '';

  return `You are an expert software architect helping plan implementation tickets for a feature or bug fix.

**YOUR PRIMARY OBJECTIVE:** Gather enough information through clarification questions to create actionable implementation tickets that can be processed by an automated build system.
${claudeSection}
**Your Workflow:**

1. **Explore Codebase**:
   - Use list_directory to explore relevant parts of the codebase
   - Read existing similar implementations to understand patterns
   - Analyze what the user wants to achieve
   - Identify what's unclear or needs user input

2. **Ask Clarification Questions**: Present questions in this format:

---
## Understanding Your Request

[Brief summary of what you understood]

## Clarification Questions

For each question, provide BOTH the question AND a recommended approach:

1. **[Topic]**
   - Question: [User-focused question - NOT technical]
   - 💡 Recommendation: [Simple, practical default choice]

2. **[Topic]**
   - Question: [User-focused question - NOT technical]
   - 💡 Recommendation: [Simple, practical default choice]

**Quick Option:** Reply "go with recommendations" to accept all defaults.
---

3. **Iterative Refinement**: As the user answers:
   - If user says "go with recommendations", accept all defaults
   - If user provides specific answers, incorporate them
   - Ask follow-up questions ONLY if critical information is still missing
   - Bias towards simplicity - this is an MVP

4. **Generate Tickets**: Once requirements are clear, use \`write_tickets\` tool to create tickets:

**Ticket Types & Prefixes:**
- \`PLAN-SCHEMA-N\`: Database schema changes (Drizzle ORM migrations)
- \`PLAN-BACKEND-N\`: API/server-side logic (tRPC, server actions)
- \`PLAN-FRONTEND-N\`: UI components and pages (React, Next.js)${
    noTest
      ? ''
      : `
- \`PLAN-WEB-TEST-N\`: E2E tests (Playwright, browser testing)`
  }

**Ticket Order (build system processes in this order):**
1. PLAN-SCHEMA tickets first (database changes)
2. PLAN-BACKEND tickets (API layer)
3. PLAN-FRONTEND tickets (UI layer)${
    noTest
      ? ''
      : `
4. PLAN-WEB-TEST tickets last (validate everything works)

**WEB TEST TICKETS - Stagehand Agent E2E Tests:**

Web test tickets are executed by Stagehand agent. Follow these guidelines:

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

**CRITICAL RULES:**
- Questions must be NON-TECHNICAL and USER-FOCUSED
- NO code paths, URLs, file names, or implementation details in questions
- NO technical jargon (API, schema, components, routes, etc.)
- Focus ONLY on user experience, behavior, and business logic

**BAD QUESTIONS (too technical):**
- "Should this be at /settings/invoices or /invoices?"
- "Should we use a boolean flag or enum?"
- "Should this be organization-level or user-level in the database?"

**GOOD QUESTIONS (user-focused):**
- "Should each user have their own invoices, or should invoices be shared per company/team?"
- "Should dark mode apply everywhere or let users choose per-page?"
- "Who should be able to see invoices - everyone or just admins?"

- YOU decide all technical implementation details based on codebase analysis
- Include technical details in ticket DESCRIPTIONS only (not questions)
- Generate only the tickets actually needed
- Ensure tickets are atomic and independently implementable
- Include clear acceptance criteria in each ticket description

**Example Questions (USER-FOCUSED):**
- "Should users be able to share tasks with others, or is this for personal use only?"
- "Do you need email notifications when tasks are due?"
- "Should completed tasks be archived or permanently deleted?"
- "Who should be able to see this - everyone or just certain people?"

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
 * Execute read_file tool
 */
function executeReadFile(
  toolInput: Record<string, unknown>,
  cwd: string
): { success: boolean; content: string } {
  try {
    const filePath = toolInput.path as string;
    const fullPath = join(cwd, filePath);

    if (!existsSync(fullPath)) {
      return { success: false, content: `File not found: ${filePath}` };
    }

    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      return { success: false, content: `Path is a directory, not a file: ${filePath}` };
    }

    const content = readFileSync(fullPath, 'utf-8');

    console.log(`\n   📖 Reading: ${filePath}`);
    return { success: true, content };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, content: `Error reading file: ${msg}` };
  }
}

/**
 * Execute list_directory tool
 */
function executeListDirectory(
  toolInput: Record<string, unknown>,
  cwd: string
): { success: boolean; content: string } {
  try {
    const dirPath = (toolInput.path as string) || '.';
    const fullPath = join(cwd, dirPath);

    if (!existsSync(fullPath)) {
      return { success: false, content: `Directory not found: ${dirPath}` };
    }

    const stats = statSync(fullPath);
    if (!stats.isDirectory()) {
      return { success: false, content: `Path is not a directory: ${dirPath}` };
    }

    const entries = readdirSync(fullPath);
    const items: string[] = [];

    // Filter out common ignored directories
    const ignoreDirs = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.tmp'];

    for (const entry of entries.sort()) {
      if (entry.startsWith('.') && entry !== '.env.example') continue;
      if (ignoreDirs.includes(entry)) continue;

      const entryPath = join(fullPath, entry);
      try {
        const entryStat = statSync(entryPath);
        if (entryStat.isDirectory()) {
          items.push(`📁 ${entry}/`);
        } else {
          items.push(`📄 ${entry}`);
        }
      } catch {
        items.push(`❓ ${entry}`);
      }
    }

    console.log(`\n   📂 Listing: ${dirPath}`);
    return { success: true, content: items.join('\n') || '(empty directory)' };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, content: `Error listing directory: ${msg}` };
  }
}

/**
 * Execute glob_search tool
 */
async function executeGlobSearch(
  toolInput: Record<string, unknown>,
  cwd: string
): Promise<{ success: boolean; content: string }> {
  try {
    const pattern = toolInput.pattern as string;

    const files = await glob(pattern, {
      cwd,
      nodir: true,
      ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**', '.next/**', '__pycache__/**'],
    });

    if (files.length === 0) {
      return { success: true, content: `No files found matching: ${pattern}` };
    }

    // Limit results
    const maxResults = 50;
    const truncated = files.length > maxResults;
    const displayFiles = files.slice(0, maxResults);

    console.log(`\n   🔍 Found ${files.length} file(s) matching: ${pattern}`);

    let content = displayFiles.join('\n');
    if (truncated) {
      content += `\n\n...[showing ${maxResults} of ${files.length} files]`;
    }

    return { success: true, content };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, content: `Error searching files: ${msg}` };
  }
}

/**
 * Execute write_tickets tool
 * Returns parsed tickets for later validation - does NOT write to file
 */
function executeWriteTickets(toolInput: Record<string, unknown>): {
  success: boolean;
  message: string;
  tickets: Ticket[];
} {
  try {
    const inputTickets = toolInput.tickets as Array<{
      id: string;
      title: string;
      description: string;
      type: 'schema' | 'backend' | 'frontend' | 'test';
      estimatedEffort: number;
      category?: string;
    }>;

    // Transform to full Ticket objects
    const tickets: Ticket[] = inputTickets.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      type: t.type,
      estimatedEffort: t.estimatedEffort,
      status: 'Todo' as const,
      category: t.category,
    }));

    // Sort tickets by processing order (using shared utility)
    const sortedTickets = sortTicketsByOrder(tickets);

    console.log(`\n📋 Generated ${sortedTickets.length} ticket(s) - validating...`);

    return {
      success: true,
      message: `Generated ${sortedTickets.length} tickets - will validate and save after confirmation`,
      tickets: sortedTickets,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`\n❌ Failed to parse tickets: ${errorMessage}`);
    return {
      success: false,
      message: `Error: ${errorMessage}`,
      tickets: [],
    };
  }
}

/**
 * Format token usage for display
 */
function formatTokenUsage(
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  cost: number
): string {
  const breakdown = [];
  if (inputTokens > 0) breakdown.push(`${inputTokens.toLocaleString()} input`);
  if (outputTokens > 0) breakdown.push(`${outputTokens.toLocaleString()} output`);
  if (cacheCreationTokens > 0)
    breakdown.push(`${cacheCreationTokens.toLocaleString()} cache write`);
  if (cacheReadTokens > 0) breakdown.push(`${cacheReadTokens.toLocaleString()} cache read`);

  return `💰 Cost: $${cost.toFixed(4)} (${breakdown.join(' + ')} tokens)`;
}

/**
 * Process a single Claude interaction with streaming
 * Handles multiple tool calls in a loop until Claude stops calling tools
 */
async function processClaudeInteraction(
  messages: Anthropic.MessageParam[],
  systemPrompt: string,
  cwd: string
): Promise<{
  response: string;
  messages: Anthropic.MessageParam[];
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  tickets: Ticket[];
  ticketsCreated: boolean;
}> {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  let responseText = '';
  let tickets: Ticket[] = [];
  let ticketsCreated = false;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let isFirstOutput = true;

  // Loop until Claude stops calling tools
  const maxIterations = 20; // Safety limit
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    // Stream the response
    const stream = await anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8096,
      system: systemPrompt,
      tools: PLAN_TOOLS,
      messages,
    });

    let currentText = '';
    const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    // Process stream events
    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'text') {
          if (isFirstOutput) {
            process.stdout.write('\n> Claude:\n');
            isFirstOutput = false;
          }
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          const delta = event.delta.text;
          currentText += delta;
          process.stdout.write(delta);
        }
      }
    }

    responseText += currentText;

    // Get final message
    const finalMessage = await stream.finalMessage();

    // Track token usage
    const usage = finalMessage.usage as unknown as {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    totalInputTokens += usage.input_tokens;
    totalOutputTokens += usage.output_tokens;
    totalCacheCreationTokens += usage.cache_creation_input_tokens || 0;
    totalCacheReadTokens += usage.cache_read_input_tokens || 0;

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

    // If no tools called, we're done
    if (toolUses.length === 0) {
      messages = [...messages, { role: 'assistant', content: finalMessage.content }];
      break;
    }

    // Execute tools
    messages = [...messages, { role: 'assistant', content: finalMessage.content }];
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const tool of toolUses) {
      if (tool.name === 'read_file') {
        const result = executeReadFile(tool.input, cwd);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: result.content,
        });
      } else if (tool.name === 'list_directory') {
        const result = executeListDirectory(tool.input, cwd);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: result.content,
        });
      } else if (tool.name === 'glob_search') {
        const result = await executeGlobSearch(tool.input, cwd);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: result.content,
        });
      } else if (tool.name === 'write_tickets') {
        const result = executeWriteTickets(tool.input);
        tickets = result.tickets;
        ticketsCreated = result.success;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: result.message,
        });
      }
    }

    messages = [...messages, { role: 'user', content: toolResults }];

    // If tickets were created, get final response and stop
    if (ticketsCreated) {
      const followupStream = await anthropic.messages.stream({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8096,
        system: systemPrompt,
        tools: PLAN_TOOLS,
        messages,
      });

      let followupText = '';
      for await (const event of followupStream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            const delta = event.delta.text;
            followupText += delta;
            process.stdout.write(delta);
          }
        }
      }

      const followupMessage = await followupStream.finalMessage();
      responseText += '\n' + followupText;
      messages = [...messages, { role: 'assistant', content: followupMessage.content }];

      // Add followup token usage
      const followupUsage = followupMessage.usage as unknown as {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      totalInputTokens += followupUsage.input_tokens;
      totalOutputTokens += followupUsage.output_tokens;
      totalCacheCreationTokens += followupUsage.cache_creation_input_tokens || 0;
      totalCacheReadTokens += followupUsage.cache_read_input_tokens || 0;

      break;
    }
  }

  return {
    response: responseText,
    messages,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    cacheReadTokens: totalCacheReadTokens,
    tickets,
    ticketsCreated,
  };
}

/**
 * Interactive planning session
 */
async function interactivePlanSession(
  initialPrompt: string,
  cwd: string,
  ticketsPath: string,
  logContext?: ReturnType<typeof logger.createContext>,
  noTest: boolean = false
): Promise<{
  messages: Anthropic.MessageParam[];
  tickets: Ticket[];
  tokensUsed: { input: number; output: number; cacheCreation: number; cacheRead: number };
  cost: number;
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

  // Read CLAUDE.md and inject into system prompt
  const claudeMdContent = readClaudeMd(cwd);
  if (claudeMdContent) {
    console.log(`📖 Loaded CLAUDE.md (${Math.round(claudeMdContent.length / 1000)}k chars)\n`);
  }

  const systemPrompt = buildPlanSystemPrompt(claudeMdContent, noTest);

  console.log(`${'─'.repeat(60)}`);
  console.log('🤖 Using model: claude-sonnet-4-5');
  console.log(`${'─'.repeat(60)}\n`);

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

  const session: PlanSession = {
    prompt: initialPrompt,
    messages: [],
  };

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCost = 0;
  let finalTickets: Ticket[] = [];

  try {
    // Start with initial prompt
    session.messages.push({ role: 'user', content: initialPrompt });

    let continueConversation = true;

    while (continueConversation) {
      console.log('\n🤔 Claude is analyzing...\n');

      const result = await processClaudeInteraction(session.messages, systemPrompt, cwd);

      session.messages = result.messages;

      // Track costs
      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      totalCacheCreationTokens += result.cacheCreationTokens;
      totalCacheReadTokens += result.cacheReadTokens;
      const batchCost = calculateCost(
        result.inputTokens,
        result.outputTokens,
        result.cacheCreationTokens,
        result.cacheReadTokens
      );
      totalCost += batchCost;

      // Display cost
      console.log('\n' + '─'.repeat(90));
      console.log(
        formatTokenUsage(
          result.inputTokens,
          result.outputTokens,
          result.cacheCreationTokens,
          result.cacheReadTokens,
          batchCost
        )
      );
      console.log('─'.repeat(90) + '\n');

      // Check if tickets were created
      if (result.ticketsCreated) {
        // Validate and write tickets using shared utility
        const { tickets: validatedTickets } = await processAndWriteTickets(
          result.tickets,
          ticketsPath,
          cwd,
          { displaySummary: true }
        );
        finalTickets = validatedTickets;

        console.log('═'.repeat(90));
        console.log('📊 Total Session Cost:');
        console.log(
          formatTokenUsage(
            totalInputTokens,
            totalOutputTokens,
            totalCacheCreationTokens,
            totalCacheReadTokens,
            totalCost
          )
        );
        console.log('═'.repeat(90));
        console.log('\n🎉 Planning complete!\n');
        console.log('💡 Next steps:');
        console.log('   - Review tickets: cat ' + ticketsPath);
        console.log('   - Build tickets: kosuke build --directory=' + cwd);
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
        console.log('═'.repeat(90));
        console.log('📊 Session Cost:');
        console.log(
          formatTokenUsage(
            totalInputTokens,
            totalOutputTokens,
            totalCacheCreationTokens,
            totalCacheReadTokens,
            totalCost
          )
        );
        console.log('═'.repeat(90) + '\n');
        continueConversation = false;
        break;
      }

      // Add user response to messages
      session.messages = [...session.messages, { role: 'user', content: userResponse }];
    }
  } catch (error) {
    console.error('\n❌ Error during planning:', error);
    throw error;
  } finally {
    process.removeListener('SIGINT', handleSigInt);
  }

  return {
    messages: session.messages,
    tickets: finalTickets,
    tokensUsed: {
      input: totalInputTokens,
      output: totalOutputTokens,
      cacheCreation: totalCacheCreationTokens,
      cacheRead: totalCacheReadTokens,
    },
    cost: totalCost,
  };
}

/**
 * Core plan function for programmatic use
 */
export async function planCore(options: PlanOptions): Promise<PlanResult> {
  const { prompt, directory, output = 'tickets.json', noTest = false } = options;

  // Validate directory
  const cwd = directory ? resolve(directory) : process.cwd();

  if (!existsSync(cwd)) {
    return {
      success: false,
      tickets: [],
      ticketsFile: '',
      tokensUsed: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      cost: 0,
      error: `Directory not found: ${cwd}`,
    };
  }

  const stats = statSync(cwd);
  if (!stats.isDirectory()) {
    return {
      success: false,
      tickets: [],
      ticketsFile: '',
      tokensUsed: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      cost: 0,
      error: `Path is not a directory: ${cwd}`,
    };
  }

  const ticketsPath = join(cwd, output);

  try {
    const result = await interactivePlanSession(prompt, cwd, ticketsPath, undefined, noTest);

    return {
      success: result.tickets.length > 0,
      tickets: result.tickets,
      ticketsFile: ticketsPath,
      tokensUsed: result.tokensUsed,
      cost: result.cost,
    };
  } catch (error) {
    return {
      success: false,
      tickets: [],
      ticketsFile: '',
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

    const ticketsPath = join(cwd, options.output || 'tickets.json');

    // Run interactive session
    const sessionData = await interactivePlanSession(
      options.prompt,
      cwd,
      ticketsPath,
      logContext,
      options.noTest ?? false
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
