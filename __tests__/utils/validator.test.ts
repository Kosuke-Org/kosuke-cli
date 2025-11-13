/**
 * Tests for validation utilities
 */

import { describe, it, expect, vi } from 'vitest';
import { execSync } from 'child_process';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

describe('validator utilities', () => {
  it('should export validation functions', async () => {
    const validatorModule = await import('@/kosuke/utils/validator');

    expect(typeof validatorModule.runLint).toBe('function');
    expect(typeof validatorModule.runTypecheck).toBe('function');
    expect(typeof validatorModule.runFormat).toBe('function');
  });

  it('should handle successful execution', async () => {
    const mockExecSync = vi.mocked(execSync);
    mockExecSync.mockReturnValue('success output' as unknown as Buffer);

    const { runLint } = await import('@/kosuke/utils/validator');
    const result = await runLint();

    expect(result.success).toBe(true);
    expect(result.output).toBe('success output');
  });

  it('should handle execution errors', async () => {
    const mockExecSync = vi.mocked(execSync);
    const error = new Error('Command failed') as Error & { stdout?: string };
    error.stdout = 'error output';
    mockExecSync.mockImplementation(() => {
      throw error;
    });

    const { runLint } = await import('@/kosuke/utils/validator');
    const result = await runLint();

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
