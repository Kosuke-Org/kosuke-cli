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

import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { Ticket, TicketsOptions, TicketsResult } from '../types.js';
import { formatCostBreakdown, runAgent } from '../utils/claude-agent.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';

/**
 * Build system prompt for ticket generation with integrated analysis
 */
function buildTicketGenerationPrompt(
  phase: 'schema' | 'backend' | 'frontend',
  ticketType: 'scaffold' | 'logic',
  requirementsContent: string,
  projectPath: string
): string {
  const phaseTypeKey = `${phase}_${ticketType}` as const;

  const phaseInstructions: Record<typeof phaseTypeKey, string> = {
    schema_scaffold: `
**GENERATE: ONE DATABASE SCHEMA SCAFFOLD TICKET**

This ticket should handle infrastructure/setup database changes based on the analysis:
- Modifications to auth tables (if organizations needed or removed)
- Billing/subscription tables (if changed or removed)
- Email verification/notification tables
- Any template baseline schema adjustments

**Key Focus:**
- What needs to be REMOVED from template (e.g., organization tables if not needed)
- What needs to be ADDED for infrastructure (e.g., organization support if needed)
- Updates to existing template tables for new requirements

Ticket ID: SCHEMA-SCAFFOLD-1
`,
    schema_logic: `
**GENERATE: ONE DATABASE SCHEMA BUSINESS LOGIC TICKET**

This ticket should handle core business domain tables based on the analysis:
- Main application entities (e.g., tasks, projects, posts, campaigns)
- Business-specific relationships
- Domain-specific fields and constraints
- Application data models

**Key Focus:**
- Core business entities unique to this application
- Relationships between business entities
- NOT infrastructure tables (auth, billing, etc.)

Ticket ID: SCHEMA-LOGIC-1
`,
    backend_scaffold: `
**GENERATE: BACKEND SCAFFOLD TICKETS**

Generate tickets for infrastructure/setup backend changes:
- Auth modifications (add/remove organization support, change providers)
- Billing API changes (remove Stripe, add different tiers, etc.)
- Email template setup (create transactional email templates)
- Landing page API routes (if needed)
- Third-party integrations setup

**Granularity:**
- ONE ticket per infrastructure area (auth, billing, email, landing)
- Let Claude decide granularity based on complexity
- Each ticket should be independently implementable

Ticket IDs: BACKEND-SCAFFOLD-1, BACKEND-SCAFFOLD-2, etc. (sequential)
`,
    backend_logic: `
**GENERATE: BACKEND BUSINESS LOGIC TICKETS**

Generate tickets for core application backend features:
- API endpoints for business entities
- Service layer logic
- Business rules and validation
- Application-specific data processing
- Feature-specific integrations

**Granularity:**
- ONE ticket per feature/module
- Let Claude decide granularity based on complexity
- Each ticket should be independently implementable

Ticket IDs: BACKEND-LOGIC-1, BACKEND-LOGIC-2, etc. (sequential)
`,
    frontend_scaffold: `
**GENERATE: FRONTEND SCAFFOLD TICKETS**

Generate tickets for infrastructure/setup frontend changes:
- Auth UI modifications (add/remove organization switcher, change auth flow)
- Billing UI changes (subscription management, pricing page updates)
- Landing page customization
- Email template previews
- Navigation/layout updates for infrastructure changes

**Granularity:**
- ONE ticket per infrastructure area
- Let Claude decide granularity based on complexity
- Each ticket should be independently implementable

Ticket IDs: FRONTEND-SCAFFOLD-1, FRONTEND-SCAFFOLD-2, etc. (sequential)
`,
    frontend_logic: `
**GENERATE: FRONTEND BUSINESS LOGIC TICKETS**

Generate tickets for core application frontend features:
- Application-specific pages
- Feature-specific UI components
- Business logic forms
- User workflows
- Application state management

**Granularity:**
- ONE ticket per PAGE or major feature
- Let Claude decide granularity based on complexity
- Each ticket should cover all components and functionality for that area

Ticket IDs: FRONTEND-LOGIC-1, FRONTEND-LOGIC-2, etc. (sequential)
`,
  };

  const categoryGuidance =
    ticketType === 'scaffold'
      ? `
**Category Assignment:**
Assign appropriate category to each ticket:
- "auth" - Authentication and authorization changes
- "billing" - Payment and subscription changes
- "email" - Transactional email setup
- "landing" - Public marketing pages
- "infrastructure" - General setup/configuration
`
      : `
**Category Assignment:**
Assign appropriate category based on business domain:
- Use the main entity name (e.g., "tasks", "projects", "campaigns")
- Or use feature name (e.g., "user-management", "notifications", "analytics")
- Keep categories consistent across related tickets
`;

  const templateBaseline = `
**Kosuke Template Baseline (what the template already includes):**
- **Authentication**: Better Auth with Email OTP
- **User Model**: Individual users (no organizations/multi-tenancy by default)
- **Billing**: Stripe with subscription tiers (free, pro, business)
- **Email**: Resend for transactional emails
- **Landing Page**: Basic marketing site with pricing
- **Database**: PostgreSQL with Drizzle ORM
- **Stack**: Next.js 15, React 19, TypeScript, Tailwind, Shadcn UI

**Analysis Instructions:**
Before generating tickets, analyze the requirements to understand:
1. **Auth**: Does it need organizations/multi-tenancy? Different auth provider?
2. **Billing**: Keep Stripe? Remove billing entirely? Different tiers?
3. **Email**: What transactional emails are needed? Custom templates?
4. **Landing**: Customize marketing pages? Remove landing page?
5. **Core Domain**: What are the main business entities and workflows?

For SCAFFOLD tickets:
- Identify what needs to be REMOVED from template (if not needed)
- Identify what needs to be ADDED to template (if needed)
- Identify what needs to be CUSTOMIZED (landing page, email templates, etc.)

For LOGIC tickets:
- Focus on core business functionality
- Implement application-specific features
- Build domain models and workflows
`;

  return `You are an expert software architect generating implementation tickets for a Kosuke Template project.

**Your Task:**
${phaseInstructions[phaseTypeKey]}

**Requirements Document:**
${requirementsContent}

${templateBaseline}

**Context:**
You have access to the project directory at: ${projectPath}
The template baseline is documented in CLAUDE.md.
Explore the codebase to understand the tech stack, architecture patterns, and coding conventions.

**Ticket Structure:**
Each ticket must be a JSON object with:
- id: string (e.g., "SCHEMA-SCAFFOLD-1", "BACKEND-LOGIC-2")
- title: string (clear, concise title)
- description: string (detailed description with acceptance criteria)
- type: "${ticketType}" (scaffold or logic)
- estimatedEffort: number (1-10, where 1=very easy, 10=very complex)
- status: "Todo" (all tickets start as Todo)
- category: string (see guidance below)
${categoryGuidance}

**Output Format:**
Return ONLY a valid JSON array of tickets. No markdown, no code blocks, just raw JSON.

Example:
[
  {
    "id": "BACKEND-SCAFFOLD-1",
    "title": "Remove organization support from authentication",
    "description": "Remove multi-tenancy/organization features from the template:\\n- Remove organization tables from schema\\n- Update user model to remove org references\\n- Simplify auth middleware (no org context)\\n- Remove org switcher from UI\\n\\nAcceptance Criteria:\\n- All organization references removed from codebase\\n- Auth flow works for individual users only\\n- Database migrations remove org tables\\n- No compilation errors",
    "type": "scaffold",
    "estimatedEffort": 6,
    "status": "Todo",
    "category": "auth"
  }
]

**Critical Instructions:**
1. Analyze requirements against template baseline
2. Explore the project directory to understand existing patterns (use read_file, grep, codebase_search)
3. Generate tickets that are actionable and specific
4. Return ONLY valid JSON - no explanations, no markdown formatting
5. Ensure ticket IDs follow the naming convention (${phase.toUpperCase()}-${ticketType.toUpperCase()}-N)
6. Make descriptions detailed with clear acceptance criteria
7. Estimate effort realistically (consider complexity, dependencies, testing)
8. Assign appropriate categories for organization and filtering
9. For scaffold tickets: focus on infrastructure changes (add/remove/customize template features)
10. For logic tickets: focus on business domain implementation

Begin by exploring the project directory, analyzing requirements, then generate the tickets.`;
}

/**
 * Parse tickets from Claude's response
 */
function parseTicketsFromResponse(response: string, phase: string, ticketType: string): Ticket[] {
  try {
    // Extract JSON from response (in case Claude includes extra text)
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error(`No JSON array found in ${phase} ${ticketType} response`);
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
      if (!ticket.type || (ticket.type !== 'scaffold' && ticket.type !== 'logic')) {
        throw new Error(`Invalid or missing type for ticket ${ticket.id}: ${ticket.type}`);
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
    console.error(`\n❌ Failed to parse tickets from ${phase} ${ticketType} phase:`);
    console.error(`Raw response:\n${response.substring(0, 500)}...\n`);
    throw new Error(
      `Failed to parse ${phase} ${ticketType} tickets: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Write tickets to file incrementally
 */
function writeTicketsToFile(outputPath: string, tickets: Ticket[]): void {
  const outputData = {
    generatedAt: new Date().toISOString(),
    totalTickets: tickets.length,
    tickets,
  };

  writeFileSync(outputPath, JSON.stringify(outputData, null, 2), 'utf-8');
}

/**
 * Generate tickets for a specific phase and type
 */
async function generatePhaseTickets(
  phase: 'schema' | 'backend' | 'frontend',
  ticketType: 'scaffold' | 'logic',
  requirementsContent: string,
  projectPath: string,
  outputPath: string,
  existingTickets: Ticket[]
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

  const typeEmoji = {
    scaffold: '🏗️',
    logic: '💡',
  };

  const phaseName = {
    schema: 'Schema',
    backend: 'Backend',
    frontend: 'Frontend',
  };

  const typeName = {
    scaffold: 'Scaffold',
    logic: 'Logic',
  };

  console.log(`\n${'='.repeat(60)}`);
  console.log(
    `${phaseEmoji[phase]} ${typeEmoji[ticketType]}  ${phaseName[phase]} ${typeName[ticketType]} Tickets`
  );
  console.log(`${'='.repeat(60)}\n`);

  const systemPrompt = buildTicketGenerationPrompt(
    phase,
    ticketType,
    requirementsContent,
    projectPath
  );

  const agentResult = await runAgent(
    `Generate ${phaseName[phase]} ${typeName[ticketType]} tickets from the requirements.`,
    {
      systemPrompt,
      cwd: projectPath,
      maxTurns: 25,
      verbosity: 'normal',
      captureConversation: true,
    }
  );

  // Parse tickets from response
  const tickets = parseTicketsFromResponse(agentResult.response, phase, ticketType);

  console.log(
    `\n✅ Generated ${tickets.length} ${phaseName[phase]} ${typeName[ticketType]} ticket${tickets.length === 1 ? '' : 's'}`
  );
  tickets.forEach((ticket) => {
    console.log(
      `   ${phaseEmoji[phase]} ${ticket.id}: ${ticket.title} (Effort: ${ticket.estimatedEffort}/10${ticket.category ? `, Category: ${ticket.category}` : ''})`
    );
  });

  // Write tickets incrementally after each phase
  const allTickets = [...existingTickets, ...tickets];
  writeTicketsToFile(outputPath, allTickets);

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

  // 4. Generate tickets in six phases (scaffold + logic for each)
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

  // Track all tickets
  let allTickets: Ticket[] = [];

  // SCAFFOLD TICKETS (Infrastructure changes)
  // Phase 1: Schema Scaffold
  const schemaScaffoldResult = await generatePhaseTickets(
    'schema',
    'scaffold',
    requirementsContent,
    projectPath,
    outputPath,
    allTickets
  );
  allTickets = [...allTickets, ...schemaScaffoldResult.tickets];
  totalInputTokens += schemaScaffoldResult.tokensUsed.input;
  totalOutputTokens += schemaScaffoldResult.tokensUsed.output;
  totalCacheCreationTokens += schemaScaffoldResult.tokensUsed.cacheCreation;
  totalCacheReadTokens += schemaScaffoldResult.tokensUsed.cacheRead;
  totalCost += schemaScaffoldResult.cost;
  allConversationMessages.push(...schemaScaffoldResult.conversationMessages);

  // Phase 2: Backend Scaffold
  const backendScaffoldResult = await generatePhaseTickets(
    'backend',
    'scaffold',
    requirementsContent,
    projectPath,
    outputPath,
    allTickets
  );
  allTickets = [...allTickets, ...backendScaffoldResult.tickets];
  totalInputTokens += backendScaffoldResult.tokensUsed.input;
  totalOutputTokens += backendScaffoldResult.tokensUsed.output;
  totalCacheCreationTokens += backendScaffoldResult.tokensUsed.cacheCreation;
  totalCacheReadTokens += backendScaffoldResult.tokensUsed.cacheRead;
  totalCost += backendScaffoldResult.cost;
  allConversationMessages.push(...backendScaffoldResult.conversationMessages);

  // Phase 3: Frontend Scaffold
  const frontendScaffoldResult = await generatePhaseTickets(
    'frontend',
    'scaffold',
    requirementsContent,
    projectPath,
    outputPath,
    allTickets
  );
  allTickets = [...allTickets, ...frontendScaffoldResult.tickets];
  totalInputTokens += frontendScaffoldResult.tokensUsed.input;
  totalOutputTokens += frontendScaffoldResult.tokensUsed.output;
  totalCacheCreationTokens += frontendScaffoldResult.tokensUsed.cacheCreation;
  totalCacheReadTokens += frontendScaffoldResult.tokensUsed.cacheRead;
  totalCost += frontendScaffoldResult.cost;
  allConversationMessages.push(...frontendScaffoldResult.conversationMessages);

  // LOGIC TICKETS (Business functionality)
  // Phase 4: Schema Logic
  const schemaLogicResult = await generatePhaseTickets(
    'schema',
    'logic',
    requirementsContent,
    projectPath,
    outputPath,
    allTickets
  );
  allTickets = [...allTickets, ...schemaLogicResult.tickets];
  totalInputTokens += schemaLogicResult.tokensUsed.input;
  totalOutputTokens += schemaLogicResult.tokensUsed.output;
  totalCacheCreationTokens += schemaLogicResult.tokensUsed.cacheCreation;
  totalCacheReadTokens += schemaLogicResult.tokensUsed.cacheRead;
  totalCost += schemaLogicResult.cost;
  allConversationMessages.push(...schemaLogicResult.conversationMessages);

  // Phase 5: Backend Logic
  const backendLogicResult = await generatePhaseTickets(
    'backend',
    'logic',
    requirementsContent,
    projectPath,
    outputPath,
    allTickets
  );
  allTickets = [...allTickets, ...backendLogicResult.tickets];
  totalInputTokens += backendLogicResult.tokensUsed.input;
  totalOutputTokens += backendLogicResult.tokensUsed.output;
  totalCacheCreationTokens += backendLogicResult.tokensUsed.cacheCreation;
  totalCacheReadTokens += backendLogicResult.tokensUsed.cacheRead;
  totalCost += backendLogicResult.cost;
  allConversationMessages.push(...backendLogicResult.conversationMessages);

  // Phase 6: Frontend Logic
  const frontendLogicResult = await generatePhaseTickets(
    'frontend',
    'logic',
    requirementsContent,
    projectPath,
    outputPath,
    allTickets
  );
  allTickets = [...allTickets, ...frontendLogicResult.tickets];
  totalInputTokens += frontendLogicResult.tokensUsed.input;
  totalOutputTokens += frontendLogicResult.tokensUsed.output;
  totalCacheCreationTokens += frontendLogicResult.tokensUsed.cacheCreation;
  totalCacheReadTokens += frontendLogicResult.tokensUsed.cacheRead;
  totalCost += frontendLogicResult.cost;
  allConversationMessages.push(...frontendLogicResult.conversationMessages);

  // Separate tickets by phase for result
  const schemaTickets = allTickets.filter((t) => t.id.startsWith('SCHEMA-'));
  const backendTickets = allTickets.filter((t) => t.id.startsWith('BACKEND-'));
  const frontendTickets = allTickets.filter((t) => t.id.startsWith('FRONTEND-'));

  return {
    schemaTickets,
    backendTickets,
    frontendTickets,
    totalTickets: allTickets.length,
    projectPath,
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
    const scaffoldTickets = [
      ...result.schemaTickets,
      ...result.backendTickets,
      ...result.frontendTickets,
    ].filter((t) => t.type === 'scaffold');
    const logicTickets = [
      ...result.schemaTickets,
      ...result.backendTickets,
      ...result.frontendTickets,
    ].filter((t) => t.type === 'logic');

    console.log(`\n${'='.repeat(60)}`);
    console.log('📊 Ticket Generation Summary');
    console.log(`${'='.repeat(60)}`);
    console.log(`\n🏗️  Scaffold Tickets (Infrastructure): ${scaffoldTickets.length}`);
    console.log(
      `   🗄️  Schema: ${result.schemaTickets.filter((t) => t.type === 'scaffold').length}`
    );
    console.log(
      `   ⚙️  Backend: ${result.backendTickets.filter((t) => t.type === 'scaffold').length}`
    );
    console.log(
      `   🎨 Frontend: ${result.frontendTickets.filter((t) => t.type === 'scaffold').length}`
    );
    console.log(`\n💡 Logic Tickets (Business Functionality): ${logicTickets.length}`);
    console.log(`   🗄️  Schema: ${result.schemaTickets.filter((t) => t.type === 'logic').length}`);
    console.log(
      `   ⚙️  Backend: ${result.backendTickets.filter((t) => t.type === 'logic').length}`
    );
    console.log(
      `   🎨 Frontend: ${result.frontendTickets.filter((t) => t.type === 'logic').length}`
    );
    console.log(`\n📝 Total Tickets: ${result.totalTickets}`);
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
