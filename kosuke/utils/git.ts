/**
 * Git utilities for Kosuke CLI
 */

import simpleGit, { type SimpleGit } from 'simple-git';
import type { GitInfo } from '../types.js';

const git: SimpleGit = simpleGit();

let gitIdentityConfigured = false;

/**
 * Configure git identity for commits (required in CI environments)
 */
async function ensureGitIdentity(): Promise<void> {
  if (gitIdentityConfigured) {
    return;
  }

  try {
    // Check if git identity is already configured
    const userName = await git.raw(['config', 'user.name']).catch(() => '');
    const userEmail = await git.raw(['config', 'user.email']).catch(() => '');

    if (userName.trim() && userEmail.trim()) {
      gitIdentityConfigured = true;
      return;
    }

    // Configure git identity using environment variables or defaults
    const name = process.env.GIT_AUTHOR_NAME || process.env.GIT_COMMITTER_NAME || 'kosuke-bot';
    const email =
      process.env.GIT_AUTHOR_EMAIL ||
      process.env.GIT_COMMITTER_EMAIL ||
      'kosuke-bot@users.noreply.github.com';

    await git.addConfig('user.name', name, false, 'local');
    await git.addConfig('user.email', email, false, 'local');

    console.log(`✅ Configured git identity: ${name} <${email}>`);
    gitIdentityConfigured = true;
  } catch (error) {
    console.warn('⚠️  Could not configure git identity, commits may fail:', error);
  }
}

/**
 * Get current repository info from git remote
 */
export async function getCurrentRepo(): Promise<GitInfo> {
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === 'origin');

  if (!origin?.refs?.push) {
    throw new Error('Could not determine repository from git remote origin');
  }

  // Parse GitHub URL (supports both HTTPS and SSH)
  const match =
    origin.refs.push.match(/github\.com[/:]([\w-]+)\/([\w-]+?)(?:\.git)?$/) ||
    origin.refs.push.match(/^([\w-]+)\/([\w-]+)$/);

  if (!match) {
    throw new Error(`Could not parse GitHub repository from URL: ${origin.refs.push}`);
  }

  return { owner: match[1], repo: match[2] };
}

/**
 * Detect if running in kosuke-template repository itself
 */
export async function isKosukeTemplateRepo(): Promise<boolean> {
  try {
    const { owner, repo } = await getCurrentRepo();
    return owner === 'Kosuke-Org' && repo === 'kosuke-template';
  } catch {
    return false;
  }
}

/**
 * Create and checkout a new branch
 */
export async function createBranch(branchName: string, baseBranch: string = 'main'): Promise<void> {
  await git.checkout(baseBranch);
  await git.pull('origin', baseBranch);

  // Delete local branch if exists
  try {
    const branches = await git.branchLocal();
    if (branches.all.includes(branchName)) {
      await git.deleteLocalBranch(branchName, true);
    }
  } catch {
    // Branch doesn't exist, continue
  }

  await git.checkoutLocalBranch(branchName);
}

/**
 * Commit changes with a message
 */
export async function commit(message: string): Promise<void> {
  await ensureGitIdentity();
  await git.add(['-A']);
  await git.commit(message, ['--no-verify']);
}

/**
 * Push current branch to origin
 */
export async function push(branchName: string): Promise<void> {
  await git.push('origin', branchName, ['--set-upstream']);
}

/**
 * Reset working directory to HEAD
 */
export async function reset(): Promise<void> {
  await git.reset(['--hard', 'HEAD']);
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(): Promise<string> {
  const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
  return branch.trim();
}
