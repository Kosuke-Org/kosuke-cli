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
  noLogs?: boolean;
}

export interface LintOptions {
  pr?: boolean;
  baseBranch?: string;
  directory?: string; // Directory to run linting in (default: cwd)
  noLogs?: boolean;
}

export interface SyncRulesOptions {
  force?: boolean;
  pr?: boolean;
  baseBranch?: string;
  noLogs?: boolean;
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
  noLogs?: boolean;
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
  directory?: string; // Directory for Claude to explore (default: cwd)
  scaffold?: boolean; // Enable scaffold mode (infrastructure setup)
  prompt?: string; // Inline requirements (alternative to --path)
  noLogs?: boolean;
}

export interface LayerAnalysis {
  needsSchema: boolean;
  needsBackend: boolean;
  needsFrontend: boolean;
  reasoning: string;
}

export interface Ticket {
  id: string; // e.g., "SCHEMA-SCAFFOLD-1", "BACKEND-LOGIC-2", "WEB-TEST-1", "DB-TEST-1"
  title: string;
  description: string;
  type: 'scaffold' | 'logic' | 'web-test' | 'db-test'; // scaffold = infrastructure setup, logic = business functionality, web-test = E2E browser tests, db-test = database validation
  estimatedEffort: number; // 1-10
  status: 'Todo' | 'InProgress' | 'Done' | 'Error';
  category?: string; // e.g., "auth", "billing", "email", "user-management"
  error?: string; // Optional error message if status is 'Error'
}

export interface TicketsResult {
  schemaTickets: Ticket[];
  backendTickets: Ticket[];
  frontendTickets: Ticket[];
  testTickets: Ticket[]; // DB and Web test tickets
  totalTickets: number;
  projectPath: string; // Directory where tickets were generated
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  cost: number;
  conversationMessages: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    toolCalls?: Array<{
      name: string;
      input: unknown;
      output?: unknown;
    }>;
  }>;
}

export interface ShipOptions {
  ticketData: Ticket; // Ticket object with all data (id, title, description, etc.)
  review?: boolean; // Enable review step with ticket context (default: false)
  directory?: string; // Directory to run ship in (default: cwd)
  dbUrl?: string; // Database URL for migrations (default: postgres://postgres:postgres@postgres:5432/postgres)
  noLogs?: boolean;
}

export interface BuildOptions {
  directory?: string; // Directory to run build in (default: cwd)
  ticketsFile?: string; // Path to tickets.json (default: tickets.json, relative to directory)
  dbUrl?: string; // Database URL for migrations (default: postgres://postgres:postgres@postgres:5432/postgres)
  reset?: boolean; // Reset all tickets to "Todo" status before processing
  askConfirm?: boolean; // Ask for confirmation before proceeding to next ticket
  askCommit?: boolean; // Ask before committing each ticket (default: auto-commit)
  review?: boolean; // Enable code review phase (default: true)
  test?: boolean; // Enable testing phase for frontend tickets (default: true)
  url?: string; // Base URL for testing (default: http://localhost:3000)
  headless?: boolean; // Run browser in headless mode during testing
  verbose?: boolean; // Enable verbose output for tests
  noLogs?: boolean;
}

export interface ReviewContext {
  ticketId: string;
  ticketTitle: string;
  ticketDescription: string;
}

export interface ReviewOptions {
  directory?: string; // Directory to review (default: cwd)
  context?: ReviewContext; // Optional ticket context for targeted review
  noLogs?: boolean;
}

export interface TestContext {
  ticketId: string;
  ticketTitle: string;
  ticketDescription: string;
}

export interface ShipResult {
  success: boolean;
  implementationFixCount: number;
  lintFixCount: number;
  reviewFixCount: number;
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
  prompt: string; // Test prompt/instructions (required)
  type?: 'web-test' | 'db-test'; // Manual test type selection (auto-detected from context if not specified)
  context?: TestContext; // Optional ticket context for test execution
  url?: string; // Base URL for web tests (default: http://localhost:3000)
  dbUrl?: string; // Database URL for db tests (default: postgres://postgres:postgres@localhost:5432/postgres)
  headless?: boolean; // Run browser in headless mode (invisible, web-test only)
  verbose?: boolean; // Enable verbose output
  directory?: string; // Directory to run tests in (default: cwd)
  noLogs?: boolean;
}

export interface TestResult {
  ticketId: string;
  testType: 'web-test' | 'db-test';
  success: boolean;
  output: string; // Human-readable test result
  logs: {
    console: string[];
    errors: string[];
  };
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  cost: number;
  error?: string;
}

export interface DBTestResult {
  success: boolean;
  tablesValidated: string[];
  errors: string[];
}

export interface TestRunnerOptions {
  ticket: Ticket;
  cwd: string;
  url?: string;
  headless?: boolean;
  verbose?: boolean;
  maxRetries?: number;
}

export interface TestRunnerResult {
  success: boolean;
  attempts: number;
  fixesApplied: number;
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  cost: number;
}

// CLI Logging types
export type {
  CommandName,
  ExecutionStatus,
  CliLogData,
  CommandExecutionContext,
} from './utils/logger.js';

// Re-export utility types for public API
export type { AnalysisResult, TestFailure } from './utils/error-analyzer.js';
export type { ConsoleLog, NetworkLog, DockerLog, CollectedLogs } from './utils/log-collector.js';
