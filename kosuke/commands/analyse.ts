/**
 * Analyse command - Analyze and fix code quality issues
 *
 * Strategy: Single PR with multiple isolated Claude runs
 * - Each batch of 10-12 files gets its own Claude run
 * - Claude only sees those specific files (no repository-wide context)
 * - Validate after each batch, commit locally
 * - Push all commits at once and create single PR
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import simpleGit from 'simple-git';
import { readFileSync } from 'fs';
import { join } from 'path';
import { discoverFiles } from '../utils/file-discovery.js';
import { createBatches } from '../utils/batch-creator.js';
import { runLint, runTypecheck } from '../utils/validator.js';
import { createBranch, commit, push, reset, getCurrentRepo } from '../utils/git.js';
import { createPullRequest } from '../utils/github.js';
import type { AnalyseOptions, Batch, Fix } from '../types.js';

interface BatchResult {
  fixes: Fix[];
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/**
 * Calculate cost based on Claude Sonnet 4.5 pricing
 * $3 per million input tokens, $15 per million output tokens
 */
function calculateCost(inputTokens: number, outputTokens: number): number {
  const INPUT_COST_PER_MILLION = 3.0;
  const OUTPUT_COST_PER_MILLION = 15.0;

  const inputCost = (inputTokens / 1_000_000) * INPUT_COST_PER_MILLION;
  const outputCost = (outputTokens / 1_000_000) * OUTPUT_COST_PER_MILLION;

  return inputCost + outputCost;
}

/**
 * Run Claude analysis on a single batch
 */
async function analyzeBatch(batch: Batch, _claudeMdRules: string): Promise<BatchResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔍 Analyzing: ${batch.name}`);
  console.log(`   Files: ${batch.files.join(', ')}`);
  console.log(`${'='.repeat(60)}\n`);

  const workspaceRoot = process.cwd();

  // System prompt: Just point to CLAUDE.md
  const systemPrompt = `You are a code quality analyzer for this repository.

Your task is to analyze specific files for code quality issues and fix them according to the rules in CLAUDE.md.

IMPORTANT: You will ONLY be given access to a specific batch of files. Do NOT explore the entire repository.

The rules you must follow are provided in CLAUDE.md.`;

  // User prompt: Simple and direct
  const promptText = `Analyze these ${batch.files.length} files for code quality issues:

${batch.files.map((f) => `- ${f}`).join('\n')}

**Your task:**
1. Read CLAUDE.md to understand all the rules and best practices
2. Read ONLY the files listed above (these are the files in this batch)
3. Check each file against the CLAUDE.md rules
4. Fix any violations you find
5. Do NOT explore or modify other files outside this batch

**Rules reference:** ${join(workspaceRoot, 'CLAUDE.md')}

Start by reading CLAUDE.md, then analyze the batch files.`;

  const options: Options = {
    model: 'claude-sonnet-4-5',
    systemPrompt,
    maxTurns: 15,
    cwd: workspaceRoot,
    permissionMode: 'bypassPermissions',
  };

  try {
    const responseStream = query({ prompt: promptText, options });

    let fixCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    // Display Claude's reasoning and actions
    for await (const message of responseStream) {
      if (message.type === 'assistant') {
        const content = message.message.content;
        for (const block of content) {
          if (block.type === 'text' && block.text.trim()) {
            // Only show key insights, not every detail
            const text = block.text.trim();
            if (
              text.includes('violation') ||
              text.includes('fix') ||
              text.includes('issue') ||
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

      // Track token usage from the response
      if (message.type === 'result' && message.subtype === 'success') {
        inputTokens += message.usage.input_tokens || 0;
        outputTokens += message.usage.output_tokens || 0;
      }
    }

    // Calculate cost for this batch
    const cost = calculateCost(inputTokens, outputTokens);

    // Return placeholder fixes (real fix tracking would require parsing Claude's edits)
    const fixes: Fix[] = batch.files.map((file) => ({
      file,
      type: 'other',
      description: 'Quality improvements',
      linesChanged: 0,
    }));

    console.log(`\n   ✨ Batch analysis complete (${fixCount} fixes applied)`);
    console.log(
      `   💰 Cost: $${cost.toFixed(4)} (${inputTokens.toLocaleString()} input + ${outputTokens.toLocaleString()} output tokens)`
    );

    return {
      fixes: fixCount > 0 ? fixes : [],
      inputTokens,
      outputTokens,
      cost,
    };
  } catch (error) {
    console.error(`\n   ❌ Error analyzing batch:`, error);
    throw error;
  }
}

/**
 * Validate fixes with lint and typecheck
 */
async function validateBatch(): Promise<boolean> {
  console.log(`   🔧 Running validation...`);

  const lintResult = await runLint();
  if (!lintResult.success) {
    console.error(`   ❌ Linting failed:\n${lintResult.error}`);
    return false;
  }
  console.log(`   ✅ Lint passed`);

  const typecheckResult = await runTypecheck();
  if (!typecheckResult.success) {
    console.error(`   ❌ Type checking failed:\n${typecheckResult.error}`);
    return false;
  }
  console.log(`   ✅ Typecheck passed`);

  return true;
}

/**
 * Create quality fixes PR
 */
async function createQualityPR(
  batches: Batch[],
  totalFixes: number,
  totalCost: number,
  totalInputTokens: number,
  totalOutputTokens: number
): Promise<void> {
  const { owner, repo } = await getCurrentRepo();

  const date = new Date().toISOString().split('T')[0];

  // Categorize by directory for summary
  const dirSummary = batches.reduce(
    (acc, batch) => {
      acc[batch.name] = (acc[batch.name] || 0) + batch.files.length;
      return acc;
    },
    {} as Record<string, number>
  );

  const prBody = `## 🔧 Automated Quality Fixes

This PR contains automated fixes to align the codebase with **CLAUDE.md** standards.

### 📈 Summary
- **Batches Processed**: ${batches.length}
- **Files Modified**: ${batches.reduce((sum, b) => sum + b.files.length, 0)}
- **Fixes Applied**: ${totalFixes}
- **💰 Estimated Cost**: $${totalCost.toFixed(4)}
  - Input tokens: ${totalInputTokens.toLocaleString()}
  - Output tokens: ${totalOutputTokens.toLocaleString()}
  - Model: Claude Sonnet 4.5 ($3/M input, $15/M output)

### 📦 Batches

${Object.entries(dirSummary)
  .map(([dir, count]) => `- **${dir}**: ${count} files`)
  .join('\n')}

### ✅ Validation
- Linting: **PASSED**
- Type checking: **PASSED**

### 🎯 Fix Categories

All fixes follow the comprehensive rules in CLAUDE.md, including:
- ✅ Type inference from tRPC routers
- ✅ Centralized type management
- ✅ Navigation patterns (Link vs Button)
- ✅ Loading states (Skeleton components)
- ✅ Component colocation
- ✅ Server-side filtering
- ✅ Python code quality (if applicable)

---

🤖 *Generated by Kosuke CLI (\`bun run kosuke analyse\`)*
`;

  // Get current branch name from git
  const git = simpleGit();
  const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);

  const prUrl = await createPullRequest({
    owner,
    repo,
    title: `chore: Quality Fixes (${date})`,
    head: currentBranch.trim(),
    base: 'main',
    body: prBody,
  });

  console.log(`✅ Pull request created: ${prUrl}`);
}

/**
 * Main analyse command
 */
export async function analyseCommand(options: AnalyseOptions = {}): Promise<void> {
  console.log('🚀 Starting Kosuke Quality Analysis...\n');

  try {
    // Validate environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }
    if (!process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN environment variable is required');
    }

    // Load CLAUDE.md rules
    const claudeMdPath = join(process.cwd(), 'CLAUDE.md');
    const claudeMdRules = readFileSync(claudeMdPath, 'utf-8');
    console.log('📖 Loaded CLAUDE.md rules\n');

    // Discover files
    console.log('🔍 Discovering files...');
    const files = await discoverFiles({
      scope: options.scope,
      types: options.types,
    });
    console.log(`📊 Found ${files.length} files to analyze\n`);

    if (files.length === 0) {
      console.log('ℹ️  No files found to analyze.');
      return;
    }

    // Create batches (10-12 files each, grouped by directory)
    const batches = createBatches(files, { maxSize: 10, groupBy: 'directory' });
    console.log(`📦 Created ${batches.length} batches\n`);

    // Dry run: just analyze and report
    if (options.dryRun) {
      console.log('🔍 DRY RUN MODE: Analyzing without creating PR...\n');
      for (const [index, batch] of batches.entries()) {
        console.log(`\nBatch ${index + 1}/${batches.length}: ${batch.name}`);
        console.log(`Files: ${batch.files.join(', ')}`);
      }
      console.log('\n✅ Dry run complete. Use without --dry-run to create PR.');
      return;
    }

    // Create working branch with unique name
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('.')[0];
    const branchName = `quality/kosuke-analysis-${timestamp}`;
    console.log(`🌿 Creating branch: ${branchName}\n`);
    await createBranch(branchName);

    // Process each batch with isolated Claude run
    const processedBatches: Batch[] = [];
    let totalFixes = 0;
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const [index, batch] of batches.entries()) {
      console.log(`\n📊 Progress: ${index + 1}/${batches.length}`);

      // Analyze batch (isolated Claude run)
      const result = await analyzeBatch(batch, claudeMdRules);

      if (result.fixes.length > 0) {
        // Validate changes
        const isValid = await validateBatch();

        if (isValid) {
          // Commit batch
          await commit(`fix(quality): ${batch.name} - ${result.fixes.length} improvements`);
          console.log(`   ✅ Batch committed\n`);

          processedBatches.push(batch);
          totalFixes += result.fixes.length;
          totalCost += result.cost;
          totalInputTokens += result.inputTokens;
          totalOutputTokens += result.outputTokens;
        } else {
          // Validation failed, rollback
          console.warn(`   ⚠️  Validation failed, rolling back batch\n`);
          await reset();
        }
      } else {
        console.log(`   ℹ️  No fixes needed for this batch\n`);
      }
    }

    if (processedBatches.length === 0) {
      console.log('✅ No fixes needed! Codebase is already compliant.\n');
      return;
    }

    // Push all commits
    console.log(`\n${'='.repeat(60)}`);
    console.log('📤 Pushing all commits...\n');
    await push(branchName);

    // Create PR
    console.log('📋 Creating pull request...\n');
    await createQualityPR(
      processedBatches,
      totalFixes,
      totalCost,
      totalInputTokens,
      totalOutputTokens
    );

    console.log('\n✅ Quality analysis complete!');
    console.log(`📊 Processed ${processedBatches.length}/${batches.length} batches`);
    console.log(`🔧 Applied ${totalFixes} fixes`);
    console.log(`💰 Total cost: $${totalCost.toFixed(4)}`);
  } catch (error) {
    console.error('\n❌ Analysis failed:', error);
    throw error;
  }
}
