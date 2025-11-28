/**
 * Tickets command - Generate tickets from requirements document or prompt
 *
 * This command has two modes:
 *
 * 1. PROMPT MODE (--prompt flag):
 *    Uses the `plan` command internally for interactive ticket creation.
 *    Claude asks clarification questions before generating tickets.
 *    Best for: Adding features or fixing bugs in existing projects.
 *
 * 2. DOCUMENT MODE (--path or docs.md):
 *    Generates tickets directly from a requirements document.
 *    No clarification questions - assumes requirements are complete.
 *    Best for: New projects with detailed requirements from `kosuke requirements`.
 *
 * SCAFFOLD MODE (--scaffold flag, document mode only):
 *   SCAFFOLD BATCH (template adaptation):
 *     1. SCAFFOLD-SCHEMA-1 (database infrastructure changes, auto-validated)
 *     2. SCAFFOLD-BACKEND-X (API infrastructure changes)
 *     3. SCAFFOLD-FRONTEND-X (UI infrastructure changes)
 *     4. SCAFFOLD-WEB-TEST-X (validate scaffold E2E)
 *
 *   LOGIC BATCH (business functionality):
 *     1. LOGIC-SCHEMA-1 (business entities, auto-validated)
 *     2. LOGIC-BACKEND-1 (business API)
 *     3. LOGIC-FRONTEND-1 (business UI)
 *     4. LOGIC-WEB-TEST-1 (validate logic E2E)
 *
 * Usage:
 *   kosuke tickets                                    # Use docs.md (no questions)
 *   kosuke tickets --scaffold                         # Scaffold + logic from docs.md
 *   kosuke tickets --path=custom.md                   # Custom requirements file
 *   kosuke tickets --prompt="Add dark mode"           # Interactive with questions
 *   kosuke tickets --prompt="Fix login bug" --dir=./  # Interactive with questions
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { Ticket, TicketsOptions, TicketsResult } from '../types.js';
import { formatCostBreakdown, runAgent } from '../utils/claude-agent.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';
import { planCore } from './plan.js';

/**
 * Build unified system prompt for comprehensive ticket generation
 */
function buildTicketPrompt(
  requirementsContent: string,
  projectPath: string,
  isScaffoldMode: boolean
): string {
  const scaffoldGuidance = isScaffoldMode
    ? `
**SCAFFOLD TICKETS - Template Adaptation ONLY:**

These tickets focus on removing, changing, or customizing the Kosuke Template baseline.
DO NOT add new business logic or features from requirements here.

Scaffold tickets should:
- ❌ REMOVE unused template features (e.g., organizations, billing, multi-tenancy)
- 🔄 CHANGE existing features (e.g., swap Better Auth for Clerk, simplify billing)
- 🎨 CUSTOMIZE infrastructure (landing page, email templates, branding, navigation)

Examples of SCAFFOLD tickets:
- "Remove organization/multi-tenancy support from auth"
- "Simplify billing to single tier (remove pro/business tiers)"
- "Customize landing page for [specific use case]"
- "Remove landing page entirely (internal tool)"
- "Update email templates for [brand name]"

**SCAFFOLD Ticket Ordering:**
1. SCAFFOLD-SCHEMA-1 (one ticket for all database infrastructure changes, auto-validated)
2. SCAFFOLD-BACKEND-1, SCAFFOLD-BACKEND-2, ... (backend infrastructure tickets)
3. SCAFFOLD-FRONTEND-1, SCAFFOLD-FRONTEND-2, ... (frontend infrastructure tickets)
4. SCAFFOLD-WEB-TEST-1, SCAFFOLD-WEB-TEST-2, ... (E2E tests for scaffold)
`
    : '';

  const webTestGuidance = `
**WEB TEST TICKETS - Stagehand Agent E2E Tests:**

Web test tickets are executed by Stagehand agent and must follow these guidelines:

**Test User Discovery:**
1. **ALWAYS read seed files** to find test user credentials:
   - Look for files: lib/db/seed.ts, src/lib/db/seed.ts
   - Pattern: Any email ending with "+kosuke_test@example.com" uses OTP code "424242"
   - Example: john+kosuke_test@example.com → OTP: 424242
   - Include all discovered test users in ticket description

**Ticket Structure Requirements:**
Each web test ticket MUST include:

1. **Test User Credentials** (at the top)
   - List all test users with their emails
   - Document OTP code (424242)
   - Specify user roles if applicable (admin, regular user, etc.)

2. **Test Steps** (numbered, detailed natural language)
   - Navigation instructions ("Navigate to /sign-in")
   - User interactions ("Click button labeled 'New Task'")
   - Input actions ("Enter 'Test Task' in title field")
   - Expected outcomes after each step ("Expected: Task appears in list")
   - Use CLEAR element descriptions (button text, labels, placeholders)
   - Use relative paths only (e.g., /sign-in, /tasks) - base URL provided as test argument

3. **Acceptance Criteria**
   - Final expected state
   - Data validation points
   - User feedback confirmation

**Stagehand Best Practices:**
- Use natural language, NOT code
- Be SPECIFIC about element identification (button text, input labels, exact URLs)
- Include EXPECTED OUTCOMES after each major action
- Combine related flows into ONE ticket (signup → create → invite = 1 ticket)
- Authentication steps MUST be explicit:
  1. Navigate to /sign-in
  2. Enter email: {test_user}+kosuke_test@example.com
  3. Click "Send Code" button
  4. Enter OTP: 424242
  5. Click "Verify" button
  6. Expected: Redirected to dashboard/main app

**Example Web Test Ticket:**

{
  "id": "LOGIC-WEB-TEST-1",
  "title": "E2E: User signup and create first task",
  "description": "**Test User Credentials:**\\n- Email: john+kosuke_test@example.com\\n- OTP Code: 424242\\n\\n**Test Steps:**\\n\\n1. **Sign in with test user**\\n   - Navigate to /sign-in\\n   - Enter email: john+kosuke_test@example.com\\n   - Click button labeled 'Send Code'\\n   - Enter OTP code: 424242\\n   - Click button labeled 'Verify'\\n   - Expected: Redirected to /tasks\\n\\n2. **Create new task**\\n   - Click button with text 'New Task'\\n   - Enter 'My First Task' in the Title field\\n   - Select 'High' from Priority dropdown\\n   - Click 'Create Task' button\\n   - Expected: Task appears in task list\\n   - Expected: Success message shown\\n\\n3. **Verify task persistence**\\n   - Refresh the page\\n   - Expected: Task 'My First Task' still visible\\n   - Expected: Priority shows 'High'\\n\\n**Acceptance Criteria:**\\n- User successfully authenticates with OTP\\n- Task is created and visible\\n- Task persists after page refresh\\n- UI shows appropriate feedback",
  "type": "test",
  "estimatedEffort": 4,
  "status": "Todo",
  "category": "tasks"
}`;

  return `You are an expert software architect generating implementation tickets.

**Requirements Document:**
${requirementsContent}

**Project Context:**
You have access to the project directory at: ${projectPath}

${scaffoldGuidance}
${webTestGuidance}

**LOGIC TICKETS - Business Functionality:**

These tickets implement the actual features and requirements from the document.

Logic tickets should:
- 🗄️ Create schema for business entities (tasks, projects, posts, etc.)
- ⚙️ Build backend APIs for business features
- 🎨 Create frontend UI for business features

**LOGIC Ticket Ordering:**
Each feature can have its own batch of tickets:

Feature 1:
1. LOGIC-SCHEMA-1 (schema for feature 1, auto-validated)
2. LOGIC-BACKEND-1 (backend for feature 1)
3. LOGIC-FRONTEND-1 (frontend for feature 1)
4. LOGIC-WEB-TEST-1 (E2E test for feature 1)

Feature 2:
5. LOGIC-BACKEND-2 (backend for feature 2, if no schema needed)
6. LOGIC-FRONTEND-2 (frontend for feature 2)
7. LOGIC-WEB-TEST-2 (E2E test for feature 2)

**Ticket Granularity:**
- Schema: Usually ONE ticket per batch (scaffold or logic), automatically validated during build
- Backend: Let complexity decide (could be 1-5 tickets per batch)
- Frontend: Let complexity decide (could be 1-5 tickets per batch)
- Web Tests: Let complexity decide (1 test per major user flow)

**Your Task:**
1. **Explore the codebase** using read_file, grep, codebase_search to understand:
   - Current tech stack and framework versions
   - Existing architecture patterns
   - Database schema structure
   - API route patterns
   - UI component library and styling
   ${isScaffoldMode ? '   - What template features are currently present\n   - What needs to be removed, changed, or customized' : ''}

2. **Discover test users** for web testing:
   - Read seed files: lib/db/seed.ts, src/lib/db/seed.ts (use read_file or grep)
   - Look for test user pattern: {name}+kosuke_test@example.com
   - Document all test users found (email addresses)
   - Note: All test users use OTP code 424242 for Better Auth
   - Include test user credentials in ALL web test tickets

3. **Analyze requirements** to determine:
   - Which layers are needed (schema/backend/frontend)
   - How to break down features into logical batches
   - What user flows need E2E web tests

4. **Generate ALL tickets** in the correct order:
   ${isScaffoldMode ? '   - SCAFFOLD batch first (template adaptation)\n   - LOGIC batches second (business features)' : '   - LOGIC batches only (business features)'}
   - Follow the ticket ordering structure above
   - Schema tickets are automatically validated during build (no separate test tickets needed)
   - For web tests: Include test user credentials, detailed steps, and expected outcomes

**Ticket Structure:**
Each ticket must be a JSON object with:
- id: string (e.g., "SCAFFOLD-SCHEMA-1", "LOGIC-BACKEND-2", "SCAFFOLD-WEB-TEST-1")
- title: string (clear, concise title)
- description: string (detailed description with acceptance criteria)
- type: "schema" | "backend" | "frontend" | "test"
- estimatedEffort: number (1-10, where 1=very easy, 10=very complex)
- status: "Todo"
- category: string (e.g., "auth", "billing", "user-management", "tasks")

**Output Format:**
Return ONLY a valid JSON array of ALL tickets in the correct order. No markdown, no code blocks, just raw JSON.

Example:
[
  {
    "id": "SCAFFOLD-SCHEMA-1",
    "title": "Remove organizations and simplify auth schema",
    "description": "Remove multi-tenancy/organization features from database:\\n- Drop organization tables\\n- Remove org foreign keys from users table\\n- Simplify schema to individual users only\\n\\nAcceptance Criteria:\\n- Organization tables removed\\n- User table simplified\\n- Migrations created and validated automatically\\n- No schema errors",
    "type": "schema",
    "estimatedEffort": 5,
    "status": "Todo",
    "category": "auth"
  },
  {
    "id": "LOGIC-WEB-TEST-1",
    "title": "E2E: User creates and manages a task",
    "description": "**Test User Credentials:**\\n- Email: john+kosuke_test@example.com\\n- OTP Code: 424242\\n\\n**Test Steps:**\\n\\n1. **Authenticate as test user**\\n   - Navigate to /sign-in\\n   - Enter email: john+kosuke_test@example.com\\n   - Click 'Send Code' button\\n   - Enter OTP: 424242\\n   - Click 'Verify' button\\n   - Expected: Redirected to /tasks dashboard\\n\\n2. **Create new task**\\n   - Click 'New Task' button\\n   - Enter title: 'Test Task'\\n   - Select priority: 'High'\\n   - Click 'Create' button\\n   - Expected: Task appears in task list\\n   - Expected: Success toast notification shown\\n\\n3. **Edit task**\\n   - Click on the created task\\n   - Change title to: 'Updated Task'\\n   - Expected: Task title updates immediately\\n\\n4. **Delete task**\\n   - Click delete icon on task\\n   - Confirm deletion in dialog\\n   - Expected: Task removed from list\\n\\n**Acceptance Criteria:**\\n- User successfully authenticates\\n- Task creation, editing, and deletion work\\n- UI provides appropriate feedback\\n- Changes persist correctly",
    "type": "test",
    "estimatedEffort": 5,
    "status": "Todo",
    "category": "tasks"
  }
]

**Critical Instructions:**
1. Explore the project directory thoroughly before generating tickets
2. ${isScaffoldMode ? 'For SCAFFOLD: Focus on template adaptation ONLY (remove/change/customize)' : ''}
3. For LOGIC: Focus on business features from requirements
4. **IMPORTANT**: Read seed files (lib/db/seed.ts or src/lib/db/seed.ts) to discover test users
5. **SCHEMA TICKETS**: No separate test tickets needed - validation happens automatically during build
6. **WEB TESTS MUST INCLUDE**:
   - Test user credentials at the top
   - Clear numbered steps with natural language
   - Expected outcomes after each step
   - Specific element descriptions (button text, labels, URLs)
   - Complete user flows in one ticket (signup → create → invite = 1 ticket)
7. Follow the exact ticket ordering structure
8. Make descriptions detailed with clear acceptance criteria
9. Return ONLY valid JSON - no explanations, no markdown
10. Ensure sequential ticket IDs match the ordering structure

Begin by:
1. Reading seed files to discover test users
2. Exploring the project directory structure
3. Generating ALL tickets in the correct order with test user info in web tests.`;
}

/**
 * Parse all tickets from Claude's response
 */
function parseAllTickets(response: string): Ticket[] {
  try {
    // Extract JSON from response (in case Claude includes extra text)
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('No JSON array found in response');
    }

    const tickets = JSON.parse(jsonMatch[0]) as Ticket[];

    // Validate tickets
    if (!Array.isArray(tickets)) {
      throw new Error(`Expected array of tickets, got ${typeof tickets}`);
    }

    const validTypes = ['schema', 'backend', 'frontend', 'test'];

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
    console.error('\n❌ Failed to parse tickets from response:');
    console.error(`Raw response:\n${response.substring(0, 500)}...\n`);
    throw new Error(
      `Failed to parse tickets: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Write tickets to output file
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
 * Core tickets logic - Simplified to single agent call
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
    `🏗️  Mode: ${isScaffoldMode ? 'Scaffold (template adaptation + business logic)' : 'Logic-only (business features)'}\n`
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

  // If prompt is provided (without path), use plan command for interactive ticket creation
  if (options.prompt && !options.path) {
    console.log('📝 Using interactive planning mode for prompt-based ticket creation...\n');

    const planResult = await planCore({
      prompt: options.prompt,
      directory: projectPath,
      output: options.output || 'tickets.json',
      noLogs: options.noLogs,
    });

    if (!planResult.success) {
      throw new Error(planResult.error || 'Plan command failed');
    }

    // Convert plan result to tickets result format
    const schemaTickets = planResult.tickets.filter((t) => t.type === 'schema');
    const backendTickets = planResult.tickets.filter((t) => t.type === 'backend');
    const frontendTickets = planResult.tickets.filter((t) => t.type === 'frontend');
    const testTickets = planResult.tickets.filter((t) => t.type === 'test');

    return {
      schemaTickets,
      backendTickets,
      frontendTickets,
      testTickets,
      totalTickets: planResult.tickets.length,
      projectPath,
      tokensUsed: planResult.tokensUsed,
      cost: planResult.cost,
      conversationMessages: [],
    };
  }

  if (options.path) {
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

  // 3. Determine output path
  const outputFilename = options.output || 'tickets.json';
  const outputPath = join(projectPath, outputFilename);

  // 4. Generate ALL tickets in a single comprehensive agent call
  console.log(`\n${'='.repeat(80)}`);
  console.log('🎯 Generating Tickets with Claude Code Agent');
  console.log(`${'='.repeat(80)}\n`);

  const systemPrompt = buildTicketPrompt(requirementsContent, projectPath, isScaffoldMode);

  const agentResult = await runAgent('Generate all tickets from requirements', {
    systemPrompt,
    cwd: projectPath,
    maxTurns: 40, // Give Claude enough turns to explore codebase and generate all tickets
    verbosity: 'normal',
    captureConversation: true,
  });

  // 5. Parse all tickets from single response
  const allTickets = parseAllTickets(agentResult.response);

  // 6. Display tickets by batch (scaffold vs logic based on ID) and by type
  const scaffoldTickets = allTickets.filter((t) => t.id.toUpperCase().startsWith('SCAFFOLD-'));
  const logicTickets = allTickets.filter((t) => t.id.toUpperCase().startsWith('LOGIC-'));
  const testTickets = allTickets.filter((t) => t.type === 'test');

  if (scaffoldTickets.length > 0) {
    console.log(`\n${'='.repeat(60)}`);
    console.log('🏗️  SCAFFOLD Tickets (Template Adaptation)');
    console.log(`${'='.repeat(60)}`);
    scaffoldTickets.forEach((ticket) => {
      const emoji = ticket.id.includes('SCHEMA')
        ? '🗄️'
        : ticket.id.includes('BACKEND')
          ? '⚙️'
          : ticket.id.includes('FRONTEND')
            ? '🎨'
            : '🌐';
      console.log(
        `   ${emoji} ${ticket.id}: ${ticket.title} (Effort: ${ticket.estimatedEffort}/10${ticket.category ? `, Category: ${ticket.category}` : ''})`
      );
    });
  }

  if (logicTickets.length > 0) {
    console.log(`\n${'='.repeat(60)}`);
    console.log('💡 LOGIC Tickets (Business Functionality)');
    console.log(`${'='.repeat(60)}`);
    logicTickets.forEach((ticket) => {
      const emoji = ticket.id.includes('SCHEMA')
        ? '🗄️'
        : ticket.id.includes('BACKEND')
          ? '⚙️'
          : '🎨';
      console.log(
        `   ${emoji} ${ticket.id}: ${ticket.title} (Effort: ${ticket.estimatedEffort}/10${ticket.category ? `, Category: ${ticket.category}` : ''})`
      );
    });
  }

  if (testTickets.length > 0) {
    console.log(`\n${'='.repeat(60)}`);
    console.log('🧪 TEST Tickets (E2E Validation)');
    console.log(`${'='.repeat(60)}`);
    testTickets.forEach((ticket) => {
      console.log(`   🌐 ${ticket.id}: ${ticket.title} (Effort: ${ticket.estimatedEffort}/10)`);
    });
  }

  // 7. Write tickets to file
  writeTicketsToFile(outputPath, allTickets);
  console.log(`\n💾 Tickets saved to: ${outputPath}`);

  // 8. Separate tickets by phase for compatibility with existing result structure
  const schemaTickets = allTickets.filter((t) => t.type === 'schema');
  const backendTickets = allTickets.filter((t) => t.type === 'backend');
  const frontendTickets = allTickets.filter((t) => t.type === 'frontend');
  // testTickets already declared above for display

  return {
    schemaTickets,
    backendTickets,
    frontendTickets,
    testTickets,
    totalTickets: allTickets.length,
    projectPath,
    tokensUsed: agentResult.tokensUsed,
    cost: agentResult.cost,
    conversationMessages: agentResult.conversationMessages || [],
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

    // Get all tickets by batch (scaffold vs logic)
    const scaffoldTickets = [
      ...result.schemaTickets,
      ...result.backendTickets,
      ...result.frontendTickets,
      ...result.testTickets,
    ].filter((t) => t.id.toUpperCase().startsWith('SCAFFOLD-'));
    const logicTickets = [
      ...result.schemaTickets,
      ...result.backendTickets,
      ...result.frontendTickets,
      ...result.testTickets,
    ].filter((t) => t.id.toUpperCase().startsWith('LOGIC-'));

    // Display summary
    console.log(`\n${'='.repeat(80)}`);
    console.log('📊 Ticket Generation Summary');
    console.log(`${'='.repeat(80)}`);

    if (scaffoldTickets.length > 0) {
      console.log(`\n🏗️  Scaffold Tickets (Template Adaptation): ${scaffoldTickets.length}`);
      console.log(
        `   🗄️  Schema: ${result.schemaTickets.filter((t) => t.id.toUpperCase().startsWith('SCAFFOLD-')).length} (auto-validated)`
      );
      console.log(
        `   ⚙️  Backend: ${result.backendTickets.filter((t) => t.id.toUpperCase().startsWith('SCAFFOLD-')).length}`
      );
      console.log(
        `   🎨 Frontend: ${result.frontendTickets.filter((t) => t.id.toUpperCase().startsWith('SCAFFOLD-')).length}`
      );
      console.log(
        `   🧪 Tests: ${result.testTickets.filter((t) => t.id.toUpperCase().startsWith('SCAFFOLD-')).length}`
      );
    }

    console.log(`\n💡 Logic Tickets (Business Functionality): ${logicTickets.length}`);
    console.log(
      `   🗄️  Schema: ${result.schemaTickets.filter((t) => t.id.toUpperCase().startsWith('LOGIC-')).length} (auto-validated)`
    );
    console.log(
      `   ⚙️  Backend: ${result.backendTickets.filter((t) => t.id.toUpperCase().startsWith('LOGIC-')).length}`
    );
    console.log(
      `   🎨 Frontend: ${result.frontendTickets.filter((t) => t.id.toUpperCase().startsWith('LOGIC-')).length}`
    );
    console.log(
      `   🧪 Tests: ${result.testTickets.filter((t) => t.id.toUpperCase().startsWith('LOGIC-')).length}`
    );

    console.log(`\n📝 Total Tickets: ${result.totalTickets}`);
    console.log(`${'='.repeat(80)}\n`);

    // Display cost breakdown
    const costBreakdown = formatCostBreakdown({
      cost: result.cost,
      tokensUsed: result.tokensUsed,
      fixCount: 0,
      response: '',
      filesReferenced: new Set(),
    });
    console.log(`💰 Total Cost: ${costBreakdown}\n`);

    // Final confirmation
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
