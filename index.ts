#!/usr/bin/env node

/**
 * Kosuke CLI - Development Automation Tool
 *
 * Commands:
 *   sync-rules [--force]  Sync rules from kosuke-template
 *   analyse               Analyze and fix code quality issues
 *   lint                  Fix linting errors with Claude AI
 *   requirements          Interactive requirements gathering
 *   getcode               Explore GitHub repositories and fetch code
 *   tickets               Generate implementation tickets from requirements
 *
 * Usage:
 *   bun run kosuke sync-rules
 *   bun run kosuke analyse
 *   bun run kosuke lint
 *   bun run kosuke requirements
 *   bun run kosuke getcode "query"
 *   bun run kosuke tickets
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
