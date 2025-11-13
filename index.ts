#!/usr/bin/env node

/**
 * Kosuke CLI - Development Automation Tool
 *
 * Commands:
 *   sync-rules [--force]  Sync rules from kosuke-template
 *   analyse               Analyze and fix code quality issues
 *   lint                  Fix linting errors with Claude AI
 *   requirements          Interactive requirements gathering
 *
 * Usage:
 *   bun run kosuke sync-rules
 *   bun run kosuke analyse
 *   bun run kosuke lint
 *   bun run kosuke requirements
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
