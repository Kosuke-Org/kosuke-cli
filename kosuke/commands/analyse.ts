/**
 * Analyse command - Analyze and fix code quality issues
 *
 * Strategy: Single PR with multiple isolated Claude runs
 * - Each batch of 10-12 files gets its own Claude run
 * - Claude only sees those specific files (no repository-wide context)
 * - Validate after each batch, commit locally
 * - If --pr flag: Push all commits and create single PR
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'fs';
import { join } from 'path';
import { discoverFiles } from '../utils/file-discovery.js';
import { createBatches } from '../utils/batch-creator.js';
import { runLint, runTypecheck } from '../utils/validator.js';
import { runWithPRBatched } from '../utils/pr-orchestrator.js';
import type { AnalyseOptions, Batch, Fix } from '../types.js';

interface BatchResult {
  batch: Batch;
  fixes: Fix[];
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
  skipped: boolean;
}

interface AnalyseResult {
  processedBatches: BatchResult[];
  totalFixes: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
}

/**
 * Calculate cost based on Claude Sonnet 4.5 pricing
 * - $3 per million input tokens
 * - $15 per million output tokens
 * - $3.75 per million cache creation tokens (input + 25% overhead)
 * - $0.30 per million cache read tokens (90% discount from input)
 */
function calculateCost(
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number = 0,
  cacheReadTokens: number = 0
): number {
  const INPUT_COST_PER_MILLION = 3.0;
  const OUTPUT_COST_PER_MILLION = 15.0;
  const CACHE_CREATION_COST_PER_MILLION = 3.75;
  const CACHE_READ_COST_PER_MILLION = 0.3;

  const inputCost = (inputTokens / 1_000_000) * INPUT_COST_PER_MILLION;
  const outputCost = (outputTokens / 1_000_000) * OUTPUT_COST_PER_MILLION;
  const cacheCreationCost = (cacheCreationTokens / 1_000_000) * CACHE_CREATION_COST_PER_MILLION;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * CACHE_READ_COST_PER_MILLION;

  return inputCost + outputCost + cacheCreationCost + cacheReadCost;
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
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

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
        // Capture all token types including cache-related tokens
        inputTokens += message.usage.input_tokens || 0;
        outputTokens += message.usage.output_tokens || 0;
        cacheCreationTokens += message.usage.cache_creation_input_tokens || 0;
        cacheReadTokens += message.usage.cache_read_input_tokens || 0;
      }
    }

    // Calculate cost for this batch
    const cost = calculateCost(inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens);

    // Return placeholder fixes (real fix tracking would require parsing Claude's edits)
    const fixes: Fix[] = batch.files.map((file) => ({
      file,
      type: 'other',
      description: 'Quality improvements',
      linesChanged: 0,
    }));

    console.log(`\n   ✨ Batch analysis complete (${fixCount} fixes applied)`);

    // Build detailed cost breakdown
    const tokenBreakdown = [];
    if (inputTokens > 0) tokenBreakdown.push(`${inputTokens.toLocaleString()} input`);
    if (outputTokens > 0) tokenBreakdown.push(`${outputTokens.toLocaleString()} output`);
    if (cacheCreationTokens > 0)
      tokenBreakdown.push(`${cacheCreationTokens.toLocaleString()} cache write`);
    if (cacheReadTokens > 0) tokenBreakdown.push(`${cacheReadTokens.toLocaleString()} cache read`);

    console.log(`   💰 Cost: $${cost.toFixed(4)} (${tokenBreakdown.join(' + ')} tokens)`);

    return {
      batch,
      fixes: fixCount > 0 ? fixes : [],
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      cost,
      skipped: false,
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
 * Core analysis logic (git-agnostic)
 * Returns batches and a function to process them
 */
async function prepareAnalysis(options: AnalyseOptions): Promise<{
  batches: Batch[];
  claudeMdRules: string;
}> {
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
    return { batches: [], claudeMdRules };
  }

  // Create batches (10-12 files each, grouped by directory)
  const batches = createBatches(files, { maxSize: 10, groupBy: 'directory' });
  console.log(`📦 Created ${batches.length} batches\n`);

  return { batches, claudeMdRules };
}

/**
 * Process all batches sequentially (git-agnostic)
 */
async function analyzeAllBatches(batches: Batch[], claudeMdRules: string): Promise<AnalyseResult> {
  const processedBatches: BatchResult[] = [];
  let totalFixes = 0;
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;

  for (const [index, batch] of batches.entries()) {
    console.log(`\n📊 Progress: ${index + 1}/${batches.length}`);

    // Analyze batch (isolated Claude run)
    const result = await analyzeBatch(batch, claudeMdRules);

    // Always validate changes
    const isValid = await validateBatch();

    if (isValid && result.fixes.length > 0) {
      console.log(`   ✅ Batch validated and ready\n`);

      processedBatches.push(result);
      totalFixes += result.fixes.length;
      totalCost += result.cost;
      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      totalCacheCreationTokens += result.cacheCreationTokens;
      totalCacheReadTokens += result.cacheReadTokens;
    } else if (!isValid) {
      // Validation failed, mark as skipped
      console.warn(`   ⚠️  Validation failed, skipping batch\n`);
      processedBatches.push({ ...result, skipped: true });
    } else {
      console.log(`   ℹ️  No fixes needed for this batch\n`);
    }
  }

  return {
    processedBatches,
    totalFixes,
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    totalCacheCreationTokens,
    totalCacheReadTokens,
  };
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

    // Prepare analysis (discover files, create batches)
    const { batches, claudeMdRules } = await prepareAnalysis(options);

    if (batches.length === 0) {
      console.log('\n✅ No files to analyze.\n');
      return;
    }

    // If --pr flag is provided, wrap with PR workflow
    if (options.pr) {
      if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN environment variable is required for --pr flag');
      }

      const date = new Date().toISOString().split('T')[0];

      // Create batch processors
      const batchProcessors = batches.map((batch, index) => async (): Promise<BatchResult> => {
        console.log(`\nBatch ${index + 1}/${batches.length}`);
        const result = await analyzeBatch(batch, claudeMdRules);
        return result;
      });

      try {
        const { results, prInfo } = await runWithPRBatched(
          {
            branchPrefix: 'quality/kosuke-analysis',
            baseBranch: options.baseBranch,
            commitMessage: (batchIndex: number) =>
              `fix(quality): ${batches[batchIndex].name} - improvements`,
            prTitle: `chore: Quality Fixes (${date})`,
            prBody: '', // TODO: Generate detailed PR body after processing
            validateBeforeCommit: validateBatch,
          },
          batchProcessors
        );

        // Calculate totals
        const processedBatches = results.filter((r) => !r.skipped);
        const totalFixes = processedBatches.reduce((sum, r) => sum + r.fixes.length, 0);
        const totalCost = processedBatches.reduce((sum, r) => sum + r.cost, 0);

        console.log('\n✅ Analysis complete!');
        console.log(`📊 Processed ${processedBatches.length}/${batches.length} batches`);
        console.log(`🔧 Applied ${totalFixes} fixes`);
        console.log(`💰 Total cost: $${totalCost.toFixed(4)}`);
        console.log(`🔗 PR: ${prInfo.prUrl}`);
      } catch (error) {
        if (error instanceof Error && error.message === 'No changes to commit') {
          console.log('\n✅ No fixes needed! Codebase is already compliant.\n');
          return;
        }
        throw error;
      }
    } else {
      // Run core logic without PR
      const result = await analyzeAllBatches(batches, claudeMdRules);

      if (result.processedBatches.length === 0) {
        console.log('\n✅ No fixes needed! Codebase is already compliant.\n');
        return;
      }

      console.log('\n✅ Analysis complete!');
      console.log(`📊 Processed ${result.processedBatches.length}/${batches.length} batches`);
      console.log(`🔧 Applied ${result.totalFixes} fixes`);
      console.log(`💰 Total cost: $${result.totalCost.toFixed(4)}`);
      console.log('\nℹ️  Changes applied locally. Use --pr flag to create a pull request.');
    }
  } catch (error) {
    console.error('\n❌ Analysis failed:', error);
    throw error;
  }
}
