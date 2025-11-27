/**
 * Build command - Batch process all tickets from tickets.json
 *
 * This command processes all "Todo" and "Error" tickets sequentially,
 * implementing each one using the ship command and committing individually.
 * Frontend tickets automatically include the --test flag.
 * All tickets automatically include the --review flag for quality assurance.
 *
 * Usage:
 *   kosuke build                           # Process and auto-commit all tickets
 *   kosuke build --ask-commit              # Ask before committing each ticket
 *   kosuke build --ask-confirm             # Ask before processing each ticket
 *   kosuke build --reset                   # Reset all tickets to "Todo" and process from scratch
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
import { loadTicketsFile, saveTicketsFile, type TicketsFile } from '../utils/tickets-manager.js';
import { shipCommand } from './ship.js';

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

  // Sort by phase: SCHEMA -> BACKEND -> FRONTEND
  tickets.sort((a, b) => {
    const getPhaseOrder = (id: string): number => {
      if (id.startsWith('SCHEMA-')) return 1;
      if (id.startsWith('BACKEND-')) return 2;
      if (id.startsWith('FRONTEND-')) return 3;
      return 4;
    };

    const phaseComparison = getPhaseOrder(a.id) - getPhaseOrder(b.id);
    if (phaseComparison !== 0) return phaseComparison;

    // Within same phase, sort by ticket number
    const aNum = parseInt(a.id.split('-')[1] || '0', 10);
    const bNum = parseInt(b.id.split('-')[1] || '0', 10);
    return aNum - bNum;
  });

  return tickets;
}

/**
 * Commit ticket changes to current branch
 */
async function commitTicket(ticket: Ticket, cwd: string): Promise<void> {
  const git = simpleGit(cwd);

  // Stage all changes
  await git.add('.');

  // Commit with ticket info
  const commitMessage = `feat: ${ticket.id} - ${ticket.title}`;
  await git.commit(commitMessage);

  console.log(`   ✅ Committed: ${commitMessage}`);
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

    // 4. Process each ticket sequentially
    for (let i = 0; i < ticketsToProcess.length; i++) {
      const ticket = ticketsToProcess[i];

      console.log('\n' + '='.repeat(80));
      console.log(`📦 Processing Ticket ${i + 1}/${ticketsToProcess.length}: ${ticket.id}`);
      console.log(`📝 ${ticket.title}`);
      console.log('='.repeat(80) + '\n');

      try {
        // Determine if this is a frontend ticket
        const isFrontendTicket = ticket.id.startsWith('FRONTEND-');

        // Step 1: Ship implements the ticket (no commit)
        await shipCommand({
          ticket: ticket.id,
          ticketsFile,
          test: isFrontendTicket,
          review: true, // Always perform code review during build
          directory: cwd,
          dbUrl,
          noLogs,
        });

        console.log(`\n✅ ${ticket.id} implemented successfully`);

        // Step 2: Build handles commit logic
        if (askCommit) {
          // Interactive: ask before committing
          const shouldCommit = await promptConfirmation(`\n❓ Commit changes for ${ticket.id}?`);

          if (shouldCommit) {
            await commitTicket(ticket, cwd);
          } else {
            console.log('   ⏭️  Skipped commit (ticket marked as Done)\n');
          }
        } else {
          // Default: auto-commit
          await commitTicket(ticket, cwd);
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
