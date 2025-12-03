/**
 * Shared types for Kosuke CLI
 */

// ============================================
// ATTACHMENT TYPES (for web integration)
// ============================================

/** File type classification */
export type FileType = 'image' | 'document';

/** Supported image MIME types for Claude API */
export type SupportedImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** Result from file upload - contains all metadata needed for Claude API */
export interface UploadResult {
  fileUrl: string;
  filename: string; // Original filename
  storedFilename: string; // Sanitized filename used in storage
  fileType: FileType;
  mediaType: string; // MIME type
  fileSize: number;
}

/** Attachment payload for messages */
export interface MessageAttachmentPayload {
  upload: UploadResult;
}

// ============================================
// BATCH AND FIX TYPES
// ============================================

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
  scaffold?: boolean; // Enable scaffold mode (template adaptation + business logic)
  prompt?: string; // Inline requirements (alternative to --path)
  noTest?: boolean; // Skip WEB-TEST ticket creation
  noLogs?: boolean;
}

export interface Ticket {
  id: string; // e.g., "SCAFFOLD-SCHEMA-1", "LOGIC-ENGINE-1", "LOGIC-BACKEND-2", "SCAFFOLD-WEB-TEST-1"
  title: string;
  description: string;
  type: 'schema' | 'engine' | 'backend' | 'frontend' | 'test'; // schema = database, engine = Python microservice, backend = API, frontend = UI, test = E2E tests
  estimatedEffort: number; // 1-10
  status: 'Todo' | 'InProgress' | 'Done' | 'Error';
  category?: string; // e.g., "auth", "billing", "email", "user-management", "tasks"
  error?: string; // Optional error message if status is 'Error'
}

export interface TicketsResult {
  schemaTickets: Ticket[];
  engineTickets: Ticket[]; // Python microservice tickets
  backendTickets: Ticket[];
  frontendTickets: Ticket[];
  testTickets: Ticket[]; // Web test tickets
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
  context?: TestContext; // Optional ticket context for test execution
  url?: string; // Base URL for web tests (default: http://localhost:3000)
  headless?: boolean; // Run browser in headless mode (invisible)
  verbose?: boolean; // Enable verbose output
  noLogs?: boolean;
}

export interface TestResult {
  ticketId: string;
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

export interface MigrateOptions {
  directory?: string; // Directory to run migrations in (default: cwd)
  dbUrl?: string; // Database URL (default: postgres://postgres:postgres@localhost:5432/postgres)
  context?: {
    ticketId?: string;
    ticketTitle?: string;
    ticketDescription?: string;
  };
  noLogs?: boolean;
}

export interface MigrateResult {
  success: boolean;
  migrationsApplied: boolean;
  seedingCompleted: boolean;
  validationPassed: boolean;
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  cost: number;
  error?: string;
}

export interface PlanOptions {
  prompt: string; // Feature or bug description
  directory?: string; // Directory with existing code (default: cwd)
  noTest?: boolean; // Skip WEB-TEST ticket creation
  noLogs?: boolean;
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
