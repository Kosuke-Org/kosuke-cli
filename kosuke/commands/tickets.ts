/**
 * Tickets command - Generate tickets from requirements document
 *
 * This command analyzes a requirements document (default: docs.md) and generates
 * structured tickets in three phases:
 * 1. Schema tickets (database design)
 * 2. Backend tickets (API, services, business logic)
 * 3. Frontend tickets (pages, components, UI)
 *
 * Claude Code Agent explores the specified directory (default: current directory)
 * to understand the existing codebase and generate contextual tickets.
 *
 * All paths (--path and --output) are relative to the project directory.
 *
 * Usage:
 *   kosuke tickets                                    # Use docs.md in current directory
 *   kosuke tickets --path=custom.md                   # Custom requirements file
 *   kosuke tickets --output=my-tickets.json           # Custom output file
 *   kosuke tickets --directory=./projects/my-app      # Analyze specific directory
 *   kosuke tickets --dir=./my-app --path=docs/spec.md # Custom directory and requirements path
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { runAgent, formatCostBreakdown } from '../utils/claude-agent.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';
import type { TicketsOptions, Ticket, TicketsResult } from '../types.js';

/**
 * Build system prompt for ticket generation
 */
function buildTicketGenerationPrompt(
  phase: 'schema' | 'backend' | 'frontend',
  requirementsContent: string,
  projectPath: string
): string {
  const phaseInstructions = {
    schema: `
**PHASE 1: DATABASE SCHEMA TICKETS**

Generate ONE comprehensive schema ticket that includes:
- All database tables needed
- Relationships between tables
- Indexes and constraints
- Data types and validation rules
- Any special considerations (soft deletes, timestamps, etc.)

Ticket ID: SCHEMA-1
`,
    backend: `
**PHASE 2: BACKEND/API TICKETS**

Generate backend tickets for:
- API endpoints and routes
- Service layer logic
- Authentication and authorization
- Business logic implementation
- Data validation and processing
- Third-party integrations

Create ONE ticket per feature/module. Each ticket should be independently implementable.

Ticket IDs: BACKEND-1, BACKEND-2, BACKEND-3, etc. (sequential)
`,
    frontend: `
**PHASE 3: FRONTEND/UI TICKETS**

Generate frontend tickets for:
- Pages and routing
- UI components
- Forms and validation
- State management
- User interactions
- Responsive design

Create ONE ticket per PAGE. Each ticket should cover all components and functionality for that page.

Ticket IDs: FRONTEND-1, FRONTEND-2, FRONTEND-3, etc. (sequential)
`,
  };

  return `You are an expert software architect and project planner analyzing a requirements document to generate implementation tickets.

**Your Task:**
${phaseInstructions[phase]}

**Requirements Document:**
${requirementsContent}

**Context:**
You have access to the project directory at: ${projectPath}
Explore the codebase to understand the tech stack, architecture patterns, and coding conventions.
Use read_file, grep, and codebase_search tools to understand the existing implementation.

**Ticket Structure:**
Each ticket must be a JSON object with:
- id: string (e.g., "SCHEMA-1", "BACKEND-1", "FRONTEND-1")
- title: string (clear, concise title)
- description: string (detailed description with acceptance criteria)
- estimatedEffort: number (1-10, where 1=very easy, 10=very complex)
- status: "Todo" (all tickets start as Todo)

**Output Format:**
Return ONLY a valid JSON array of tickets. No markdown, no code blocks, just raw JSON.

Example:
[
  {
    "id": "SCHEMA-1",
    "title": "Design and implement complete database schema",
    "description": "Create database schema including:\\n- Users table with authentication fields\\n- Organizations table with multi-tenant support\\n- Posts table for social media content\\n- Automations table for campaign configuration\\n- Leads table with status tracking\\n\\nRelationships:\\n- User belongs to many Organizations\\n- Posts and Automations belong to Organization\\n- Leads belong to Automation and Post\\n\\nAcceptance Criteria:\\n- Schema validates successfully\\n- Migrations run successfully\\n- All relationships properly defined\\n- Indexes on foreign keys and frequently queried fields",
    "estimatedEffort": 8,
    "status": "Todo"
  }
]

**Critical Instructions:**
1. Analyze the requirements thoroughly
2. Explore the project directory to understand existing patterns (use read_file, grep, codebase_search tools)
3. Generate tickets that are actionable and specific
4. Return ONLY valid JSON - no explanations, no markdown formatting
5. Ensure ticket IDs follow the naming convention (${phase.toUpperCase()}-N)
6. Make descriptions detailed with clear acceptance criteria
7. Estimate effort realistically (consider complexity, dependencies, testing)

Begin by exploring the project directory, then generate the tickets.`;
}

/**
 * Parse tickets from Claude's response
 */
function parseTicketsFromResponse(response: string, phase: string): Ticket[] {
  try {
    // Extract JSON from response (in case Claude includes extra text)
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error(`No JSON array found in ${phase} response`);
    }

    const tickets = JSON.parse(jsonMatch[0]) as Ticket[];

    // Validate tickets
    if (!Array.isArray(tickets)) {
      throw new Error(`Expected array of tickets, got ${typeof tickets}`);
    }

    for (const ticket of tickets) {
      if (!ticket.id || !ticket.title || !ticket.description) {
        throw new Error(`Invalid ticket structure: ${JSON.stringify(ticket)}`);
      }
      if (
        typeof ticket.estimatedEffort !== 'number' ||
        ticket.estimatedEffort < 1 ||
        ticket.estimatedEffort > 10
      ) {
        throw new Error(
          `Invalid estimatedEffort for ticket ${ticket.id}: ${ticket.estimatedEffort}`
        );
      }
      if (!ticket.status) {
        ticket.status = 'Todo';
      }
    }

    return tickets;
  } catch (error) {
    console.error(`\n❌ Failed to parse tickets from ${phase} phase:`);
    console.error(`Raw response:\n${response.substring(0, 500)}...\n`);
    throw new Error(
      `Failed to parse ${phase} tickets: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Write tickets to file incrementally
 */
function writeTicketsToFile(
  outputPath: string,
  schemaTickets: Ticket[],
  backendTickets: Ticket[],
  frontendTickets: Ticket[]
): void {
  const allTickets = [...schemaTickets, ...backendTickets, ...frontendTickets];
  const outputData = {
    generatedAt: new Date().toISOString(),
    totalTickets: allTickets.length,
    tickets: allTickets,
  };

  writeFileSync(outputPath, JSON.stringify(outputData, null, 2), 'utf-8');
}

/**
 * Generate tickets for a specific phase
 */
async function generatePhaseTickets(
  phase: 'schema' | 'backend' | 'frontend',
  requirementsContent: string,
  projectPath: string,
  outputPath: string,
  existingSchemaTickets: Ticket[],
  existingBackendTickets: Ticket[]
): Promise<{
  tickets: Ticket[];
  tokensUsed: { input: number; output: number; cacheCreation: number; cacheRead: number };
  cost: number;
  conversationMessages: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    toolCalls?: Array<{
      name: string;
      input: unknown;
      output?: unknown;
    }>;
  }>;
}> {
  const phaseEmoji = {
    schema: '🗄️',
    backend: '⚙️',
    frontend: '🎨',
  };

  const phaseName = {
    schema: 'Schema',
    backend: 'Backend',
    frontend: 'Frontend',
  };

  console.log(`\n${'='.repeat(60)}`);
  console.log(
    `${phaseEmoji[phase]}  Phase ${phase === 'schema' ? '1' : phase === 'backend' ? '2' : '3'}: ${phaseName[phase]} Tickets`
  );
  console.log(`${'='.repeat(60)}\n`);

  const systemPrompt = buildTicketGenerationPrompt(phase, requirementsContent, projectPath);

  const agentResult = await runAgent(
    `Generate ${phaseName[phase]} tickets from the requirements document.`,
    {
      systemPrompt,
      cwd: projectPath,
      maxTurns: 25,
      verbosity: 'normal',
      captureConversation: true, // Capture full conversation for backend logging
    }
  );

  // Parse tickets from response
  const tickets = parseTicketsFromResponse(agentResult.response, phase);

  console.log(
    `\n✅ Generated ${tickets.length} ${phaseName[phase]} ticket${tickets.length === 1 ? '' : 's'}`
  );
  tickets.forEach((ticket) => {
    console.log(
      `   ${phaseEmoji[phase]} ${ticket.id}: ${ticket.title} (Effort: ${ticket.estimatedEffort}/10)`
    );
  });

  // Write tickets incrementally after each phase
  if (phase === 'schema') {
    writeTicketsToFile(outputPath, tickets, [], []);
  } else if (phase === 'backend') {
    writeTicketsToFile(outputPath, existingSchemaTickets, tickets, []);
  } else if (phase === 'frontend') {
    writeTicketsToFile(outputPath, existingSchemaTickets, existingBackendTickets, tickets);
  }

  console.log(`   💾 Progress saved to: ${outputPath}\n`);

  return {
    tickets,
    tokensUsed: agentResult.tokensUsed,
    cost: agentResult.cost,
    conversationMessages: agentResult.conversationMessages || [],
  };
}

/**
 * Core tickets logic
 */
export async function ticketsCore(options: TicketsOptions): Promise<TicketsResult> {
  const { path = 'docs.md', directory } = options;

  // 1. Validate and resolve project directory
  const projectPath = directory ? resolve(directory) : process.cwd();

  if (!existsSync(projectPath)) {
    throw new Error(
      `Directory not found: ${projectPath}\n` +
        `Please provide a valid directory using --directory=<path>\n` +
        `Example: kosuke tickets --directory=./my-project`
    );
  }

  const stats = statSync(projectPath);
  if (!stats.isDirectory()) {
    throw new Error(
      `Path is not a directory: ${projectPath}\n` + `Please provide a valid directory path.`
    );
  }

  console.log(`📁 Using project directory: ${projectPath}\n`);

  // 2. Read requirements document (relative to project directory)
  console.log('📄 Reading requirements document...');
  const requirementsPath = join(projectPath, path);

  if (!existsSync(requirementsPath)) {
    throw new Error(
      `Requirements document not found: ${path}\n` +
        `Please provide a valid path using --path=<file>\n` +
        `Example: kosuke tickets --path=requirements.md`
    );
  }

  const requirementsContent = readFileSync(requirementsPath, 'utf-8');
  console.log(`   ✅ Loaded ${path} (${requirementsContent.length} characters)\n`);

  // 3. Determine output path for incremental writes
  const outputFilename = options.output || 'tickets.json';
  const outputPath = join(projectPath, outputFilename);

  // 4. Generate tickets in three phases (written incrementally)
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCost = 0;

  // Collect all conversation messages from all phases
  const allConversationMessages: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    toolCalls?: Array<{ name: string; input: unknown; output?: unknown }>;
  }> = [];

  // Phase 1: Schema
  const schemaResult = await generatePhaseTickets(
    'schema',
    requirementsContent,
    projectPath,
    outputPath,
    [],
    []
  );
  totalInputTokens += schemaResult.tokensUsed.input;
  totalOutputTokens += schemaResult.tokensUsed.output;
  totalCacheCreationTokens += schemaResult.tokensUsed.cacheCreation;
  totalCacheReadTokens += schemaResult.tokensUsed.cacheRead;
  totalCost += schemaResult.cost;
  allConversationMessages.push(...schemaResult.conversationMessages);

  // Phase 2: Backend
  const backendResult = await generatePhaseTickets(
    'backend',
    requirementsContent,
    projectPath,
    outputPath,
    schemaResult.tickets,
    []
  );
  totalInputTokens += backendResult.tokensUsed.input;
  totalOutputTokens += backendResult.tokensUsed.output;
  totalCacheCreationTokens += backendResult.tokensUsed.cacheCreation;
  totalCacheReadTokens += backendResult.tokensUsed.cacheRead;
  totalCost += backendResult.cost;
  allConversationMessages.push(...backendResult.conversationMessages);

  // Phase 3: Frontend
  const frontendResult = await generatePhaseTickets(
    'frontend',
    requirementsContent,
    projectPath,
    outputPath,
    schemaResult.tickets,
    backendResult.tickets
  );
  totalInputTokens += frontendResult.tokensUsed.input;
  totalOutputTokens += frontendResult.tokensUsed.output;
  totalCacheCreationTokens += frontendResult.tokensUsed.cacheCreation;
  totalCacheReadTokens += frontendResult.tokensUsed.cacheRead;
  totalCost += frontendResult.cost;
  allConversationMessages.push(...frontendResult.conversationMessages);

  const totalTickets =
    schemaResult.tickets.length + backendResult.tickets.length + frontendResult.tickets.length;

  return {
    schemaTickets: schemaResult.tickets,
    backendTickets: backendResult.tickets,
    frontendTickets: frontendResult.tickets,
    totalTickets,
    projectPath, // Include project path for output file resolution
    tokensUsed: {
      input: totalInputTokens,
      output: totalOutputTokens,
      cacheCreation: totalCacheCreationTokens,
      cacheRead: totalCacheReadTokens,
    },
    cost: totalCost,
    conversationMessages: allConversationMessages,
  };
}

/**
 * Main tickets command
 */
export async function ticketsCommand(options: TicketsOptions): Promise<void> {
  const { noLogs = false } = options;
  console.log('🎫 Starting Ticket Generation...\n');

  // Initialize logging context
  const logContext = logger.createContext('tickets', { noLogs });
  const cleanupHandler = setupCancellationHandler(logContext);

  try {
    // Validate environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    // Execute core logic
    const result = await ticketsCore(options);

    // Track metrics
    logger.trackTokens(logContext, result.tokensUsed);
    logContext.conversationMessages = result.conversationMessages;

    // Display summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('📊 Summary');
    console.log(`${'='.repeat(60)}`);
    console.log(`🗄️  Schema Tickets: ${result.schemaTickets.length}`);
    console.log(`⚙️  Backend Tickets: ${result.backendTickets.length}`);
    console.log(`🎨 Frontend Tickets: ${result.frontendTickets.length}`);
    console.log(`📝 Total Tickets: ${result.totalTickets}`);
    console.log(`${'='.repeat(60)}\n`);

    // Display cost breakdown
    const costBreakdown = formatCostBreakdown({
      cost: result.cost,
      tokensUsed: result.tokensUsed,
      fixCount: 0,
      response: '',
      filesReferenced: new Set(),
    });
    console.log(`💰 Total Cost: ${costBreakdown}\n`);

    // Final confirmation (file already written incrementally)
    const outputFilename = options.output || 'tickets.json';
    const outputPath = join(result.projectPath, outputFilename);
    console.log(`✅ All tickets saved to: ${outputPath}\n`);

    console.log('✅ Ticket generation completed successfully!');

    // Log successful execution
    await logger.complete(logContext, 'success');
    cleanupHandler();
  } catch (error) {
    console.error('\n❌ Ticket generation failed:', error);

    // Log failed execution
    await logger.complete(logContext, 'error', error as Error);
    cleanupHandler();

    throw error;
  }
}
