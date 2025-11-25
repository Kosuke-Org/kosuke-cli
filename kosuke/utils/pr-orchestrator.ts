/**
 * PR Orchestrator - Generic PR workflow utility
 *
 * Handles branch creation, commits, push, and PR creation
 * Used across all commands that support --pr flag
 */

import simpleGit, { type SimpleGit } from 'simple-git';
import { createBranch, commit, push, getCurrentRepo, getCurrentBranch } from './git.js';
import { createPullRequest } from './github.js';

interface PRWorkflowOptions {
  /** Prefix for branch name (e.g., 'quality', 'fix', 'sync') */
  branchPrefix: string;

  /** Base branch to create PR against (default: current branch) */
  baseBranch?: string;

  /** Commit message (can be function for multiple commits) */
  commitMessage: string | ((batchIndex: number) => string);

  /** PR title */
  prTitle: string;

  /** PR body (markdown) */
  prBody: string;

  /** Optional validation before each commit */
  validateBeforeCommit?: () => Promise<boolean>;

  /** Optional callback after each batch/commit */
  onBatchComplete?: (batchIndex: number) => Promise<void>;

  /** Number of batches to process (default: 1 for single commit) */
  batchCount?: number;

  /** Directory to run git operations in (default: cwd) */
  cwd?: string;
}

interface PRWorkflowResult {
  branchName: string;
  prUrl: string;
  baseBranch: string;
  commitsCreated: number;
}

/**
 * Execute core logic wrapped with PR workflow
 */
export async function runWithPR<T>(
  options: PRWorkflowOptions,
  coreLogic: () => Promise<T>
): Promise<{ result: T; prInfo: PRWorkflowResult }> {
  // Validate environment
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN environment variable is required for --pr flag');
  }

  const { cwd } = options;
  const git: SimpleGit = cwd ? simpleGit(cwd) : simpleGit();

  // Get base branch (current branch before creating feature branch)
  const baseBranch = options.baseBranch || (await getCurrentBranch(cwd));
  console.log(`📍 Base branch: ${baseBranch}\n`);

  // Create working branch with unique name
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('.')[0];
  const branchName = `${options.branchPrefix}/${timestamp}`;
  console.log(`🌿 Creating branch: ${branchName}\n`);
  await createBranch(branchName, baseBranch, cwd);

  // Execute core logic
  const result = await coreLogic();

  // Check if there are any changes to commit
  const status = await git.status();
  if (status.files.length === 0) {
    console.log('\nℹ️  No changes detected. Skipping PR creation.');
    throw new Error('No changes to commit');
  }

  // Commit changes
  console.log('\n📝 Committing changes...');
  const commitMsg =
    typeof options.commitMessage === 'function' ? options.commitMessage(0) : options.commitMessage;
  await commit(commitMsg, cwd);
  console.log('   ✅ Changes committed\n');

  // Push branch
  console.log('📤 Pushing branch...');
  await push(branchName, cwd);
  console.log('   ✅ Branch pushed\n');

  // Create PR
  console.log('📋 Creating pull request...');
  const { owner, repo } = await getCurrentRepo(cwd);

  const prUrl = await createPullRequest({
    owner,
    repo,
    title: options.prTitle,
    head: branchName,
    base: baseBranch,
    body: options.prBody,
  });

  console.log(`   ✅ Pull request created: ${prUrl}\n`);

  return {
    result,
    prInfo: {
      branchName,
      prUrl,
      baseBranch,
      commitsCreated: 1,
    },
  };
}

/**
 * Execute core logic wrapped with PR workflow (batch mode)
 * Supports multiple commits for batch processing
 */
export async function runWithPRBatched<T>(
  options: PRWorkflowOptions,
  batches: Array<() => Promise<T>>
): Promise<{ results: T[]; prInfo: PRWorkflowResult }> {
  // Validate environment
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN environment variable is required for --pr flag');
  }

  const { cwd } = options;
  const git: SimpleGit = cwd ? simpleGit(cwd) : simpleGit();

  // Get base branch
  const baseBranch = options.baseBranch || (await getCurrentBranch(cwd));
  console.log(`📍 Base branch: ${baseBranch}\n`);

  // Create working branch
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('.')[0];
  const branchName = `${options.branchPrefix}/${timestamp}`;
  console.log(`🌿 Creating branch: ${branchName}\n`);
  await createBranch(branchName, baseBranch, cwd);

  // Process each batch
  const results: T[] = [];
  let commitsCreated = 0;

  for (let i = 0; i < batches.length; i++) {
    console.log(`\n📊 Processing batch ${i + 1}/${batches.length}...`);

    // Execute batch logic
    const result = await batches[i]();
    results.push(result);

    // Check if there are changes
    const status = await git.status();
    if (status.files.length === 0) {
      console.log('   ℹ️  No changes in this batch, skipping commit');
      continue;
    }

    // Validate if needed
    if (options.validateBeforeCommit) {
      console.log('   🔧 Running validation...');
      const isValid = await options.validateBeforeCommit();
      if (!isValid) {
        console.warn('   ⚠️  Validation failed, skipping this batch');
        await git.reset(['--hard', 'HEAD']);
        continue;
      }
      console.log('   ✅ Validation passed');
    }

    // Commit batch
    const commitMsg =
      typeof options.commitMessage === 'function'
        ? options.commitMessage(i)
        : options.commitMessage;
    await commit(commitMsg, cwd);
    commitsCreated++;
    console.log('   ✅ Batch committed');

    // Callback if needed
    if (options.onBatchComplete) {
      await options.onBatchComplete(i);
    }
  }

  // Check if any commits were made
  if (commitsCreated === 0) {
    console.log('\nℹ️  No changes were committed. Skipping PR creation.');
    throw new Error('No changes to commit');
  }

  // Push all commits
  console.log(`\n📤 Pushing ${commitsCreated} commit(s)...`);
  await push(branchName, cwd);
  console.log('   ✅ All commits pushed\n');

  // Create PR
  console.log('📋 Creating pull request...');
  const { owner, repo } = await getCurrentRepo(cwd);

  const prUrl = await createPullRequest({
    owner,
    repo,
    title: options.prTitle,
    head: branchName,
    base: baseBranch,
    body: options.prBody,
  });

  console.log(`   ✅ Pull request created: ${prUrl}\n`);

  return {
    results,
    prInfo: {
      branchName,
      prUrl,
      baseBranch,
      commitsCreated,
    },
  };
}
