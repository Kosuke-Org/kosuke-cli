/**
 * Tests for file discovery utilities
 */

import { describe, it, expect } from 'vitest';
import { discoverFiles } from '@/kosuke/utils/file-discovery';

describe('discoverFiles', () => {
  it('should return an array of files', async () => {
    const files = await discoverFiles();

    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBeGreaterThan(0);
  });

  it('should discover TypeScript files by default', async () => {
    const files = await discoverFiles();

    // Should find at least some .ts files
    const tsFiles = files.filter((f) => f.endsWith('.ts'));
    expect(tsFiles.length).toBeGreaterThan(0);
  });

  it('should respect file type filters', async () => {
    const files = await discoverFiles({ types: ['ts'] });

    // All files should be .ts files
    expect(files.every((f) => f.endsWith('.ts'))).toBe(true);
  });

  it('should filter out node_modules', async () => {
    const files = await discoverFiles();

    // Should not include any files from node_modules
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });

  it('should filter out dist directory', async () => {
    const files = await discoverFiles();

    // Should not include any files from dist
    expect(files.some((f) => f.includes('dist/'))).toBe(false);
  });

  it('should support scope filtering', async () => {
    const files = await discoverFiles({ scope: 'kosuke' });

    // All files should be under kosuke directory
    expect(files.every((f) => f.startsWith('kosuke/'))).toBe(true);
  });

  it('should return unique files', async () => {
    const files = await discoverFiles();

    // Should not have duplicates
    const uniqueFiles = [...new Set(files)];
    expect(files.length).toBe(uniqueFiles.length);
  });

  it('should return sorted files', async () => {
    const files = await discoverFiles();

    // Should be sorted alphabetically
    const sortedFiles = [...files].sort();
    expect(files).toEqual(sortedFiles);
  });
});
