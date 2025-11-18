/**
 * Shared types for Kosuke CLI
 */

export interface Batch {
  name: string;
  directory: string;
  files: string[];
}

export interface Fix {
  file: string;
  type: FixType;
  description: string;
  linesChanged: number;
}

type FixType =
  | 'type-inference'
  | 'navigation-pattern'
  | 'loading-state'
  | 'component-colocation'
  | 'server-side-filtering'
  | 'python-quality'
  | 'other';

export interface AnalyseOptions {
  pr?: boolean;
  baseBranch?: string;
  scope?: string;
  types?: string[];
}

export interface LintOptions {
  pr?: boolean;
  baseBranch?: string;
}

export interface SyncRulesOptions {
  force?: boolean;
  pr?: boolean;
  baseBranch?: string;
}

export interface RulesAdaptation {
  relevant: boolean;
  adaptedContent: string;
  summary: string;
}

export interface GitInfo {
  owner: string;
  repo: string;
}

export interface GetCodeOptions {
  repo?: string; // Repository identifier (owner/repo or URL)
  query: string; // Natural language query
  template?: boolean; // Use kosuke-template
  output?: string; // Optional: save output to file
}

export interface RepositoryInfo {
  owner: string;
  repo: string;
  fullName: string; // "owner/repo"
  localPath: string; // Local cache path
}

export interface CodeExplorationResult {
  repository: string;
  query: string;
  response: string;
  filesReferenced: string[];
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  cost: number;
}

export interface TicketsOptions {
  path?: string; // Path to requirements document (default: docs.md)
  output?: string; // Output file (default: tickets.json)
  template?: string; // Custom template repo (default: kosuke-template)
}

export interface Ticket {
  id: string; // e.g., "SCHEMA-1", "BACKEND-1", "FRONTEND-1"
  title: string;
  description: string;
  estimatedEffort: number; // 1-10
  status: 'Todo' | 'InProgress' | 'Done' | 'Error';
  error?: string; // Optional error message if status is 'Error'
}

export interface TicketsResult {
  schemaTickets: Ticket[];
  backendTickets: Ticket[];
  frontendTickets: Ticket[];
  totalTickets: number;
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  cost: number;
}

export interface ShipOptions {
  ticket: string; // Ticket ID (e.g., "SCHEMA-1")
  review?: boolean; // Enable review step
  commit?: boolean; // Commit and push to current branch
  pr?: boolean; // Create pull request (new branch)
  baseBranch?: string; // Base branch for PR
  ticketsFile?: string; // Path to tickets.json (default: tickets.json)
  test?: boolean; // Run tests after implementation
}

export interface BuildOptions {
  ticketsFile?: string; // Path to tickets.json (default: tickets.json)
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ReviewOptions {
  // No options for now - reviews current git diff
}

export interface ShipResult {
  ticketId: string;
  success: boolean;
  implementationFixCount: number;
  lintFixCount: number;
  reviewPerformed: boolean;
  reviewFixCount: number;
  gitDiffReviewed: boolean;
  gitDiffReviewFixCount: number;
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  cost: number;
  error?: string;
}

export interface ReviewResult {
  success: boolean;
  issuesFound: number;
  fixesApplied: number;
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  cost: number;
}

export interface TestOptions {
  ticket: string; // Ticket ID to test (required)
  url?: string; // Base URL (default: http://localhost:3000)
  headed?: boolean; // Show browser during testing
  debug?: boolean; // Enable Playwright inspector
  updateBaseline?: boolean; // Update visual baselines
  maxRetries?: number; // Max fix-retest iterations (default: 3)
  ticketsFile?: string; // Path to tickets.json (default: tickets.json)
  pr?: boolean; // Create pull request with fixes
  baseBranch?: string; // Base branch for PR
}

export interface TestResult {
  ticketId: string;
  success: boolean;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  visualDiffs: number;
  fixesApplied: number;
  lintFixCount: number;
  iterations: number;
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  cost: number;
  testFilePath: string;
  tracePath: string;
  error?: string;
}

// Re-export utility types for public API
export type { AnalysisResult, TestFailure } from './utils/error-analyzer.js';
export type { ConsoleLog, NetworkLog, DockerLog, CollectedLogs } from './utils/log-collector.js';
export type { PlaywrightResult, PlaywrightOptions } from './utils/playwright-agent.js';
export type { GeneratedTest } from './utils/test-generator.js';
export type { VisualDiff, VisualTestOptions } from './utils/visual-tester.js';
