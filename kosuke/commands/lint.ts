/**
 * Lint command - Use Claude to fix linting errors
 *
 * Strategy: Run linter, give errors to Claude, let it fix them
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { runLint } from '../utils/validator.js';
import { commit, push, createBranch, getCurrentRepo } from '../utils/git.js';
import { createPullRequest } from '../utils/github.js';

interface LintOptions {
  dryRun?: boolean;
  noPr?: boolean;
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
 * Main lint command
 */
export async function lintCommand(options: LintOptions = {}): Promise<void> {
  console.log('🚀 Starting Kosuke Lint Fix...\n');

  try {
    // Validate environment for PR creation
    if (!options.noPr) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY environment variable is required');
      }
      if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN environment variable is required');
      }
    }

    // Run initial lint check
    console.log('🔍 Running linter...\n');
    let lintResult = await runLint();

    if (lintResult.success) {
      console.log('✅ No linting errors found! Code is clean.\n');
      return;
    }

    console.log('❌ Linting errors found:\n');
    console.log(lintResult.error);

    if (options.dryRun) {
      console.log('\n🔍 DRY RUN MODE: Not fixing errors.');
      return;
    }

    // Create working branch
    let branchName = '';
    if (!options.noPr) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('.')[0];
      branchName = `fix/kosuke-lint-${timestamp}`;
      console.log(`\n🌿 Creating branch: ${branchName}\n`);
      await createBranch(branchName);
    }

    // Use Claude to fix errors (up to 3 attempts)
    let attemptCount = 0;
    const maxAttempts = 3;

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

      // Verify fixes by running lint again
      console.log('\n🔍 Verifying fixes...\n');
      lintResult = await runLint();

      if (lintResult.success) {
        console.log('✅ All linting errors fixed!\n');
        break;
      } else {
        console.log(
          `\n⚠️  Some errors remain (${lintResult.error?.split('\n').length || 0} lines):`
        );
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

    // Commit and push if not in no-PR mode
    if (!options.noPr && branchName) {
      try {
        console.log('\n📝 Committing fixes...\n');
        await commit('chore: fix linting errors');
        console.log('✅ Changes committed\n');

        console.log('📤 Pushing changes...\n');
        await push(branchName);
        console.log('✅ Changes pushed\n');

        // Create PR
        console.log('📋 Creating pull request...\n');
        const { owner, repo } = await getCurrentRepo();

        const prBody = `## 🔧 Automated Lint Fixes

This PR contains automated fixes for linting errors.

### 📈 Summary
- **Fix Attempts**: ${attemptCount}
- **Status**: ✅ All errors fixed

### ✅ Validation
- Linting: **PASSED**

---

🤖 *Generated by Kosuke CLI (\`kosuke lint\`)*`;

        const prUrl = await createPullRequest({
          owner,
          repo,
          title: `chore: Fix linting errors`,
          head: branchName,
          base: 'main',
          body: prBody,
        });

        console.log(`✅ Pull request created: ${prUrl}`);
      } catch (error) {
        console.error('\n❌ Failed to create PR:', error);
        if (branchName) {
          console.log(`\nℹ️  Changes may be on branch: ${branchName}`);
          console.log(`   You can manually create a PR from this branch.`);
        }
        throw error;
      }
    }

    console.log('\n✅ Lint fixing complete!');
  } catch (error) {
    console.error('\n❌ Lint fixing failed:', error);
    throw error;
  }
}
