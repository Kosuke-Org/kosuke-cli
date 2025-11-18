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
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { runAgent, formatCostBreakdown } from '../utils/claude-agent.js';
import { ensureRepoReady } from '../utils/repository-manager.js';
import { runWithPR } from '../utils/pr-orchestrator.js';
import { commitAndPushCurrentBranch } from '../utils/git.js';
import { reviewCore } from './review.js';
import { testCore } from './test.js';
import { runComprehensiveLinting } from '../utils/validator.js';
import type { ShipOptions, ShipResult, Ticket } from '../types.js';

interface TicketsFile {
  generatedAt: string;
  totalTickets: number;
  tickets: Ticket[];
}

/**
 * Load tickets from file
 */
function loadTicketsFile(ticketsPath: string): TicketsFile {
  if (!existsSync(ticketsPath)) {
    throw new Error(
      `Tickets file not found: ${ticketsPath}\n` +
        `Please generate tickets first using: kosuke tickets`
    );
  }

  try {
    const content = readFileSync(ticketsPath, 'utf-8');
    return JSON.parse(content) as TicketsFile;
  } catch (error) {
    throw new Error(
      `Failed to parse tickets file: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Save tickets to file
 */
function saveTicketsFile(ticketsPath: string, ticketsData: TicketsFile): void {
  writeFileSync(ticketsPath, JSON.stringify(ticketsData, null, 2), 'utf-8');
}

/**
 * Find ticket by ID
 */
function findTicket(ticketsData: TicketsFile, ticketId: string): Ticket | undefined {
  return ticketsData.tickets.find((t) => t.id === ticketId);
}

/**
 * Update ticket status in file
 */
function updateTicketStatus(
  ticketsPath: string,
  ticketId: string,
  status: Ticket['status'],
  error?: string
): void {
  const ticketsData = loadTicketsFile(ticketsPath);
  const ticket = findTicket(ticketsData, ticketId);

  if (!ticket) {
    console.warn(`⚠️  Ticket ${ticketId} not found, skipping status update`);
    return;
  }

  ticket.status = status;
  if (error) {
    ticket.error = error;
  } else {
    delete ticket.error;
  }

  saveTicketsFile(ticketsPath, ticketsData);
}

/**
 * Load CLAUDE.md rules
 */
function loadClaudeRules(cwd: string = process.cwd()): string {
  const claudePath = join(cwd, 'CLAUDE.md');

  if (!existsSync(claudePath)) {
    throw new Error(
      `CLAUDE.md not found in workspace root.\n` +
        `Please ensure CLAUDE.md exists at: ${claudePath}`
    );
  }

  return readFileSync(claudePath, 'utf-8');
}

/**
 * Build system prompt for ticket implementation
 */
function buildImplementationPrompt(ticket: Ticket, claudeRules: string, repoPath: string): string {
  return `You are an expert software engineer implementing a feature ticket.

**Your Task:**
Implement the following ticket according to the project's coding standards and architecture patterns.

**Ticket Information:**
- ID: ${ticket.id}
- Title: ${ticket.title}
- Description:
${ticket.description}

**Project Rules (CLAUDE.md):**
${claudeRules}

**Context:**
You have access to the kosuke-template repository at: ${repoPath}
Use this to understand implementation patterns, but DO NOT copy code directly.
Adapt patterns to fit the current project's needs.

**Implementation Requirements:**
1. Follow ALL guidelines in CLAUDE.md
2. Use appropriate patterns from kosuke-template as reference
3. Write clean, well-documented code
4. Ensure TypeScript type safety
5. Add error handling where appropriate
6. Make the implementation production-ready

**Critical Instructions:**
- Read relevant files in the current workspace to understand the codebase
- Implement ALL requirements from the ticket description
- Use search_replace or write tools to create/modify files
- Ensure acceptance criteria are met
- Do not make assumptions - ask for clarification if needed through comments

Begin by exploring the current codebase, then implement the ticket systematically.`;
}

/**
 * Build system prompt for review
 */
function buildReviewPrompt(ticket: Ticket, claudeRules: string): string {
  return `You are a senior code reviewer ensuring compliance with project standards.

**Your Task:**
Review the implementation of ticket ${ticket.id} and ensure it follows CLAUDE.md rules.

**Ticket Context:**
- ID: ${ticket.id}
- Title: ${ticket.title}

**Project Rules (CLAUDE.md):**
${claudeRules}

**Review Requirements:**
1. Check compliance with CLAUDE.md guidelines
2. Verify code quality and best practices
3. Ensure TypeScript type safety
4. Check error handling
5. Verify naming conventions
6. Check for security issues
7. Ensure proper documentation

**If Issues Found:**
- Use search_replace or write tools to FIX them immediately
- Don't just report issues - FIX them!
- Make minimal necessary changes
- Ensure fixes don't break functionality

**Critical Instructions:**
- Read the files that were recently modified for this ticket
- Identify any violations of CLAUDE.md rules
- Fix ALL issues found
- Ensure the code is production-ready after your review

Begin by reading recent changes and reviewing them against the standards.`;
}

/**
 * Core ship logic (git-agnostic, reusable)
 */
export async function shipCore(options: ShipOptions): Promise<ShipResult> {
  const { ticket: ticketId, review = false, test = false, ticketsFile = 'tickets.json' } = options;
  const cwd = process.cwd();
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

  // 3. Load CLAUDE.md rules
  console.log('📖 Loading CLAUDE.md rules...');
  const claudeRules = loadClaudeRules(cwd);
  console.log(`   ✅ Loaded rules (${claudeRules.length} characters)\n`);

  // 4. Fetch kosuke-template for context
  console.log('📥 Fetching kosuke-template for context...');
  const repoInfo = await ensureRepoReady('Kosuke-Org/kosuke-template');
  console.log(`   ✅ Template repository ready at ${repoInfo.localPath}\n`);

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

    const systemPrompt = buildImplementationPrompt(ticket, claudeRules, repoInfo.localPath);

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

    const lintResult = await runComprehensiveLinting();
    console.log(`\n✅ Linting completed (${lintResult.fixCount} fixes applied)`);

    // 7. Review phase (if review flag is set)
    let reviewPerformed = false;
    if (review) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🔍 Phase 3: Pre-Review (Full Context)`);
      console.log(`${'='.repeat(60)}\n`);

      const reviewSystemPrompt = buildReviewPrompt(ticket, claudeRules);

      const reviewResult = await runAgent(
        `Review implementation of ticket ${ticketId} against CLAUDE.md rules`,
        {
          systemPrompt: reviewSystemPrompt,
          cwd,
          maxTurns: 25,
          verbosity: 'normal',
        }
      );

      reviewFixCount = reviewResult.fixCount;
      totalInputTokens += reviewResult.tokensUsed.input;
      totalOutputTokens += reviewResult.tokensUsed.output;
      totalCacheCreationTokens += reviewResult.tokensUsed.cacheCreation;
      totalCacheReadTokens += reviewResult.tokensUsed.cacheRead;
      totalCost += reviewResult.cost;

      console.log(`\n✨ Pre-Review completed (${reviewFixCount} issues fixed)`);
      console.log(`💰 Review cost: ${formatCostBreakdown(reviewResult)}`);

      // Run linting again after review fixes
      if (reviewFixCount > 0) {
        console.log('\n🔧 Running linting after review fixes...');
        await runComprehensiveLinting();
      }

      reviewPerformed = true;
    }

    // 8. Test phase (if test flag is set)
    let testFixCount = 0;
    if (test) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🧪 Phase ${review ? '4' : '3'}: Testing`);
      console.log(`${'='.repeat(60)}\n`);

      const testResult = await testCore({
        ticket: ticketId,
        ticketsFile,
      });

      testFixCount = testResult.fixesApplied;
      totalInputTokens += testResult.tokensUsed.input;
      totalOutputTokens += testResult.tokensUsed.output;
      totalCacheCreationTokens += testResult.tokensUsed.cacheCreation;
      totalCacheReadTokens += testResult.tokensUsed.cacheRead;
      totalCost += testResult.cost;

      if (!testResult.success) {
        throw new Error(`Tests failed after ${testResult.iterations} iterations`);
      }

      console.log(`\n✨ Testing completed (${testFixCount} fixes applied)`);
      console.log(`💰 Testing cost: $${testResult.cost.toFixed(4)}`);
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
async function reviewGitDiff(): Promise<{
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

  const result = await reviewCore({});

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
  const { ticket: ticketId, commit = false, pr = false } = options;
  console.log(`🚢 Shipping Ticket: ${ticketId}\n`);

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
        },
        async () => {
          // Run core implementation
          const result = await shipCore(options);

          // Review git diff before committing
          const diffReview = await reviewGitDiff();
          diffReviewCost = diffReview.cost;
          diffReviewFixCount = diffReview.fixCount;

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
    } else if (commit) {
      // Run core logic
      const result = await shipCore(options);

      if (!result.success) {
        throw new Error(result.error || 'Ship failed');
      }

      // Review git diff before committing
      const diffReview = await reviewGitDiff();

      // Commit and push to current branch
      console.log('\n📝 Committing and pushing to current branch...');
      await commitAndPushCurrentBranch(`feat: implement ${ticketId}`);
      console.log('   ✅ Changes committed and pushed\n');

      console.log('\n✅ Ship completed successfully!');
      console.log(`📊 Implementation fixes: ${result.implementationFixCount}`);
      console.log(`🔧 Linting fixes: ${result.lintFixCount}`);
      if (result.reviewPerformed) {
        console.log(`🔍 Pre-review fixes: ${result.reviewFixCount}`);
      }
      console.log(`🔍 Git diff review fixes: ${diffReview.fixCount}`);
      console.log(`💰 Total cost: $${(result.cost + diffReview.cost).toFixed(4)}`);
    } else {
      // Run core logic without any git operations
      const result = await shipCore(options);

      if (!result.success) {
        throw new Error(result.error || 'Ship failed');
      }

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
    }
  } catch (error) {
    console.error('\n❌ Ship failed:', error);
    throw error;
  }
}
