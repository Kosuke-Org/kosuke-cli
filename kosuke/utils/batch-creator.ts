/**
 * Batch creation utilities for Kosuke CLI
 */

import { dirname } from 'path';
import type { Batch } from '../types.js';

interface BatchCreatorOptions {
  maxSize?: number;
  groupBy?: 'directory' | 'flat';
}

/**
 * Group files into batches for processing
 */
export function createBatches(files: string[], options: BatchCreatorOptions = {}): Batch[] {
  const maxSize = options.maxSize || 10;
  const groupBy = options.groupBy || 'directory';

  if (groupBy === 'flat') {
    // Simple batching: chunk files into groups of maxSize
    return chunkArray(files, maxSize).map((chunk, index) => ({
      name: `batch-${index + 1}`,
      directory: process.cwd(),
      files: chunk,
    }));
  }

  // Group by directory: keep related files together
  const dirGroups = new Map<string, string[]>();

  for (const file of files) {
    const dir = getTopLevelDir(file);
    if (!dirGroups.has(dir)) {
      dirGroups.set(dir, []);
    }
    dirGroups.get(dir)!.push(file);
  }

  // Create batches from directory groups
  const batches: Batch[] = [];

  for (const [dir, dirFiles] of dirGroups.entries()) {
    const chunks = chunkArray(dirFiles, maxSize);
    for (let i = 0; i < chunks.length; i++) {
      const batchName = chunks.length > 1 ? `${dir} (${i + 1}/${chunks.length})` : dir;
      batches.push({
        name: batchName,
        directory: dirname(chunks[i][0] || '.'),
        files: chunks[i],
      });
    }
  }

  return batches;
}

/**
 * Get top-level directory from a file path
 */
function getTopLevelDir(filePath: string): string {
  const parts = filePath.split('/');

  // For engine files
  if (parts[0] === 'engine') {
    return 'engine';
  }

  // For app routes
  if (parts[0] === 'app') {
    if (parts[1] === '(logged-in)' && parts[2]) {
      return `app/${parts[1]}/${parts[2]}`;
    }
    return `app/${parts[1] || ''}`;
  }

  // For lib files
  if (parts[0] === 'lib') {
    return `lib/${parts[1] || ''}`;
  }

  // Default: first directory
  return parts[0] || '.';
}

/**
 * Chunk an array into smaller arrays
 */
function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}
