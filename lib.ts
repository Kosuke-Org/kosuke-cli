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
 *   discoverFiles,
 *   runLint,
 *   type ValidationResult
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
 * // Use validation utilities
 * const lintResult: ValidationResult = await runLint();
 *
 * // Discover files
 * const files = await discoverFiles({ types: ['ts', 'tsx'] });
 * ```
 */

// Re-export commands
export { analyseCommand } from './kosuke/commands/analyse.js';
export { lintCommand, fixCodeQualityErrors, fixLintErrors } from './kosuke/commands/lint.js';
export { syncRulesCommand } from './kosuke/commands/sync-rules.js';
export { requirementsCommand } from './kosuke/commands/requirements.js';
export { getCodeCore } from './kosuke/commands/getcode.js';
export { ticketsCore } from './kosuke/commands/tickets.js';
export { shipCommand, shipCore } from './kosuke/commands/ship.js';
export { buildCommand } from './kosuke/commands/build.js';
export { reviewCommand, reviewCore } from './kosuke/commands/review.js';
export { testCommand, testCore } from './kosuke/commands/test.js';

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
  ReviewOptions,
  ReviewResult,
  TestOptions,
  TestResult,
  // Testing utility types
  AnalysisResult,
  TestFailure,
  ConsoleLog,
  NetworkLog,
  DockerLog,
  CollectedLogs,
  PlaywrightResult,
  PlaywrightOptions,
  GeneratedTest,
  VisualDiff,
  VisualTestOptions,
} from './kosuke/types.js';

export type { ValidationResult } from './kosuke/utils/validator.js';
export type { AgentVerbosity, AgentConfig, AgentResult } from './kosuke/utils/claude-agent.js';
