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
 *   test                    Run atomic tests (web E2E or database validation)
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
 *   bun run kosuke test --prompt="Test user login flow" --type=web-test
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
          scaffold: args.includes('--scaffold'),
          prompt: args.find((arg) => arg.startsWith('--prompt='))?.split('=')[1],
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
        const promptArg = args.find((arg) => arg.startsWith('--prompt='))?.split('=')[1];

        if (!promptArg) {
          console.error('❌ The --prompt flag is required\n');
          console.log('Usage: kosuke test --prompt="..." [OPTIONS]');
          console.log('\nOptions:');
          console.log('  --prompt="..."       Test instructions (required)');
          console.log(
            '  --type=TYPE          Test type: web-test or db-test (auto-detected if not specified)'
          );
          console.log(
            '  --url=URL            Base URL for web tests (default: http://localhost:3000)'
          );
          console.log('  --db-url=URL         Database URL for db tests (default: postgres://...)');
          console.log(
            '  --headless           Run in headless mode (invisible browser, web-test only)'
          );
          console.log('  --verbose            Enable verbose output');
          console.log('  --directory=PATH     Directory to test (default: cwd)');
          console.log('\nExamples:');
          console.log('  kosuke test --prompt="Test user login flow" --type=web-test');
          console.log('  kosuke test --prompt="Validate users table exists" --type=db-test');
          console.log('  kosuke test --prompt="..." --verbose --headless');
          console.log('\nNote: This command is mainly used programmatically from kosuke build.');
          console.log('      For ticket-based testing with retries, use: kosuke build');
          process.exit(1);
        }

        const typeArg = args.find((arg) => arg.startsWith('--type='))?.split('=')[1];
        if (typeArg && typeArg !== 'web-test' && typeArg !== 'db-test') {
          console.error('❌ Invalid test type. Use: web-test or db-test\n');
          process.exit(1);
        }

        const options = {
          prompt: promptArg,
          type: typeArg as 'web-test' | 'db-test' | undefined,
          url: args.find((arg) => arg.startsWith('--url='))?.split('=')[1],
          dbUrl: args.find((arg) => arg.startsWith('--db-url='))?.split('=')[1],
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
    Generate implementation tickets from requirements document or inline prompt
    Intelligently determines which layers (schema/backend/frontend) are needed

    LOGIC-ONLY MODE (default - for existing projects):
      Analyzes requirements and generates only needed tickets:
      - Schema logic (if database changes needed)
      - Backend logic (if API changes needed)
      - Frontend logic (if UI changes needed)
      - DB tests (if schema changes)
      - Web tests (if implementation changes)

    SCAFFOLD MODE (--scaffold flag - for new projects):
      Generates full infrastructure setup + business logic:

      SCAFFOLD BATCH:
        1. Schema scaffold (auth, billing, infrastructure)
        2. DB test (validate scaffold)
        3. Backend scaffold (API infrastructure)
        4. Frontend scaffold (UI infrastructure)
        5. Web tests (validate scaffold E2E)

      LOGIC BATCH:
        1. Schema logic (business entities)
        2. DB test (validate logic)
        3. Backend logic (business API)
        4. Frontend logic (business UI)
        5. Web tests (validate logic E2E)

    Options:
      --path=<file>         Path to requirements document (default: docs.md)
      --prompt="..."        Inline requirements (alternative to --path)
      --scaffold            Enable scaffold mode for new projects
      --output=<file>       Output file for tickets (default: tickets.json)
      --directory=<path>    Directory for Claude to explore (default: current directory)
      --dir=<path>          Alias for --directory

    Examples:
      # Logic-only mode (existing projects)
      kosuke tickets --prompt="Add dark mode toggle"
      kosuke tickets --prompt="Add user notifications"
      kosuke tickets --path=feature.md

      # Scaffold mode (new projects)
      kosuke tickets --scaffold --path=docs.md
      kosuke tickets --scaffold --prompt="Build a task manager with teams"

      # With custom options
      kosuke tickets --directory=./my-app --prompt="Add export to CSV"
      kosuke tickets --output=my-tickets.json --path=requirements.md

  build [options]
    Batch process all "Todo" and "Error" tickets from tickets.json
    Implements tickets and runs tests with automatic fixing
    Processes tickets in order: Schema → DB Test → Backend → Frontend → Web Test
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

  review
    Review current git diff against CLAUDE.md rules
    Identifies and fixes compliance issues in uncommitted changes
    Note: Changes applied locally only (no --pr support)

    Examples:
      kosuke review                           # Review uncommitted changes

  test --prompt="..." [options]
    Run atomic tests (web E2E or database validation, no fixing, no retries)

    Test types:
      - web-test: Browser E2E testing with Stagehand + Claude AI
      - db-test:  Database schema validation with Claude Code

    For iterative test+fix workflow, use: kosuke build

    Options:
      --prompt="..."        Test instructions (required)
      --type=<type>         Test type: web-test or db-test (auto-detected if not specified)
      --url=<URL>           Base URL for web tests (default: http://localhost:3000)
      --db-url=<URL>        Database URL for db tests (default: postgres://postgres:postgres@localhost:5432/postgres)
      --headless            Run browser in headless mode (web-test only, invisible)
      --verbose             Enable verbose output
      --directory=<path>    Directory to run tests in (default: current directory)
      --dir=<path>          Alias for --directory

    Examples:
      kosuke test --prompt="Test user login flow" --type=web-test
      kosuke test --prompt="Validate users table exists" --type=db-test
      kosuke test --prompt="..." --url=http://localhost:4000
      kosuke test --prompt="..." --db-url=postgres://...
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
