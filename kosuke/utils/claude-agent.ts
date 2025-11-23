/**
 * Claude Agent - Centralized Claude SDK integration
 *
 * Provides unified agent initialization, execution, logging, and cost tracking
 * for all commands that use Claude Code Agent SDK.
 */

import { query, type Options, type PermissionMode } from '@anthropic-ai/claude-agent-sdk';

/**
 * Verbosity levels for agent execution
 * - minimal: Only show tool usage (fixes, file reads)
 * - normal: Show tool usage + key insights
 * - verbose: Show all text output + tool usage
 */
export type AgentVerbosity = 'minimal' | 'normal' | 'verbose';

/**
 * Configuration for agent execution
 */
export interface AgentConfig {
  systemPrompt: string;
  maxTurns?: number;
  model?: string;
  cwd?: string;
  verbosity?: AgentVerbosity;
  permissionMode?: PermissionMode;
}

/**
 * Result from agent execution
 */
export interface AgentResult {
  response: string;
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  cost: number;
  fixCount: number;
  filesReferenced: Set<string>;
}

/**
 * Calculate cost based on Claude Sonnet 4.5 pricing
 * - $3 per million input tokens
 * - $15 per million output tokens
 * - $3.75 per million cache creation tokens (input + 25% overhead)
 * - $0.30 per million cache read tokens (90% discount from input)
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number = 0,
  cacheReadTokens: number = 0
): number {
  const INPUT_COST_PER_MILLION = 3.0;
  const OUTPUT_COST_PER_MILLION = 15.0;
  const CACHE_CREATION_COST_PER_MILLION = 3.75;
  const CACHE_READ_COST_PER_MILLION = 0.3;

  const inputCost = (inputTokens / 1_000_000) * INPUT_COST_PER_MILLION;
  const outputCost = (outputTokens / 1_000_000) * OUTPUT_COST_PER_MILLION;
  const cacheCreationCost = (cacheCreationTokens / 1_000_000) * CACHE_CREATION_COST_PER_MILLION;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * CACHE_READ_COST_PER_MILLION;

  return inputCost + outputCost + cacheCreationCost + cacheReadCost;
}

/**
 * Format cost breakdown as human-readable string
 */
export function formatCostBreakdown(result: AgentResult): string {
  const tokenBreakdown = [];
  if (result.tokensUsed.input > 0) {
    tokenBreakdown.push(`${result.tokensUsed.input.toLocaleString()} input`);
  }
  if (result.tokensUsed.output > 0) {
    tokenBreakdown.push(`${result.tokensUsed.output.toLocaleString()} output`);
  }
  if (result.tokensUsed.cacheCreation > 0) {
    tokenBreakdown.push(`${result.tokensUsed.cacheCreation.toLocaleString()} cache write`);
  }
  if (result.tokensUsed.cacheRead > 0) {
    tokenBreakdown.push(`${result.tokensUsed.cacheRead.toLocaleString()} cache read`);
  }

  return `$${result.cost.toFixed(4)} (${tokenBreakdown.join(' + ')} tokens)`;
}

/**
 * Determine if text should be logged based on verbosity level
 */
function shouldLogText(text: string, verbosity: AgentVerbosity): boolean {
  if (verbosity === 'verbose') {
    return true;
  }

  if (verbosity === 'minimal') {
    return false;
  }

  // Normal: Log key insights only
  const keywords = [
    'violation',
    'fix',
    'issue',
    'error',
    'found',
    'located',
    'implementation',
    '✅',
    '❌',
  ];
  const lowerText = text.toLowerCase();
  return keywords.some((keyword) => lowerText.includes(keyword)) || text.length < 200;
}

/**
 * Log assistant message based on verbosity
 */
function logAssistantMessage(text: string, verbosity: AgentVerbosity): void {
  const trimmed = text.trim();
  if (!trimmed || !shouldLogText(trimmed, verbosity)) {
    return;
  }

  // Truncate long messages for readability
  const maxLength = verbosity === 'verbose' ? 500 : 100;
  const display = trimmed.length > maxLength ? `${trimmed.substring(0, maxLength)}...` : trimmed;
  console.log(`   💭 ${display}`);
}

/**
 * Format tool arguments for display (truncate if too long)
 */
function formatToolArgs(input: unknown, maxLength: number = 80): string {
  if (!input || typeof input !== 'object') {
    return JSON.stringify(input);
  }

  const str = JSON.stringify(input);
  if (str.length <= maxLength) {
    return str;
  }

  return `${str.substring(0, maxLength)}...`;
}

/**
 * Log tool usage
 */
function logToolUsage(toolName: string, toolInput: unknown, filesReferenced: Set<string>): void {
  if (toolName === 'read_file' && toolInput && typeof toolInput === 'object') {
    const input = toolInput as { target_file?: string };
    if (input.target_file) {
      console.log(`   🔧 Reading ${input.target_file}`);
      filesReferenced.add(input.target_file);
    }
  } else if (toolName === 'grep' && toolInput && typeof toolInput === 'object') {
    const input = toolInput as { pattern?: string; path?: string };
    const pathInfo = input.path ? ` in ${input.path}` : '';
    console.log(`   🔍 Searching for: ${input.pattern || 'pattern'}${pathInfo}`);
  } else if (toolName === 'glob_file_search' && toolInput && typeof toolInput === 'object') {
    const input = toolInput as { glob_pattern?: string; target_directory?: string };
    const dirInfo = input.target_directory ? ` in ${input.target_directory}` : '';
    console.log(`   📁 Finding files: ${input.glob_pattern || '*'}${dirInfo}`);
  } else if (toolName === 'codebase_search' && toolInput && typeof toolInput === 'object') {
    const input = toolInput as { query?: string; target_directories?: string[] };
    const dirInfo =
      input.target_directories && input.target_directories.length > 0
        ? ` in ${input.target_directories.join(', ')}`
        : '';
    console.log(`   🔎 Searching codebase: ${input.query || 'query'}${dirInfo}`);
  } else if (toolName === 'write' || toolName === 'search_replace') {
    // Don't log here - fixCount will handle it
  } else if (toolName === 'run_terminal_cmd' && toolInput && typeof toolInput === 'object') {
    const input = toolInput as { command?: string };
    const cmd = input.command || 'command';
    const truncated = cmd.length > 60 ? `${cmd.substring(0, 60)}...` : cmd;
    console.log(`   🔧 Running: ${truncated}`);
  } else if (toolName === 'list_dir' && toolInput && typeof toolInput === 'object') {
    const input = toolInput as { target_directory?: string };
    console.log(`   📂 Listing directory: ${input.target_directory || '.'}`);
  } else {
    // Generic tool logging with arguments
    const args = formatToolArgs(toolInput, 60);
    console.log(`   🔧 ${toolName}(${args})`);
  }
}

/**
 * Run Claude agent with unified configuration and logging
 */
export async function runAgent(prompt: string, config: AgentConfig): Promise<AgentResult> {
  const {
    systemPrompt,
    maxTurns = 20,
    model = 'claude-sonnet-4-5',
    cwd = process.cwd(),
    verbosity = 'normal',
    permissionMode = 'bypassPermissions',
  } = config;

  const options: Options = {
    model,
    systemPrompt,
    maxTurns,
    cwd,
    permissionMode,
  };

  const responseStream = query({ prompt, options });

  let response = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let fixCount = 0;
  const filesReferenced = new Set<string>();

  // Process the response stream
  for await (const message of responseStream) {
    if (message.type === 'assistant') {
      const content = message.message.content;
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          response += block.text;
          logAssistantMessage(block.text, verbosity);
        } else if (block.type === 'tool_use') {
          // Track fixes
          if (block.name === 'write' || block.name === 'search_replace') {
            fixCount++;
            console.log(`   🔧 Applying fix ${fixCount}...`);
          } else {
            logToolUsage(block.name, block.input, filesReferenced);
          }
        }
      }
    }

    // Track token usage
    if (message.type === 'result' && message.subtype === 'success') {
      inputTokens += message.usage.input_tokens || 0;
      outputTokens += message.usage.output_tokens || 0;
      cacheCreationTokens += message.usage.cache_creation_input_tokens || 0;
      cacheReadTokens += message.usage.cache_read_input_tokens || 0;
    }
  }

  // Calculate cost
  const cost = calculateCost(inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens);

  return {
    response: response.trim(),
    tokensUsed: {
      input: inputTokens,
      output: outputTokens,
      cacheCreation: cacheCreationTokens,
      cacheRead: cacheReadTokens,
    },
    cost,
    fixCount,
    filesReferenced,
  };
}
