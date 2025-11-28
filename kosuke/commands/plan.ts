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
 */

import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import * as readline from 'readline';
import type { PlanOptions, Ticket } from '../types.js';
import { calculateCost } from '../utils/claude-agent.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';

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
  codeContext: string;
  messages: Anthropic.MessageParam[];
}

/**
 * Tool definitions for ticket generation
 */
const PLAN_TOOLS: Anthropic.Tool[] = [
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
                  'Ticket ID with prefix: SCHEMA- for database, BACKEND- for API, FRONTEND- for UI, WEB-TEST- for E2E tests',
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
 * Build system prompt for plan command
 */
function buildPlanSystemPrompt(codeContext: string): string {
  return `You are an expert software architect helping plan implementation tickets for a feature or bug fix.

**YOUR PRIMARY OBJECTIVE:** Gather enough information through clarification questions to create actionable implementation tickets that can be processed by an automated build system.

**CODE CONTEXT:**
The user is working with the following codebase structure:
${codeContext}

**Your Workflow:**

1. **Initial Analysis**: When the user describes a feature or bug:
   - Analyze what they want to achieve
   - Consider the existing codebase patterns from the code context
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
- \`SCHEMA-N\`: Database schema changes (Drizzle ORM migrations)
- \`BACKEND-N\`: API/server-side logic (tRPC, server actions)
- \`FRONTEND-N\`: UI components and pages (React, Next.js)
- \`WEB-TEST-N\`: E2E tests (Playwright, browser testing)

**Ticket Order (build system processes in this order):**
1. SCHEMA tickets first (database changes)
2. BACKEND tickets (API layer)
3. FRONTEND tickets (UI layer)
4. WEB-TEST tickets last (validate everything works)

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

**Example Ticket Description:**
\`\`\`
Implement dark mode toggle in the settings page.

**Acceptance Criteria:**
- Toggle appears in user settings
- Preference persists across sessions
- All pages respect the theme setting
- Smooth transition animation

**Technical Notes (from codebase analysis):**
- Use existing ThemeProvider at app/providers.tsx
- Follow button patterns from components/ui/button.tsx
- Store preference in user settings table (lib/db/schema/users.ts)
- Use CSS variables for theming (see globals.css)
\`\`\``;
}

/**
 * Gather code context from directory
 */
function gatherCodeContext(directory: string, maxDepth = 3): string {
  const context: string[] = [];
  const relevantFiles: string[] = [];

  // Key files to always include if they exist
  const keyFiles = [
    'CLAUDE.md',
    'package.json',
    'tsconfig.json',
    'lib/db/schema/index.ts',
    'lib/db/schema.ts',
    'app/layout.tsx',
    'components/ui/button.tsx',
  ];

  // Read key files
  for (const file of keyFiles) {
    const filePath = join(directory, file);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        // Truncate large files
        const truncated =
          content.length > 2000 ? content.slice(0, 2000) + '\n...[truncated]' : content;
        relevantFiles.push(`### ${file}\n\`\`\`\n${truncated}\n\`\`\``);
      } catch {
        // Skip files that can't be read
      }
    }
  }

  // Build directory tree
  function buildTree(dir: string, prefix = '', depth = 0): string[] {
    if (depth > maxDepth) return [];

    const items: string[] = [];
    const ignoreDirs = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.tmp'];

    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (ignoreDirs.includes(entry) || entry.startsWith('.')) continue;

        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            items.push(`${prefix}📁 ${entry}/`);
            items.push(...buildTree(fullPath, prefix + '  ', depth + 1));
          } else {
            items.push(`${prefix}📄 ${entry}`);
          }
        } catch {
          // Skip entries that can't be stat'd
        }
      }
    } catch {
      // Skip directories that can't be read
    }

    return items;
  }

  const tree = buildTree(directory);
  context.push('## Project Structure\n```\n' + tree.slice(0, 100).join('\n') + '\n```');

  if (relevantFiles.length > 0) {
    context.push('\n## Key Files\n' + relevantFiles.join('\n\n'));
  }

  return context.join('\n');
}

/**
 * Execute write_tickets tool
 */
function executeWriteTickets(
  toolInput: Record<string, unknown>,
  ticketsPath: string
): { success: boolean; message: string; tickets: Ticket[] } {
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

    // Sort tickets by processing order
    tickets.sort((a, b) => {
      const getPhaseOrder = (id: string): number => {
        if (id.startsWith('SCHEMA-')) return 1;
        if (id.startsWith('DB-TEST-')) return 2;
        if (id.startsWith('BACKEND-')) return 3;
        if (id.startsWith('FRONTEND-')) return 4;
        if (id.startsWith('WEB-TEST-')) return 5;
        return 6;
      };
      return getPhaseOrder(a.id) - getPhaseOrder(b.id);
    });

    // Display tickets being created
    console.log(`\n${'='.repeat(70)}`);
    console.log('📋 Creating Implementation Tickets');
    console.log(`${'='.repeat(70)}\n`);

    for (const ticket of tickets) {
      const emoji =
        ticket.type === 'schema'
          ? '🗄️'
          : ticket.type === 'backend'
            ? '⚙️'
            : ticket.type === 'frontend'
              ? '🎨'
              : '🧪';
      console.log(`${emoji} ${ticket.id}: ${ticket.title}`);
      console.log(`   Type: ${ticket.type} | Effort: ${ticket.estimatedEffort}/10`);
      if (ticket.category) {
        console.log(`   Category: ${ticket.category}`);
      }
      console.log('');
    }

    // Create tickets file
    const ticketsFile = {
      generatedAt: new Date().toISOString(),
      totalTickets: tickets.length,
      tickets,
    };

    writeFileSync(ticketsPath, JSON.stringify(ticketsFile, null, 2), 'utf-8');

    console.log(`${'='.repeat(70)}`);
    console.log(`✅ Created ${tickets.length} ticket(s) → ${ticketsPath}`);
    console.log(`${'='.repeat(70)}\n`);

    return {
      success: true,
      message: `Successfully created ${tickets.length} tickets`,
      tickets,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`\n❌ Failed to write tickets: ${errorMessage}`);
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
 */
async function processClaudeInteraction(
  userInput: string,
  previousMessages: Anthropic.MessageParam[],
  systemPrompt: string,
  ticketsPath: string
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

  // Build message history
  const messages: Anthropic.MessageParam[] = userInput
    ? [...previousMessages, { role: 'user', content: userInput }]
    : previousMessages;

  // Stream the response
  const stream = await anthropic.messages.stream({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8096,
    system: systemPrompt,
    tools: PLAN_TOOLS,
    messages,
  });

  let responseText = '';
  const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  let isFirstOutput = true;

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
        responseText += delta;
        process.stdout.write(delta);
      }
    }
  }

  // Get final message
  const finalMessage = await stream.finalMessage();

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

  // Execute tools
  let updatedMessages = messages;
  let tickets: Ticket[] = [];
  let ticketsCreated = false;

  if (toolUses.length > 0) {
    updatedMessages = [...messages, { role: 'assistant', content: finalMessage.content }];

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const tool of toolUses) {
      if (tool.name === 'write_tickets') {
        const result = executeWriteTickets(tool.input, ticketsPath);
        tickets = result.tickets;
        ticketsCreated = result.success;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: result.message,
        });
      }
    }

    updatedMessages = [...updatedMessages, { role: 'user', content: toolResults }];

    // Get follow-up response after tool execution
    const followupStream = await anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8096,
      system: systemPrompt,
      tools: PLAN_TOOLS,
      messages: updatedMessages,
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
    updatedMessages = [...updatedMessages, { role: 'assistant', content: followupMessage.content }];

    // Combine token usage
    const finalUsage = finalMessage.usage as unknown as {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    const followupUsage = followupMessage.usage as unknown as {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };

    return {
      response: responseText,
      messages: updatedMessages,
      inputTokens: finalUsage.input_tokens + followupUsage.input_tokens,
      outputTokens: finalUsage.output_tokens + followupUsage.output_tokens,
      cacheCreationTokens:
        (finalUsage.cache_creation_input_tokens || 0) +
        (followupUsage.cache_creation_input_tokens || 0),
      cacheReadTokens:
        (finalUsage.cache_read_input_tokens || 0) + (followupUsage.cache_read_input_tokens || 0),
      tickets,
      ticketsCreated,
    };
  } else {
    updatedMessages = [...messages, { role: 'assistant', content: finalMessage.content }];

    const usage = finalMessage.usage as unknown as {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };

    return {
      response: responseText,
      messages: updatedMessages,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      tickets: [],
      ticketsCreated: false,
    };
  }
}

/**
 * Interactive planning session
 */
async function interactivePlanSession(
  initialPrompt: string,
  cwd: string,
  ticketsPath: string,
  logContext?: ReturnType<typeof logger.createContext>
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
  console.log('📁 Analyzing codebase...\n');

  // Gather code context
  const codeContext = gatherCodeContext(cwd);
  const systemPrompt = buildPlanSystemPrompt(codeContext);

  console.log('✅ Codebase analyzed. Starting planning session.\n');
  console.log('✨ Tip: Press Enter to submit, type "exit" to quit.\n');

  // Set up Ctrl+C handler
  const handleSigInt = async () => {
    console.log('\n\n👋 Exiting planning session...\n');
    if (logContext) {
      await logger.complete(logContext, 'cancelled');
    }
    process.exit(0);
  };
  process.on('SIGINT', handleSigInt);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const session: PlanSession = {
    prompt: initialPrompt,
    codeContext,
    messages: [],
  };

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCost = 0;
  let finalTickets: Ticket[] = [];

  const askQuestion = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      const lines: string[] = [];
      let currentLine = '';

      console.log('(Enter = new line, empty line = submit, Ctrl+D = submit)\n');
      process.stdout.write(prompt);

      // Store original stdin state
      const wasRaw = process.stdin.isRaw;

      // Enable raw mode to capture key combinations
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }

      // Remove existing listeners
      process.stdin.removeAllListeners('data');
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      const onData = (key: string) => {
        // Ctrl+C - exit
        if (key === '\u0003') {
          cleanup();
          process.exit(0);
        }

        // Ctrl+D - submit
        if (key === '\u0004') {
          if (currentLine.length > 0) {
            lines.push(currentLine);
          }
          process.stdout.write('\n');
          cleanup();
          resolve(lines.join('\n').trim());
          return;
        }

        // Enter key - new line OR submit if empty
        if (key === '\r') {
          // If current line is empty and we have content, submit
          if (currentLine === '' && lines.length > 0) {
            process.stdout.write('\n');
            cleanup();
            resolve(lines.join('\n').trim());
            return;
          }

          // Otherwise, add line and continue
          lines.push(currentLine);
          currentLine = '';
          process.stdout.write('\n... ');
          return;
        }

        // Backspace
        if (key === '\u007f' || key === '\b' || key === '\x08') {
          if (currentLine.length > 0) {
            currentLine = currentLine.slice(0, -1);
            process.stdout.write('\b \b');
          }
          return;
        }

        // Tab - insert 2 spaces
        if (key === '\t') {
          currentLine += '  ';
          process.stdout.write('  ');
          return;
        }

        // Ignore escape sequences and other control characters
        if (key === '\x1b' || key.charCodeAt(0) < 32) {
          return;
        }

        // Regular character
        currentLine += key;
        process.stdout.write(key);
      };

      const cleanup = () => {
        process.stdin.removeListener('data', onData);
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(wasRaw || false);
        }
        process.stdin.pause();
      };

      process.stdin.on('data', onData);
    });
  };

  try {
    // Start with initial prompt
    session.messages.push({ role: 'user', content: initialPrompt });

    let continueConversation = true;

    while (continueConversation) {
      console.log('\n🤔 Claude is analyzing...\n');

      const result = await processClaudeInteraction(
        '',
        session.messages,
        systemPrompt,
        ticketsPath
      );

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
        finalTickets = result.tickets;
        console.log('\n✅ Tickets created: ' + ticketsPath);
        console.log('\n' + '═'.repeat(90));
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
    rl.close();
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
  const { prompt, directory, output = 'tickets.json' } = options;

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
    const result = await interactivePlanSession(prompt, cwd, ticketsPath);

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
    const sessionData = await interactivePlanSession(options.prompt, cwd, ticketsPath, logContext);

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
