/**
 * Build command - Batch process all tickets from tickets.json
 *
 * This command processes all "Todo" and "Error" tickets sequentially,
 * implementing each one using the ship command with --commit flag.
 * Each ticket is committed individually to the current branch.
 * Frontend tickets automatically include the --test flag.
 *
 * Usage:
 *   kosuke build                           # Process and commit all tickets
 *   kosuke build --tickets=path/to/tickets.json
 *   kosuke build --db-url=postgres://user:pass@host:5432/db
 *
 * Note: Create a feature branch before running build:
 *   git checkout -b feat/implement-tickets
 *   kosuke build
 *   gh pr create
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { shipCommand } from './ship.js';
import type { BuildOptions, Ticket } from '../types.js';

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
 * Filter and sort tickets for processing
 */
function getTicketsToProcess(ticketsData: TicketsFile): Ticket[] {
  // Get all Todo and Error tickets (automatic retry on Error)
  let tickets = ticketsData.tickets.filter((t) => t.status === 'Todo' || t.status === 'Error');

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
      dbUrl = 'postgres://postgres:postgres@postgres:5432/postgres',
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

    // 1. Load tickets
    console.log('📋 Loading tickets...');
    const ticketsData = loadTicketsFile(ticketsPath);
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

    // 2. Process each ticket sequentially with ship --commit
    for (let i = 0; i < ticketsToProcess.length; i++) {
      const ticket = ticketsToProcess[i];

      console.log('\n' + '='.repeat(80));
      console.log(`📦 Processing Ticket ${i + 1}/${ticketsToProcess.length}: ${ticket.id}`);
      console.log(`📝 ${ticket.title}`);
      console.log('='.repeat(80) + '\n');

      try {
        // Determine if this is a frontend ticket
        const isFrontendTicket = ticket.id.startsWith('FRONTEND-');

        // Use ship command with --commit flag, add --test for frontend tickets
        await shipCommand({
          ticket: ticket.id,
          commit: true,
          ticketsFile,
          test: isFrontendTicket,
          directory: cwd,
          dbUrl,
          noLogs,
        });

        console.log(`\n✅ ${ticket.id} completed and committed successfully\n`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`\n❌ Failed to process ${ticket.id}: ${errorMessage}`);
        console.error('\n❌ Build stopped due to ticket failure');
        console.error('ℹ️  Fix the issue and run build again to resume from failed tickets\n');
        throw error;
      }
    }

    // 3. Display final summary
    console.log('\n' + '='.repeat(80));
    console.log('✅ Build Completed Successfully!');
    console.log('='.repeat(80));
    console.log(`📦 Total tickets processed: ${ticketsToProcess.length}`);
    console.log(`✅ All tickets have been committed to current branch`);
    console.log('='.repeat(80));
    console.log('\n💡 Next steps:');
    console.log('   - Review the commits');
    console.log('   - Create a PR using: gh pr create');
    console.log('   - Or push to a remote branch and create PR manually\n');
  } catch (error) {
    console.error('\n❌ Build failed:', error);
    throw error;
  }
}
