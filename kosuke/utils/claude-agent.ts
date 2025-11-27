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
  captureConversation?: boolean; // Enable full conversation capture (for tickets/requirements)
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
  conversationMessages?: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    toolCalls?: Array<{
      name: string;
      input: unknown;
      output?: unknown;
    }>;
  }>; // Full conversation capture (if enabled)
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

  // Show full message without truncation
  console.log(`   💭 ${trimmed}`);
}

/**
 * Format tool arguments for display (no truncation)
 */
function formatToolArgs(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return JSON.stringify(input);
  }

  return JSON.stringify(input);
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
    console.log(`   🔧 Running: ${cmd}`);
  } else if (toolName === 'list_dir' && toolInput && typeof toolInput === 'object') {
    const input = toolInput as { target_directory?: string };
    console.log(`   📂 Listing directory: ${input.target_directory || '.'}`);
  } else {
    // Generic tool logging with arguments
    const args = formatToolArgs(toolInput);
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
    captureConversation = false,
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

  // Conversation capture (if enabled)
  const conversationMessages: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    toolCalls?: Array<{
      name: string;
      input: unknown;
      output?: unknown;
    }>;
  }> = [];

  // Track current assistant message and tool calls
  let currentMessage: {
    role: 'assistant';
    content: string;
    timestamp: string;
    toolCalls: Array<{ name: string; input: unknown; output?: unknown }>;
  } | null = null;

  // Add user message if capturing
  if (captureConversation) {
    conversationMessages.push({
      role: 'user',
      content: prompt,
      timestamp: new Date().toISOString(),
    });
  }

  // Process the response stream
  for await (const message of responseStream) {
    if (message.type === 'assistant') {
      const content = message.message.content;

      // Start new assistant message if capturing
      if (captureConversation && !currentMessage) {
        currentMessage = {
          role: 'assistant',
          content: '',
          timestamp: new Date().toISOString(),
          toolCalls: [],
        };
      }

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          response += block.text;
          logAssistantMessage(block.text, verbosity);

          // Add to current message content
          if (captureConversation && currentMessage) {
            currentMessage.content += block.text;
          }
        } else if (block.type === 'tool_use') {
          // Track fixes
          if (block.name === 'write' || block.name === 'search_replace') {
            fixCount++;
            console.log(`   🔧 Applying fix ${fixCount}...`);
          } else {
            logToolUsage(block.name, block.input, filesReferenced);
          }

          // Capture tool call
          if (captureConversation && currentMessage) {
            currentMessage.toolCalls.push({
              name: block.name,
              input: block.input,
              // Output will be added when we receive tool_result
            });
          }
        }
      }
    }

    // Capture tool results
    // Note: tool_result is not part of the message stream type, so we skip this for now
    // Tool outputs are captured through the SDK's internal handling

    // Track token usage
    if (message.type === 'result' && message.subtype === 'success') {
      inputTokens += message.usage.input_tokens || 0;
      outputTokens += message.usage.output_tokens || 0;
      cacheCreationTokens += message.usage.cache_creation_input_tokens || 0;
      cacheReadTokens += message.usage.cache_read_input_tokens || 0;

      // Save current message when turn completes
      if (captureConversation && currentMessage) {
        conversationMessages.push({
          role: currentMessage.role,
          content: currentMessage.content,
          timestamp: currentMessage.timestamp,
          toolCalls: currentMessage.toolCalls.length > 0 ? currentMessage.toolCalls : undefined,
        });
        currentMessage = null; // Reset for next turn
      }
    }
  }

  // Calculate cost
  const cost = calculateCost(inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens);

  const result: AgentResult = {
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

  // Include conversation if captured
  if (captureConversation && conversationMessages.length > 0) {
    result.conversationMessages = conversationMessages;
  }

  return result;
}
