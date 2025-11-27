/**
 * Ship command - Implement a ticket from tickets.json
 *
 * This command takes a ticket ID, implements it following CLAUDE.md rules,
 * runs linting, and optionally performs code review with ticket context.
 *
 * Note: Ship implements tickets but does NOT commit. Use 'build' command for commits.
 *
 * Usage:
 *   kosuke ship --ticket=SCHEMA-1                    # Implement ticket (local only)
 *   kosuke ship --ticket=BACKEND-2 --review          # Implement with code review
 *   kosuke ship --ticket=FRONTEND-1 --test           # Implement and run tests
 *   kosuke ship --ticket=SCHEMA-1 --tickets=path/to/tickets.json
 *   kosuke ship --ticket=SCHEMA-1 --db-url=postgres://user:pass@host:5432/db
 */

import { existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import type { ShipOptions, ShipResult, Ticket } from '../types.js';
import { formatCostBreakdown, runAgent } from '../utils/claude-agent.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';
import { findTicket, loadTicketsFile, updateTicketStatus } from '../utils/tickets-manager.js';
import { runComprehensiveLinting } from '../utils/validator.js';
import { reviewCore } from './review.js';
import { testCore } from './test.js';

/**
 * Build system prompt for ticket implementation
 */
function buildImplementationPrompt(ticket: Ticket, dbUrl: string): string {
  const isSchemaTicket = ticket.id.toUpperCase().startsWith('SCHEMA-');

  const schemaMigrationInstructions = isSchemaTicket
    ? `

**Database Schema Changes (CRITICAL FOR SCHEMA TICKETS):**
This is a SCHEMA ticket. After making changes to database schema files:
1. Run \`bun run db:generate\` to generate Drizzle migrations
2. **CRITICAL**: Run \`POSTGRES_URL="${dbUrl}" bun run db:migrate\` to apply migrations to the database
   ⚠️ **MIGRATIONS MUST BE APPLIED AFTER GENERATION** - Generating migrations alone does NOT update the database!
   ⚠️ The database schema will NOT change until you run \`db:migrate\` to apply the generated migrations
   ⚠️ Skipping this step will cause runtime errors when the app expects the new schema
3. Run \`POSTGRES_URL="${dbUrl}" bun run db:seed\` to seed the database with initial data
4. Verify migration files were created in lib/db/migrations/
5. Handle any migration errors before proceeding
6. Ensure schema changes follow Drizzle ORM best practices from project guidelines
`
    : '';

  return `You are an expert software engineer implementing a feature ticket.

**Your Task:**
Implement the following ticket according to the project's coding standards and architecture patterns (CLAUDE.md will be loaded automatically).

**Ticket Information:**
- ID: ${ticket.id}
- Title: ${ticket.title}
- Description:
${ticket.description}

**Implementation Requirements:**
1. Follow ALL project guidelines from CLAUDE.md
2. Explore the current codebase to understand existing patterns and architecture
3. Write clean, well-documented code
4. Ensure TypeScript type safety
5. Add error handling where appropriate
6. Make the implementation production-ready${schemaMigrationInstructions}

**Critical Instructions:**
- Read relevant files in the current workspace to understand the codebase
- Learn from existing code patterns and conventions
- Implement ALL requirements from the ticket description
- Use search_replace or write tools to create/modify files
- Ensure acceptance criteria are met
- Maintain consistency with the existing codebase style

Begin by exploring the current codebase, then implement the ticket systematically.`;
}

/**
 * Core ship logic (git-agnostic, reusable)
 */
export async function shipCore(options: ShipOptions): Promise<ShipResult> {
  const {
    ticket: ticketId,
    review = false,
    test = false,
    ticketsFile = 'tickets.json',
    directory,
    dbUrl = 'postgres://postgres:postgres@localhost:5432/postgres',
  } = options;

  // 1. Validate and resolve directory
  const cwd = directory ? resolve(directory) : process.cwd();

  if (directory) {
    if (!existsSync(cwd)) {
      throw new Error(
        `Directory not found: ${cwd}\n` +
          `Please provide a valid directory using --directory=<path>\n` +
          `Example: kosuke ship --ticket=SCHEMA-1 --directory=./my-project`
      );
    }

    const stats = statSync(cwd);
    if (!stats.isDirectory()) {
      throw new Error(
        `Path is not a directory: ${cwd}\n` + `Please provide a valid directory path.`
      );
    }

    console.log(`📁 Using project directory: ${cwd}\n`);
  }

  const ticketsPath = join(cwd, ticketsFile);

  // 1. Load and validate ticket
  console.log('📋 Loading ticket...');
  const ticketsData = loadTicketsFile(ticketsPath);
  const ticket = findTicket(ticketsData, ticketId);

  if (!ticket) {
    throw new Error(
      `Ticket ${ticketId} not found in ${ticketsFile}\n` +
        `Available tickets: ${ticketsData.tickets.map((t) => t.id).join(', ')}`
    );
  }

  if (ticket.status === 'Done') {
    throw new Error(
      `Ticket ${ticketId} is already marked as Done.\n` +
        `If you want to re-implement it, manually change its status to "Todo" in ${ticketsFile}`
    );
  }

  console.log(`   ✅ Loaded ticket: ${ticket.id} - ${ticket.title}\n`);

  // 2. Update status to InProgress
  console.log('📝 Updating ticket status to InProgress...');
  updateTicketStatus(ticketsPath, ticketId, 'InProgress');
  console.log('   ✅ Status updated\n');

  // 3. Context ready (using current working directory)
  console.log('📁 Working in current directory context\n');

  // Determine ticket type
  const isSchemaTicket = ticket.id.toUpperCase().startsWith('SCHEMA-');

  // Track metrics
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCost = 0;
  let implementationFixCount = 0;
  let reviewFixCount = 0;

  try {
    // 5. Implementation phase
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 Phase 1: Implementation`);
    console.log(`${'='.repeat(60)}\n`);

    const systemPrompt = buildImplementationPrompt(ticket, dbUrl);

    const implementationResult = await runAgent(`Implement ticket ${ticketId}: ${ticket.title}`, {
      systemPrompt,
      cwd,
      maxTurns: 40,
      verbosity: 'normal',
    });

    implementationFixCount = implementationResult.fixCount;
    totalInputTokens += implementationResult.tokensUsed.input;
    totalOutputTokens += implementationResult.tokensUsed.output;
    totalCacheCreationTokens += implementationResult.tokensUsed.cacheCreation;
    totalCacheReadTokens += implementationResult.tokensUsed.cacheRead;
    totalCost += implementationResult.cost;

    console.log(`\n✨ Implementation completed (${implementationFixCount} changes made)`);
    console.log(`💰 Implementation cost: ${formatCostBreakdown(implementationResult)}`);

    // 6. Linting phase
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔧 Phase 2: Linting & Quality Checks`);
    console.log(`${'='.repeat(60)}\n`);

    const lintResult = await runComprehensiveLinting(cwd);
    console.log(`\n✅ Linting completed (${lintResult.fixCount} fixes applied)`);

    // 7. Review phase (if review flag is set) - SKIP for SCHEMA tickets
    if (review && !isSchemaTicket) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🔍 Phase 3: Code Review (Git Diff)`);
      console.log(`${'='.repeat(60)}\n`);

      const reviewResult = await reviewCore({
        directory: cwd,
        context: {
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          ticketDescription: ticket.description,
        },
      });

      reviewFixCount = reviewResult.fixesApplied;
      totalInputTokens += reviewResult.tokensUsed.input;
      totalOutputTokens += reviewResult.tokensUsed.output;
      totalCacheCreationTokens += reviewResult.tokensUsed.cacheCreation;
      totalCacheReadTokens += reviewResult.tokensUsed.cacheRead;
      totalCost += reviewResult.cost;

      console.log(
        `\n✨ Review completed (${reviewResult.issuesFound} issues found, ${reviewFixCount} fixes applied)`
      );
    } else if (review && isSchemaTicket) {
      console.log(
        '\nℹ️  Skipping code review for SCHEMA ticket (review focuses on application code, not database migrations)'
      );
    }

    // 8. Test phase (if test flag is set) - ITERATIVE
    let testFixCount = 0;
    let testIterations = 0;
    const maxTestRetries = 3;

    if (test) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🧪 Phase ${review ? '4' : '3'}: Testing (Iterative)`);
      console.log(`${'='.repeat(60)}\n`);

      let testsPassing = false;

      for (let attempt = 1; attempt <= maxTestRetries; attempt++) {
        testIterations = attempt;
        console.log(`\n🧪 Test Attempt ${attempt}/${maxTestRetries}\n`);

        // Run atomic test
        const testResult = await testCore({
          ticket: ticketId,
          url: options.url,
          headed: options.headed,
          debug: options.debug,
          ticketsFile,
          directory: cwd,
        });

        totalInputTokens += testResult.tokensUsed.input;
        totalOutputTokens += testResult.tokensUsed.output;
        totalCacheCreationTokens += testResult.tokensUsed.cacheCreation;
        totalCacheReadTokens += testResult.tokensUsed.cacheRead;
        totalCost += testResult.cost;

        if (testResult.success) {
          testsPassing = true;
          console.log('\n✅ Tests passed!');
          break;
        }

        // If not last attempt, analyze and fix
        if (attempt < maxTestRetries) {
          console.log('\n🔍 Analyzing test failures...');

          // Collect Docker logs for backend debugging
          const { LogCollector } = await import('../utils/log-collector.js');
          const logCollector = new LogCollector();
          await logCollector.collectDockerLogs('30s');
          const dockerLogs = logCollector.getErrors();

          // Analyze errors and apply fixes
          const { analyzeAndFix } = await import('../utils/error-analyzer.js');
          const fixResult = await analyzeAndFix(
            ticket,
            testResult.output,
            testResult.logs,
            dockerLogs,
            cwd
          );

          testFixCount += fixResult.fixesApplied;
          totalInputTokens += fixResult.tokensUsed.input;
          totalOutputTokens += fixResult.tokensUsed.output;
          totalCacheCreationTokens += fixResult.tokensUsed.cacheCreation;
          totalCacheReadTokens += fixResult.tokensUsed.cacheRead;
          totalCost += fixResult.cost;

          console.log(`\n🔧 Applied ${fixResult.fixesApplied} fixes`);
          console.log(`💰 Fix cost: $${fixResult.cost.toFixed(4)}`);
        }
      }

      if (!testsPassing) {
        throw new Error(`Tests failed after ${maxTestRetries} attempts`);
      }

      console.log(
        `\n✨ Testing completed (${testFixCount} fixes applied over ${testIterations} iterations)`
      );
      console.log(`💰 Testing cost: $${totalCost.toFixed(4)}`);
    }

    // 9. Update status to Done
    console.log('\n📝 Updating ticket status to Done...');
    updateTicketStatus(ticketsPath, ticketId, 'Done');
    console.log('   ✅ Ticket marked as Done\n');

    return {
      ticketId,
      success: true,
      implementationFixCount,
      lintFixCount: lintResult.fixCount,
      reviewFixCount,
      tokensUsed: {
        input: totalInputTokens,
        output: totalOutputTokens,
        cacheCreation: totalCacheCreationTokens,
        cacheRead: totalCacheReadTokens,
      },
      cost: totalCost,
    };
  } catch (error) {
    // Update ticket status to Error
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Implementation failed: ${errorMessage}`);
    updateTicketStatus(ticketsPath, ticketId, 'Error', errorMessage);

    return {
      ticketId,
      success: false,
      implementationFixCount,
      lintFixCount: 0,
      reviewFixCount,
      tokensUsed: {
        input: totalInputTokens,
        output: totalOutputTokens,
        cacheCreation: totalCacheCreationTokens,
        cacheRead: totalCacheReadTokens,
      },
      cost: totalCost,
      error: errorMessage,
    };
  }
}

/**
 * Main ship command
 */
export async function shipCommand(options: ShipOptions): Promise<void> {
  const { ticket: ticketId, noLogs = false } = options;
  console.log(`🚢 Shipping Ticket: ${ticketId}\n`);

  // Initialize logging context
  const logContext = logger.createContext('ship', { noLogs });
  const cleanupHandler = setupCancellationHandler(logContext);

  try {
    // Validate environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    // Run core implementation
    const result = await shipCore(options);

    if (!result.success) {
      throw new Error(result.error || 'Ship failed');
    }

    // Track metrics
    logger.trackTokens(logContext, result.tokensUsed);
    logContext.fixesApplied =
      result.implementationFixCount + result.lintFixCount + result.reviewFixCount;

    // Display summary
    console.log('\n✅ Ship completed successfully!');
    console.log(`📊 Implementation fixes: ${result.implementationFixCount}`);
    console.log(`🔧 Linting fixes: ${result.lintFixCount}`);
    if (result.reviewFixCount > 0) {
      console.log(`🔍 Review fixes: ${result.reviewFixCount}`);
    }
    console.log(`💰 Total cost: $${result.cost.toFixed(4)}`);
    console.log('\nℹ️  Changes applied locally. Commits are handled by the build command.');

    // Log successful execution
    await logger.complete(logContext, 'success');
    cleanupHandler();
  } catch (error) {
    console.error('\n❌ Ship failed:', error);

    // Log failed execution
    await logger.complete(logContext, 'error', error as Error);
    cleanupHandler();

    throw error;
  }
}
