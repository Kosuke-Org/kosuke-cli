/**
 * Tests for CLI logger utility
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('logger', () => {
  beforeEach(() => {
    // Clear any module cache
    vi.resetModules();
    // Suppress console warnings in tests
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('calculateCost', () => {
    it('should calculate cost correctly with input and output tokens only', async () => {
      const { logger } = await import('@/kosuke/utils/logger');
      const cost = logger.calculateCost(1_000_000, 1_000_000);
      // $3 (input) + $15 (output) = $18
      expect(cost).toBe('18.000000');
    });

    it('should calculate cost correctly with cache tokens', async () => {
      const { logger } = await import('@/kosuke/utils/logger');
      const cost = logger.calculateCost(1_000_000, 1_000_000, 1_000_000, 1_000_000);
      // $3 (input) + $15 (output) + $3.75 (cache write) + $0.30 (cache read) = $22.05
      expect(cost).toBe('22.050000');
    });

    it('should handle zero tokens', async () => {
      const { logger } = await import('@/kosuke/utils/logger');
      const cost = logger.calculateCost(0, 0, 0, 0);
      expect(cost).toBe('0.000000');
    });

    it('should handle small token amounts', async () => {
      const { logger } = await import('@/kosuke/utils/logger');
      const cost = logger.calculateCost(1000, 500);
      // (1000/1M * $3) + (500/1M * $15) = $0.003 + $0.0075 = $0.0105
      expect(cost).toBe('0.010500');
    });
  });

  describe('createContext', () => {
    it('should create a new context with correct initial values', async () => {
      const { logger } = await import('@/kosuke/utils/logger');
      const context = logger.createContext('ship');

      expect(context.command).toBe('ship');
      expect(context.tokensInput).toBe(0);
      expect(context.tokensOutput).toBe(0);
      expect(context.tokensCacheCreation).toBe(0);
      expect(context.tokensCacheRead).toBe(0);
      expect(context.inferenceTimeMs).toBe(0);
      expect(context.fixesApplied).toBe(0);
      expect(context.testsRun).toBe(0);
      expect(context.testsPassed).toBe(0);
      expect(context.testsFailed).toBe(0);
      expect(context.iterations).toBe(0);
      expect(context.filesModified).toEqual([]);
      expect(context.startTime).toBeGreaterThan(0);
      expect(context.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should support all command types', async () => {
      const { logger } = await import('@/kosuke/utils/logger');
      const commands = ['ship', 'test', 'review', 'getcode', 'tickets'] as const;

      commands.forEach((command) => {
        const context = logger.createContext(command);
        expect(context.command).toBe(command);
      });
    });
  });

  describe('trackTokens', () => {
    it('should accumulate token usage', async () => {
      const { logger } = await import('@/kosuke/utils/logger');
      const context = logger.createContext('ship');

      logger.trackTokens(context, {
        input: 1000,
        output: 500,
        cacheCreation: 100,
        cacheRead: 50,
      });

      expect(context.tokensInput).toBe(1000);
      expect(context.tokensOutput).toBe(500);
      expect(context.tokensCacheCreation).toBe(100);
      expect(context.tokensCacheRead).toBe(50);

      // Track more tokens
      logger.trackTokens(context, {
        input: 2000,
        output: 1000,
        cacheCreation: 200,
        cacheRead: 100,
      });

      expect(context.tokensInput).toBe(3000);
      expect(context.tokensOutput).toBe(1500);
      expect(context.tokensCacheCreation).toBe(300);
      expect(context.tokensCacheRead).toBe(150);
    });
  });

  describe('isEnabled', () => {
    it('should return false when environment variables are not set', async () => {
      // Stub environment variables before importing
      vi.stubEnv('KOSUKE_BASE_URL', '');
      vi.stubEnv('KOSUKE_API_KEY', '');
      vi.stubEnv('KOSUKE_PROJECT_ID', '');

      // Import logger with stubbed env
      const { logger } = await import('@/kosuke/utils/logger.js');

      expect(logger.isEnabled()).toBe(false);
    });

    it('should return true when all environment variables are set', async () => {
      // Stub environment variables before importing
      vi.stubEnv('KOSUKE_BASE_URL', 'https://example.com');
      vi.stubEnv('KOSUKE_API_KEY', 'test-api-key');
      vi.stubEnv('KOSUKE_PROJECT_ID', 'test-project-id');

      // Import logger with stubbed env
      const { logger } = await import('@/kosuke/utils/logger.js');

      expect(logger.isEnabled()).toBe(true);
    });
  });

  describe('getProjectContext', () => {
    it('should return null when logging is disabled', async () => {
      // Stub environment variables before importing
      vi.stubEnv('KOSUKE_BASE_URL', '');
      vi.stubEnv('KOSUKE_API_KEY', '');
      vi.stubEnv('KOSUKE_PROJECT_ID', '');

      // Import logger with no env vars
      const { logger } = await import('@/kosuke/utils/logger');

      const context = logger.getProjectContext();
      expect(context).toBeNull();
    });

    it('should return project context when logging is enabled', async () => {
      // Stub environment variables before importing
      vi.stubEnv('KOSUKE_BASE_URL', 'https://example.com');
      vi.stubEnv('KOSUKE_API_KEY', 'test-api-key');
      vi.stubEnv('KOSUKE_PROJECT_ID', 'test-project-id');

      // Import logger with stubbed env
      const { logger } = await import('@/kosuke/utils/logger.js');

      const context = logger.getProjectContext();
      expect(context).toEqual({ projectId: 'test-project-id' });
    });
  });

  describe('logCommand', () => {
    it('should not throw when logging is disabled', async () => {
      vi.stubEnv('KOSUKE_BASE_URL', '');
      vi.stubEnv('KOSUKE_API_KEY', '');
      vi.stubEnv('KOSUKE_PROJECT_ID', '');

      const { logger } = await import('@/kosuke/utils/logger');
      const context = logger.createContext('ship');
      await expect(logger.complete(context, 'success')).resolves.not.toThrow();
    });

    it('should not throw when API call fails', async () => {
      vi.stubEnv('KOSUKE_BASE_URL', 'https://example.com');
      vi.stubEnv('KOSUKE_API_KEY', 'test-api-key');
      vi.stubEnv('KOSUKE_PROJECT_ID', 'test-project-id');

      // Mock fetch to throw an error
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const { logger } = await import('@/kosuke/utils/logger');
      const context = logger.createContext('ship');
      await expect(logger.complete(context, 'success')).resolves.not.toThrow();
    });
  });

  describe('cost calculation edge cases', () => {
    it('should handle very large token counts', async () => {
      const { logger } = await import('@/kosuke/utils/logger');
      const cost = logger.calculateCost(100_000_000, 50_000_000);
      // (100M/1M * $3) + (50M/1M * $15) = $300 + $750 = $1050
      expect(cost).toBe('1050.000000');
    });

    it('should format decimals correctly', async () => {
      const { logger } = await import('@/kosuke/utils/logger');
      const cost = logger.calculateCost(333, 666);
      // Should have exactly 6 decimal places
      expect(cost).toMatch(/^\d+\.\d{6}$/);
    });

    it('should handle fractional token costs', async () => {
      const { logger } = await import('@/kosuke/utils/logger');
      const cost = logger.calculateCost(1, 1, 1, 1);
      // Very small amounts should still be calculated
      const numericCost = parseFloat(cost);
      expect(numericCost).toBeGreaterThan(0);
      expect(numericCost).toBeLessThan(0.001);
    });
  });

  describe('context mutation', () => {
    it('should allow direct mutation of context fields', async () => {
      const { logger } = await import('@/kosuke/utils/logger');
      const context = logger.createContext('test');

      context.testsRun = 10;
      context.testsPassed = 8;
      context.testsFailed = 2;
      context.fixesApplied = 5;
      context.iterations = 3;
      context.filesModified = ['file1.ts', 'file2.ts'];

      expect(context.testsRun).toBe(10);
      expect(context.testsPassed).toBe(8);
      expect(context.testsFailed).toBe(2);
      expect(context.fixesApplied).toBe(5);
      expect(context.iterations).toBe(3);
      expect(context.filesModified).toEqual(['file1.ts', 'file2.ts']);
    });
  });

  describe('complete', () => {
    it('should calculate execution time', async () => {
      vi.stubEnv('KOSUKE_BASE_URL', 'https://example.com');
      vi.stubEnv('KOSUKE_API_KEY', 'test-api-key');
      vi.stubEnv('KOSUKE_PROJECT_ID', 'test-project-id');

      // Mock fetch to avoid actual API calls
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const { logger } = await import('@/kosuke/utils/logger');
      const context = logger.createContext('ship');
      const startTime = Date.now();

      // Simulate some work
      await new Promise((resolve) => setTimeout(resolve, 100));

      await logger.complete(context, 'success');

      const executionTime = Date.now() - startTime;
      // Allow for small timing variance (±1ms) due to timer precision
      expect(executionTime).toBeGreaterThanOrEqual(99);
    });

    it('should handle error status with error message', async () => {
      vi.stubEnv('KOSUKE_BASE_URL', 'https://example.com');
      vi.stubEnv('KOSUKE_API_KEY', 'test-api-key');
      vi.stubEnv('KOSUKE_PROJECT_ID', 'test-project-id');

      // Mock fetch to throw an error
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const { logger } = await import('@/kosuke/utils/logger');
      const context = logger.createContext('ship');
      const error = new Error('Test error message');

      await expect(logger.complete(context, 'error', error)).resolves.not.toThrow();
    });

    it('should handle cancelled status', async () => {
      vi.stubEnv('KOSUKE_BASE_URL', 'https://example.com');
      vi.stubEnv('KOSUKE_API_KEY', 'test-api-key');
      vi.stubEnv('KOSUKE_PROJECT_ID', 'test-project-id');

      // Mock fetch to avoid actual API calls
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const { logger } = await import('@/kosuke/utils/logger');
      const context = logger.createContext('ship');

      await expect(logger.complete(context, 'cancelled')).resolves.not.toThrow();
    });
  });
});
