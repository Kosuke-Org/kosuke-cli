/**
 * Tests for validation utilities
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';

// Mock modules
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe('validator utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('exports', () => {
    it('should export validation functions', async () => {
      const validatorModule = await import('@/kosuke/utils/validator');

      expect(typeof validatorModule.runLint).toBe('function');
      expect(typeof validatorModule.runTypecheck).toBe('function');
      expect(typeof validatorModule.runFormat).toBe('function');
      expect(typeof validatorModule.detectPackageManager).toBe('function');
      expect(typeof validatorModule.readPackageJsonScripts).toBe('function');
    });
  });

  describe('detectPackageManager', () => {
    it('should detect bun from lockfile', async () => {
      const mockExistsSync = vi.mocked(existsSync);
      mockExistsSync.mockImplementation((path: unknown) => {
        return String(path).includes('bun.lockb');
      });

      const { detectPackageManager } = await import('@/kosuke/utils/validator');
      const result = detectPackageManager('/test/path');

      expect(result).toBe('bun');
    });

    it('should detect pnpm from lockfile', async () => {
      const mockExistsSync = vi.mocked(existsSync);
      mockExistsSync.mockImplementation((path: unknown) => {
        return String(path).includes('pnpm-lock.yaml');
      });

      const { detectPackageManager } = await import('@/kosuke/utils/validator');
      const result = detectPackageManager('/test/path');

      expect(result).toBe('pnpm');
    });

    it('should detect yarn from lockfile', async () => {
      const mockExistsSync = vi.mocked(existsSync);
      mockExistsSync.mockImplementation((path: unknown) => {
        return String(path).includes('yarn.lock');
      });

      const { detectPackageManager } = await import('@/kosuke/utils/validator');
      const result = detectPackageManager('/test/path');

      expect(result).toBe('yarn');
    });

    it('should detect npm from lockfile', async () => {
      const mockExistsSync = vi.mocked(existsSync);
      mockExistsSync.mockImplementation((path: unknown) => {
        return String(path).includes('package-lock.json');
      });

      const { detectPackageManager } = await import('@/kosuke/utils/validator');
      const result = detectPackageManager('/test/path');

      expect(result).toBe('npm');
    });

    it('should default to npm if no lockfile found', async () => {
      const mockExistsSync = vi.mocked(existsSync);
      mockExistsSync.mockReturnValue(false);

      const { detectPackageManager } = await import('@/kosuke/utils/validator');
      const result = detectPackageManager('/test/path');

      expect(result).toBe('npm');
    });
  });

  describe('readPackageJsonScripts', () => {
    it('should read scripts from package.json', async () => {
      const mockExistsSync = vi.mocked(existsSync);
      const mockReadFileSync = vi.mocked(readFileSync);

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: {
            format: 'prettier --write .',
            lint: 'eslint .',
            typecheck: 'tsc --noEmit',
          },
        })
      );

      const { readPackageJsonScripts } = await import('@/kosuke/utils/validator');
      const result = readPackageJsonScripts('/test/path');

      expect(result).toEqual({
        format: 'prettier --write .',
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      });
    });

    it('should return null if package.json does not exist', async () => {
      const mockExistsSync = vi.mocked(existsSync);
      mockExistsSync.mockReturnValue(false);

      const { readPackageJsonScripts } = await import('@/kosuke/utils/validator');
      const result = readPackageJsonScripts('/test/path');

      expect(result).toBeNull();
    });

    it('should return null if package.json has no scripts', async () => {
      const mockExistsSync = vi.mocked(existsSync);
      const mockReadFileSync = vi.mocked(readFileSync);

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({}));

      const { readPackageJsonScripts } = await import('@/kosuke/utils/validator');
      const result = readPackageJsonScripts('/test/path');

      expect(result).toBeNull();
    });
  });

  describe('runFormat', () => {
    it('should handle successful execution', async () => {
      const mockExecSync = vi.mocked(execSync);
      const mockExistsSync = vi.mocked(existsSync);
      const mockReadFileSync = vi.mocked(readFileSync);

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: { format: 'prettier --write .' },
        })
      );
      mockExecSync.mockReturnValue('success output' as unknown as Buffer);

      const { runFormat } = await import('@/kosuke/utils/validator');
      const result = await runFormat();

      expect(result.success).toBe(true);
      expect(result.output).toBe('success output');
    });

    it('should return warning if format script is missing', async () => {
      const mockExistsSync = vi.mocked(existsSync);
      const mockReadFileSync = vi.mocked(readFileSync);

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: { lint: 'eslint .' },
        })
      );

      const { runFormat } = await import('@/kosuke/utils/validator');
      const result = await runFormat();

      expect(result.success).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('format');
    });

    it('should handle execution errors', async () => {
      const mockExecSync = vi.mocked(execSync);
      const mockExistsSync = vi.mocked(existsSync);
      const mockReadFileSync = vi.mocked(readFileSync);

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: { format: 'prettier --write .' },
        })
      );

      const error = new Error('Command failed') as Error & { stdout?: string };
      error.stdout = 'error output';
      mockExecSync.mockImplementation(() => {
        throw error;
      });

      const { runFormat } = await import('@/kosuke/utils/validator');
      const result = await runFormat();

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('runLint', () => {
    it('should handle successful execution', async () => {
      const mockExecSync = vi.mocked(execSync);
      const mockExistsSync = vi.mocked(existsSync);
      const mockReadFileSync = vi.mocked(readFileSync);

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: { lint: 'eslint .' },
        })
      );
      mockExecSync.mockReturnValue('success output' as unknown as Buffer);

      const { runLint } = await import('@/kosuke/utils/validator');
      const result = await runLint();

      expect(result.success).toBe(true);
      expect(result.output).toBe('success output');
    });

    it('should return warning if lint script is missing', async () => {
      const mockExistsSync = vi.mocked(existsSync);
      const mockReadFileSync = vi.mocked(readFileSync);

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: { format: 'prettier --write .' },
        })
      );

      const { runLint } = await import('@/kosuke/utils/validator');
      const result = await runLint();

      expect(result.success).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('lint');
    });

    it('should handle execution errors', async () => {
      const mockExecSync = vi.mocked(execSync);
      const mockExistsSync = vi.mocked(existsSync);
      const mockReadFileSync = vi.mocked(readFileSync);

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: { lint: 'eslint .' },
        })
      );

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
});
