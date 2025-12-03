/**
 * Kosuke CLI - Library API
 *
 * Use this module to programmatically access Kosuke CLI functionality
 * in your TypeScript projects.
 *
 * @example
 * ```typescript
 * import {
 *   analyseCommand,
 *   getCodeCore,
 *   shipCore,
 *   runTestsWithRetry,
 *   discoverFiles,
 *   runLint,
 *   logger,
 *   withCommandTracking,
 *   type Ticket,
 *   type ValidationResult,
 *   type CommandExecutionContext
 * } from '@kosuke-ai/cli';
 *
 * // Run analysis programmatically
 * await analyseCommand({ scope: 'src', pr: false });
 *
 * // Explore code from a repository
 * const result = await getCodeCore({
 *   repo: 'owner/repo',
 *   query: 'How does authentication work?'
 * });
 *
 * // Ship a ticket (ticket-agnostic)
 * const ticket: Ticket = {
 *   id: 'FRONTEND-1',
 *   title: 'Implement login page',
 *   description: 'Create a login page with email/password...',
 *   estimatedEffort: 5,
 *   status: 'InProgress'
 * };
 * const shipResult = await shipCore({
 *   ticketData: ticket,
 *   review: true,
 *   directory: './my-project'
 * });
 *
 * // Run tests with retry logic
 * if (ticket.id.startsWith('FRONTEND-')) {
 *   const testResult = await runTestsWithRetry({
 *     ticket,
 *     cwd: './my-project',
 *     maxRetries: 3
 *   });
 * }
 *
 * // Use validation utilities
 * const lintResult: ValidationResult = await runLint();
 *
 * // Discover files
 * const files = await discoverFiles({ types: ['ts', 'tsx'] });
 *
 * // Track command execution with automatic logging
 * await withCommandTracking('ship', async (ctx: CommandExecutionContext) => {
 *   // Your command logic here
 *   ctx.fixesApplied = 5;
 *   ctx.filesModified = ['src/app.ts'];
 * });
 * ```
 */

import packageJson from './package.json';

// Re-export commands
export { analyseCommand } from './kosuke/commands/analyse.js';
export { lintCommand, fixCodeQualityErrors, fixLintErrors } from './kosuke/commands/lint.js';
export { syncRulesCommand } from './kosuke/commands/sync-rules.js';
export { requirementsCommand, requirementsCore } from './kosuke/commands/requirements.js';
export { planCommand, planCore, planCoreStreaming } from './kosuke/commands/plan.js';
export { getCodeCore } from './kosuke/commands/getcode.js';
export { ticketsCore } from './kosuke/commands/tickets.js';
export { shipCore } from './kosuke/commands/ship.js';
export {
  buildCommand,
  buildCoreStreaming,
  sortTicketsByProcessingOrder,
} from './kosuke/commands/build.js';
export { migrateCommand, migrateCore } from './kosuke/commands/migrate.js';
export { reviewCommand, reviewCore } from './kosuke/commands/review.js';
export { testCommand, testCore } from './kosuke/commands/test.js';
export { runTestsWithRetry } from './kosuke/utils/test-runner.js';

// Re-export utilities
export { discoverFiles } from './kosuke/utils/file-discovery.js';
export { createBatches } from './kosuke/utils/batch-creator.js';
export {
  runLint,
  runTypecheck,
  runFormat,
  runTests,
  runComprehensiveLinting,
  detectPackageManager,
  readPackageJsonScripts,
} from './kosuke/utils/validator.js';
export { getRepoLocalPath } from './kosuke/utils/repository-manager.js';
export { validateRepoAccess } from './kosuke/utils/repository-resolver.js';
export { logger, withCommandTracking, setupCancellationHandler } from './kosuke/utils/logger.js';
export { askQuestion } from './kosuke/utils/interactive-input.js';
export {
  loadTicketsFile,
  saveTicketsFile,
  writeTicketsFile,
  updateTicketStatus,
  parseTickets,
  sortTicketsByOrder,
  validateAndFixTickets,
  displayTicketsSummary,
  processAndWriteTickets,
} from './kosuke/utils/tickets-manager.js';

// Re-export types
export type {
  Batch,
  Fix,
  AnalyseOptions,
  LintOptions,
  SyncRulesOptions,
  RulesAdaptation,
  GitInfo,
  GetCodeOptions,
  CodeExplorationResult,
  TicketsOptions,
  TicketsResult,
  Ticket,
  ShipOptions,
  ShipResult,
  BuildOptions,
  MigrateOptions,
  MigrateResult,
  PlanOptions,
  ReviewContext,
  ReviewOptions,
  ReviewResult,
  TestContext,
  TestOptions,
  TestResult,
  TestRunnerOptions,
  TestRunnerResult,
  FileType,
  SupportedImageMediaType,
  UploadResult,
  MessageAttachmentPayload,
  // Testing utility types
  AnalysisResult,
  TestFailure,
  ConsoleLog,
  NetworkLog,
  DockerLog,
  CollectedLogs,
  // Logger types
  CommandName,
  ExecutionStatus,
  CliLogData,
  CommandExecutionContext,
} from './kosuke/types.js';

export type { ValidationResult } from './kosuke/utils/validator.js';
export type { AgentVerbosity, AgentConfig, AgentResult } from './kosuke/utils/claude-agent.js';
export type { RequirementsOptions, RequirementsResult } from './kosuke/commands/requirements.js';
export {
  PlanEventName,
  type PlanEventNameType,
  type PlanResult,
  type PlanStreamEventType,
  type PlanStreamingOptions,
} from './kosuke/commands/plan.js';
export type { TicketsFile, TicketReviewResult } from './kosuke/utils/tickets-manager.js';
export {
  BuildEventName,
  type BuildEventNameType,
  type BuildStreamEventType,
  type BuildStreamingOptions,
  type BuildTokenUsage,
} from './kosuke/commands/build.js';

// Export version from package.json
export const version = packageJson.version;
