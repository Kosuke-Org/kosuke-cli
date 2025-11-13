/**
 * Lint command - Use Claude to fix linting errors
 *
 * Strategy: Run linter, give errors to Claude, let it fix them
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { runLint } from '../utils/validator.js';
import { runWithPR } from '../utils/pr-orchestrator.js';
import type { LintOptions } from '../types.js';

interface LintFixResult {
  success: boolean;
  attempts: number;
  fixesApplied: number;
}

/**
 * Run Claude-powered lint fixing
 */
async function fixLintErrors(lintErrors: string): Promise<boolean> {
  console.log('\n🤖 Using Claude to fix linting errors...\n');

  const workspaceRoot = process.cwd();

  // System prompt
  const systemPrompt = `You are a code quality expert specialized in fixing linting errors.

Your task is to analyze linting errors and fix them according to the project's linting rules.

IMPORTANT: Focus ONLY on fixing the specific linting errors provided. Do not make unnecessary changes.`;

  // User prompt
  const promptText = `The following linting errors need to be fixed:

\`\`\`
${lintErrors}
\`\`\`

**Your task:**
1. Analyze each linting error carefully
2. Read the files that have errors
3. Fix each error according to the linting rules
4. Make minimal changes - only fix what's broken
5. Ensure your fixes don't introduce new issues

Start by reading the files with errors and fixing them one by one.`;

  const options: Options = {
    model: 'claude-sonnet-4-5',
    systemPrompt,
    maxTurns: 20,
    cwd: workspaceRoot,
    permissionMode: 'bypassPermissions',
  };

  try {
    const responseStream = query({ prompt: promptText, options });

    let fixCount = 0;

    // Display Claude's actions
    for await (const message of responseStream) {
      if (message.type === 'assistant') {
        const content = message.message.content;
        for (const block of content) {
          if (block.type === 'text' && block.text.trim()) {
            const text = block.text.trim();
            // Show key insights
            if (
              text.includes('fix') ||
              text.includes('error') ||
              text.includes('✅') ||
              text.includes('❌')
            ) {
              console.log(`   💭 ${text}`);
            }
          } else if (block.type === 'tool_use') {
            if (block.name === 'write' || block.name === 'search_replace') {
              fixCount++;
              console.log(`   🔧 Applying fix ${fixCount}...`);
            }
          }
        }
      }
    }

    console.log(`\n✨ Claude completed (${fixCount} fixes applied)`);
    return fixCount > 0;
  } catch (error) {
    console.error('\n❌ Error during Claude fixing:', error);
    return false;
  }
}

/**
 * Core lint fixing logic (git-agnostic)
 */
async function fixLintErrorsCore(): Promise<LintFixResult> {
  console.log('🔍 Running linter...\n');
  let lintResult = await runLint();

  if (lintResult.success) {
    console.log('✅ No linting errors found! Code is clean.\n');
    return { success: true, attempts: 0, fixesApplied: 0 };
  }

  console.log('❌ Linting errors found:\n');
  console.log(lintResult.error);

  // Use Claude to fix errors (up to 3 attempts)
  let attemptCount = 0;
  const maxAttempts = 3;
  let totalFixes = 0;

  while (!lintResult.success && attemptCount < maxAttempts) {
    attemptCount++;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔄 Fix Attempt ${attemptCount}/${maxAttempts}`);
    console.log(`${'='.repeat(60)}`);

    const fixApplied = await fixLintErrors(lintResult.error || '');

    if (!fixApplied) {
      console.log('\n⚠️  No fixes were applied by Claude');
      break;
    }

    totalFixes++;

    // Verify fixes by running lint again
    console.log('\n🔍 Verifying fixes...\n');
    lintResult = await runLint();

    if (lintResult.success) {
      console.log('✅ All linting errors fixed!\n');
      break;
    } else {
      console.log(`\n⚠️  Some errors remain (${lintResult.error?.split('\n').length || 0} lines):`);
      console.log(lintResult.error);
    }
  }

  // Check final result
  if (!lintResult.success) {
    console.error('\n❌ Could not fix all linting errors after 3 attempts');
    console.log('\nRemaining errors:');
    console.log(lintResult.error);
    throw new Error('Linting errors remain after maximum attempts');
  }

  return {
    success: true,
    attempts: attemptCount,
    fixesApplied: totalFixes,
  };
}

/**
 * Main lint command
 */
export async function lintCommand(options: LintOptions = {}): Promise<void> {
  console.log('🚀 Starting Kosuke Lint Fix...\n');

  try {
    // Validate environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    // If --pr flag is provided, wrap with PR workflow
    if (options.pr) {
      const { result, prInfo } = await runWithPR(
        {
          branchPrefix: 'fix/kosuke-lint',
          baseBranch: options.baseBranch,
          commitMessage: 'chore: fix linting errors',
          prTitle: 'chore: Fix linting errors',
          prBody: `## 🔧 Automated Lint Fixes

This PR contains automated fixes for linting errors.

### 📈 Summary
- **Status**: ✅ All errors fixed

### ✅ Validation
- Linting: **PASSED**

---

🤖 *Generated by Kosuke CLI (\`kosuke lint --pr\`)*`,
        },
        fixLintErrorsCore
      );

      console.log('\n✅ Lint fixing complete!');
      console.log(`📊 Attempts: ${result.attempts}`);
      console.log(`🔧 Fixes applied: ${result.fixesApplied}`);
      console.log(`🔗 PR: ${prInfo.prUrl}`);
    } else {
      // Run core logic without PR
      const result = await fixLintErrorsCore();

      console.log('\n✅ Lint fixing complete!');
      console.log(`📊 Attempts: ${result.attempts}`);
      console.log(`🔧 Fixes applied: ${result.fixesApplied}`);
      console.log('\nℹ️  Changes applied locally. Use --pr flag to create a pull request.');
    }
  } catch (error) {
    console.error('\n❌ Lint fixing failed:', error);
    throw error;
  }
}
