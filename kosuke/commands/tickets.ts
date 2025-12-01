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
 *     1. SCAFFOLD-SCHEMA-1 (ONE ticket for ALL database infrastructure changes)
 *     2. SCAFFOLD-BACKEND-X → SCAFFOLD-FRONTEND-X → SCAFFOLD-WEB-TEST-X (feature-by-feature)
 *
 *   LOGIC BATCH (business functionality):
 *     1. LOGIC-SCHEMA-1 (ONE ticket for ALL business entities)
 *     2. LOGIC-BACKEND-X → LOGIC-FRONTEND-X → LOGIC-WEB-TEST-X (feature-by-feature)
 *
 * LOGIC-ONLY MODE (default):
 *   Only generates LOGIC tickets for new features
 *   1. LOGIC-SCHEMA-1 (ONE ticket for ALL business entities)
 *   2. LOGIC-BACKEND-X → LOGIC-FRONTEND-X → LOGIC-WEB-TEST-X (feature-by-feature)
 *
 * Workflow:
 *   1. Claude Code Agent explores codebase and generates tickets
 *   2. Review step validates and fixes ticket structure
 *   3. Outputs validated tickets.json
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
 * Review result structure
 */
interface ReviewResult {
  validationIssues: string[];
  fixedTickets: Ticket[];
}

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

**SCAFFOLD Ticket Ordering - CRITICAL:**
1. SCAFFOLD-SCHEMA-1 (ONE ticket for ALL database infrastructure changes, auto-validated)
2. SCAFFOLD-BACKEND-X → SCAFFOLD-FRONTEND-X → SCAFFOLD-WEB-TEST-X (feature-by-feature)
3. Each feature follows: backend → frontend → test pattern

**SCAFFOLD Web Tests Must Validate:**
- Authentication flow works without removed features (e.g., no org selection)
- Navigation doesn't have broken links after removing pages
- Landing page renders correctly with new branding
- Signup flow works with simplified structure
- Settings pages work without removed sections (e.g., billing removed)
- Any customized templates (emails, landing) render correctly
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

**LOGIC Ticket Ordering - CRITICAL RULES:**

**RULE 1: ONLY ONE LOGIC-SCHEMA-1 ticket**
- Combine ALL business entities into ONE schema ticket
- ❌ WRONG: LOGIC-SCHEMA-1, LOGIC-SCHEMA-2, LOGIC-SCHEMA-3
- ✅ CORRECT: LOGIC-SCHEMA-1 (all entities: properties, inquiries, favorites, etc.)

**RULE 2: Feature-by-Feature Pattern (STRICT)**
After schema, each feature MUST follow: backend → frontend → test

Example with 2 features:
1. LOGIC-SCHEMA-1 (ALL schemas combined)
2. LOGIC-BACKEND-1 (feature 1 backend)
3. LOGIC-FRONTEND-1 (feature 1 frontend)
4. LOGIC-WEB-TEST-1 (feature 1 test)
5. LOGIC-BACKEND-2 (feature 2 backend)
6. LOGIC-FRONTEND-2 (feature 2 frontend)
7. LOGIC-WEB-TEST-2 (feature 2 test)

**RULE 3: Do NOT group by type**
❌ WRONG: All backends, then all frontends, then all tests
✅ CORRECT: Feature-by-feature (backend → frontend → test per feature)

**Ticket Granularity:**
- Schema: EXACTLY ONE ticket for LOGIC batch (combines ALL entities)
- Backend: Let complexity decide (could be 1-5 tickets per batch)
- Frontend: Let complexity decide (could be 1-5 tickets per batch)
- Web Tests: 1 test per major user flow (matches feature grouping)

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

Example (Full Ordering Structure - Scaffold Mode):
[
  {
    "id": "SCAFFOLD-SCHEMA-1",
    "title": "Remove organizations and simplify auth schema",
    "description": "Remove multi-tenancy/organization features from database:\\n- Drop organization tables\\n- Remove org foreign keys from users table\\n- Simplify schema to individual users only\\n\\nAcceptance Criteria:\\n- Organization tables removed\\n- User table simplified\\n- Migrations validated automatically\\n- No schema errors",
    "type": "schema",
    "estimatedEffort": 5,
    "status": "Todo",
    "category": "auth"
  },
  {
    "id": "SCAFFOLD-BACKEND-1",
    "title": "Remove organization tRPC routers",
    "description": "Remove organization-related backend logic:\\n- Delete lib/trpc/routers/organizations.ts\\n- Remove from main appRouter\\n- Clean up organization schemas\\n\\nAcceptance Criteria:\\n- Organization routers removed\\n- AppRouter compiles without errors\\n- Type safety maintained",
    "type": "backend",
    "estimatedEffort": 4,
    "status": "Todo",
    "category": "auth"
  },
  {
    "id": "SCAFFOLD-FRONTEND-1",
    "title": "Remove organization pages and navigation",
    "description": "Remove organization-related UI:\\n- Delete app/(logged-in)/org/[slug]/ directory\\n- Remove org switcher from navigation\\n- Simplify layout without org context\\n\\nAcceptance Criteria:\\n- Organization pages removed\\n- Navigation simplified\\n- No broken links",
    "type": "frontend",
    "estimatedEffort": 5,
    "status": "Todo",
    "category": "auth"
  },
  {
    "id": "SCAFFOLD-WEB-TEST-1",
    "title": "E2E: Validate simplified auth flow",
    "description": "**Test User Credentials:**\\n- Email: john+kosuke_test@example.com\\n- OTP Code: 424242\\n\\n**Test Steps:**\\n\\n1. **Sign up without org selection**\\n   - Navigate to /sign-up\\n   - Enter email: newuser+kosuke_test@example.com\\n   - Click 'Send Code' button\\n   - Enter OTP: 424242\\n   - Click 'Verify'\\n   - Expected: Redirected directly to app (no org setup)\\n\\n2. **Verify navigation**\\n   - Expected: No org switcher visible\\n   - Expected: All navigation links work\\n\\n**Acceptance Criteria:**\\n- Auth works without org selection\\n- No broken navigation links\\n- No references to removed features",
    "type": "test",
    "estimatedEffort": 4,
    "status": "Todo",
    "category": "auth"
  },
  {
    "id": "LOGIC-SCHEMA-1",
    "title": "Create tasks schema",
    "description": "Create database schema for tasks feature:\\n- Create taskStatusEnum: 'todo', 'in_progress', 'done'\\n- Create tasks table with userId foreign key\\n- Export inferred types\\n\\nAcceptance Criteria:\\n- Tasks table created\\n- Enums defined at database level\\n- Migrations validated automatically\\n- No schema errors",
    "type": "schema",
    "estimatedEffort": 4,
    "status": "Todo",
    "category": "tasks"
  },
  {
    "id": "LOGIC-BACKEND-1",
    "title": "Create tasks tRPC router",
    "description": "Create backend API for tasks:\\n- Create lib/trpc/schemas/tasks.ts\\n- Create lib/trpc/routers/tasks.ts\\n- Implement CRUD operations (list, get, create, update, delete)\\n- Server-side filtering and pagination\\n\\nAcceptance Criteria:\\n- All CRUD operations work\\n- Authorization enforced\\n- Type-safe implementation",
    "type": "backend",
    "estimatedEffort": 6,
    "status": "Todo",
    "category": "tasks"
  },
  {
    "id": "LOGIC-FRONTEND-1",
    "title": "Create tasks page with list and filters",
    "description": "Create tasks management UI:\\n- Create app/(logged-in)/tasks/page.tsx\\n- Task list with filters (status, search)\\n- Add new task button\\n- Task cards with edit/delete actions\\n\\nAcceptance Criteria:\\n- Task list displays correctly\\n- Filters work server-side\\n- CRUD operations functional\\n- Responsive design",
    "type": "frontend",
    "estimatedEffort": 7,
    "status": "Todo",
    "category": "tasks"
  },
  {
    "id": "LOGIC-WEB-TEST-1",
    "title": "E2E: User creates and manages tasks",
    "description": "**Test User Credentials:**\\n- Email: john+kosuke_test@example.com\\n- OTP Code: 424242\\n\\n**Test Steps:**\\n\\n1. **Sign in**\\n   - Navigate to /sign-in\\n   - Enter email: john+kosuke_test@example.com\\n   - Click 'Send Code' button\\n   - Enter OTP: 424242\\n   - Click 'Verify'\\n   - Expected: Redirected to /tasks\\n\\n2. **Create task**\\n   - Click 'New Task' button\\n   - Enter title: 'Test Task'\\n   - Select status: 'Todo'\\n   - Click 'Create'\\n   - Expected: Task appears in list\\n   - Expected: Success toast shown\\n\\n3. **Update task**\\n   - Click on task\\n   - Change status to 'Done'\\n   - Expected: Status updates immediately\\n\\n4. **Delete task**\\n   - Click delete button\\n   - Confirm in dialog\\n   - Expected: Task removed from list\\n\\n**Acceptance Criteria:**\\n- User authenticates successfully\\n- Task CRUD operations work\\n- UI provides appropriate feedback",
    "type": "test",
    "estimatedEffort": 5,
    "status": "Todo",
    "category": "tasks"
  }
]

**Critical Instructions:**
1. Explore the project directory thoroughly before generating tickets
2. ${isScaffoldMode ? 'For SCAFFOLD: Focus on template adaptation ONLY (remove/change/customize) + MUST create SCAFFOLD-WEB-TEST tickets' : ''}
3. For LOGIC: Focus on business features from requirements
4. **IMPORTANT**: Read seed files (lib/db/seed.ts or src/lib/db/seed.ts) to discover test users
5. **SCHEMA TICKETS**: No separate test tickets needed - validation happens automatically during build
6. ${isScaffoldMode ? '**SCAFFOLD-WEB-TEST TICKETS ARE MANDATORY**: Test that removed features are gone, navigation works, landing page updated, auth flow simplified' : ''}
7. **WEB TESTS MUST INCLUDE**:
   - Test user credentials at the top
   - Clear numbered steps with natural language
   - Expected outcomes after each step
   - Specific element descriptions (button text, labels, URLs)
   - Complete user flows in one ticket (signup → create → invite = 1 ticket)
8. Follow the exact ticket ordering structure
9. Make descriptions detailed with clear acceptance criteria
10. Return ONLY valid JSON - no explanations, no markdown
11. Ensure sequential ticket IDs match the ordering structure

Begin by:
1. Reading seed files to discover test users
2. Exploring the project directory structure
3. Generating ALL tickets in the correct order with test user info in web tests
${isScaffoldMode ? '4. IMPORTANT: Create SCAFFOLD-WEB-TEST tickets to validate template changes work correctly' : ''}.`;
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
 * Build review and fix prompt for ticket validation
 */
function buildReviewAndFixPrompt(
  initialTickets: Ticket[],
  requirementsContent: string,
  isScaffoldMode: boolean
): string {
  return `You are a ticket validation and correction expert.

**Original Requirements:**
${requirementsContent}

**Generated Tickets to Review:**
${JSON.stringify(initialTickets, null, 2)}

**Your Task: VALIDATE AND FIX the tickets according to these STRICT RULES:**

**RULE 1: ONE Schema Ticket Per Batch (CRITICAL)**
- Each batch (SCAFFOLD, LOGIC) must have EXACTLY ONE schema ticket
- ❌ WRONG: LOGIC-SCHEMA-1, LOGIC-SCHEMA-2, LOGIC-SCHEMA-3
- ✅ CORRECT: LOGIC-SCHEMA-1 (combines ALL business entities in one ticket)
- Same for SCAFFOLD-SCHEMA-1 (combines ALL infrastructure schema changes)

**RULE 2: Feature-by-Feature Ordering (STRICT)**
Each feature MUST follow this exact pattern:
1. Backend ticket
2. Frontend ticket
3. Test ticket

Example for 2 features:
[
  { "id": "LOGIC-SCHEMA-1", ... },        // ONE schema for all
  { "id": "LOGIC-BACKEND-1", ... },       // Feature 1 backend
  { "id": "LOGIC-FRONTEND-1", ... },      // Feature 1 frontend
  { "id": "LOGIC-WEB-TEST-1", ... },      // Feature 1 test
  { "id": "LOGIC-BACKEND-2", ... },       // Feature 2 backend
  { "id": "LOGIC-FRONTEND-2", ... },      // Feature 2 frontend
  { "id": "LOGIC-WEB-TEST-2", ... }       // Feature 2 test
]

**RULE 3: Sequential Numbering**
- After combining schemas, renumber all tickets sequentially
- LOGIC-BACKEND-1, LOGIC-BACKEND-2, LOGIC-BACKEND-3 (sequential)
- LOGIC-FRONTEND-1, LOGIC-FRONTEND-2, LOGIC-FRONTEND-3 (sequential)
- LOGIC-WEB-TEST-1, LOGIC-WEB-TEST-2, LOGIC-WEB-TEST-3 (sequential)

**RULE 4: Test Tickets Must Include Credentials**
- Every WEB-TEST ticket MUST start with test user credentials
- Format: "**Test User Credentials:**\\n- Email: user+kosuke_test@example.com\\n- OTP Code: 424242"

**AUTOMATIC FIXES TO APPLY:**

1. **Combine Schema Tickets:**
   - If multiple LOGIC-SCHEMA-X tickets exist, merge into ONE LOGIC-SCHEMA-1
   - Combine all table definitions, enums, and types into single ticket
   - Update description to include ALL schemas
   - Same for SCAFFOLD-SCHEMA-X tickets
   - Preserve all schema details from original tickets

2. **Reorder Tickets by Feature:**
   - Group related backend/frontend/test tickets together
   - Enforce: backend → frontend → test pattern for each feature
   - Do NOT group all backends, then all frontends, then all tests
   - Each feature is a cohesive unit (backend + frontend + test)

3. **Renumber Ticket IDs:**
   - After combining/reordering, ensure sequential IDs
   - Update ticket IDs to match new order
   - Example: If LOGIC-BACKEND-3 becomes first backend, rename to LOGIC-BACKEND-1

4. **Validate Test User Info:**
   - Ensure all WEB-TEST tickets have credentials at top of description
   - If missing, add placeholder credentials

**ORDERING EXAMPLES:**

${
  isScaffoldMode
    ? `**Scaffold Mode (with both SCAFFOLD and LOGIC):**
[
  // SCAFFOLD batch
  { "id": "SCAFFOLD-SCHEMA-1" },      // ONE schema for all infrastructure
  { "id": "SCAFFOLD-BACKEND-1" },     // Infrastructure feature 1 backend
  { "id": "SCAFFOLD-FRONTEND-1" },    // Infrastructure feature 1 frontend
  { "id": "SCAFFOLD-WEB-TEST-1" },    // Infrastructure feature 1 test
  { "id": "SCAFFOLD-BACKEND-2" },     // Infrastructure feature 2 backend
  { "id": "SCAFFOLD-FRONTEND-2" },    // Infrastructure feature 2 frontend

  // LOGIC batch
  { "id": "LOGIC-SCHEMA-1" },         // ONE schema for all business
  { "id": "LOGIC-BACKEND-1" },        // Business feature 1 backend
  { "id": "LOGIC-FRONTEND-1" },       // Business feature 1 frontend
  { "id": "LOGIC-WEB-TEST-1" },       // Business feature 1 test
  { "id": "LOGIC-BACKEND-2" },        // Business feature 2 backend
  { "id": "LOGIC-FRONTEND-2" },       // Business feature 2 frontend
  { "id": "LOGIC-WEB-TEST-2" }        // Business feature 2 test
]`
    : `**Logic-Only Mode:**
[
  { "id": "LOGIC-SCHEMA-1" },         // ONE schema for all business
  { "id": "LOGIC-BACKEND-1" },        // Feature 1 backend
  { "id": "LOGIC-FRONTEND-1" },       // Feature 1 frontend
  { "id": "LOGIC-WEB-TEST-1" },       // Feature 1 test
  { "id": "LOGIC-BACKEND-2" },        // Feature 2 backend
  { "id": "LOGIC-FRONTEND-2" },       // Feature 2 frontend
  { "id": "LOGIC-WEB-TEST-2" }        // Feature 2 test
]`
}

**OUTPUT FORMAT:**
Return ONLY a valid JSON object with this exact structure:
{
  "validationIssues": [
    "Issue 1 found and fixed",
    "Issue 2 found and fixed"
  ],
  "fixedTickets": [
    { /* all ticket objects in corrected order */ }
  ]
}

**CRITICAL INSTRUCTIONS:**
- Return ONLY valid JSON (no markdown, no code blocks, no explanations)
- fixedTickets array must contain ALL tickets (not just changed ones)
- Preserve all ticket content (descriptions, acceptance criteria, effort, category)
- Only fix structure, ordering, and numbering issues
- If no issues found, return empty validationIssues array with original tickets
- Ensure sequential numbering matches the new order

Begin validation and fixing now.`;
}

/**
 * Review and fix tickets with Claude
 */
async function reviewAndFixTickets(
  initialTickets: Ticket[],
  requirementsContent: string,
  isScaffoldMode: boolean,
  projectPath: string
): Promise<ReviewResult> {
  console.log(`\n${'='.repeat(80)}`);
  console.log('🔍 Reviewing and Validating Tickets');
  console.log(`${'='.repeat(80)}\n`);

  const reviewPrompt = buildReviewAndFixPrompt(initialTickets, requirementsContent, isScaffoldMode);

  const reviewResult = await runAgent('Review and fix generated tickets', {
    systemPrompt: reviewPrompt,
    maxTurns: 20,
    verbosity: 'minimal',
    cwd: projectPath,
  });

  try {
    // Parse review result
    const jsonMatch = reviewResult.response.match(/\{[\s\S]*"fixedTickets"[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No valid review result found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as ReviewResult;

    if (!parsed.fixedTickets || !Array.isArray(parsed.fixedTickets)) {
      throw new Error('Invalid review result: fixedTickets must be an array');
    }

    // Validate fixed tickets
    const validTypes = ['schema', 'backend', 'frontend', 'test'];
    for (const ticket of parsed.fixedTickets) {
      if (!ticket.id || !ticket.title || !ticket.description || !ticket.type) {
        throw new Error(`Invalid ticket structure in review result: ${JSON.stringify(ticket)}`);
      }
      if (!validTypes.includes(ticket.type)) {
        throw new Error(`Invalid type in reviewed ticket ${ticket.id}: ${ticket.type}`);
      }
    }

    return parsed;
  } catch (error) {
    console.error('\n❌ Review step failed to parse or validate tickets');
    console.error('Error:', error);
    console.error(
      '\nReview response (first 1000 chars):',
      reviewResult.response.substring(0, 1000)
    );
    throw new Error(
      `Ticket review and validation failed. Please check the review prompt and try again.\n` +
        `Error: ${error instanceof Error ? error.message : String(error)}`
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

  // 5. Parse initial tickets
  const initialTickets = parseAllTickets(agentResult.response);
  console.log(`\n✅ Initial generation: ${initialTickets.length} tickets created`);

  // 6. Review and fix tickets
  const reviewResult = await reviewAndFixTickets(
    initialTickets,
    requirementsContent,
    isScaffoldMode,
    projectPath
  );

  // Display what was fixed
  if (reviewResult.validationIssues.length > 0) {
    console.log(`\n${'='.repeat(80)}`);
    console.log('🔧 Validation Issues Found and Fixed:');
    console.log(`${'='.repeat(80)}`);
    reviewResult.validationIssues.forEach((issue, idx) => {
      console.log(`   ${idx + 1}. ${issue}`);
    });
    console.log();
  } else {
    console.log('\n✅ No validation issues found - tickets are correctly structured\n');
  }

  const allTickets = reviewResult.fixedTickets;

  // 8. Display tickets by batch (scaffold vs logic based on ID) and by type
  const scaffoldTickets = allTickets.filter((t) => t.id.toUpperCase().startsWith('SCAFFOLD-'));
  const logicTickets = allTickets.filter((t) => t.id.toUpperCase().startsWith('LOGIC-'));
  const testTickets = allTickets.filter((t) => t.type === 'test');

  if (scaffoldTickets.length > 0) {
    console.log(`\n${'='.repeat(60)}`);
    console.log('🏗️  SCAFFOLD Tickets (Template Adaptation)');
    console.log(`${'='.repeat(60)}`);
    scaffoldTickets.forEach((ticket) => {
      const emoji =
        ticket.type === 'schema'
          ? '🗄️'
          : ticket.type === 'backend'
            ? '⚙️'
            : ticket.type === 'frontend'
              ? '🎨'
              : '🌐'; // test type
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
      const emoji =
        ticket.type === 'schema'
          ? '🗄️'
          : ticket.type === 'backend'
            ? '⚙️'
            : ticket.type === 'frontend'
              ? '🎨'
              : '🌐'; // test type
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

  // 9. Write tickets to file
  writeTicketsToFile(outputPath, allTickets);
  console.log(`\n💾 Tickets saved to: ${outputPath}`);

  // 10. Separate tickets by phase for compatibility with existing result structure
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
