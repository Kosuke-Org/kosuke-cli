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
