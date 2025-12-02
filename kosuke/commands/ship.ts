/**
 * Ship Core - Ticket-agnostic implementation engine
 *
 * This module provides the core implementation logic for tickets.
 * It is designed to be called programmatically with ticket data,
 * making it independent of tickets.json or any ticket management system.
 *
 * Features:
 * - Implements tickets following CLAUDE.md rules
 * - Runs comprehensive linting
 * - Optionally performs code review with ticket context
 * - Does NOT manage ticket lifecycle (status updates, commits, etc.)
 *
 * Usage (Programmatic):
 *   import { shipCore } from './commands/ship.js';
 *
 *   const result = await shipCore({
 *     ticketData: { id: 'SCHEMA-1', title: '...', description: '...' },
 *     review: true,
 *     directory: './my-project',
 *   });
 *
 * Note: The CLI command 'kosuke ship' is deprecated.
 *       Use 'kosuke build' instead for complete ticket workflow.
 */

import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import type { ShipOptions, ShipResult, Ticket } from '../types.js';
import { formatCostBreakdown, runAgent } from '../utils/claude-agent.js';
import { runComprehensiveLinting } from '../utils/validator.js';
import { reviewCore } from './review.js';

/**
 * Validate ticket data has all required fields
 */
function validateTicketData(ticketData: Ticket): void {
  if (!ticketData.id || typeof ticketData.id !== 'string') {
    throw new Error('Invalid ticket: id is required and must be a string');
  }
  if (!ticketData.title || typeof ticketData.title !== 'string') {
    throw new Error('Invalid ticket: title is required and must be a string');
  }
  if (!ticketData.description || typeof ticketData.description !== 'string') {
    throw new Error('Invalid ticket: description is required and must be a string');
  }
}

/**
 * Build system prompt for ticket implementation
 */
function buildImplementationPrompt(ticket: Ticket, _dbUrl: string): string {
  const isSchemaTicket = ticket.id.toUpperCase().startsWith('SCHEMA-');

  const schemaMigrationInstructions = isSchemaTicket
    ? `

**Database Schema Changes (CRITICAL FOR SCHEMA TICKETS):**
This is a SCHEMA ticket. After making changes to database schema files:
1. Run \`bun run db:generate\` to generate Drizzle migrations
2. Verify migration files were created in lib/db/migrations/
3. Ensure schema changes follow Drizzle ORM best practices from project guidelines

⛔ **FORBIDDEN COMMANDS** (will be run automatically in a later phase):
- DO NOT run \`db:migrate\` or \`bun run db:migrate\`
- DO NOT run \`db:seed\` or \`bun run db:seed\`
- DO NOT run \`db:push\` or \`bun run db:push\`
- DO NOT connect to or query the database directly
Only run \`db:generate\` - the build system handles migrations separately.
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
 * Core ship logic (ticket-agnostic, reusable)
 * Implements a ticket without managing its lifecycle (status updates, etc.)
 */
export async function shipCore(options: ShipOptions): Promise<ShipResult> {
  // Validate ticket data
  validateTicketData(options.ticketData);

  const ticket = options.ticketData;
  const {
    review = false,
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
          `Example: shipCore({ ticketData: ticket, directory: './my-project' })`
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

  console.log(`📋 Implementing ticket: ${ticket.id} - ${ticket.title}\n`);

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
    // 2. Implementation phase
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 Phase 1: Implementation`);
    console.log(`${'='.repeat(60)}\n`);

    const systemPrompt = buildImplementationPrompt(ticket, dbUrl);

    const implementationResult = await runAgent(`Implement ticket ${ticket.id}: ${ticket.title}`, {
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

    // 3. Linting phase
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔧 Phase 2: Linting & Quality Checks`);
    console.log(`${'='.repeat(60)}\n`);

    const lintResult = await runComprehensiveLinting(cwd);
    console.log(`\n✅ Linting completed (${lintResult.fixCount} fixes applied)`);

    // 4. Review phase (if review flag is set) - SKIP for SCHEMA tickets
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

    // 5. Return success result
    return {
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
    // Return error result
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Implementation failed: ${errorMessage}`);

    return {
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
