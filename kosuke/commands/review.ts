/**
 * Review command - Review git diff against CLAUDE.md rules
 *
 * This command reviews only the current git diff (uncommitted changes)
 * for compliance with CLAUDE.md rules, fixes any issues found,
 * and runs comprehensive linting afterwards.
 * Note: This command does NOT support --pr flag (changes applied locally only).
 *
 * Usage:
 *   kosuke review                          # Review current git diff
 */

import type { ReviewContext, ReviewOptions, ReviewResult } from '../types.js';
import { formatCostBreakdown, runAgent } from '../utils/claude-agent.js';
import { getGitDiff, hasUncommittedChanges } from '../utils/git.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';
import { runComprehensiveLinting } from '../utils/validator.js';

/**
 * Build system prompt for code review (git diff only)
 */
function buildReviewSystemPrompt(gitDiff: string, context?: ReviewContext): string {
  const ticketContextSection = context
    ? `
**🎫 Ticket Being Implemented:**
- ID: ${context.ticketId}
- Title: ${context.ticketTitle}
- Description:
${context.ticketDescription}

**Ticket-Specific Review Requirements:**
- Verify changes align with the ticket description above
- Ensure all requirements from the ticket are addressed in the diff
- Check that the implementation matches the intended feature/fix
- Look for any obvious missing functionality described in the ticket
- Fix any misalignments between the code changes and ticket requirements

`
    : '';

  return `You are a senior code reviewer conducting a code quality review of recent changes.

**Your Task:**
Review the git diff below for compliance with the project's coding guidelines (CLAUDE.md will be loaded automatically).
${ticketContextSection}
**Git Diff to Review:**
\`\`\`diff
${gitDiff}
\`\`\`

**Review Scope:**
1. **Code Quality**: Check for violations of CLAUDE.md guidelines
2. **Type Safety**: Ensure proper TypeScript usage
3. **Best Practices**: Verify coding patterns and conventions
4. **Error Handling**: Ensure proper error handling
5. **Documentation**: Check for adequate comments and docs
6. **Security**: Identify potential security issues
7. **Performance**: Look for obvious performance issues

**Critical Instructions:**
- Focus ONLY on the files and changes shown in the git diff above
- Identify ALL violations of CLAUDE.md rules in the changed code
- For EACH issue found, FIX it immediately using search_replace or write tools
- Don't just report issues - FIX them!
- Make minimal necessary changes
- Ensure fixes don't break functionality
- If you need to see more context from a file, use the read_file tool

**What to Look For in the Changes:**
- Use of \`any\` type (should be avoided)
- Missing error handling
- Inconsistent naming conventions
- Poor code organization
- Missing JSDoc comments on exported functions
- Improper use of dependencies
- Code duplication
- Overly complex functions
- Missing type exports

Review the changes shown in the diff and fix any issues you find.`;
}

/**
 * Core review logic - reviews git diff only
 */
export async function reviewCore(options: ReviewOptions = {}): Promise<ReviewResult> {
  const cwd = options.directory || process.cwd();
  const { context } = options;

  // Log ticket context if provided
  if (context) {
    console.log(`🎫 Reviewing changes for: ${context.ticketId} - ${context.ticketTitle}\n`);
  }

  // 1. Check for uncommitted changes
  console.log('🔍 Checking for uncommitted changes...');
  const hasChanges = await hasUncommittedChanges(cwd);

  if (!hasChanges) {
    console.log('   ℹ️  No uncommitted changes found. Nothing to review.\n');
    return {
      success: true,
      issuesFound: 0,
      fixesApplied: 0,
      tokensUsed: {
        input: 0,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
      },
      cost: 0,
    };
  }

  console.log('   ✅ Found uncommitted changes\n');

  // 2. Get git diff
  console.log('📝 Getting git diff...');
  const gitDiff = await getGitDiff(cwd);

  if (!gitDiff || gitDiff.trim().length === 0) {
    console.log('   ℹ️  No diff available. Nothing to review.\n');
    return {
      success: true,
      issuesFound: 0,
      fixesApplied: 0,
      tokensUsed: {
        input: 0,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
      },
      cost: 0,
    };
  }

  console.log(`   ✅ Got diff (${gitDiff.length} characters)\n`);

  // 3. Review phase
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔍 Phase 1: Code Review of Git Diff`);
  console.log(`${'='.repeat(60)}\n`);

  const systemPrompt = buildReviewSystemPrompt(gitDiff, context);

  const reviewResult = await runAgent(
    'Review the git diff for compliance with CLAUDE.md rules and fix all issues found',
    {
      systemPrompt,
      cwd,
      maxTurns: 30,
      verbosity: 'normal',
    }
  );

  const issuesFound = reviewResult.fixCount;

  console.log(`\n✨ Review completed`);
  console.log(`   🔍 Issues found and fixed: ${issuesFound}`);
  console.log(`   💰 Review cost: ${formatCostBreakdown(reviewResult)}`);

  // 5. Linting phase
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔧 Phase 2: Linting & Quality Checks`);
  console.log(`${'='.repeat(60)}\n`);

  const lintResult = await runComprehensiveLinting(cwd);
  console.log(`\n✅ Linting completed (${lintResult.fixCount} additional fixes applied)`);

  return {
    success: true,
    issuesFound,
    fixesApplied: issuesFound + lintResult.fixCount,
    tokensUsed: reviewResult.tokensUsed,
    cost: reviewResult.cost,
  };
}

/**
 * Main review command
 */
export async function reviewCommand(options: ReviewOptions = {}): Promise<void> {
  const { noLogs = false } = options;
  console.log('🔍 Starting Code Review (Git Diff)...\n');

  // Initialize logging context
  const logContext = logger.createContext('review', { noLogs });
  const cleanupHandler = setupCancellationHandler(logContext);

  try {
    // Validate environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    // Execute core logic (no PR support for review command)
    const result = await reviewCore(options);

    // Track metrics
    logger.trackTokens(logContext, result.tokensUsed);
    logContext.fixesApplied = result.fixesApplied;

    if (result.issuesFound === 0 && result.fixesApplied === 0) {
      console.log('\n✅ Review completed - no issues found!');
      await logger.complete(logContext, 'success');
      cleanupHandler();
      return;
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 Review Summary');
    console.log('='.repeat(60));
    console.log(`🔍 Issues found: ${result.issuesFound}`);
    console.log(`🔧 Total fixes applied: ${result.fixesApplied}`);
    console.log(`💰 Total cost: $${result.cost.toFixed(4)}`);
    console.log('='.repeat(60));

    console.log('\n✅ Review completed successfully!');
    console.log('ℹ️  All changes applied locally.');

    // Log successful execution
    await logger.complete(logContext, 'success');
    cleanupHandler();
  } catch (error) {
    console.error('\n❌ Review failed:', error);

    // Log failed execution
    await logger.complete(logContext, 'error', error as Error);
    cleanupHandler();

    throw error;
  }
}
