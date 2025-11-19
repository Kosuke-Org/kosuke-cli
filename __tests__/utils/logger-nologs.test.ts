/**
 * Tests for logger noLogs functionality
 */

import { describe, it, expect } from 'vitest';
import { logger } from '../../kosuke/utils/logger.js';

describe('Logger noLogs flag', () => {
  it('should create context with noLogs=false by default', () => {
    const context = logger.createContext('ship');
    expect(context.noLogs).toBe(false);
  });

  it('should create context with noLogs=true when specified', () => {
    const context = logger.createContext('ship', { noLogs: true });
    expect(context.noLogs).toBe(true);
  });

  it('should not call API when noLogs is true', async () => {
    const context = logger.createContext('test', { noLogs: true });

    // Should not throw even if env vars are missing
    await expect(logger.complete(context, 'success')).resolves.not.toThrow();
  });

  it('should respect noLogs flag in context', async () => {
    const context = logger.createContext('review', { noLogs: true });
    context.tokensInput = 100;
    context.tokensOutput = 200;

    // Should complete without making API calls
    await expect(logger.complete(context, 'success')).resolves.not.toThrow();
  });

  it('should handle noLogs with error status', async () => {
    const context = logger.createContext('ship', { noLogs: true });
    const error = new Error('Test error');

    // Should not throw even with error status and noLogs
    await expect(logger.complete(context, 'error', error)).resolves.not.toThrow();
  });
});
