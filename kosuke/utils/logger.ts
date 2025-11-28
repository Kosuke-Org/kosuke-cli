/**
 * CLI Logger - Centralized logging to kosuke-core
 *
 * Provides automatic command execution tracking, token usage logging,
 * and cost monitoring for all CLI commands.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Command names supported by the logger
 */
export type CommandName = 'ship' | 'test' | 'review' | 'getcode' | 'tickets' | 'migrate' | 'plan';

/**
 * Execution status
 */
export type ExecutionStatus = 'success' | 'error' | 'cancelled';

/**
 * CLI log data structure matching kosuke-core API schema
 */
export interface CliLogData {
  // Project context (required)
  projectId: string;

  // Command details
  command: CommandName;

  // Execution status
  status: ExecutionStatus;
  errorMessage?: string;

  // Token usage (required)
  tokensInput: number;
  tokensOutput: number;
  tokensCacheCreation?: number;
  tokensCacheRead?: number;
  cost: string; // Decimal as string

  // Performance (required)
  executionTimeMs: number;
  inferenceTimeMs?: number;

  // Command-specific results (all optional)
  fixesApplied?: number;
  testsRun?: number;
  testsPassed?: number;
  testsFailed?: number;
  iterations?: number;
  filesModified?: string[];

  // Metadata
  cliVersion?: string;
  metadata?: Record<string, unknown>;

  // Conversation Data (full capture for tickets/requirements commands)
  conversationMessages?: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    toolCalls?: Array<{
      name: string;
      input: unknown;
      output?: unknown;
    }>;
  }>;

  // Timestamps (ISO 8601 format)
  startedAt: string;
  completedAt: string;
}

/**
 * Logger configuration
 */
interface LoggerConfig {
  baseUrl: string;
  apiKey: string;
  projectId: string;
  enabled: boolean;
}

/**
 * Runtime logger options
 */
interface LoggerRuntimeOptions {
  noLogs?: boolean; // Skip API calls when true (still tracks context internally)
}

/**
 * Command execution context for automatic tracking
 */
export interface CommandExecutionContext {
  command: CommandName;
  startTime: number;
  startedAt: string;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheCreation: number;
  tokensCacheRead: number;
  inferenceTimeMs: number;
  fixesApplied: number;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  iterations: number;
  filesModified: string[];
  noLogs: boolean; // Skip API calls when true
  conversationMessages: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    toolCalls?: Array<{
      name: string;
      input: unknown;
      output?: unknown;
    }>;
  }>; // Track conversation during execution
}

/**
 * CLI Logger class
 */
class CliLogger {
  private config: LoggerConfig;
  private cliVersion: string;

  constructor() {
    this.config = this.loadConfig();
    this.cliVersion = this.loadVersion();
  }

  /**
   * Load configuration from environment variables
   */
  private loadConfig(suppressWarning = false): LoggerConfig {
    const baseUrl = process.env.KOSUKE_BASE_URL || '';
    const apiKey = process.env.KOSUKE_API_KEY || '';
    const projectId = process.env.KOSUKE_PROJECT_ID || '';

    const enabled = !!(baseUrl && apiKey && projectId);

    if (!enabled && !suppressWarning) {
      console.warn(
        '⚠️  CLI logging disabled - missing KOSUKE_BASE_URL, KOSUKE_API_KEY, or KOSUKE_PROJECT_ID'
      );
    }

    return {
      baseUrl,
      apiKey,
      projectId,
      enabled,
    };
  }

  /**
   * Load CLI version from package.json
   */
  private loadVersion(): string {
    try {
      const packagePath = join(__dirname, '..', '..', 'package.json');
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));
      return packageJson.version || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Calculate cost from token usage
   * Uses Claude Sonnet 4.5 pricing
   */
  calculateCost(
    tokensInput: number,
    tokensOutput: number,
    tokensCacheCreation: number = 0,
    tokensCacheRead: number = 0
  ): string {
    const INPUT_COST_PER_MILLION = 3.0;
    const OUTPUT_COST_PER_MILLION = 15.0;
    const CACHE_CREATION_COST_PER_MILLION = 3.75;
    const CACHE_READ_COST_PER_MILLION = 0.3;

    const inputCost = (tokensInput / 1_000_000) * INPUT_COST_PER_MILLION;
    const outputCost = (tokensOutput / 1_000_000) * OUTPUT_COST_PER_MILLION;
    const cacheCreationCost = (tokensCacheCreation / 1_000_000) * CACHE_CREATION_COST_PER_MILLION;
    const cacheReadCost = (tokensCacheRead / 1_000_000) * CACHE_READ_COST_PER_MILLION;

    const totalCost = inputCost + outputCost + cacheCreationCost + cacheReadCost;
    return totalCost.toFixed(6);
  }

  /**
   * Log command execution to kosuke-core
   */
  async logCommand(data: CliLogData): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.config.baseUrl}/api/cli/logs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cli-api-key': this.config.apiKey,
        },
        body: JSON.stringify(data),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        try {
          const error = await response.json();
          console.warn(`⚠️  Failed to log command: ${JSON.stringify(error)}`);
        } catch {
          // Response might not be JSON (e.g., HTML error page)
          console.warn(`⚠️  Failed to log command: ${response.status} ${response.statusText}`);
        }
      }
    } catch (error) {
      // Non-blocking: log warning but don't throw
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`⚠️  Error logging command: ${message}`);
    }
  }

  /**
   * Create a new command execution context
   */
  createContext(command: CommandName, options: LoggerRuntimeOptions = {}): CommandExecutionContext {
    return {
      command,
      startTime: Date.now(),
      startedAt: new Date().toISOString(),
      tokensInput: 0,
      tokensOutput: 0,
      tokensCacheCreation: 0,
      tokensCacheRead: 0,
      inferenceTimeMs: 0,
      fixesApplied: 0,
      testsRun: 0,
      testsPassed: 0,
      testsFailed: 0,
      iterations: 0,
      filesModified: [],
      noLogs: options.noLogs || false,
      conversationMessages: [],
    };
  }

  /**
   * Track tokens from an agent result
   */
  trackTokens(
    context: CommandExecutionContext,
    tokensUsed: {
      input: number;
      output: number;
      cacheCreation: number;
      cacheRead: number;
    }
  ): void {
    context.tokensInput += tokensUsed.input;
    context.tokensOutput += tokensUsed.output;
    context.tokensCacheCreation += tokensUsed.cacheCreation;
    context.tokensCacheRead += tokensUsed.cacheRead;
  }

  /**
   * Complete command execution and log it
   */
  async complete(
    context: CommandExecutionContext,
    status: ExecutionStatus,
    error?: Error
  ): Promise<void> {
    // Skip API call if noLogs is true (but still track context internally)
    if (context.noLogs || !this.config.enabled) {
      return;
    }

    const executionTimeMs = Date.now() - context.startTime;
    const completedAt = new Date().toISOString();

    const logData: CliLogData = {
      projectId: this.config.projectId,
      command: context.command,
      status,
      errorMessage: error?.message,
      tokensInput: context.tokensInput,
      tokensOutput: context.tokensOutput,
      tokensCacheCreation:
        context.tokensCacheCreation > 0 ? context.tokensCacheCreation : undefined,
      tokensCacheRead: context.tokensCacheRead > 0 ? context.tokensCacheRead : undefined,
      cost: this.calculateCost(
        context.tokensInput,
        context.tokensOutput,
        context.tokensCacheCreation,
        context.tokensCacheRead
      ),
      executionTimeMs,
      inferenceTimeMs: context.inferenceTimeMs > 0 ? context.inferenceTimeMs : undefined,
      fixesApplied: context.fixesApplied > 0 ? context.fixesApplied : undefined,
      testsRun: context.testsRun > 0 ? context.testsRun : undefined,
      testsPassed: context.testsPassed > 0 ? context.testsPassed : undefined,
      testsFailed: context.testsFailed > 0 ? context.testsFailed : undefined,
      iterations: context.iterations > 0 ? context.iterations : undefined,
      filesModified: context.filesModified.length > 0 ? context.filesModified : undefined,
      conversationMessages:
        context.conversationMessages.length > 0 ? context.conversationMessages : undefined,
      cliVersion: this.cliVersion,
      startedAt: context.startedAt,
      completedAt,
    };

    await this.logCommand(logData);
  }

  /**
   * Get project context (returns null if not configured)
   */
  getProjectContext(): { projectId: string } | null {
    if (!this.config.enabled) {
      return null;
    }

    return {
      projectId: this.config.projectId,
    };
  }

  /**
   * Check if logging is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

// Export singleton instance
export const logger = new CliLogger();

/**
 * Wrapper function to automatically track command execution
 *
 * Example usage:
 * ```typescript
 * export async function shipCommand(options: ShipOptions): Promise<void> {
 *   await withCommandTracking('ship', async (ctx) => {
 *     // ... command logic ...
 *     // Track tokens from agent results
 *     logger.trackTokens(ctx, result.tokensUsed);
 *     ctx.fixesApplied += result.fixCount;
 *   }, { noLogs: options.noLogs });
 * }
 * ```
 */
export async function withCommandTracking<T>(
  command: CommandName,
  fn: (context: CommandExecutionContext) => Promise<T>,
  options: LoggerRuntimeOptions = {}
): Promise<T> {
  const context = logger.createContext(command, options);

  try {
    const result = await fn(context);
    await logger.complete(context, 'success');
    return result;
  } catch (error) {
    await logger.complete(context, 'error', error as Error);
    throw error;
  }
}

/**
 * Handle command cancellation (SIGINT)
 */
export function setupCancellationHandler(context: CommandExecutionContext): () => void {
  const handler = async () => {
    console.log('\n\n⚠️  Command cancelled by user');
    await logger.complete(context, 'cancelled');
    process.exit(130); // Standard exit code for SIGINT
  };

  process.on('SIGINT', handler);

  // Return cleanup function
  return () => {
    process.off('SIGINT', handler);
  };
}
