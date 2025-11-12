/**
 * GitHub API utilities for Kosuke CLI
 */

import { Octokit } from '@octokit/rest';

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

interface CreatePROptions {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
}

/**
 * Create a pull request
 */
export async function createPullRequest(options: CreatePROptions): Promise<string> {
  const { data: pr } = await octokit.pulls.create({
    owner: options.owner,
    repo: options.repo,
    title: options.title,
    head: options.head,
    base: options.base,
    body: options.body,
  });

  return pr.html_url;
}
