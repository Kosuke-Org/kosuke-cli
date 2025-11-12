/**
 * File discovery utilities for Kosuke CLI
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { glob } from 'glob';
import ignore from 'ignore';

const KOSUKEIGNORE_FILE = '.kosukeignore';

/**
 * Read .kosukeignore file and return ignore patterns
 */
function readKosukeignore(cwd: string = process.cwd()): string[] {
  const kosukeignorePath = join(cwd, KOSUKEIGNORE_FILE);

  if (!existsSync(kosukeignorePath)) {
    return [];
  }

  const content = readFileSync(kosukeignorePath, 'utf-8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

interface DiscoverFilesOptions {
  include?: string[];
  scope?: string;
  types?: string[];
  cwd?: string;
}

/**
 * Discover files to analyze, respecting .kosukeignore
 */
export async function discoverFiles(options: DiscoverFilesOptions = {}): Promise<string[]> {
  const cwd = options.cwd || process.cwd();

  // Default patterns to include
  const defaultPatterns = ['**/*.ts', '**/*.tsx', '**/*.py'];

  // Build include patterns
  let includePatterns: string[];
  if (options.scope) {
    // Scope: specific directories
    const scopes = options.scope.split(',').map((s) => s.trim());
    if (options.types) {
      includePatterns = scopes.flatMap((scope) =>
        options.types!.map((type) => `${scope}/**/*.${type}`)
      );
    } else {
      includePatterns = scopes.flatMap((scope) =>
        defaultPatterns.map((pattern) => `${scope}/${pattern}`)
      );
    }
  } else if (options.types) {
    // Types: specific file extensions
    includePatterns = options.types.map((type) => `**/*.${type}`);
  } else {
    // Default: all supported types
    includePatterns = options.include || defaultPatterns;
  }

  // Load .kosukeignore patterns
  const kosukeignorePatterns = readKosukeignore(cwd);

  // Always exclude these
  const alwaysExclude = [
    'node_modules/**',
    '.next/**',
    'dist/**',
    'build/**',
    '**/*.tsbuildinfo',
    'drizzle/**',
    '__pycache__/**',
    '*.pyc',
    '.pytest_cache/**',
    'engine/uv.lock',
  ];

  const ig = ignore().add([...kosukeignorePatterns, ...alwaysExclude]);

  // Find all matching files
  const allFiles: string[] = [];
  for (const pattern of includePatterns) {
    const files = await glob(pattern, {
      cwd,
      ignore: alwaysExclude,
      nodir: true,
    });
    allFiles.push(...files);
  }

  // Filter with .kosukeignore
  const filteredFiles = allFiles.filter((file) => !ig.ignores(file));

  // Remove duplicates and sort
  return [...new Set(filteredFiles)].sort();
}
