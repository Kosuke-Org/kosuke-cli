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
  status: 'Todo' | 'Done';
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
