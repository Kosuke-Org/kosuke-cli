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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { glob } from 'glob';
import type {
  MessageAttachmentPayload,
  PlanOptions,
  SupportedImageMediaType,
  Ticket,
} from '../types.js';
import { calculateCost } from '../utils/claude-agent.js';
import { askQuestion } from '../utils/interactive-input.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';
import { processAndWriteTickets, sortTicketsByOrder } from '../utils/tickets-manager.js';

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

  return join(ticketsDir, `${timestamp}.ticket.json`);
}

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
                  'Ticket ID with prefix: PLAN-SCHEMA- for database, PLAN-ENGINE- for Python microservice, PLAN-BACKEND- for API, PLAN-FRONTEND- for UI, PLAN-WEB-TEST- for E2E tests',
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
                enum: ['schema', 'engine', 'backend', 'frontend', 'test'],
                description:
                  'Ticket type: schema (database), engine (Python microservice), backend (API), frontend (UI), test (E2E)',
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

**CRITICAL RULES FOR QUESTIONS:**
- Questions must be NON-TECHNICAL and USER-FOCUSED
- Focus ONLY on user experience, behavior, and business logic
- YOU decide all technical/algorithmic details (libraries, caching, performance, architecture)
- Never ask about: URLs, database design, APIs, algorithms, processing timing, or implementation approach
- Include technical decisions in ticket DESCRIPTIONS, not in questions to users

**Examples:**
- ❌ BAD: "Should we cache results or process on-demand?"
- ❌ BAD: "Should this use Python or TypeScript?"
- ✅ GOOD: "Should invoices be per-user or shared per company?"
- ✅ GOOD: "For empty descriptions, show neutral mood or hide it?"

**Ticket Generation Rules:**
- Generate only the tickets actually needed
- Ensure tickets are atomic and independently implementable
- Include clear acceptance criteria in each ticket description

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
 * Plan stream event names
 */
export const PlanEventName = {
  TEXT_DELTA: 'text_delta',
  TOOL_USE: 'tool_use',
  TOOL_RESULT: 'tool_result',
  CLARIFICATION: 'clarification',
  TICKETS_GENERATED: 'tickets_generated',
  COMPLETE: 'complete',
  ERROR: 'error',
} as const;

export type PlanEventNameType = (typeof PlanEventName)[keyof typeof PlanEventName];

/**
 * Event types for streaming plan execution
 */
export type PlanStreamEventType =
  | { type: typeof PlanEventName.TEXT_DELTA; content: string }
  | {
      type: typeof PlanEventName.TOOL_USE;
      toolName: string;
      toolId: string;
      input: Record<string, unknown>;
    }
  | { type: typeof PlanEventName.TOOL_RESULT; toolId: string; result: string; isError: boolean }
  | {
      type: typeof PlanEventName.CLARIFICATION;
      question: string;
      sendAnswer: (answer: string) => void;
    }
  | { type: typeof PlanEventName.TICKETS_GENERATED; tickets: Ticket[]; ticketsPath: string }
  | {
      type: typeof PlanEventName.COMPLETE;
      tickets: Ticket[];
      ticketsPath: string;
      tokensUsed: PlanResult['tokensUsed'];
      cost: number;
    }
  | { type: typeof PlanEventName.ERROR; message: string };

/**
 * Options for streaming plan execution
 */
export interface PlanStreamingOptions {
  /** Feature or bug description */
  prompt: string;
  /** Project directory path */
  directory?: string;
  /** Skip WEB-TEST ticket generation */
  noTest?: boolean;
  /** Custom tickets output path (optional, defaults to tickets/{timestamp}.ticket.json) */
  ticketsPath?: string;
  /** Optional attachments (images, PDFs) for context - web integration only */
  attachments?: MessageAttachmentPayload[];
  /** Optional conversation history for resuming after clarification */
  conversationHistory?: Anthropic.MessageParam[];
}

/**
 * Check if a media type is a supported image type for Claude API
 */
function isSupportedImageMediaType(mediaType: string): mediaType is SupportedImageMediaType {
  return (
    mediaType === 'image/jpeg' ||
    mediaType === 'image/png' ||
    mediaType === 'image/gif' ||
    mediaType === 'image/webp'
  );
}

/**
 * Build the initial user message with optional attachments
 * Creates properly typed content blocks for images, documents, and text
 * Uses public URLs for file attachments (Claude fetches from URL)
 */
function buildInitialMessage(
  prompt: string,
  attachments?: MessageAttachmentPayload[]
): Anthropic.MessageParam {
  // If no attachments, return simple string content
  if (!attachments || attachments.length === 0) {
    return { role: 'user', content: prompt };
  }

  // Build content blocks array for user message with attachments
  type UserContentBlock = Exclude<Anthropic.MessageParam['content'], string>[number];
  const contentBlocks: UserContentBlock[] = [];

  // Add text block first
  if (prompt.trim()) {
    contentBlocks.push({
      type: 'text',
      text: prompt.trim(),
    });
  }

  // Add image or document blocks for all attachments using public URLs
  for (const attachment of attachments) {
    const { upload } = attachment;

    if (upload.fileType === 'image') {
      if (isSupportedImageMediaType(upload.mediaType)) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'url',
            url: upload.fileUrl,
          },
        });
      } else {
        // Fallback for unsupported image types - add as text reference
        contentBlocks.push({
          type: 'text',
          text: `Attached image available at ${upload.fileUrl}`,
        });
      }
    } else if (upload.fileType === 'document') {
      contentBlocks.push({
        type: 'document',
        source: {
          type: 'url',
          url: upload.fileUrl,
        },
      });
    }
  }

  return { role: 'user', content: contentBlocks };
}

/**
 * Streaming plan execution - the core implementation
 *
 * This AsyncGenerator is the single source of truth for planning logic.
 * Both CLI and web integrations consume this stream.
 *
 * @example
 * ```ts
 * // Web usage
 * for await (const event of planCoreStreaming({ prompt, directory })) {
 *   if (event.type === 'text_delta') {
 *     sendToClient(event.content);
 *   } else if (event.type === 'clarification') {
 *     showQuestion(event.question);
 *     // Later when user responds:
 *     event.sendAnswer(userInput);
 *   } else if (event.type === 'complete') {
 *     showSuccess(event.tickets, event.cost);
 *   }
 * }
 * ```
 */
export async function* planCoreStreaming(
  options: PlanStreamingOptions
): AsyncGenerator<PlanStreamEventType> {
  const {
    prompt,
    directory,
    noTest = false,
    ticketsPath: customTicketsPath,
    attachments,
    conversationHistory,
  } = options;

  // Validate directory
  const cwd = directory ? resolve(directory) : process.cwd();

  if (!existsSync(cwd)) {
    yield { type: 'error', message: `Directory not found: ${cwd}` };
    return;
  }

  const stats = statSync(cwd);
  if (!stats.isDirectory()) {
    yield { type: 'error', message: `Path is not a directory: ${cwd}` };
    return;
  }

  const ticketsPath = customTicketsPath || generateTicketsPath(cwd);

  // Read CLAUDE.md and build system prompt
  const claudeMdContent = readClaudeMd(cwd);
  const systemPrompt = buildPlanSystemPrompt(claudeMdContent, noTest);

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  // Use conversation history if resuming, otherwise build initial message
  let messages: Anthropic.MessageParam[];
  if (conversationHistory && conversationHistory.length > 0) {
    // Resuming conversation - append the new user message to history
    messages = [...conversationHistory, { role: 'user', content: prompt }];
  } else {
    // New conversation - build initial message with optional attachments
    const initialMessage = buildInitialMessage(prompt, attachments);
    messages = [initialMessage];
  }
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let finalTickets: Ticket[] = [];

  const maxIterations = 50; // Safety limit for entire session
  let iterations = 0;

  try {
    sessionLoop: while (iterations < maxIterations) {
      iterations++;

      // Inner loop: process Claude response and tools until we need user input or complete
      let needsUserInput = false;

      while (!needsUserInput && iterations < maxIterations) {
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

        // Process stream events - yield text deltas
        for await (const event of stream) {
          if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              const delta = event.delta.text;
              currentText += delta;
              yield { type: 'text_delta', content: delta };
            }
          }
        }

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

        // Update messages with assistant response
        messages = [...messages, { role: 'assistant', content: finalMessage.content }];

        // If no tools called, check if we need clarification
        if (toolUses.length === 0) {
          // Check if the response contains clarification questions
          if (
            currentText.includes('Clarification Questions') ||
            currentText.includes('Quick Option')
          ) {
            // Create a promise that will be resolved when answer is provided
            let resolveAnswer: ((answer: string) => void) | null = null;
            const answerPromise = new Promise<string>((resolve) => {
              resolveAnswer = resolve;
            });

            yield {
              type: 'clarification',
              question: currentText,
              sendAnswer: (answer: string) => {
                if (resolveAnswer) resolveAnswer(answer);
              },
            };

            // Wait for answer
            const answer = await answerPromise;
            messages = [...messages, { role: 'user', content: answer }];
            needsUserInput = false; // Continue processing with the answer
            continue;
          }

          // No clarification needed and no tools - we're done with this iteration
          break;
        }

        // Execute tools
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const tool of toolUses) {
          // Emit tool_use event before execution
          yield { type: 'tool_use', toolName: tool.name, toolId: tool.id, input: tool.input };

          if (tool.name === 'read_file') {
            const result = executeReadFile(tool.input, cwd);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tool.id,
              content: result.content,
            });
            // Emit tool_result event after execution
            yield {
              type: 'tool_result',
              toolId: tool.id,
              result: 'File read successfully',
              isError: false,
            };
          } else if (tool.name === 'list_directory') {
            const result = executeListDirectory(tool.input, cwd);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tool.id,
              content: result.content,
            });
            yield {
              type: 'tool_result',
              toolId: tool.id,
              result: 'Directory listed',
              isError: false,
            };
          } else if (tool.name === 'glob_search') {
            const result = await executeGlobSearch(tool.input, cwd);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tool.id,
              content: result.content,
            });
            yield {
              type: 'tool_result',
              toolId: tool.id,
              result: 'Search completed',
              isError: false,
            };
          } else if (tool.name === 'write_tickets') {
            const result = executeWriteTickets(tool.input);

            if (result.success) {
              // Validate and write tickets to disk
              const { tickets: validatedTickets } = await processAndWriteTickets(
                result.tickets,
                ticketsPath,
                cwd,
                { displaySummary: false }
              );
              finalTickets = validatedTickets;

              yield { type: 'tickets_generated', tickets: validatedTickets, ticketsPath };
              yield {
                type: 'tool_result',
                toolId: tool.id,
                result: 'Tickets written',
                isError: false,
              };
            } else {
              yield { type: 'tool_result', toolId: tool.id, result: result.message, isError: true };
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: tool.id,
              content: result.message,
            });
          }
        }

        messages = [...messages, { role: 'user', content: toolResults }];

        // If tickets were created, get final response and complete
        if (finalTickets.length > 0) {
          const followupStream = await anthropic.messages.stream({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 8096,
            system: systemPrompt,
            tools: PLAN_TOOLS,
            messages,
          });

          for await (const event of followupStream) {
            if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') {
                yield { type: 'text_delta', content: event.delta.text };
              }
            }
          }

          const followupMessage = await followupStream.finalMessage();
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

          // Calculate final cost and complete
          const cost = calculateCost(
            totalInputTokens,
            totalOutputTokens,
            totalCacheCreationTokens,
            totalCacheReadTokens
          );

          yield {
            type: 'complete',
            tickets: finalTickets,
            ticketsPath,
            tokensUsed: {
              input: totalInputTokens,
              output: totalOutputTokens,
              cacheCreation: totalCacheCreationTokens,
              cacheRead: totalCacheReadTokens,
            },
            cost,
          };

          return;
        }
      }

      // If we exit inner loop without completing, break session loop
      break sessionLoop;
    }

    // If we reach here without tickets, yield complete with empty tickets
    const cost = calculateCost(
      totalInputTokens,
      totalOutputTokens,
      totalCacheCreationTokens,
      totalCacheReadTokens
    );

    yield {
      type: 'complete',
      tickets: finalTickets,
      ticketsPath,
      tokensUsed: {
        input: totalInputTokens,
        output: totalOutputTokens,
        cacheCreation: totalCacheCreationTokens,
        cacheRead: totalCacheReadTokens,
      },
      cost,
    };
  } catch (error) {
    yield {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Interactive planning session - CLI wrapper around planCoreStreaming
 *
 * Consumes the streaming generator and handles:
 * - Terminal output (stdout)
 * - User input (stdin via askQuestion)
 * - Ctrl+C handling
 */
async function interactivePlanSession(
  initialPrompt: string,
  cwd: string,
  ticketsPath: string,
  logContext?: ReturnType<typeof logger.createContext>,
  noTest: boolean = false
): Promise<{
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

  // Check for CLAUDE.md
  const claudeMdPath = join(cwd, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, 'utf-8');
    console.log(`📖 Loaded CLAUDE.md (${Math.round(content.length / 1000)}k chars)\n`);
  }

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

  let finalTickets: Ticket[] = [];
  let finalTokensUsed = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  let finalCost = 0;
  let isFirstTextOutput = true;

  try {
    console.log('\n🤔 Claude is analyzing...\n');

    // Consume the streaming generator
    for await (const event of planCoreStreaming({
      prompt: initialPrompt,
      directory: cwd,
      noTest,
      ticketsPath,
    })) {
      switch (event.type) {
        case 'text_delta':
          // First text output - print header
          if (isFirstTextOutput) {
            process.stdout.write('\n> Claude:\n');
            isFirstTextOutput = false;
          }
          process.stdout.write(event.content);
          break;

        case 'clarification':
          // Reset for next Claude response
          isFirstTextOutput = true;

          // Show cost so far (we don't have intermediate costs in streaming, skip for now)
          console.log('\n');

          // Ask for user response
          console.log('💬 Your response (type "exit" to quit):\n');
          const userResponse = await askQuestion('You: ');

          if (!userResponse) {
            console.log('\n⚠️  Empty response. Please provide an answer or type "exit".');
            event.sendAnswer('go with recommendations');
          } else if (userResponse.toLowerCase() === 'exit') {
            console.log('\n👋 Exiting planning session.\n');
            // Send empty to trigger completion
            event.sendAnswer('exit');
          } else {
            console.log('\n🤔 Claude is analyzing...\n');
            event.sendAnswer(userResponse);
          }
          break;

        case 'tickets_generated':
          console.log(`\n\n📋 Generated ${event.tickets.length} ticket(s)`);
          console.log(`📁 Saved to: ${event.ticketsPath}\n`);

          // Display ticket summary
          for (const ticket of event.tickets) {
            console.log(`   • ${ticket.id}: ${ticket.title}`);
          }
          break;

        case 'complete':
          finalTickets = event.tickets;
          finalTokensUsed = event.tokensUsed;
          finalCost = event.cost;

          console.log('\n' + '═'.repeat(90));
          console.log('📊 Total Session Cost:');
          console.log(
            formatTokenUsage(
              event.tokensUsed.input,
              event.tokensUsed.output,
              event.tokensUsed.cacheCreation,
              event.tokensUsed.cacheRead,
              event.cost
            )
          );
          console.log('═'.repeat(90));

          if (event.tickets.length > 0) {
            const relativeTicketsPath = event.ticketsPath.replace(cwd + '/', '');
            console.log('\n🎉 Planning complete!\n');
            console.log('💡 Next steps:');
            console.log('   - Review tickets: cat "' + event.ticketsPath + '"');
            console.log(
              '   - Build tickets: kosuke build --directory="' +
                cwd +
                '" --tickets="' +
                relativeTicketsPath +
                '"'
            );
            console.log('   - List all tickets: ls ' + join(cwd, 'tickets'));
          } else {
            console.log('\n👋 Session ended without generating tickets.\n');
          }
          break;

        case 'error':
          console.error(`\n❌ Error: ${event.message}`);
          throw new Error(event.message);
      }
    }
  } catch (error) {
    console.error('\n❌ Error during planning:', error);
    throw error;
  } finally {
    process.removeListener('SIGINT', handleSigInt);
  }

  return {
    tickets: finalTickets,
    tokensUsed: finalTokensUsed,
    cost: finalCost,
  };
}

/**
 * Core plan function for programmatic use (CLI mode with stdin/stdout)
 *
 * For web/programmatic use without terminal I/O, use planCoreStreaming instead.
 */
export async function planCore(options: PlanOptions): Promise<PlanResult> {
  const { prompt, directory, noTest = false } = options;

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

  const ticketsPath = generateTicketsPath(cwd);

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

    const ticketsPath = generateTicketsPath(cwd);

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
