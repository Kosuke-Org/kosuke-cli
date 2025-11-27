/**
 * Tickets command - Generate tickets from requirements document
 *
 * This command analyzes a requirements document (default: docs.md) and generates
 * structured tickets with test coverage:
 *
 * SCAFFOLD BATCH:
 *   1. Schema scaffold (database infrastructure)
 *   2. DB test (validate scaffold schema)
 *   3. Backend scaffold (API infrastructure)
 *   4. Frontend scaffold (UI infrastructure)
 *   5. Web tests (validate scaffold E2E)
 *
 * LOGIC BATCHES (1..N):
 *   1. Schema logic (business entities)
 *   2. DB test (validate logic schema)
 *   3. Backend logic (business API)
 *   4. Frontend logic (business UI)
 *   5. Web tests (validate logic E2E)
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
import type { LayerAnalysis, Ticket, TicketsOptions, TicketsResult } from '../types.js';
import { formatCostBreakdown, runAgent } from '../utils/claude-agent.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';

/**
 * Analyze requirements to determine which layers are needed
 */
async function analyzeRequiredLayers(
  requirementsContent: string,
  projectPath: string
): Promise<LayerAnalysis> {
  console.log('🔍 Analyzing requirements to determine needed layers...\n');

  const systemPrompt = `You are an expert software architect analyzing requirements to determine which layers need changes.

**Your Task:**
Analyze the requirements and determine which layers (schema/backend/frontend) need changes.

**Requirements:**
${requirementsContent}

**Context:**
You have access to the project directory at: ${projectPath}
Explore the codebase to understand the existing architecture and tech stack.

**Analysis Criteria:**

**Schema (Database):**
- New tables, columns, or relationships
- Changes to existing database structure
- Data model modifications
- Examples: "Add comments to posts", "Track user preferences", "Store session data"

**Backend (API):**
- New API endpoints or business logic
- Changes to existing endpoints
- Server-side processing or validation
- Integration with external services
- Examples: "Export data to CSV", "Send email notifications", "Process payments"

**Frontend (UI):**
- New pages, components, or user interactions
- Changes to existing UI
- User-facing features
- Examples: "Add dark mode toggle", "Create dashboard", "Build user profile page"

**Important:**
- Simple UI changes (styling, layout) typically DON'T need backend or schema changes
- Features involving data persistence ALWAYS need schema + backend + frontend
- API-only features (webhooks, cron jobs) may not need frontend changes
- Be precise - only include layers that are actually needed

**Output Format:**
Return ONLY a valid JSON object with this structure:
{
  "needsSchema": boolean,
  "needsBackend": boolean,
  "needsFrontend": boolean,
  "reasoning": "Brief explanation of why each layer is or isn't needed"
}

No markdown, no code blocks, just raw JSON.`;

  const agentResult = await runAgent('Analyze requirements and determine needed layers', {
    systemPrompt,
    cwd: projectPath,
    maxTurns: 15,
    verbosity: 'minimal',
  });

  // Parse response
  try {
    const jsonMatch = agentResult.response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in analysis response');
    }

    const analysis = JSON.parse(jsonMatch[0]) as LayerAnalysis;

    // Validate structure
    if (
      typeof analysis.needsSchema !== 'boolean' ||
      typeof analysis.needsBackend !== 'boolean' ||
      typeof analysis.needsFrontend !== 'boolean' ||
      typeof analysis.reasoning !== 'string'
    ) {
      throw new Error('Invalid analysis structure');
    }

    return analysis;
  } catch (error) {
    console.error('❌ Failed to parse layer analysis:', error);
    console.error('Raw response:', agentResult.response.substring(0, 500));
    throw new Error(
      `Failed to analyze required layers: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Build system prompt for DB test ticket generation
 */
function buildDBTestPrompt(
  batchType: 'scaffold' | 'logic',
  requirementsContent: string,
  projectPath: string,
  previousSchemaTickets: Ticket[]
): string {
  const ticketId = batchType === 'scaffold' ? 'DB-TEST-1' : 'DB-TEST-2';

  const schemaTicketsContext = previousSchemaTickets
    .map((t) => `**${t.id}: ${t.title}**\n${t.description}`)
    .join('\n\n');

  return `You are an expert QA engineer generating database validation test tickets.

**Your Task:**
Generate ONE database test ticket to validate the schema implementation from the tickets below.

**Schema Tickets to Validate:**
${schemaTicketsContext}

**Database Test Ticket Goal:**
Based on the schema tickets above, create a test that validates those tables were correctly created:
1. Extract all table names mentioned in the schema tickets
2. List all tables that need to be validated
3. Create a test ticket that checks those tables exist

**IMPORTANT:**
- Do NOT explore the codebase
- Do NOT look at existing schema files
- ONLY use the schema tickets above to determine what tables to validate
- The test should verify that the tables described in those tickets exist

**Ticket Structure:**
- id: "${ticketId}"
- title: Clear description of what schema is being validated
- description: Detailed test plan with:
  * List of tables to validate (extracted from schema tickets above)
  * What to check: verify all tables exist
  * Success criteria: all tables from schema tickets exist in database
- type: "db-test"
- estimatedEffort: 1-3 (these are simple validation tests)
- status: "Todo"
- category: "database-validation"

**Output Format:**
Return ONLY a valid JSON array with ONE ticket. No markdown, no code blocks, just raw JSON.

Example:
[
  {
    "id": "DB-TEST-1",
    "title": "Validate scaffold database schema",
    "description": "Verify that the scaffold schema has been correctly implemented based on SCHEMA-SCAFFOLD-1:\\n\\nTables to validate:\\n- users\\n- user_subscriptions\\n- notifications\\n\\nValidation checks:\\n- Verify all tables exist\\n- Check table names are correct\\n\\nAcceptance Criteria:\\n- All tables from SCHEMA-SCAFFOLD-1 exist in database\\n- No schema errors",
    "type": "db-test",
    "estimatedEffort": 2,
    "status": "Todo",
    "category": "database-validation"
  }
]

**Critical Instructions:**
1. Analyze the schema tickets above to extract table names
2. Generate a focused test ticket that validates those specific tables exist
3. Reference the schema ticket IDs in the description
4. Keep descriptions clear and actionable
5. Return ONLY valid JSON - no explanations, no markdown formatting`;
}

/**
 * Build system prompt for Web test ticket generation
 */
function buildWebTestPrompt(
  batchType: 'scaffold' | 'logic',
  requirementsContent: string,
  projectPath: string,
  previousImplementationTickets: { backend: Ticket[]; frontend: Ticket[] },
  startingNumber: number
): string {
  const backendTicketsContext = previousImplementationTickets.backend
    .map((t) => `**${t.id}: ${t.title}**\n${t.description}`)
    .join('\n\n');

  const frontendTicketsContext = previousImplementationTickets.frontend
    .map((t) => `**${t.id}: ${t.title}**\n${t.description}`)
    .join('\n\n');

  return `You are an expert QA engineer generating end-to-end web test tickets.

**Your Task:**
Generate web test tickets to validate the implementation from the backend and frontend tickets below.

**Backend Tickets to Validate:**
${backendTicketsContext || 'No backend tickets for this batch'}

**Frontend Tickets to Validate:**
${frontendTicketsContext || 'No frontend tickets for this batch'}

**Web Test Ticket Goals:**
Based on the implementation tickets above, create tests that validate those features work end-to-end:
1. Analyze the backend and frontend tickets to understand what features were implemented
2. Create test tickets that verify those features work correctly in the browser
3. Focus on user-facing functionality and complete user flows

**IMPORTANT:**
- Do NOT explore the codebase
- Do NOT look at existing frontend implementation
- ONLY use the implementation tickets above to determine what to test
- The tests should verify that the features described in those tickets work end-to-end

Let Claude decide granularity based on complexity - could be:
- One test per major user flow
- One test covering multiple related features
- Multiple tests for complex features

**Ticket Structure:**
Each ticket must have:
- id: "WEB-TEST-${startingNumber}", "WEB-TEST-${startingNumber + 1}", etc. (sequential)
- title: Clear description of what is being tested
- description: Detailed test plan with:
  * Reference to implementation tickets being tested
  * User flow to test
  * Steps to execute
  * Expected outcomes (based on implementation tickets)
  * Success criteria
- type: "web-test"
- estimatedEffort: number (1-10 based on test complexity)
- status: "Todo"
- category: feature name being tested

**Output Format:**
Return ONLY a valid JSON array of tickets. No markdown, no code blocks, just raw JSON.

Example:
[
  {
    "id": "WEB-TEST-1",
    "title": "Test authentication flow (validates BACKEND-SCAFFOLD-1, FRONTEND-SCAFFOLD-1)",
    "description": "Validate that the authentication implementation from BACKEND-SCAFFOLD-1 and FRONTEND-SCAFFOLD-1 works end-to-end:\\n\\nTest Flow:\\n1. Navigate to sign-in page\\n2. Enter credentials\\n3. Submit form\\n4. Verify redirect to dashboard\\n5. Check user session is active\\n\\nExpected Results (from implementation tickets):\\n- Sign-in successful\\n- User redirected to dashboard\\n- Protected content visible\\n\\nAcceptance Criteria:\\n- Authentication works as described in BACKEND-SCAFFOLD-1\\n- UI matches FRONTEND-SCAFFOLD-1 requirements\\n- No console errors\\n- Session persists correctly",
    "type": "web-test",
    "estimatedEffort": 5,
    "status": "Todo",
    "category": "authentication"
  }
]

**Critical Instructions:**
1. Analyze the implementation tickets above to extract features to test
2. Generate test tickets that validate those specific features
3. Reference the implementation ticket IDs in test descriptions
4. Focus on end-to-end user flows that span backend + frontend
5. Make descriptions detailed with clear steps
6. Return ONLY valid JSON - no explanations, no markdown formatting
7. Ensure ticket IDs are sequential starting from WEB-TEST-${startingNumber}`;
}

/**
 * Build system prompt for ticket generation with integrated analysis
 */
function buildTicketGenerationPrompt(
  phase: 'schema' | 'backend' | 'frontend' | 'db-test' | 'web-test',
  ticketType: 'scaffold' | 'logic' | 'db-test' | 'web-test',
  requirementsContent: string,
  projectPath: string,
  isScaffoldMode: boolean,
  previousTickets?: {
    schema?: Ticket[];
    backend?: Ticket[];
    frontend?: Ticket[];
    webTestStartNumber?: number;
  }
): string {
  // Handle test tickets differently
  if (phase === 'db-test') {
    return buildDBTestPrompt(
      ticketType as 'scaffold' | 'logic',
      requirementsContent,
      projectPath,
      previousTickets?.schema || []
    );
  }
  if (phase === 'web-test') {
    const startingNumber = previousTickets?.webTestStartNumber || 1;

    return buildWebTestPrompt(
      ticketType as 'scaffold' | 'logic',
      requirementsContent,
      projectPath,
      {
        backend: previousTickets?.backend || [],
        frontend: previousTickets?.frontend || [],
      },
      startingNumber
    );
  }

  // For implementation tickets (schema, backend, frontend)
  type ImplPhase = 'schema' | 'backend' | 'frontend';
  type ImplType = 'scaffold' | 'logic';
  const phaseTypeKey = `${phase as ImplPhase}_${ticketType as ImplType}` as const;

  const phaseInstructions: Record<`${ImplPhase}_${ImplType}`, string> = {
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

  const contextualGuidance = isScaffoldMode
    ? `
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
`
    : `
**Project Context:**
Explore the codebase to understand:
- Tech stack and framework versions (Next.js, React, etc.)
- Existing architecture patterns (App Router, API routes, etc.)
- Database schema structure and ORM (Drizzle, Prisma, etc.)
- API route patterns and conventions
- UI component library and styling approach
- Testing framework and patterns
- Authentication system (if any)
- State management approach

**Critical Instructions:**
- Generate tickets that follow existing patterns in the codebase
- Use the same naming conventions, file structure, and code style
- Leverage existing utilities and components where possible
- Match the existing tech stack (don't introduce new frameworks)
- Follow the project's architectural decisions
- Maintain consistency with existing code quality standards
`;

  return `You are an expert software architect generating implementation tickets for ${isScaffoldMode ? 'a Kosuke Template project' : 'an existing project'}.

**Your Task:**
${phaseInstructions[phaseTypeKey]}

**Requirements Document:**
${requirementsContent}

${contextualGuidance}

**Context:**
You have access to the project directory at: ${projectPath}
${isScaffoldMode ? 'The template baseline is documented in CLAUDE.md.' : ''}
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

    const validTypes = ['scaffold', 'logic', 'db-test', 'web-test'];

    for (const ticket of tickets) {
      if (!ticket.id || !ticket.title || !ticket.description) {
        throw new Error(`Invalid ticket structure: ${JSON.stringify(ticket)}`);
      }
      if (!ticket.type || !validTypes.includes(ticket.type)) {
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
  phase: 'schema' | 'backend' | 'frontend' | 'db-test' | 'web-test',
  ticketType: 'scaffold' | 'logic' | 'db-test' | 'web-test',
  requirementsContent: string,
  projectPath: string,
  outputPath: string,
  existingTickets: Ticket[],
  isScaffoldMode: boolean,
  previousTickets?: {
    schema?: Ticket[];
    backend?: Ticket[];
    frontend?: Ticket[];
    webTestStartNumber?: number;
  }
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
  const phaseEmoji: Record<string, string> = {
    schema: '🗄️',
    backend: '⚙️',
    frontend: '🎨',
    'db-test': '🧪',
    'web-test': '🌐',
  };

  const typeEmoji: Record<string, string> = {
    scaffold: '🏗️',
    logic: '💡',
    'db-test': '🧪',
    'web-test': '🌐',
  };

  const phaseName: Record<string, string> = {
    schema: 'Schema',
    backend: 'Backend',
    frontend: 'Frontend',
    'db-test': 'DB Test',
    'web-test': 'Web Test',
  };

  const typeName: Record<string, string> = {
    scaffold: 'Scaffold',
    logic: 'Logic',
    'db-test': 'DB Test',
    'web-test': 'Web Test',
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
    projectPath,
    isScaffoldMode,
    previousTickets
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
  const { directory, scaffold = false } = options;
  const isScaffoldMode = scaffold;

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

  console.log(`📁 Using project directory: ${projectPath}`);
  console.log(
    `🏗️  Mode: ${isScaffoldMode ? 'Scaffold (infrastructure + logic)' : 'Logic-only (smart layer detection)'}\n`
  );

  // 2. Get requirements content (from prompt or file)
  let requirementsContent: string;

  if (options.prompt && options.path) {
    throw new Error(
      'Cannot use both --prompt and --path. Please provide only one:\n' +
        '  kosuke tickets --prompt="Add dark mode"\n' +
        '  kosuke tickets --path=docs.md'
    );
  }

  if (options.prompt) {
    requirementsContent = options.prompt;
    console.log(`📝 Using inline prompt (${requirementsContent.length} characters)\n`);
  } else if (options.path) {
    const requirementsPath = join(projectPath, options.path);
    if (!existsSync(requirementsPath)) {
      throw new Error(
        `Requirements document not found: ${options.path}\n` +
          `Please provide a valid path using --path=<file>\n` +
          `Example: kosuke tickets --path=requirements.md`
      );
    }
    requirementsContent = readFileSync(requirementsPath, 'utf-8');
    console.log(`📄 Loaded ${options.path} (${requirementsContent.length} characters)\n`);
  } else {
    // Default to docs.md if neither prompt nor path provided
    const defaultPath = 'docs.md';
    const requirementsPath = join(projectPath, defaultPath);
    if (!existsSync(requirementsPath)) {
      throw new Error(
        'Requirements not provided. Use either:\n' +
          '  --prompt="Your requirements here"\n' +
          '  --path=requirements.md\n' +
          '  Or create a docs.md file in the project directory'
      );
    }
    requirementsContent = readFileSync(requirementsPath, 'utf-8');
    console.log(`📄 Loaded ${defaultPath} (${requirementsContent.length} characters)\n`);
  }

  // 3. Determine output path for incremental writes
  const outputFilename = options.output || 'tickets.json';
  const outputPath = join(projectPath, outputFilename);

  // 4. Analyze required layers (only in logic-only mode)
  let layerAnalysis: LayerAnalysis | null = null;

  if (!isScaffoldMode) {
    layerAnalysis = await analyzeRequiredLayers(requirementsContent, projectPath);

    console.log(`\n📊 Layer Analysis:`);
    console.log(`   Schema (DB):   ${layerAnalysis.needsSchema ? '✅ Required' : '⏭️  Skip'}`);
    console.log(`   Backend (API): ${layerAnalysis.needsBackend ? '✅ Required' : '⏭️  Skip'}`);
    console.log(`   Frontend (UI): ${layerAnalysis.needsFrontend ? '✅ Required' : '⏭️  Skip'}`);
    console.log(`\n💭 Reasoning: ${layerAnalysis.reasoning}\n`);
  }

  // 5. Generate tickets in the new structure with tests
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

  // Helper to add metrics from a phase result
  const addMetrics = (result: Awaited<ReturnType<typeof generatePhaseTickets>>) => {
    allTickets = [...allTickets, ...result.tickets];
    totalInputTokens += result.tokensUsed.input;
    totalOutputTokens += result.tokensUsed.output;
    totalCacheCreationTokens += result.tokensUsed.cacheCreation;
    totalCacheReadTokens += result.tokensUsed.cacheRead;
    totalCost += result.cost;
    allConversationMessages.push(...result.conversationMessages);
  };

  // ==================== SCAFFOLD MODE ====================
  if (isScaffoldMode) {
    console.log('\n' + '='.repeat(80));
    console.log('🏗️  SCAFFOLD BATCH - Infrastructure Setup');
    console.log('='.repeat(80));

    // Track batch tickets for test generation
    let batchSchemaTickets: Ticket[] = [];
    let batchBackendTickets: Ticket[] = [];
    let batchFrontendTickets: Ticket[] = [];

    // 1. Schema Scaffold
    const schemaScaffoldResult = await generatePhaseTickets(
      'schema',
      'scaffold',
      requirementsContent,
      projectPath,
      outputPath,
      allTickets,
      isScaffoldMode
    );
    addMetrics(schemaScaffoldResult);
    batchSchemaTickets = schemaScaffoldResult.tickets;

    // 2. DB Test (validate scaffold schema)
    addMetrics(
      await generatePhaseTickets(
        'db-test',
        'scaffold',
        requirementsContent,
        projectPath,
        outputPath,
        allTickets,
        isScaffoldMode,
        { schema: batchSchemaTickets }
      )
    );

    // 3. Backend Scaffold
    const backendScaffoldResult = await generatePhaseTickets(
      'backend',
      'scaffold',
      requirementsContent,
      projectPath,
      outputPath,
      allTickets,
      isScaffoldMode
    );
    addMetrics(backendScaffoldResult);
    batchBackendTickets = backendScaffoldResult.tickets;

    // 4. Frontend Scaffold
    const frontendScaffoldResult = await generatePhaseTickets(
      'frontend',
      'scaffold',
      requirementsContent,
      projectPath,
      outputPath,
      allTickets,
      isScaffoldMode
    );
    addMetrics(frontendScaffoldResult);
    batchFrontendTickets = frontendScaffoldResult.tickets;

    // 5. Web Tests (validate scaffold E2E)
    addMetrics(
      await generatePhaseTickets(
        'web-test',
        'scaffold',
        requirementsContent,
        projectPath,
        outputPath,
        allTickets,
        isScaffoldMode,
        {
          backend: batchBackendTickets,
          frontend: batchFrontendTickets,
          webTestStartNumber: 1,
        }
      )
    );

    // ==================== LOGIC BATCH ====================
    console.log('\n' + '='.repeat(80));
    console.log('💡 LOGIC BATCH - Business Functionality');
    console.log('='.repeat(80));

    // Reset batch tracking for logic
    batchSchemaTickets = [];
    batchBackendTickets = [];
    batchFrontendTickets = [];

    // 1. Schema Logic
    const schemaLogicResult = await generatePhaseTickets(
      'schema',
      'logic',
      requirementsContent,
      projectPath,
      outputPath,
      allTickets,
      isScaffoldMode
    );
    addMetrics(schemaLogicResult);
    batchSchemaTickets = schemaLogicResult.tickets;

    // 2. DB Test (validate logic schema)
    addMetrics(
      await generatePhaseTickets(
        'db-test',
        'logic',
        requirementsContent,
        projectPath,
        outputPath,
        allTickets,
        isScaffoldMode,
        { schema: batchSchemaTickets }
      )
    );

    // 3. Backend Logic
    const backendLogicResult = await generatePhaseTickets(
      'backend',
      'logic',
      requirementsContent,
      projectPath,
      outputPath,
      allTickets,
      isScaffoldMode
    );
    addMetrics(backendLogicResult);
    batchBackendTickets = backendLogicResult.tickets;

    // 4. Frontend Logic
    const frontendLogicResult = await generatePhaseTickets(
      'frontend',
      'logic',
      requirementsContent,
      projectPath,
      outputPath,
      allTickets,
      isScaffoldMode
    );
    addMetrics(frontendLogicResult);
    batchFrontendTickets = frontendLogicResult.tickets;

    // 5. Web Tests (validate logic E2E)
    const currentWebTestCount = allTickets.filter((t) => t.id.startsWith('WEB-TEST-')).length;
    addMetrics(
      await generatePhaseTickets(
        'web-test',
        'logic',
        requirementsContent,
        projectPath,
        outputPath,
        allTickets,
        isScaffoldMode,
        {
          backend: batchBackendTickets,
          frontend: batchFrontendTickets,
          webTestStartNumber: currentWebTestCount + 1,
        }
      )
    );
  } else {
    // ==================== LOGIC-ONLY MODE ====================
    console.log('\n' + '='.repeat(80));
    console.log('💡 LOGIC-ONLY MODE - Smart Layer Detection');
    console.log('='.repeat(80));

    // Track tickets for test generation
    let schemaTickets: Ticket[] = [];
    let backendTickets: Ticket[] = [];
    let frontendTickets: Ticket[] = [];

    // 1. Schema Logic (if needed)
    if (layerAnalysis?.needsSchema) {
      const schemaLogicResult = await generatePhaseTickets(
        'schema',
        'logic',
        requirementsContent,
        projectPath,
        outputPath,
        allTickets,
        isScaffoldMode
      );
      addMetrics(schemaLogicResult);
      schemaTickets = schemaLogicResult.tickets;

      // DB Test (validate schema)
      if (schemaTickets.length > 0) {
        addMetrics(
          await generatePhaseTickets(
            'db-test',
            'logic',
            requirementsContent,
            projectPath,
            outputPath,
            allTickets,
            isScaffoldMode,
            { schema: schemaTickets }
          )
        );
      }
    }

    // 2. Backend Logic (if needed)
    if (layerAnalysis?.needsBackend) {
      const backendLogicResult = await generatePhaseTickets(
        'backend',
        'logic',
        requirementsContent,
        projectPath,
        outputPath,
        allTickets,
        isScaffoldMode
      );
      addMetrics(backendLogicResult);
      backendTickets = backendLogicResult.tickets;
    }

    // 3. Frontend Logic (if needed)
    if (layerAnalysis?.needsFrontend) {
      const frontendLogicResult = await generatePhaseTickets(
        'frontend',
        'logic',
        requirementsContent,
        projectPath,
        outputPath,
        allTickets,
        isScaffoldMode
      );
      addMetrics(frontendLogicResult);
      frontendTickets = frontendLogicResult.tickets;
    }

    // 4. Web Tests (if backend or frontend tickets generated)
    if (backendTickets.length > 0 || frontendTickets.length > 0) {
      addMetrics(
        await generatePhaseTickets(
          'web-test',
          'logic',
          requirementsContent,
          projectPath,
          outputPath,
          allTickets,
          isScaffoldMode,
          {
            backend: backendTickets,
            frontend: frontendTickets,
            webTestStartNumber: 1,
          }
        )
      );
    }
  }

  // Separate tickets by phase for result
  const schemaTickets = allTickets.filter((t) => t.id.startsWith('SCHEMA-'));
  const backendTickets = allTickets.filter((t) => t.id.startsWith('BACKEND-'));
  const frontendTickets = allTickets.filter((t) => t.id.startsWith('FRONTEND-'));
  const testTickets = allTickets.filter(
    (t) => t.id.startsWith('DB-TEST-') || t.id.startsWith('WEB-TEST-')
  );

  return {
    schemaTickets,
    backendTickets,
    frontendTickets,
    testTickets,
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
    const dbTestTickets = result.testTickets.filter((t) => t.type === 'db-test');
    const webTestTickets = result.testTickets.filter((t) => t.type === 'web-test');

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
    console.log(`\n🧪 Test Tickets: ${result.testTickets.length}`);
    console.log(`   🧪 Database Tests: ${dbTestTickets.length}`);
    console.log(`   🌐 Web Tests: ${webTestTickets.length}`);
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
