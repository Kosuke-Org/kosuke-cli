/**
 * Ship command - Implement a ticket from tickets.json
 *
 * This command takes a ticket ID, implements it following CLAUDE.md rules,
 * runs linting and fixing, and optionally performs a review step.
 *
 * Usage:
 *   kosuke ship --ticket=SCHEMA-1                    # Implement ticket (local only)
 *   kosuke ship --ticket=BACKEND-2 --review          # Implement with review
 *   kosuke ship --ticket=FRONTEND-1 --commit         # Implement and commit to current branch
 *   kosuke ship --ticket=BACKEND-3 --pr              # Implement and create PR (new branch)
 *   kosuke ship --ticket=FRONTEND-1 --test           # Implement and run tests
 *   kosuke ship --ticket=SCHEMA-1 --tickets=path/to/tickets.json
 *   kosuke ship --ticket=SCHEMA-1 --db-url=postgres://user:pass@host:5432/db
 */

import { existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import type { ShipOptions, ShipResult, Ticket } from '../types.js';
import { formatCostBreakdown, runAgent } from '../utils/claude-agent.js';
import { commitAndPushCurrentBranch } from '../utils/git.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';
import { runWithPR } from '../utils/pr-orchestrator.js';
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
2. Run \`POSTGRES_URL="${dbUrl}" bun run db:migrate\` to apply migrations to the database
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

    // 7. Review phase (if review flag is set)
    let reviewPerformed = false;
    if (review) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🔍 Phase 3: Code Review (Git Diff)`);
      console.log(`${'='.repeat(60)}\n`);

      // Use existing review logic from review.ts
      const reviewResult = await reviewCore({ directory: cwd });

      reviewFixCount = reviewResult.fixesApplied;
      totalInputTokens += reviewResult.tokensUsed.input;
      totalOutputTokens += reviewResult.tokensUsed.output;
      totalCacheCreationTokens += reviewResult.tokensUsed.cacheCreation;
      totalCacheReadTokens += reviewResult.tokensUsed.cacheRead;
      totalCost += reviewResult.cost;

      console.log(
        `\n✨ Review completed (${reviewResult.issuesFound} issues found, ${reviewFixCount} total fixes applied)`
      );

      reviewPerformed = true;
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
      reviewPerformed,
      reviewFixCount,
      gitDiffReviewed: false,
      gitDiffReviewFixCount: 0,
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
      reviewPerformed: false,
      reviewFixCount,
      gitDiffReviewed: false,
      gitDiffReviewFixCount: 0,
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
 * Review git diff after implementation
 */
async function reviewGitDiff(cwd?: string): Promise<{
  fixCount: number;
  cost: number;
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
}> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔍 Reviewing Git Diff Against CLAUDE.md`);
  console.log(`${'='.repeat(60)}\n`);

  const result = await reviewCore({ directory: cwd });

  return {
    fixCount: result.fixesApplied,
    cost: result.cost,
    tokensUsed: result.tokensUsed,
  };
}

/**
 * Main ship command
 */
export async function shipCommand(options: ShipOptions): Promise<void> {
  const { ticket: ticketId, commit = false, pr = false, directory, noLogs = false } = options;
  console.log(`🚢 Shipping Ticket: ${ticketId}\n`);

  // Resolve directory (for git operations and reviewGitDiff)
  const cwd = directory ? resolve(directory) : process.cwd();

  // Initialize logging context
  const logContext = logger.createContext('ship', { noLogs });
  const cleanupHandler = setupCancellationHandler(logContext);

  try {
    // Validate environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    // Validate mutually exclusive flags
    if (commit && pr) {
      throw new Error(
        'Cannot use --commit and --pr together.\n' +
          'Use --commit to push to current branch, or --pr to create a new branch with pull request.'
      );
    }

    if (pr && !process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN environment variable is required for --pr flag');
    }

    if (commit && !process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN environment variable is required for --commit flag');
    }

    // If --pr flag is provided, wrap with PR workflow
    if (pr) {
      let diffReviewCost = 0;
      let diffReviewFixCount = 0;

      const { result: shipResult, prInfo } = await runWithPR(
        {
          branchPrefix: `feat/ticket-${ticketId}`,
          baseBranch: options.baseBranch,
          commitMessage: `feat: implement ${ticketId}`,
          prTitle: `feat: Implement ${ticketId}`,
          prBody: `## 🎫 Ticket Implementation

Implements ticket **${ticketId}** from tickets.json.

### 📋 Details
- Implementation fixes: ${0} (will be filled by result)
- Linting fixes: ${0}
- Review performed: ${options.review ? 'Yes' : 'No'}

---

🤖 *Generated by Kosuke CLI (\`kosuke ship --ticket=${ticketId} ${options.review ? '--review ' : ''}--pr\`)*`,
          cwd,
        },
        async () => {
          // Run core implementation
          const result = await shipCore(options);

          // Track metrics
          logger.trackTokens(logContext, result.tokensUsed);
          logContext.fixesApplied +=
            result.implementationFixCount + result.lintFixCount + result.reviewFixCount;

          // Review git diff before committing
          const diffReview = await reviewGitDiff(cwd);
          diffReviewCost = diffReview.cost;
          diffReviewFixCount = diffReview.fixCount;

          // Track diff review metrics
          logger.trackTokens(logContext, diffReview.tokensUsed);
          logContext.fixesApplied += diffReview.fixCount;

          return result;
        }
      );

      // Display summary with updated values
      console.log('\n✅ Ship completed successfully!');
      console.log(`📊 Implementation fixes: ${shipResult.implementationFixCount}`);
      console.log(`🔧 Linting fixes: ${shipResult.lintFixCount}`);
      if (shipResult.reviewPerformed) {
        console.log(`🔍 Pre-review fixes: ${shipResult.reviewFixCount}`);
      }
      console.log(`🔍 Git diff review fixes: ${diffReviewFixCount}`);
      console.log(`💰 Total cost: $${(shipResult.cost + diffReviewCost).toFixed(4)}`);
      console.log(`🔗 PR: ${prInfo.prUrl}`);

      // Log successful execution
      await logger.complete(logContext, 'success');
      cleanupHandler();
    } else if (commit) {
      // Run core logic
      const result = await shipCore(options);

      if (!result.success) {
        throw new Error(result.error || 'Ship failed');
      }

      // Track core metrics
      logger.trackTokens(logContext, result.tokensUsed);
      logContext.fixesApplied +=
        result.implementationFixCount + result.lintFixCount + result.reviewFixCount;

      // Review git diff before committing
      const diffReview = await reviewGitDiff(cwd);

      // Track diff review metrics
      logger.trackTokens(logContext, diffReview.tokensUsed);
      logContext.fixesApplied += diffReview.fixCount;

      // Commit and push to current branch
      console.log('\n📝 Committing and pushing to current branch...');
      await commitAndPushCurrentBranch(`feat: implement ${ticketId}`, cwd);
      console.log('   ✅ Changes committed and pushed\n');

      console.log('\n✅ Ship completed successfully!');
      console.log(`📊 Implementation fixes: ${result.implementationFixCount}`);
      console.log(`🔧 Linting fixes: ${result.lintFixCount}`);
      if (result.reviewPerformed) {
        console.log(`🔍 Pre-review fixes: ${result.reviewFixCount}`);
      }
      console.log(`🔍 Git diff review fixes: ${diffReview.fixCount}`);
      console.log(`💰 Total cost: $${(result.cost + diffReview.cost).toFixed(4)}`);

      // Log successful execution
      await logger.complete(logContext, 'success');
      cleanupHandler();
    } else {
      // Run core logic without any git operations
      const result = await shipCore(options);

      if (!result.success) {
        throw new Error(result.error || 'Ship failed');
      }

      // Track core metrics
      logger.trackTokens(logContext, result.tokensUsed);
      logContext.fixesApplied +=
        result.implementationFixCount + result.lintFixCount + result.reviewFixCount;

      console.log('\n✅ Ship completed successfully!');
      console.log(`📊 Implementation fixes: ${result.implementationFixCount}`);
      console.log(`🔧 Linting fixes: ${result.lintFixCount}`);
      if (result.reviewPerformed) {
        console.log(`🔍 Review fixes: ${result.reviewFixCount}`);
      }
      console.log(`💰 Total cost: $${result.cost.toFixed(4)}`);
      console.log(
        '\nℹ️  Changes applied locally. Use --commit to push or --pr to create a pull request.'
      );

      // Log successful execution
      await logger.complete(logContext, 'success');
      cleanupHandler();
    }
  } catch (error) {
    console.error('\n❌ Ship failed:', error);

    // Log failed execution
    await logger.complete(logContext, 'error', error as Error);
    cleanupHandler();

    throw error;
  }
}
