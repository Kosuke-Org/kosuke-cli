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
 *   build                   Batch process all tickets from tickets.json
 *   review                  Review codebase against CLAUDE.md rules
 *   test                    Run E2E tests with automated fixing (ticket or custom prompt)
 *
 * Usage:
 *   bun run kosuke sync-rules
 *   bun run kosuke analyse
 *   bun run kosuke lint
 *   bun run kosuke requirements
 *   bun run kosuke getcode "query"
 *   bun run kosuke tickets
 *   bun run kosuke build
 *   bun run kosuke review
 *   bun run kosuke test --ticket=FRONTEND-1 OR --prompt="Test login flow"
 *
 * Environment Variables:
 *   ANTHROPIC_API_KEY - Required for Claude API
 *   GITHUB_TOKEN - Required for creating PRs
 */

import 'dotenv/config';
import { analyseCommand } from './kosuke/commands/analyse.js';
import { buildCommand } from './kosuke/commands/build.js';
import { getCodeCommand, parseGetCodeArgs } from './kosuke/commands/getcode.js';
import { lintCommand } from './kosuke/commands/lint.js';
import { requirementsCommand } from './kosuke/commands/requirements.js';
import { reviewCommand } from './kosuke/commands/review.js';
import { syncRulesCommand } from './kosuke/commands/sync-rules.js';
import { testCommand } from './kosuke/commands/test.js';
import { ticketsCommand } from './kosuke/commands/tickets.js';

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
          noLogs: args.includes('--no-logs'),
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
          noLogs: args.includes('--no-logs'),
        };
        await analyseCommand(options);
        break;
      }

      case 'lint': {
        const options = {
          pr: args.includes('--pr'),
          baseBranch: args.find((arg) => arg.startsWith('--base-branch='))?.split('=')[1],
          directory: args.find((arg) => arg.startsWith('--directory='))?.split('=')[1],
          noLogs: args.includes('--no-logs'),
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
          directory:
            args.find((arg) => arg.startsWith('--directory='))?.split('=')[1] ||
            args.find((arg) => arg.startsWith('--dir='))?.split('=')[1],
          noLogs: args.includes('--no-logs'),
        };
        await ticketsCommand(options);
        break;
      }

      case 'build': {
        const options = {
          directory:
            args.find((arg) => arg.startsWith('--directory='))?.split('=')[1] ||
            args.find((arg) => arg.startsWith('--dir='))?.split('=')[1],
          ticketsFile: args.find((arg) => arg.startsWith('--tickets='))?.split('=')[1],
          dbUrl: args.find((arg) => arg.startsWith('--db-url='))?.split('=')[1],
          reset: args.includes('--reset'),
          askConfirm: args.includes('--ask-confirm'),
          askCommit: args.includes('--ask-commit'),
          review: !args.includes('--no-review'), // Default true, disabled with --no-review
          test: !args.includes('--no-test'), // Default true, disabled with --no-test
          url: args.find((arg) => arg.startsWith('--url='))?.split('=')[1],
          headless: args.includes('--headless'),
          verbose: args.includes('--verbose'),
          noLogs: args.includes('--no-logs'),
        };
        await buildCommand(options);
        break;
      }

      case 'review': {
        const options = {
          noLogs: args.includes('--no-logs'),
        };
        await reviewCommand(options);
        break;
      }

      case 'test': {
        const ticketArg = args.find((arg) => arg.startsWith('--ticket='))?.split('=')[1];
        const promptArg = args.find((arg) => arg.startsWith('--prompt='))?.split('=')[1];

        if (!ticketArg && !promptArg) {
          console.error('❌ Either --ticket or --prompt flag is required\n');
          console.log(
            'Usage: kosuke test --ticket=FRONTEND-1 [OPTIONS]  OR  kosuke test --prompt="..." [OPTIONS]'
          );
          console.log('\nOptions:');
          console.log('  --ticket=ID         Test a specific ticket from tickets.json');
          console.log('  --prompt="..."      Test with a custom prompt');
          console.log('  --url=URL           Base URL (default: http://localhost:3000)');
          console.log('  --headless          Run in headless mode (invisible browser)');
          console.log('  --verbose           Enable verbose output');
          console.log('  --directory=PATH    Directory to test (default: cwd)');
          console.log('\nExamples:');
          console.log('  kosuke test --ticket=FRONTEND-1                    # Test ticket');
          console.log('  kosuke test --prompt="Test login flow"             # Test with prompt');
          console.log('  kosuke test --ticket=FRONTEND-1 --verbose          # Verbose output');
          console.log('  kosuke test --prompt="..." --headless              # Headless mode');
          process.exit(1);
        }

        if (ticketArg && promptArg) {
          console.error('❌ Cannot provide both --ticket and --prompt. Use one or the other.\n');
          process.exit(1);
        }

        const options = {
          ticket: ticketArg,
          prompt: promptArg,
          url: args.find((arg) => arg.startsWith('--url='))?.split('=')[1],
          headless: args.includes('--headless'),
          verbose: args.includes('--verbose'),
          ticketsFile: args.find((arg) => arg.startsWith('--tickets='))?.split('=')[1],
          directory:
            args.find((arg) => arg.startsWith('--directory='))?.split('=')[1] ||
            args.find((arg) => arg.startsWith('--dir='))?.split('=')[1],
          noLogs: args.includes('--no-logs'),
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
      --directory=<path>    Directory to run linting in (default: current directory)

    Examples:
      kosuke lint                          # Local fixes only
      kosuke lint --pr                     # Create PR with fixes
      kosuke lint --pr --base-branch=main
      kosuke lint --directory=./my-project # Run lint in specific directory

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
      --path=<file>         Path to requirements document (default: docs.md, relative to project directory)
      --output=<file>       Output file for tickets (default: tickets.json, relative to project directory)
      --directory=<path>    Directory for Claude to explore (default: current directory)
      --dir=<path>          Alias for --directory

    Examples:
      kosuke tickets                                    # Use docs.md in current directory
      kosuke tickets --path=requirements.md             # Custom requirements file
      kosuke tickets --output=my-tickets.json           # Custom output file
      kosuke tickets --directory=./projects/my-app      # Analyze specific directory
      kosuke tickets --dir=./my-app --path=docs/spec.md # Custom directory and requirements path

  build [options]
    Batch process all "Todo" and "Error" tickets from tickets.json
    Implements and commits each ticket individually to current branch
    Processes tickets in order: Schema → Backend → Frontend
    Frontend tickets automatically include E2E testing (unless --no-test)
    All tickets include code review by default (unless --no-review)

    Options:
      --directory=<path>    Directory to run build in (default: current directory)
      --dir=<path>          Alias for --directory
      --tickets=<file>      Path to tickets file (default: tickets.json, relative to directory)
      --db-url=<url>        Database URL for migrations (default: postgres://postgres:postgres@postgres:5432/postgres)
      --reset               Reset all tickets to "Todo" status before processing (start from scratch)
      --ask-confirm         Ask for confirmation before proceeding to next ticket (useful for review)
      --ask-commit          Ask before committing each ticket (default: auto-commit after each ticket)
      --no-review           Skip code review phase (enabled by default)
      --no-test             Skip testing phase for frontend tickets (enabled by default)
      --url=<URL>           Base URL for testing (default: http://localhost:3000)
      --headless            Run tests in headless mode (invisible browser)
      --verbose             Enable verbose output for tests

    Examples:
      git checkout -b feat/implement-tickets  # Create feature branch first
      kosuke build                            # Process and auto-commit all tickets
      gh pr create                            # Create PR manually

      kosuke build --ask-commit               # Ask before committing each ticket
      kosuke build --ask-confirm              # Ask before processing each ticket
      kosuke build --ask-commit --ask-confirm # Fully interactive mode
      kosuke build --reset                    # Reset all tickets and start from scratch
      kosuke build --no-review --no-test      # Skip review and testing (fastest)
      kosuke build --headless                 # Run tests in headless mode
      kosuke build --verbose                  # Enable verbose test output
      kosuke build --tickets=custom.json      # Use custom tickets file
      kosuke build --directory=./my-project   # Run build in specific directory
      kosuke build --db-url=postgres://user:pass@host:5432/db  # Custom DB

    Note: If a ticket fails, fix the issue and run build again to resume

  review
    Review current git diff against CLAUDE.md rules
    Identifies and fixes compliance issues in uncommitted changes
    Note: Changes applied locally only (no --pr support)

    Examples:
      kosuke review                           # Review uncommitted changes

  test [--ticket=<ID> | --prompt="..."] [options]
    Run atomic browser tests with AI-powered automation (no fixing, no retries)
    Uses Stagehand with Claude AI for intelligent browser interaction
    For iterative test+fix workflow, use: kosuke ship --test

    Options:
      --ticket=<ID>         Ticket ID to test (from tickets.json, e.g., FRONTEND-1)
      --prompt="..."        Custom test prompt (alternative to --ticket)
      --url=<URL>           Base URL (default: http://localhost:3000)
      --headless            Run in headless mode (invisible browser)
      --verbose             Enable verbose output
      --tickets=<file>      Path to tickets file (default: tickets.json, relative to directory)
      --directory=<path>    Directory to run tests in (default: current directory)
      --dir=<path>          Alias for --directory

    Examples:
      kosuke test --ticket=FRONTEND-1                    # Test ticket (atomic)
      kosuke test --prompt="Test user login flow"        # Test with custom prompt
      kosuke test --ticket=FRONTEND-1 --url=http://localhost:4000
      kosuke test --prompt="..." --verbose               # Enable verbose output
      kosuke test --ticket=FRONTEND-1 --headless         # Run in headless mode
      kosuke test --ticket=FRONTEND-1 --directory=./my-project  # Specific directory

GLOBAL OPTIONS:

  --no-logs           Disable logging to Kosuke API (useful when kosuke-cli is used as library)
                      By default, logging is enabled if KOSUKE_BASE_URL, KOSUKE_API_KEY,
                      and KOSUKE_PROJECT_ID environment variables are set.
                      This flag can be used with any command to prevent API logging calls.

WORKFLOW:

  By default, all commands apply changes locally without git operations.
  Use the --pr flag to create a pull request with the changes.

ENVIRONMENT VARIABLES:

  ANTHROPIC_API_KEY     Required for Claude API access
  GITHUB_TOKEN          Required when using --pr flag
  KOSUKE_BASE_URL       Optional: Base URL for Kosuke API logging
  KOSUKE_API_KEY        Optional: API key for Kosuke API logging
  KOSUKE_PROJECT_ID     Optional: Project ID for Kosuke API logging

CONFIGURATION:

  .kosukeignore       Exclude files/directories from analysis
                      (same syntax as .gitignore)
`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
