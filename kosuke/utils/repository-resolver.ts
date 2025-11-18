/**
 * Repository Resolver - Smart repository inference from queries
 */

import { Octokit } from '@octokit/rest';

const KOSUKE_TEMPLATE_REPO = 'Kosuke-Org/kosuke-template';
const DEFAULT_ORG = 'Kosuke-Org';

// Well-known repositories mapping
const WELL_KNOWN_REPOS: Record<string, string> = {
  nextjs: 'vercel/next.js',
  'next.js': 'vercel/next.js',
  next: 'vercel/next.js',
  react: 'facebook/react',
  shadcn: 'shadcn/ui',
  'shadcn-ui': 'shadcn/ui',
  tailwind: 'tailwindlabs/tailwindcss',
  tailwindcss: 'tailwindlabs/tailwindcss',
  prisma: 'prisma/prisma',
  drizzle: 'drizzle-team/drizzle-orm',
  'drizzle-orm': 'drizzle-team/drizzle-orm',
  trpc: 'trpc/trpc',
  remix: 'remix-run/remix',
  astro: 'withastro/astro',
  svelte: 'sveltejs/svelte',
  vue: 'vuejs/core',
  nuxt: 'nuxt/nuxt',
  angular: 'angular/angular',
  express: 'expressjs/express',
  fastify: 'fastify/fastify',
  nestjs: 'nestjs/nest',
  'kosuke-template': KOSUKE_TEMPLATE_REPO,
};

/**
 * Resolve repository identifier to owner/repo format
 */
export async function resolveRepository(
  repo: string | undefined,
  query: string,
  useTemplate: boolean,
  githubToken?: string
): Promise<string> {
  // If --template flag is used, always use kosuke-template
  if (useTemplate) {
    return KOSUKE_TEMPLATE_REPO;
  }

  // If repo is explicitly provided, normalize it
  if (repo) {
    return normalizeRepoIdentifier(repo);
  }

  // Try to infer from query
  const inferred = inferRepoFromQuery(query);
  if (inferred) {
    return inferred;
  }

  // If we have a GitHub token, try searching (optional, as per requirement)
  if (githubToken) {
    const searched = await searchGitHubRepo(query, githubToken);
    if (searched) {
      return searched;
    }
  }

  // Could not determine repository
  throw new Error(
    `Could not determine repository from query: "${query}"\n` +
      `Please specify the repository explicitly:\n` +
      `  kosuke getcode "owner/repo" "${query}"\n` +
      `Or use --template flag for kosuke-template:\n` +
      `  kosuke getcode --template "${query}"`
  );
}

/**
 * Normalize repository identifier to owner/repo format
 */
function normalizeRepoIdentifier(repo: string): string {
  // Handle GitHub URLs
  const urlPatterns = [
    /github\.com\/([^\/]+)\/([^\/\s]+)/i, // https://github.com/owner/repo
    /github\.com:([^\/]+)\/([^\/\s]+)/i, // git@github.com:owner/repo
  ];

  for (const pattern of urlPatterns) {
    const match = repo.match(pattern);
    if (match) {
      const owner = match[1];
      const repoName = match[2].replace(/\.git$/, ''); // Remove .git suffix
      return `${owner}/${repoName}`;
    }
  }

  // Already in owner/repo format
  if (repo.includes('/')) {
    return repo;
  }

  // Just repo name, assume Kosuke-Org
  if (repo.startsWith('kosuke-')) {
    return `${DEFAULT_ORG}/${repo}`;
  }

  // Can't normalize
  throw new Error(
    `Invalid repository format: "${repo}"\n` +
      `Expected formats:\n` +
      `  - owner/repo (e.g., "facebook/react")\n` +
      `  - https://github.com/owner/repo\n` +
      `  - kosuke-* (assumes Kosuke-Org/kosuke-*)`
  );
}

/**
 * Extract repository name from user input
 */
function inferRepoFromQuery(query: string): string | null {
  const queryLower = query.toLowerCase();

  // Pattern 1: Explicit owner/repo format in query
  const ownerRepoPattern = /\b([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\b/;
  const match = query.match(ownerRepoPattern);
  if (match) {
    return `${match[1]}/${match[2]}`;
  }

  // Pattern 2: Kosuke-specific repos (e.g., "kosuke-template", "kosuke-cli")
  const kosukeRepoPattern = /\b(kosuke-[a-zA-Z0-9_-]+)\b/i;
  const kosukeMatch = query.match(kosukeRepoPattern);
  if (kosukeMatch) {
    return `${DEFAULT_ORG}/${kosukeMatch[1].toLowerCase()}`;
  }

  // Pattern 3: Well-known repositories
  for (const [keyword, repoIdentifier] of Object.entries(WELL_KNOWN_REPOS)) {
    if (queryLower.includes(keyword)) {
      return repoIdentifier;
    }
  }

  return null;
}

/**
 * Search GitHub for repository (fallback, requires token)
 */
async function searchGitHubRepo(query: string, githubToken: string): Promise<string | null> {
  try {
    const octokit = new Octokit({ auth: githubToken });

    // Extract potential repo names from query
    const words = query.match(/\b[a-zA-Z][a-zA-Z0-9_-]{2,}\b/g) || [];

    for (const word of words) {
      // Skip common words
      const skipWords = [
        'from',
        'repository',
        'repo',
        'code',
        'implementation',
        'inspiration',
        'example',
        'how',
        'does',
        'work',
        'what',
        'where',
        'show',
        'find',
      ];
      if (skipWords.includes(word.toLowerCase())) {
        continue;
      }

      // Search GitHub
      const { data } = await octokit.search.repos({
        q: word,
        sort: 'stars',
        order: 'desc',
        per_page: 1,
      });

      // Only return if it's a popular repo (>1000 stars)
      if (data.items.length > 0 && data.items[0].stargazers_count > 1000) {
        return data.items[0].full_name;
      }
    }
  } catch {
    // Silently fail - this is just a fallback
    console.warn('   ⚠️  GitHub search failed, explicit repo required');
  }

  return null;
}

/**
 * Validate repository access
 */
export async function validateRepoAccess(
  repoIdentifier: string,
  githubToken?: string
): Promise<boolean> {
  if (!githubToken) {
    // Without token, assume public access
    return true;
  }

  try {
    const octokit = new Octokit({ auth: githubToken });
    const [owner, repo] = repoIdentifier.split('/');

    await octokit.repos.get({ owner, repo });
    return true;
  } catch {
    return false;
  }
}
