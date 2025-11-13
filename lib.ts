/**
 * Kosuke CLI - Library API
 *
 * Use this module to programmatically access Kosuke CLI functionality
 * in your TypeScript projects.
 *
 * @example
 * ```typescript
 * import { analyseCommand, discoverFiles } from '@kosuke-ai/cli';
 *
 * // Run analysis programmatically
 * await analyseCommand({ scope: 'src', pr: false });
 *
 * // Use utilities
 * const files = await discoverFiles({ types: ['ts', 'tsx'] });
 * ```
 */

// Re-export commands
export { analyseCommand } from './kosuke/commands/analyse.js';
export { lintCommand } from './kosuke/commands/lint.js';
export { syncRulesCommand } from './kosuke/commands/sync-rules.js';
export { requirementsCommand } from './kosuke/commands/requirements.js';

// Re-export utilities
export { discoverFiles } from './kosuke/utils/file-discovery.js';
export { createBatches } from './kosuke/utils/batch-creator.js';
export { runLint, runTypecheck, runFormat } from './kosuke/utils/validator.js';

// Re-export types
export type {
  Batch,
  Fix,
  AnalyseOptions,
  LintOptions,
  SyncRulesOptions,
  RulesAdaptation,
  GitInfo,
} from './kosuke/types.js';
