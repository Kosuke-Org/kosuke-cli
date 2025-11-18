/**
 * Tickets command - Generate tickets from requirements document
 *
 * This command analyzes a requirements document (default: docs.md) and generates
 * structured tickets in three phases:
 * 1. Schema tickets (database design)
 * 2. Backend tickets (API, services, business logic)
 * 3. Frontend tickets (pages, components, UI)
 *
 * Usage:
 *   kosuke tickets                           # Use docs.md
 *   kosuke tickets --path=custom.md          # Custom requirements file
 *   kosuke tickets --output=my-tickets.json  # Custom output file
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { ensureRepoReady } from '../utils/repository-manager.js';
import { runAgent, formatCostBreakdown } from '../utils/claude-agent.js';
import type { TicketsOptions, Ticket, TicketsResult } from '../types.js';

/**
 * Build system prompt for ticket generation
 */
function buildTicketGenerationPrompt(
  phase: 'schema' | 'backend' | 'frontend',
  requirementsContent: string,
  repoPath: string
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

The schema should follow the patterns used in kosuke-template (Prisma ORM).

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

The implementation should follow the patterns used in kosuke-template (tRPC, Next.js API routes).
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

The implementation should follow the patterns used in kosuke-template (Next.js, React, TailwindCSS).
`,
  };

  return `You are an expert software architect and project planner analyzing a requirements document to generate implementation tickets.

**Your Task:**
${phaseInstructions[phase]}

**Requirements Document:**
${requirementsContent}

**Context:**
You have access to the kosuke-template repository at: ${repoPath}
Use this to understand the tech stack, architecture patterns, and coding conventions.
DO NOT reference specific files in your tickets - use the template only for general understanding.

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
    "description": "Create Prisma schema including:\\n- Users table with authentication fields\\n- Organizations table with multi-tenant support\\n- Posts table for social media content\\n- Automations table for campaign configuration\\n- Leads table with status tracking\\n\\nRelationships:\\n- User belongs to many Organizations\\n- Posts and Automations belong to Organization\\n- Leads belong to Automation and Post\\n\\nAcceptance Criteria:\\n- Schema validates with Prisma\\n- Migrations run successfully\\n- All relationships properly defined\\n- Indexes on foreign keys and frequently queried fields",
    "estimatedEffort": 8,
    "status": "Todo"
  }
]

**Critical Instructions:**
1. Analyze the requirements thoroughly
2. Explore kosuke-template to understand patterns (use read_file, grep, codebase_search tools)
3. Generate tickets that are actionable and specific
4. Return ONLY valid JSON - no explanations, no markdown formatting
5. Ensure ticket IDs follow the naming convention (${phase.toUpperCase()}-N)
6. Make descriptions detailed with clear acceptance criteria
7. Estimate effort realistically (consider complexity, dependencies, testing)

Begin by exploring the kosuke-template repository, then generate the tickets.`;
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
 * Generate tickets for a specific phase
 */
async function generatePhaseTickets(
  phase: 'schema' | 'backend' | 'frontend',
  requirementsContent: string,
  repoPath: string
): Promise<{
  tickets: Ticket[];
  tokensUsed: { input: number; output: number; cacheCreation: number; cacheRead: number };
  cost: number;
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

  const systemPrompt = buildTicketGenerationPrompt(phase, requirementsContent, repoPath);

  const agentResult = await runAgent(
    `Generate ${phaseName[phase]} tickets from the requirements document.`,
    {
      systemPrompt,
      cwd: repoPath,
      maxTurns: 25,
      verbosity: 'normal',
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

  return {
    tickets,
    tokensUsed: agentResult.tokensUsed,
    cost: agentResult.cost,
  };
}

/**
 * Core tickets logic
 */
export async function ticketsCore(options: TicketsOptions): Promise<TicketsResult> {
  const { path = 'docs.md', template = 'Kosuke-Org/kosuke-template' } = options;

  // 1. Read requirements document
  console.log('📄 Reading requirements document...');
  const requirementsPath = join(process.cwd(), path);

  if (!existsSync(requirementsPath)) {
    throw new Error(
      `Requirements document not found: ${path}\n` +
        `Please provide a valid path using --path=<file>\n` +
        `Example: kosuke tickets --path=requirements.md`
    );
  }

  const requirementsContent = readFileSync(requirementsPath, 'utf-8');
  console.log(`   ✅ Loaded ${path} (${requirementsContent.length} characters)\n`);

  // 2. Fetch kosuke-template for context
  console.log('📥 Fetching kosuke-template for context...');
  const repoInfo = await ensureRepoReady(template);
  console.log(`   ✅ Template repository ready at ${repoInfo.localPath}\n`);

  // 3. Generate tickets in three phases
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCost = 0;

  // Phase 1: Schema
  const schemaResult = await generatePhaseTickets(
    'schema',
    requirementsContent,
    repoInfo.localPath
  );
  totalInputTokens += schemaResult.tokensUsed.input;
  totalOutputTokens += schemaResult.tokensUsed.output;
  totalCacheCreationTokens += schemaResult.tokensUsed.cacheCreation;
  totalCacheReadTokens += schemaResult.tokensUsed.cacheRead;
  totalCost += schemaResult.cost;

  // Phase 2: Backend
  const backendResult = await generatePhaseTickets(
    'backend',
    requirementsContent,
    repoInfo.localPath
  );
  totalInputTokens += backendResult.tokensUsed.input;
  totalOutputTokens += backendResult.tokensUsed.output;
  totalCacheCreationTokens += backendResult.tokensUsed.cacheCreation;
  totalCacheReadTokens += backendResult.tokensUsed.cacheRead;
  totalCost += backendResult.cost;

  // Phase 3: Frontend
  const frontendResult = await generatePhaseTickets(
    'frontend',
    requirementsContent,
    repoInfo.localPath
  );
  totalInputTokens += frontendResult.tokensUsed.input;
  totalOutputTokens += frontendResult.tokensUsed.output;
  totalCacheCreationTokens += frontendResult.tokensUsed.cacheCreation;
  totalCacheReadTokens += frontendResult.tokensUsed.cacheRead;
  totalCost += frontendResult.cost;

  const totalTickets =
    schemaResult.tickets.length + backendResult.tickets.length + frontendResult.tickets.length;

  return {
    schemaTickets: schemaResult.tickets,
    backendTickets: backendResult.tickets,
    frontendTickets: frontendResult.tickets,
    totalTickets,
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
 * Main tickets command
 */
export async function ticketsCommand(options: TicketsOptions): Promise<void> {
  console.log('🎫 Starting Ticket Generation...\n');

  try {
    // Validate environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    // Execute core logic
    const result = await ticketsCore(options);

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

    // Save to file
    const outputPath = options.output || 'tickets.json';
    const outputData = {
      generatedAt: new Date().toISOString(),
      totalTickets: result.totalTickets,
      tickets: [...result.schemaTickets, ...result.backendTickets, ...result.frontendTickets],
    };

    writeFileSync(outputPath, JSON.stringify(outputData, null, 2), 'utf-8');
    console.log(`💾 Tickets saved to: ${outputPath}\n`);

    console.log('✅ Ticket generation completed successfully!');
  } catch (error) {
    console.error('\n❌ Ticket generation failed:', error);
    throw error;
  }
}
