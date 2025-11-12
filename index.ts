#!/usr/bin/env tsx

/**
 * Kosuke CLI - Development Automation Tool
 *
 * Commands:
 *   sync-rules [--force]  Sync rules from kosuke-template
 *   analyse               Analyze and fix code quality issues
 *
 * Usage:
 *   bun run kosuke sync-rules
 *   bun run kosuke analyse
 *
 * Environment Variables:
 *   ANTHROPIC_API_KEY - Required for Claude API
 *   GITHUB_TOKEN - Required for creating PRs
 */

import 'dotenv/config';
import { syncRulesCommand } from './kosuke/commands/sync-rules';
import { analyseCommand } from './kosuke/commands/analyse';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    showHelp();
    process.exit(1);
  }

  try {
    switch (command) {
      case 'sync-rules': {
        const hasForceFlag = args.includes('--force');
        await syncRulesCommand(hasForceFlag);
        break;
      }

      case 'analyse': {
        const options = {
          dryRun: args.includes('--dry-run'),
          scope: args.find((arg) => arg.startsWith('--scope='))?.split('=')[1],
          types: args
            .find((arg) => arg.startsWith('--types='))
            ?.split('=')[1]
            ?.split(','),
        };
        await analyseCommand(options);
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

  sync-rules [--force]
    Sync rules and documentation from kosuke-template
    
    Options:
      --force    Compare files regardless of recent commit history
    
    Examples:
      bun run kosuke sync-rules
      bun run kosuke sync-rules --force

  analyse
    Analyze and fix code quality issues against CLAUDE.md rules
    Creates a single PR with all fixes from multiple isolated Claude runs
    
    Options:
      --dry-run       Report violations only, don't create PR
      --scope=<dirs>  Analyze specific directories (comma-separated)
      --types=<exts>  Analyze specific file types (comma-separated)
    
    Examples:
      bun run kosuke analyse
      bun run kosuke analyse --scope=hooks,lib/trpc
      bun run kosuke analyse --types=ts,tsx
      bun run kosuke analyse --dry-run

ENVIRONMENT VARIABLES:

  ANTHROPIC_API_KEY   Required for Claude API access
  GITHUB_TOKEN        Required for creating pull requests

CONFIGURATION:

  .kosukeignore       Exclude files/directories from analysis
                      (same syntax as .gitignore)
`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
