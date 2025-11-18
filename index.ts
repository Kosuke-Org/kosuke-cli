#!/usr/bin/env node

/**
 * Kosuke CLI - Development Automation Tool
 *
 * Commands:
 *   sync-rules [--force]    Sync rules from kosuke-template
 *   analyse                 Analyze and fix code quality issues
 *   lint                    Fix linting errors with Claude AI
 *   requirements            Interactive requirements gathering
 *   getcode                 Explore GitHub repositories and fetch code
 *   tickets                 Generate implementation tickets from requirements
 *   ship --ticket=<ID>      Implement a single ticket from tickets.json
 *   build                   Batch process all tickets from tickets.json
 *   review                  Review codebase against CLAUDE.md rules
 *   test --ticket=<ID>      Run E2E tests with automated fixing
 *
 * Usage:
 *   bun run kosuke sync-rules
 *   bun run kosuke analyse
 *   bun run kosuke lint
 *   bun run kosuke requirements
 *   bun run kosuke getcode "query"
 *   bun run kosuke tickets
 *   bun run kosuke ship --ticket=SCHEMA-1
 *   bun run kosuke build
 *   bun run kosuke review
 *   bun run kosuke test --ticket=FRONTEND-1
 *
 * Environment Variables:
 *   ANTHROPIC_API_KEY - Required for Claude API
 *   GITHUB_TOKEN - Required for creating PRs
 */

import 'dotenv/config';
import { syncRulesCommand } from './kosuke/commands/sync-rules.js';
import { analyseCommand } from './kosuke/commands/analyse.js';
import { lintCommand } from './kosuke/commands/lint.js';
import { requirementsCommand } from './kosuke/commands/requirements.js';
import { getCodeCommand, parseGetCodeArgs } from './kosuke/commands/getcode.js';
import { ticketsCommand } from './kosuke/commands/tickets.js';
import { shipCommand } from './kosuke/commands/ship.js';
import { buildCommand } from './kosuke/commands/build.js';
import { reviewCommand } from './kosuke/commands/review.js';
import { testCommand } from './kosuke/commands/test.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    showHelp();
    process.exit(0);
  }

  try {
    switch (command) {
      case 'sync-rules': {
        const options = {
          force: args.includes('--force'),
          pr: args.includes('--pr'),
          baseBranch: args.find((arg) => arg.startsWith('--base-branch='))?.split('=')[1],
        };
        await syncRulesCommand(options);
        break;
      }

      case 'analyse': {
        const options = {
          pr: args.includes('--pr'),
          baseBranch: args.find((arg) => arg.startsWith('--base-branch='))?.split('=')[1],
          scope: args.find((arg) => arg.startsWith('--scope='))?.split('=')[1],
          types: args
            .find((arg) => arg.startsWith('--types='))
            ?.split('=')[1]
            ?.split(','),
        };
        await analyseCommand(options);
        break;
      }

      case 'lint': {
        const options = {
          pr: args.includes('--pr'),
          baseBranch: args.find((arg) => arg.startsWith('--base-branch='))?.split('=')[1],
        };
        await lintCommand(options);
        break;
      }

      case 'requirements': {
        await requirementsCommand();
        break;
      }

      case 'getcode': {
        const options = parseGetCodeArgs(args);
        await getCodeCommand(options);
        break;
      }

      case 'tickets': {
        const options = {
          path: args.find((arg) => arg.startsWith('--path='))?.split('=')[1],
          output: args.find((arg) => arg.startsWith('--output='))?.split('=')[1],
          template: args.find((arg) => arg.startsWith('--template='))?.split('=')[1],
        };
        await ticketsCommand(options);
        break;
      }

      case 'ship': {
        const ticketArg = args.find((arg) => arg.startsWith('--ticket='))?.split('=')[1];
        if (!ticketArg) {
          console.error('❌ --ticket flag is required\n');
          console.log('Usage: kosuke ship --ticket=SCHEMA-1 [--review] [--test] [--commit | --pr]');
          console.log('\nExamples:');
          console.log('  kosuke ship --ticket=SCHEMA-1                # Local only');
          console.log('  kosuke ship --ticket=BACKEND-2 --review      # With review');
          console.log('  kosuke ship --ticket=FRONTEND-1 --test       # With testing');
          console.log('  kosuke ship --ticket=FRONTEND-1 --commit     # Commit to current branch');
          console.log('  kosuke ship --ticket=BACKEND-3 --pr          # Create PR (new branch)');
          process.exit(1);
        }

        const options = {
          ticket: ticketArg,
          review: args.includes('--review'),
          test: args.includes('--test'),
          commit: args.includes('--commit'),
          pr: args.includes('--pr'),
          baseBranch: args.find((arg) => arg.startsWith('--base-branch='))?.split('=')[1],
          ticketsFile: args.find((arg) => arg.startsWith('--tickets='))?.split('=')[1],
        };
        await shipCommand(options);
        break;
      }

      case 'build': {
        const options = {
          ticketsFile: args.find((arg) => arg.startsWith('--tickets='))?.split('=')[1],
        };
        await buildCommand(options);
        break;
      }

      case 'review': {
        const options = {};
        await reviewCommand(options);
        break;
      }

      case 'test': {
        const ticketArg = args.find((arg) => arg.startsWith('--ticket='))?.split('=')[1];
        if (!ticketArg) {
          console.error('❌ --ticket flag is required\n');
          console.log('Usage: kosuke test --ticket=FRONTEND-1 [--url=URL] [--headed] [--pr]');
          console.log('\nExamples:');
          console.log('  kosuke test --ticket=FRONTEND-1                    # Test with auto-fix');
          console.log('  kosuke test --ticket=FRONTEND-1 --url=http://localhost:4000');
          console.log('  kosuke test --ticket=FRONTEND-1 --headed           # Show browser');
          console.log('  kosuke test --ticket=FRONTEND-1 --update-baseline  # Update visuals');
          console.log('  kosuke test --ticket=FRONTEND-1 --pr               # Create PR');
          process.exit(1);
        }

        const options = {
          ticket: ticketArg,
          url: args.find((arg) => arg.startsWith('--url='))?.split('=')[1],
          headed: args.includes('--headed'),
          debug: args.includes('--debug'),
          updateBaseline: args.includes('--update-baseline'),
          maxRetries: parseInt(
            args.find((arg) => arg.startsWith('--max-retries='))?.split('=')[1] || '3'
          ),
          ticketsFile: args.find((arg) => arg.startsWith('--tickets='))?.split('=')[1],
          pr: args.includes('--pr'),
          baseBranch: args.find((arg) => arg.startsWith('--base-branch='))?.split('=')[1],
        };
        await testCommand(options);
        break;
      }

      default:
        console.error(`❌ Unknown command: ${command}\n`);
        showHelp();
        process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║              Kosuke CLI - Development Tools               ║
╚═══════════════════════════════════════════════════════════╝

COMMANDS:

  sync-rules [options]
    Sync rules and documentation from kosuke-template
    
    Options:
      --force               Compare files regardless of recent commit history
      --pr                  Create a pull request with changes
      --base-branch=<name>  Base branch for PR (default: current branch)
    
    Examples:
      kosuke sync-rules                    # Local changes only
      kosuke sync-rules --force            # Force comparison
      kosuke sync-rules --pr               # Create PR
      kosuke sync-rules --pr --base-branch=develop

  analyse [options]
    Analyze and fix code quality issues against CLAUDE.md rules
    Applies fixes locally by default
    
    Options:
      --pr                  Create a pull request with fixes
      --base-branch=<name>  Base branch for PR (default: current branch)
      --scope=<dirs>        Analyze specific directories (comma-separated)
      --types=<exts>        Analyze specific file types (comma-separated)
    
    Examples:
      kosuke analyse                       # Local fixes only
      kosuke analyse --pr                  # Create PR with fixes
      kosuke analyse --scope=hooks,lib/trpc
      kosuke analyse --types=ts,tsx
      kosuke analyse --pr --base-branch=main

  lint [options]
    Use Claude AI to automatically fix linting errors
    Applies fixes locally by default
    
    Options:
      --pr                  Create a pull request with fixes
      --base-branch=<name>  Base branch for PR (default: current branch)
    
    Examples:
      kosuke lint                          # Local fixes only
      kosuke lint --pr                     # Create PR with fixes
      kosuke lint --pr --base-branch=main

  requirements
    Interactive requirements gathering with Claude AI
    Generates a comprehensive docs.md file
    
    Examples:
      kosuke requirements

  getcode [repo] "<query>" [options]
    Explore GitHub repositories and fetch code implementations
    Uses Claude Code Agent to find and explain code
    
    Options:
      --template, -t        Use kosuke-template repository
      --output=<file>       Save output to file
    
    Examples:
      kosuke getcode "facebook/react" "How does reconciliation work?"
      kosuke getcode "How is routing implemented in Next.js?"
      kosuke getcode --template "What authentication system is used?"
      kosuke getcode -t "Show me pagination examples"

  tickets [options]
    Generate implementation tickets from requirements document
    Analyzes requirements and creates structured tickets in three phases:
    1. Schema tickets (database design)
    2. Backend tickets (API, services, business logic)
    3. Frontend tickets (pages, components, UI)
    
    Options:
      --path=<file>         Path to requirements document (default: docs.md)
      --output=<file>       Output file for tickets (default: tickets.json)
      --template=<repo>     Custom template repository (default: kosuke-template)
    
    Examples:
      kosuke tickets                          # Use docs.md
      kosuke tickets --path=requirements.md   # Custom requirements file
      kosuke tickets --output=my-tickets.json # Custom output file

  ship --ticket=<ID> [options]
    Implement a single ticket from tickets.json
    Follows CLAUDE.md rules, runs linting, and optionally performs review and tests
    
    Options:
      --ticket=<ID>         Ticket ID to implement (required, e.g., SCHEMA-1)
      --review              Perform code review step after implementation
      --test                Run E2E tests after implementation
      --commit              Commit and push to current branch
      --pr                  Create new branch and pull request (mutually exclusive with --commit)
      --base-branch=<name>  Base branch for PR (default: current branch)
      --tickets=<file>      Path to tickets file (default: tickets.json)
    
    Examples:
      kosuke ship --ticket=SCHEMA-1                # Implement locally only
      kosuke ship --ticket=BACKEND-2 --review      # Implement with review
      kosuke ship --ticket=FRONTEND-1 --test       # Implement with testing
      kosuke ship --ticket=FRONTEND-1 --commit     # Commit to current branch
      kosuke ship --ticket=BACKEND-3 --pr          # Create new branch + PR
      kosuke ship --ticket=SCHEMA-1 --tickets=custom.json

  build [options]
    Batch process all "Todo" and "Error" tickets from tickets.json
    Automatically commits each ticket to current branch
    Processes tickets in order: Schema → Backend → Frontend
    Frontend tickets automatically include E2E testing
    
    Options:
      --tickets=<file>      Path to tickets file (default: tickets.json)
    
    Examples:
      git checkout -b feat/implement-tickets  # Create feature branch first
      kosuke build                            # Process and commit all tickets
      gh pr create                            # Create PR manually
      
      kosuke build --tickets=custom.json      # Use custom tickets file
    
    Note: If a ticket fails, fix the issue and run build again to resume

  review
    Review current git diff against CLAUDE.md rules
    Identifies and fixes compliance issues in uncommitted changes
    Note: Changes applied locally only (no --pr support)
    
    Examples:
      kosuke review                           # Review uncommitted changes

  test --ticket=<ID> [options]
    Run E2E tests for a ticket with automated fixing
    Uses Playwright for testing, Claude AI for analyzing and fixing issues
    Iteratively tests and fixes until passing or max retries reached
    
    Options:
      --ticket=<ID>         Ticket ID to test (required, e.g., FRONTEND-1)
      --url=<URL>           Base URL (default: http://localhost:3000)
      --headed              Show browser during testing
      --debug               Enable Playwright inspector
      --update-baseline     Update visual regression baselines
      --max-retries=<N>     Maximum fix-retest iterations (default: 3)
      --tickets=<file>      Path to tickets file (default: tickets.json)
      --pr                  Create pull request with fixes
      --base-branch=<name>  Base branch for PR (default: current branch)
    
    Examples:
      kosuke test --ticket=FRONTEND-1                    # Test with auto-fix
      kosuke test --ticket=FRONTEND-1 --url=http://localhost:4000
      kosuke test --ticket=FRONTEND-1 --headed           # Show browser
      kosuke test --ticket=FRONTEND-1 --update-baseline  # Update visuals
      kosuke test --ticket=FRONTEND-1 --max-retries=5    # More attempts
      kosuke test --ticket=FRONTEND-1 --pr               # Create PR with fixes

WORKFLOW:

  By default, all commands apply changes locally without git operations.
  Use the --pr flag to create a pull request with the changes.

ENVIRONMENT VARIABLES:

  ANTHROPIC_API_KEY   Required for Claude API access
  GITHUB_TOKEN        Required when using --pr flag

CONFIGURATION:

  .kosukeignore       Exclude files/directories from analysis
                      (same syntax as .gitignore)
`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
