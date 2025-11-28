/**
 * Build command - Batch process all tickets from tickets.json
 *
 * This command processes all "Todo" and "Error" tickets sequentially,
 * implementing each one using the ship core engine and committing individually.
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
 * Filter and sort tickets for processing
 */
function getTicketsToProcess(ticketsData: TicketsFile): Ticket[] {
  // Get all Todo and Error tickets (automatic retry on Error)
  const tickets = ticketsData.tickets.filter((t) => t.status === 'Todo' || t.status === 'Error');

  // Sort by phase: SCHEMA -> DB-TEST -> BACKEND -> FRONTEND -> WEB-TEST
  tickets.sort((a, b) => {
    const getPhaseOrder = (id: string): number => {
      if (id.startsWith('SCHEMA-')) return 1;
      if (id.startsWith('DB-TEST-')) return 2;
      if (id.startsWith('BACKEND-')) return 3;
      if (id.startsWith('FRONTEND-')) return 4;
      if (id.startsWith('WEB-TEST-')) return 5;
      return 6;
    };

    const phaseComparison = getPhaseOrder(a.id) - getPhaseOrder(b.id);
    if (phaseComparison !== 0) return phaseComparison;

    // Within same phase, sort by ticket number
    const aNum = parseInt(a.id.split('-').slice(-1)[0] || '0', 10);
    const bNum = parseInt(b.id.split('-').slice(-1)[0] || '0', 10);
    return aNum - bNum;
  });

  return tickets;
}

/**
 * Commit batch of tickets to current branch
 */
async function commitBatch(batchTickets: Ticket[], cwd: string): Promise<void> {
  const git = simpleGit(cwd);

  // Stage all changes
  await git.add('.');

  // Create commit message with all tickets in batch
  const ticketIds = batchTickets.map((t) => t.id).join(', ');
  const batchType = batchTickets[0].id.startsWith('WEB-TEST-')
    ? batchTickets[0].id.split('-')[2] === '1'
      ? 'scaffold'
      : 'logic'
    : 'implementation';

  const commitMessage = `feat: ${batchType} batch (${ticketIds})`;
  await git.commit(commitMessage);

  console.log(`\n   ✅ Committed batch: ${commitMessage}\n`);
}

/**
 * Determine if we should commit after this ticket
 * Commits happen after the last WEB-TEST in a batch
 */
function shouldCommitAfterTicket(currentTicket: Ticket, nextTicket: Ticket | undefined): boolean {
  // Always commit after last ticket
  if (!nextTicket) return true;

  // Commit if current is WEB-TEST and next is not WEB-TEST (batch boundary)
  if (currentTicket.id.startsWith('WEB-TEST-') && !nextTicket.id.startsWith('WEB-TEST-')) {
    return true;
  }

  return false;
}

/**
 * Main build command - processes all tickets and commits each one
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

    // 4. Process each ticket sequentially with batch tracking
    const batchTickets: Ticket[] = []; // Track tickets in current batch

    for (let i = 0; i < ticketsToProcess.length; i++) {
      const ticket = ticketsToProcess[i];
      const nextTicket = ticketsToProcess[i + 1];

      console.log('\n' + '='.repeat(80));
      console.log(`📦 Processing Ticket ${i + 1}/${ticketsToProcess.length}: ${ticket.id}`);
      console.log(`📝 ${ticket.title}`);
      console.log('='.repeat(80) + '\n');

      try {
        // Step 1: Update status to InProgress
        console.log('📝 Updating ticket status to InProgress...');
        updateTicketStatus(ticketsPath, ticket.id, 'InProgress');
        console.log('   ✅ Status updated\n');

        // Step 2: Process ticket based on type
        const isTestTicket = ticket.type === 'test';

        if (isTestTicket) {
          // This is a test ticket - run test with retry
          console.log(`\n${'='.repeat(60)}`);
          console.log(`🧪 Running Test`);
          console.log(`${'='.repeat(60)}\n`);

          // Generate test prompt from ticket
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
            console.log(`\n⚠️  Test failed (attempt ${retryCount}/${maxRetries})`);
            console.log(`📝 Error: ${testResult.error}\n`);

            console.log(`🔧 Running ship to fix test failures...\n`);

            // Create a fix ticket for ship
            const fixTicket: Ticket = {
              id: `${ticket.id}-FIX-${retryCount}`,
              title: `Fix ${ticket.id} test failures`,
              description: `Fix the following test failures:\n\n${testResult.error}\n\nOriginal ticket:\n${ticket.description}`,
              type: 'backend', // Use backend type for test fix tickets
              estimatedEffort: 5,
              status: 'InProgress',
              category: ticket.category,
            };

            const shipResult = await shipCore({
              ticketData: fixTicket,
              review: false, // Skip review for test fixes
              directory: cwd,
              dbUrl,
              noLogs,
            });

            if (!shipResult.success) {
              console.error(`\n❌ Fix attempt ${retryCount} failed: ${shipResult.error}`);
              continue;
            }

            console.log(`\n✅ Fix applied (attempt ${retryCount})`);
            console.log(`💰 Fix cost: $${shipResult.cost.toFixed(4)}\n`);

            // Re-run test
            console.log(`🔄 Re-running test...\n`);
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

          if (!testResult.success) {
            throw new Error(`Test failed after ${maxRetries} fix attempts:\n${testResult.error}`);
          }

          console.log(`\n✅ ${ticket.id} test passed`);
          console.log(`💰 Test cost: $${testResult.cost.toFixed(4)}`);
        } else {
          // Regular implementation ticket - run ship
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

          console.log(`\n✅ ${ticket.id} implemented successfully`);
          console.log(`📊 Implementation fixes: ${shipResult.implementationFixCount}`);
          console.log(`🔧 Linting fixes: ${shipResult.lintFixCount}`);
          if (shipResult.reviewFixCount > 0) {
            console.log(`🔍 Review fixes: ${shipResult.reviewFixCount}`);
          }
          console.log(`💰 Ship cost: $${shipResult.cost.toFixed(4)}`);

          // If this is a schema ticket, run migrations
          if (ticket.type === 'schema') {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`🗄️  Phase 4: Database Migration & Validation`);
            console.log(`${'='.repeat(60)}\n`);

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

            console.log(`\n✅ Migrations applied and validated`);
            console.log(`   ✓ Migrations applied: ${migrateResult.migrationsApplied}`);
            console.log(`   ✓ Seeding completed: ${migrateResult.seedingCompleted}`);
            console.log(`   ✓ Validation passed: ${migrateResult.validationPassed}`);
            console.log(`💰 Migration cost: $${migrateResult.cost.toFixed(4)}`);
          }
        }

        // Step 3: Update ticket status to Done
        console.log('\n📝 Updating ticket status to Done...');
        updateTicketStatus(ticketsPath, ticket.id, 'Done');
        console.log(`   ✅ Ticket ${ticket.id} marked as Done\n`);

        // Add to batch tracking
        batchTickets.push(ticket);

        // Step 4: Commit batch if at batch boundary
        const shouldCommit = shouldCommitAfterTicket(ticket, nextTicket);

        if (shouldCommit && batchTickets.length > 0) {
          if (askCommit) {
            // Interactive: ask before committing
            const commitConfirmed = await promptConfirmation(
              `\n❓ Commit batch of ${batchTickets.length} ticket(s)?`
            );

            if (commitConfirmed) {
              await commitBatch(batchTickets, cwd);
            } else {
              console.log('   ⏭️  Skipped batch commit\n');
            }
          } else {
            // Default: auto-commit batch
            await commitBatch(batchTickets, cwd);
          }

          // Reset batch tracking
          batchTickets.length = 0;
        }

        // Ask for confirmation before proceeding to next ticket (if not last ticket)
        if (askConfirm && i < ticketsToProcess.length - 1) {
          const shouldContinue = await promptConfirmation('\n❓ Proceed to next ticket?');

          if (!shouldContinue) {
            console.log('\n⏸️  Build paused by user');
            console.log(`📊 Progress: ${i + 1}/${ticketsToProcess.length} tickets completed`);
            console.log('ℹ️  Run build again to resume from remaining tickets\n');
            return;
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`\n❌ Failed to process ${ticket.id}: ${errorMessage}`);

        // Update ticket status to Error
        updateTicketStatus(ticketsPath, ticket.id, 'Error', errorMessage);

        console.error('\n❌ Build stopped due to ticket failure');
        console.error('ℹ️  Fix the issue and run build again to resume from failed tickets\n');
        throw error;
      }
    }

    // 5. Display final summary
    console.log('\n' + '='.repeat(80));
    console.log('✅ Build Completed Successfully!');
    console.log('='.repeat(80));
    console.log(`📦 Total tickets processed: ${ticketsToProcess.length}`);
    console.log(`✅ All tickets have been implemented and committed`);
    console.log('='.repeat(80));
    console.log('\n💡 Next steps:');
    console.log('   - Review the commits: git log');
    console.log('   - Create a PR using: gh pr create');
    console.log('   - Or push to remote: git push origin <branch-name>\n');
  } catch (error) {
    console.error('\n❌ Build failed:', error);
    throw error;
  }
}
