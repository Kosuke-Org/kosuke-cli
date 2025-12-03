/**
 * Build command - Process all tickets from tickets.json
 *
 * This command processes all "Todo" and "Error" tickets sequentially,
 * implementing each one using the ship core engine and committing after each ticket.
 * Frontend tickets automatically run tests (unless --no-test is specified).
 * All tickets include code review by default (unless --no-review is specified).
 *
 * Usage:
 *   kosuke build                           # Process and auto-commit all tickets
 *   kosuke build --ask-commit              # Ask before committing each ticket
 *   kosuke build --ask-confirm             # Ask before processing each ticket
 *   kosuke build --reset                   # Reset all tickets to "Todo" and process from scratch
 *   kosuke build --no-review               # Skip code review phase
 *   kosuke build --no-test                 # Skip testing phase for frontend tickets
 *   kosuke build --headless                # Run tests in headless mode (invisible)
 *   kosuke build --verbose                 # Enable verbose test output
 *   kosuke build --tickets=path/to/tickets.json
 *   kosuke build --db-url=postgres://user:pass@host:5432/db
 *
 * Note: Create a feature branch before running build:
 *   git checkout -b feat/implement-tickets
 *   kosuke build
 *   gh pr create
 */

import { existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import * as readline from 'readline';
import simpleGit from 'simple-git';
import type { BuildOptions, Ticket } from '../types.js';
import { generateWebTestPrompt } from '../utils/prompt-generator.js';
import {
  loadTicketsFile,
  saveTicketsFile,
  updateTicketStatus,
  type TicketsFile,
} from '../utils/tickets-manager.js';
import { migrateCore } from './migrate.js';
import { shipCore } from './ship.js';
import { testCore } from './test.js';

// ============================================
// STREAMING TYPES
// ============================================

/**
 * Token usage tracking
 */
export interface BuildTokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/**
 * Build stream event names
 */
export const BuildEventName = {
  TICKET_START: 'ticket_start',
  TICKET_COMPLETE: 'ticket_complete',
  STATUS: 'status',
  BUILD_COMPLETE: 'build_complete',
  ERROR: 'error',
} as const;

export type BuildEventNameType = (typeof BuildEventName)[keyof typeof BuildEventName];

/**
 * Event types for streaming build execution
 */
export type BuildStreamEventType =
  | {
      type: typeof BuildEventName.TICKET_START;
      ticket: Ticket;
      ticketIndex: number;
      totalTickets: number;
    }
  | {
      type: typeof BuildEventName.TICKET_COMPLETE;
      ticket: Ticket;
      success: boolean;
      error?: string;
      tokensUsed: BuildTokenUsage;
      cost: number;
    }
  | {
      type: typeof BuildEventName.STATUS;
      message: string;
      ticket?: Ticket;
    }
  | {
      type: typeof BuildEventName.BUILD_COMPLETE;
      successCount: number;
      failedCount: number;
      totalTickets: number;
      totalTokensUsed: BuildTokenUsage;
      totalCost: number;
    }
  | {
      type: typeof BuildEventName.ERROR;
      message: string;
      ticket?: Ticket;
    };

/**
 * Options for streaming build execution
 */
export interface BuildStreamingOptions {
  /** Working directory */
  directory?: string;
  /** Database URL for migrations */
  dbUrl?: string;
  /** Enable code review */
  review?: boolean;
  /** Test URL for web tests */
  url?: string;
  /** Run tests in headless mode */
  headless?: boolean;
  /** Verbose test output */
  verbose?: boolean;
  /** Suppress logs */
  noLogs?: boolean;
}

/**
 * Prompt user for confirmation to continue
 */
async function promptConfirmation(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`\n${message} (y/n): `, (answer) => {
      rl.close();
      const response = answer.trim().toLowerCase();
      resolve(response === 'y' || response === 'yes');
    });
  });
}

/**
 * Get phase order for ticket sorting
 */
function getPhaseOrder(id: string): number {
  const upperCase = id.toUpperCase();
  if (upperCase.includes('SCHEMA')) return 1;
  if (upperCase.includes('DB-TEST')) return 2;
  if (upperCase.includes('ENGINE')) return 3;
  if (upperCase.includes('BACKEND')) return 4;
  if (upperCase.includes('FRONTEND')) return 5;
  if (upperCase.includes('WEB-TEST') || upperCase.includes('TEST')) return 6;
  return 7;
}

/**
 * Sort tickets by processing order
 */
export function sortTicketsByProcessingOrder(tickets: Ticket[]): Ticket[] {
  return [...tickets].sort((a, b) => {
    const phaseComparison = getPhaseOrder(a.id) - getPhaseOrder(b.id);
    if (phaseComparison !== 0) return phaseComparison;

    // Within same phase, sort by ticket number
    const aNum = parseInt(a.id.split('-').slice(-1)[0] || '0', 10);
    const bNum = parseInt(b.id.split('-').slice(-1)[0] || '0', 10);
    return aNum - bNum;
  });
}

/**
 * Filter and sort tickets for processing
 */
function getTicketsToProcess(ticketsData: TicketsFile): Ticket[] {
  // Get all Todo and Error tickets (automatic retry on Error)
  const tickets = ticketsData.tickets.filter((t) => t.status === 'Todo' || t.status === 'Error');
  return sortTicketsByProcessingOrder(tickets);
}

// ============================================
// STREAMING BUILD CORE
// ============================================

/**
 * Streaming build execution - the core implementation
 *
 * This AsyncGenerator is the single source of truth for build logic.
 * Both CLI and web integrations consume this stream.
 *
 * @param tickets - Array of tickets to process (should be pre-filtered and sorted)
 * @param options - Build options
 * @yields BuildStreamEventType - Events for each ticket
 *
 * @example
 * ```ts
 * // Web usage
 * const ticketsToProcess = tickets.filter(t => t.status === 'Todo' || t.status === 'Error');
 * const sorted = sortTicketsByProcessingOrder(ticketsToProcess);
 *
 * for await (const event of buildCoreStreaming(sorted, { directory: cwd })) {
 *   if (event.type === 'ticket_start') {
 *     console.log(`Processing ${event.ticket.id}...`);
 *   } else if (event.type === 'ticket_complete') {
 *     console.log(`${event.ticket.id} ${event.success ? 'done' : 'failed'}`);
 *   } else if (event.type === 'build_complete') {
 *     console.log(`Build done: ${event.successCount}/${event.totalTickets}`);
 *   }
 * }
 * ```
 */
export async function* buildCoreStreaming(
  tickets: Ticket[],
  options: BuildStreamingOptions = {}
): AsyncGenerator<BuildStreamEventType> {
  const {
    directory,
    dbUrl = 'postgres://postgres:postgres@localhost:5432/postgres',
    review = true,
    url,
    headless,
    verbose,
    noLogs = true,
  } = options;

  const cwd = directory ? resolve(directory) : process.cwd();

  // Validate directory
  if (!existsSync(cwd)) {
    yield { type: 'error', message: `Directory not found: ${cwd}` };
    return;
  }

  const stats = statSync(cwd);
  if (!stats.isDirectory()) {
    yield { type: 'error', message: `Path is not a directory: ${cwd}` };
    return;
  }

  const totalTokens: BuildTokenUsage = {
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
  };
  let totalCost = 0;
  let successCount = 0;
  let failedCount = 0;

  if (tickets.length === 0) {
    yield {
      type: 'build_complete',
      successCount: 0,
      failedCount: 0,
      totalTickets: 0,
      totalTokensUsed: totalTokens,
      totalCost: 0,
    };
    return;
  }

  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i];

    // Yield ticket start event
    yield {
      type: 'ticket_start',
      ticket,
      ticketIndex: i,
      totalTickets: tickets.length,
    };

    try {
      // Update ticket status
      ticket.status = 'InProgress';

      yield {
        type: 'status',
        message: `Processing ${ticket.id}: ${ticket.title}`,
        ticket,
      };

      // Process based on ticket type
      const isTestTicket = ticket.type === 'test';

      if (isTestTicket) {
        // Test ticket - run testCore with retry
        yield {
          type: 'status',
          message: `Running test for ${ticket.id}`,
          ticket,
        };

        const testPrompt = generateWebTestPrompt(ticket);

        let testResult = await testCore({
          prompt: testPrompt,
          context: {
            ticketId: ticket.id,
            ticketTitle: ticket.title,
            ticketDescription: ticket.description,
          },
          url,
          headless,
          verbose,
          noLogs,
        });

        let retryCount = 0;
        const maxRetries = 3;

        // Retry loop: if test fails, run ship to fix it
        while (!testResult.success && retryCount < maxRetries) {
          retryCount++;

          yield {
            type: 'status',
            message: `Test failed (attempt ${retryCount}/${maxRetries}), running fix...`,
            ticket,
          };

          // Create a fix ticket for ship
          const fixTicket: Ticket = {
            id: `${ticket.id}-FIX-${retryCount}`,
            title: `Fix ${ticket.id} test failures`,
            description: `Fix the following test failures:\n\n${testResult.error}\n\nOriginal ticket:\n${ticket.description}`,
            type: 'backend',
            estimatedEffort: 5,
            status: 'InProgress',
            category: ticket.category,
          };

          const shipResult = await shipCore({
            ticketData: fixTicket,
            review: false,
            directory: cwd,
            dbUrl,
            noLogs,
          });

          if (shipResult.success) {
            // Accumulate tokens from fix
            totalTokens.input += shipResult.tokensUsed.input;
            totalTokens.output += shipResult.tokensUsed.output;
            totalTokens.cacheCreation += shipResult.tokensUsed.cacheCreation;
            totalTokens.cacheRead += shipResult.tokensUsed.cacheRead;
            totalCost += shipResult.cost;

            yield {
              type: 'status',
              message: `Fix applied (attempt ${retryCount}), re-running test...`,
              ticket,
            };

            // Re-run test
            testResult = await testCore({
              prompt: testPrompt,
              context: {
                ticketId: ticket.id,
                ticketTitle: ticket.title,
                ticketDescription: ticket.description,
              },
              url,
              headless,
              verbose,
              noLogs,
            });
          }
        }

        if (!testResult.success) {
          throw new Error(`Test failed after ${maxRetries} fix attempts:\n${testResult.error}`);
        }

        // Accumulate test tokens
        totalTokens.input += testResult.tokensUsed.input;
        totalTokens.output += testResult.tokensUsed.output;
        totalTokens.cacheCreation += testResult.tokensUsed.cacheCreation;
        totalTokens.cacheRead += testResult.tokensUsed.cacheRead;
        totalCost += testResult.cost;

        ticket.status = 'Done';
        successCount++;

        yield {
          type: 'ticket_complete',
          ticket,
          success: true,
          tokensUsed: testResult.tokensUsed,
          cost: testResult.cost,
        };
      } else {
        // Regular implementation ticket - run shipCore
        const shipResult = await shipCore({
          ticketData: ticket,
          review,
          directory: cwd,
          dbUrl,
          noLogs,
        });

        if (!shipResult.success) {
          throw new Error(shipResult.error || 'Ship failed');
        }

        // Accumulate tokens and cost
        totalTokens.input += shipResult.tokensUsed.input;
        totalTokens.output += shipResult.tokensUsed.output;
        totalTokens.cacheCreation += shipResult.tokensUsed.cacheCreation;
        totalTokens.cacheRead += shipResult.tokensUsed.cacheRead;
        totalCost += shipResult.cost;

        // Run migrations for schema tickets
        if (ticket.type === 'schema') {
          yield {
            type: 'status',
            message: `Running migrations for ${ticket.id}`,
            ticket,
          };

          const migrateResult = await migrateCore({
            directory: cwd,
            dbUrl,
            context: {
              ticketId: ticket.id,
              ticketTitle: ticket.title,
              ticketDescription: ticket.description,
            },
            noLogs,
          });

          if (!migrateResult.success) {
            throw new Error(`Migration failed: ${migrateResult.error}`);
          }

          // Accumulate migration tokens
          totalTokens.input += migrateResult.tokensUsed.input;
          totalTokens.output += migrateResult.tokensUsed.output;
          totalTokens.cacheCreation += migrateResult.tokensUsed.cacheCreation;
          totalTokens.cacheRead += migrateResult.tokensUsed.cacheRead;
          totalCost += migrateResult.cost;
        }

        ticket.status = 'Done';
        successCount++;

        yield {
          type: 'ticket_complete',
          ticket,
          success: true,
          tokensUsed: shipResult.tokensUsed,
          cost: shipResult.cost,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Mark ticket as error
      ticket.status = 'Error';
      ticket.error = errorMessage;
      failedCount++;

      yield {
        type: 'ticket_complete',
        ticket,
        success: false,
        error: errorMessage,
        tokensUsed: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        cost: 0,
      };

      yield {
        type: 'error',
        message: `Ticket ${ticket.id} failed: ${errorMessage}`,
        ticket,
      };

      // Continue to next ticket (don't stop on error)
    }
  }

  // Yield build complete event
  yield {
    type: 'build_complete',
    successCount,
    failedCount,
    totalTickets: tickets.length,
    totalTokensUsed: totalTokens,
    totalCost,
  };
}

/**
 * Commit a single ticket to current branch
 */
async function commitTicket(ticket: Ticket, cwd: string): Promise<void> {
  const git = simpleGit(cwd);

  // Stage all changes
  await git.add('.');

  // Create commit message for this ticket
  const ticketType = ticket.type || 'feat';
  const commitMessage = `${ticketType}: ${ticket.id} - ${ticket.title}`;
  await git.commit(commitMessage, ['--no-verify']);

  console.log(`\n   ✅ Committed: ${commitMessage}\n`);
}

/**
 * Main build command - CLI wrapper around buildCoreStreaming
 *
 * Consumes the streaming generator and handles:
 * - Terminal output (stdout)
 * - Interactive prompts (askConfirm, askCommit)
 * - Git commits after each ticket
 * - File I/O for ticket status updates
 */
export async function buildCommand(options: BuildOptions): Promise<void> {
  console.log('🏗️  Starting Build - Batch Ticket Processing\n');

  try {
    // Validate environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    if (!process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN environment variable is required for build command');
    }

    const {
      directory,
      ticketsFile = 'tickets.json',
      dbUrl = 'postgres://postgres:postgres@localhost:5432/postgres',
      reset = false,
      askConfirm = false,
      askCommit = false,
      review = true,
      url,
      headless,
      verbose,
      noLogs = false,
    } = options;

    // 1. Validate and resolve directory
    const cwd = directory ? resolve(directory) : process.cwd();

    if (!existsSync(cwd)) {
      throw new Error(
        `Directory not found: ${cwd}\n` +
          `Please provide a valid directory using --directory=<path>\n` +
          `Example: kosuke build --directory=./my-project`
      );
    }

    const stats = statSync(cwd);
    if (!stats.isDirectory()) {
      throw new Error(
        `Path is not a directory: ${cwd}\n` + `Please provide a valid directory path.`
      );
    }

    console.log(`📁 Using project directory: ${cwd}\n`);

    const ticketsPath = join(cwd, ticketsFile);

    // 2. Load tickets
    console.log('📋 Loading tickets...');
    const ticketsData = loadTicketsFile(ticketsPath);

    // 3. Reset all tickets to "Todo" if --reset flag is provided
    if (reset) {
      console.log('🔄 Resetting all tickets to "Todo" status...');
      let resetCount = 0;
      ticketsData.tickets.forEach((ticket) => {
        if (ticket.status !== 'Todo') {
          ticket.status = 'Todo';
          delete ticket.error;
          resetCount++;
        }
      });
      saveTicketsFile(ticketsPath, ticketsData);
      console.log(`   ✅ Reset ${resetCount} ticket(s) to "Todo" status\n`);
    }

    const ticketsToProcess = getTicketsToProcess(ticketsData);

    if (ticketsToProcess.length === 0) {
      console.log('ℹ️  No tickets found with status "Todo" or "Error"');
      return;
    }

    console.log(`   ✅ Found ${ticketsToProcess.length} ticket(s) to process\n`);

    // Display tickets to be processed
    console.log('📦 Tickets to be processed:');
    ticketsToProcess.forEach((ticket, index) => {
      console.log(`   ${index + 1}. ${ticket.id}: ${ticket.title}`);
    });
    console.log('');

    // Track state for CLI-specific handling
    let currentTicketIndex = 0;
    let shouldStop = false;

    // 4. Consume the streaming build
    for await (const event of buildCoreStreaming(ticketsToProcess, {
      directory: cwd,
      dbUrl,
      review,
      url,
      headless,
      verbose,
      noLogs,
    })) {
      if (shouldStop) break;

      switch (event.type) {
        case 'ticket_start':
          console.log('\n' + '='.repeat(80));
          console.log(
            `📦 Processing Ticket ${event.ticketIndex + 1}/${event.totalTickets}: ${event.ticket.id}`
          );
          console.log(`📝 ${event.ticket.title}`);
          console.log('='.repeat(80) + '\n');

          // Update ticket status in file
          updateTicketStatus(ticketsPath, event.ticket.id, 'InProgress');
          console.log('📝 Updating ticket status to InProgress...');
          console.log('   ✅ Status updated\n');
          currentTicketIndex = event.ticketIndex;
          break;

        case 'status':
          console.log(`   ℹ️  ${event.message}`);
          break;

        case 'ticket_complete':
          if (event.success) {
            console.log(`\n✅ ${event.ticket.id} completed successfully`);
            console.log(`💰 Cost: $${event.cost.toFixed(4)}`);

            // Update ticket status in file
            updateTicketStatus(ticketsPath, event.ticket.id, 'Done');
            console.log('\n📝 Updating ticket status to Done...');
            console.log(`   ✅ Ticket ${event.ticket.id} marked as Done\n`);

            // Commit this ticket
            if (askCommit) {
              const commitConfirmed = await promptConfirmation(`\n❓ Commit ${event.ticket.id}?`);
              if (commitConfirmed) {
                await commitTicket(event.ticket, cwd);
              } else {
                console.log('   ⏭️  Skipped commit for this ticket\n');
              }
            } else {
              await commitTicket(event.ticket, cwd);
            }

            // Ask for confirmation before next ticket
            if (askConfirm && currentTicketIndex < ticketsToProcess.length - 1) {
              const shouldContinue = await promptConfirmation('\n❓ Proceed to next ticket?');
              if (!shouldContinue) {
                console.log('\n⏸️  Build paused by user');
                console.log(
                  `📊 Progress: ${currentTicketIndex + 1}/${ticketsToProcess.length} tickets completed`
                );
                console.log('ℹ️  Run build again to resume from remaining tickets\n');
                shouldStop = true;
              }
            }
          } else {
            console.error(`\n❌ ${event.ticket.id} failed: ${event.error}`);

            // Update ticket status in file
            updateTicketStatus(ticketsPath, event.ticket.id, 'Error', event.error);

            // For CLI, we stop on first error (different from web which continues)
            console.error('\n❌ Build stopped due to ticket failure');
            console.error('ℹ️  Fix the issue and run build again to resume from failed tickets\n');
            throw new Error(event.error);
          }
          break;

        case 'error':
          console.error(`\n❌ Error: ${event.message}`);
          break;

        case 'build_complete':
          console.log('\n' + '='.repeat(80));
          console.log('✅ Build Completed Successfully!');
          console.log('='.repeat(80));
          console.log(`📦 Total tickets processed: ${event.totalTickets}`);
          console.log(`✅ Successful: ${event.successCount}`);
          if (event.failedCount > 0) {
            console.log(`❌ Failed: ${event.failedCount}`);
          }
          console.log(`💰 Total cost: $${event.totalCost.toFixed(4)}`);
          console.log('='.repeat(80));
          console.log('\n💡 Next steps:');
          console.log('   - Review the commits: git log');
          console.log('   - Create a PR using: gh pr create');
          console.log('   - Or push to remote: git push origin <branch-name>\n');
          break;
      }
    }
  } catch (error) {
    console.error('\n❌ Build failed:', error);
    throw error;
  }
}
