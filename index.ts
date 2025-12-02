#!/usr/bin/env node

/**
 * Kosuke CLI - Development Automation Tool
 *
 * Commands:
 *   sync-rules [--force]    Sync rules from kosuke-template
 *   analyse                 Analyze and fix code quality issues
 *   lint                    Fix linting errors with Claude AI
 *   requirements            Interactive requirements gathering
 *   plan                    AI-driven ticket planning from feature/bug descriptions
 *   getcode                 Explore GitHub repositories and fetch code
 *   tickets                 Generate implementation tickets from requirements
 *   build                   Batch process all tickets from tickets.json
 *   migrate                 Apply database migrations and validate schema
 *   review                  Review codebase against CLAUDE.md rules
 *   test                    Run atomic web E2E tests
 *
 * Usage:
 *   bun run kosuke sync-rules
 *   bun run kosuke analyse
 *   bun run kosuke lint
 *   bun run kosuke requirements
 *   bun run kosuke getcode "query"
 *   bun run kosuke tickets
 *   bun run kosuke build
 *   bun run kosuke migrate
 *   bun run kosuke review
 *   bun run kosuke test --prompt="Test user login flow"
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
import { migrateCommand } from './kosuke/commands/migrate.js';
import { planCommand } from './kosuke/commands/plan.js';
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

      case 'plan': {
        const options = {
          prompt: args.find((arg) => arg.startsWith('--prompt='))?.split('=')[1] || '',
          directory:
            args.find((arg) => arg.startsWith('--directory='))?.split('=')[1] ||
            args.find((arg) => arg.startsWith('--dir='))?.split('=')[1],
          output: args.find((arg) => arg.startsWith('--output='))?.split('=')[1],
          noTest: args.includes('--no-test'),
          noLogs: args.includes('--no-logs'),
        };

        if (!options.prompt) {
          console.error('❌ The --prompt flag is required\n');
          console.log('Usage: kosuke plan --prompt="..." [OPTIONS]');
          console.log('\nOptions:');
          console.log('  --prompt="..."       Feature or bug description (required)');
          console.log('  --directory=PATH     Directory with existing code (default: cwd)');
          console.log('  --output=FILE        Output file for tickets (default: tickets.json)');
          console.log('  --no-test            Skip WEB-TEST ticket creation');
          console.log('\nExamples:');
          console.log('  kosuke plan --prompt="Add dark mode toggle"');
          console.log('  kosuke plan --prompt="Fix login timeout bug" --directory=./my-app');
          console.log(
            '  kosuke plan --prompt="Add user notifications" --output=feature-tickets.json'
          );
          process.exit(1);
        }

        await planCommand(options);
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
          scaffold: args.includes('--scaffold'),
          prompt: args.find((arg) => arg.startsWith('--prompt='))?.split('=')[1],
          noTest: args.includes('--no-test'),
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

      case 'migrate': {
        const options = {
          directory:
            args.find((arg) => arg.startsWith('--directory='))?.split('=')[1] ||
            args.find((arg) => arg.startsWith('--dir='))?.split('=')[1],
          dbUrl: args.find((arg) => arg.startsWith('--db-url='))?.split('=')[1],
          noLogs: args.includes('--no-logs'),
        };
        await migrateCommand(options);
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
        const promptArg = args.find((arg) => arg.startsWith('--prompt='))?.split('=')[1];

        if (!promptArg) {
          console.error('❌ The --prompt flag is required\n');
          console.log('Usage: kosuke test --prompt="..." [OPTIONS]');
          console.log('\nOptions:');
          console.log('  --prompt="..."       Test instructions (required)');
          console.log(
            '  --url=URL            Base URL for web tests (default: http://localhost:3000)'
          );
          console.log('  --headless           Run in headless mode (invisible browser)');
          console.log('  --verbose            Enable verbose output');
          console.log('  --directory=PATH     Directory to test (default: cwd)');
          console.log('\nExamples:');
          console.log('  kosuke test --prompt="Test user login flow"');
          console.log('  kosuke test --prompt="Test task creation" --verbose --headless');
          console.log('\nNote: This command is mainly used programmatically from kosuke build.');
          console.log('      For ticket-based testing with retries, use: kosuke build');
          process.exit(1);
        }

        const options = {
          prompt: promptArg,
          url: args.find((arg) => arg.startsWith('--url='))?.split('=')[1],
          headless: args.includes('--headless'),
          verbose: args.includes('--verbose'),
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

  plan --prompt="..." [options]
    AI-driven ticket planning from feature/bug descriptions
    Analyzes existing codebase and asks clarification questions
    Generates tickets.json compatible with build command

    Options:
      --prompt="..."        Feature or bug description (required)
      --directory=<path>    Directory with existing code (default: current directory)
      --dir=<path>          Alias for --directory
      --output=<file>       Output file for tickets (default: tickets.json)

    Examples:
      kosuke plan --prompt="Add dark mode toggle"
      kosuke plan --prompt="Fix login timeout bug" --directory=./my-app
      kosuke plan --prompt="Add user notifications" --output=feature-tickets.json

    Features:
      - Analyzes codebase to understand existing patterns
      - Asks non-technical clarification questions
      - Auto-detects ticket types (SCHEMA, BACKEND, FRONTEND, WEB-TEST)
      - Reply "go with recommendations" to accept all defaults

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
    Generate implementation tickets from requirements document or prompt
    
    Two modes of operation:

    PROMPT MODE (--prompt flag):
      Uses 'plan' command internally for INTERACTIVE ticket creation.
      Claude asks clarification questions before generating tickets.
      Best for: Adding features or fixing bugs in existing projects.

    DOCUMENT MODE (--path or docs.md):
      Generates tickets directly from requirements document.
      No clarification questions - assumes requirements are complete.
      Best for: New projects with docs.md from 'kosuke requirements'.

    SCAFFOLD MODE (--scaffold, document mode only):
      Generates infrastructure adaptation + business logic tickets.

    Options:
      --prompt="..."        Feature/bug description (triggers interactive mode)
      --path=<file>         Path to requirements document (default: docs.md)
      --scaffold            Enable scaffold mode (document mode only)
      --output=<file>       Output file for tickets (default: tickets.json)
      --directory=<path>    Directory for Claude to explore (default: current directory)
      --dir=<path>          Alias for --directory

    Examples:
      # Interactive mode (with clarification questions)
      kosuke tickets --prompt="Add dark mode toggle" --dir=./my-app
      kosuke tickets --prompt="Fix login timeout bug"

      # Document mode (no questions, from docs.md)
      kosuke tickets                              # Uses docs.md
      kosuke tickets --path=feature.md            # Custom file
      kosuke tickets --scaffold                   # Scaffold + logic from docs.md

  build [options]
    Batch process all "Todo" and "Error" tickets from tickets.json
    Implements tickets and runs tests with automatic fixing
    Processes tickets in order: Schema (auto-validated) → Backend → Frontend → Web Test
    Commits in batches after each web-test completion
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

  migrate [options]
    Apply database migrations and validate schema changes
    Uses Claude Code Agent to run migrations, seed database, and validate

    Note: This command does NOT generate migrations (ship handles that)
          Automatically called by build command after SCHEMA tickets

    Options:
      --directory=<path>    Directory to run migrations in (default: current directory)
      --dir=<path>          Alias for --directory
      --db-url=<url>        Database URL (default: postgres://postgres:postgres@localhost:5432/postgres)

    Examples:
      kosuke migrate                          # Apply migrations in current directory
      kosuke migrate --directory=./my-app    # Apply in specific project
      kosuke migrate --db-url=postgres://... # Custom database URL

  review
    Review current git diff against CLAUDE.md rules
    Identifies and fixes compliance issues in uncommitted changes
    Note: Changes applied locally only (no --pr support)

    Examples:
      kosuke review                           # Review uncommitted changes

  test --prompt="..." [options]
    Run atomic web E2E tests (no fixing, no retries)

    Test type:
      - web-test: Browser E2E testing with Stagehand + Claude AI

    For iterative test+fix workflow, use: kosuke build

    Options:
      --prompt="..."        Test instructions (required)
      --url=<URL>           Base URL for web tests (default: http://localhost:3000)
      --headless            Run browser in headless mode (invisible)
      --verbose             Enable verbose output
      --directory=<path>    Directory to run tests in (default: current directory)
      --dir=<path>          Alias for --directory

    Examples:
      kosuke test --prompt="Test user login flow"
      kosuke test --prompt="Test task creation" --url=http://localhost:4000
      kosuke test --prompt="..." --verbose --headless
      kosuke test --prompt="..." --directory=./my-project

    Note: This command is mainly used programmatically from kosuke build.
          For ticket-based testing with retries, use: kosuke build

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
