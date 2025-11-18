/**
 * Repository Manager - Clone and update GitHub repositories
 */

import simpleGit, { type SimpleGit } from 'simple-git';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { RepositoryInfo } from '../types.js';

const REPOS_DIR = '.tmp/repos';

/**
 * Ensure repository is cloned and up-to-date
 */
export async function ensureRepoReady(repoIdentifier: string): Promise<RepositoryInfo> {
  const repoInfo = getRepositoryInfo(repoIdentifier);

  if (existsSync(repoInfo.localPath)) {
    // Repository exists, pull latest changes
    await updateRepository(repoInfo);
  } else {
    // Clone repository
    await cloneRepository(repoInfo);
  }

  return repoInfo;
}

/**
 * Get repository information
 */
function getRepositoryInfo(repoIdentifier: string): RepositoryInfo {
  const [owner, repo] = repoIdentifier.split('/');

  if (!owner || !repo) {
    throw new Error(`Invalid repository identifier: ${repoIdentifier}`);
  }

  // Replace '/' with '__' to avoid nested directories
  const safeName = repoIdentifier.replace('/', '__');
  const localPath = join(process.cwd(), REPOS_DIR, safeName);

  return {
    owner,
    repo,
    fullName: repoIdentifier,
    localPath,
  };
}

/**
 * Clone repository
 */
async function cloneRepository(repoInfo: RepositoryInfo): Promise<void> {
  console.log(`📥 Cloning ${repoInfo.fullName}...`);

  const git: SimpleGit = simpleGit();
  const repoUrl = `https://github.com/${repoInfo.fullName}.git`;

  // Ensure repos directory exists
  const reposDir = join(process.cwd(), REPOS_DIR);
  if (!existsSync(reposDir)) {
    mkdirSync(reposDir, { recursive: true });
  }

  try {
    await git.clone(repoUrl, repoInfo.localPath, [
      '--depth',
      '1', // Shallow clone for faster cloning
      '--single-branch',
    ]);

    console.log(`   ✅ Cloned to ${REPOS_DIR}/${repoInfo.fullName.replace('/', '__')}\n`);
  } catch (error) {
    throw new Error(
      `Failed to clone repository ${repoInfo.fullName}:\n` +
        `${error instanceof Error ? error.message : String(error)}\n\n` +
        `Please check:\n` +
        `- Repository exists and is accessible\n` +
        `- You have network connectivity\n` +
        `- Repository name is correct (owner/repo format)`
    );
  }
}

/**
 * Update repository (git pull)
 */
async function updateRepository(repoInfo: RepositoryInfo): Promise<void> {
  console.log(`🔄 Updating ${repoInfo.fullName}...`);

  const git: SimpleGit = simpleGit(repoInfo.localPath);

  try {
    // Fetch and pull latest changes
    await git.fetch(['origin', '--depth', '1']);
    await git.pull('origin', 'HEAD');

    console.log(`   ✅ Updated to latest version\n`);
  } catch (error) {
    // If update fails, it's not critical - we can use the existing version
    console.warn(
      `   ⚠️  Could not update repository (using cached version):\n   ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

/**
 * Get local path for a repository (without ensuring it exists)
 */
export function getRepoLocalPath(repoIdentifier: string): string {
  const safeName = repoIdentifier.replace('/', '__');
  return join(process.cwd(), REPOS_DIR, safeName);
}
