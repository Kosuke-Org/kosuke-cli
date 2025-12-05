/**
 * Claude Agent - Centralized Claude SDK integration
 *
 * Provides unified agent initialization, execution, logging, and cost tracking
 * for all commands that use Claude Code Agent SDK.
 */

import {
  query,
  type Options,
  type PermissionMode,
  type SettingSource,
  type McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'fs';
import { join } from 'path';

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
  settingSources?: SettingSource[]; // Where to load settings from (e.g., 'project' loads CLAUDE.md)
  resume?: string; // Session ID to resume multi-turn conversation
  mcpServers?: Record<string, McpServerConfig>; // Custom MCP servers with tools
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
  sessionId?: string; // Session ID for multi-turn conversation continuity
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
  // Handle both SDK tool names (Read, Glob, Bash) and legacy names (read_file, glob_file_search, run_terminal_cmd)
  if (
    (toolName === 'Read' || toolName === 'read_file') &&
    toolInput &&
    typeof toolInput === 'object'
  ) {
    const input = toolInput as { file_path?: string; target_file?: string };
    const filePath = input.file_path || input.target_file;
    if (filePath) {
      console.log(`   📄 Reading ${filePath}`);
      filesReferenced.add(filePath);
    }
  } else if (
    (toolName === 'Grep' || toolName === 'grep') &&
    toolInput &&
    typeof toolInput === 'object'
  ) {
    const input = toolInput as { pattern?: string; path?: string };
    const pathInfo = input.path ? ` in ${input.path}` : '';
    console.log(`   🔍 Searching: ${input.pattern || 'pattern'}${pathInfo}`);
  } else if (
    (toolName === 'Glob' || toolName === 'glob_file_search') &&
    toolInput &&
    typeof toolInput === 'object'
  ) {
    const input = toolInput as {
      pattern?: string;
      glob_pattern?: string;
      target_directory?: string;
    };
    const pattern = input.pattern || input.glob_pattern || '*';
    const dirInfo = input.target_directory ? ` in ${input.target_directory}` : '';
    console.log(`   📁 Finding: ${pattern}${dirInfo}`);
  } else if (toolName === 'CodebaseSearch' && toolInput && typeof toolInput === 'object') {
    const input = toolInput as { query?: string; target_directories?: string[] };
    const dirInfo =
      input.target_directories && input.target_directories.length > 0
        ? ` in ${input.target_directories.join(', ')}`
        : '';
    console.log(`   🔎 Codebase search: ${input.query || 'query'}${dirInfo}`);
  } else if (
    toolName === 'Edit' ||
    toolName === 'write' ||
    toolName === 'search_replace' ||
    toolName === 'edit_notebook' ||
    toolName === 'delete_file'
  ) {
    // Don't log here - fixCount will handle it
  } else if (
    (toolName === 'Bash' || toolName === 'run_terminal_cmd') &&
    toolInput &&
    typeof toolInput === 'object'
  ) {
    const input = toolInput as { command?: string };
    const cmd = input.command || 'command';
    // Truncate long commands
    const displayCmd = cmd.length > 60 ? cmd.substring(0, 57) + '...' : cmd;
    console.log(`   💻 Running: ${displayCmd}`);
  } else if (
    (toolName === 'ListDir' || toolName === 'list_dir') &&
    toolInput &&
    typeof toolInput === 'object'
  ) {
    const input = toolInput as { target_directory?: string };
    console.log(`   📂 Listing: ${input.target_directory || '.'}`);
  } else if (toolName.includes('write_tickets') && toolInput && typeof toolInput === 'object') {
    const input = toolInput as { tickets?: Array<{ id: string; title: string }> };
    const ticketCount = input.tickets?.length || 0;
    console.log(`   📋 Creating ${ticketCount} ticket${ticketCount !== 1 ? 's' : ''}...`);
  } else if (toolName === 'Task' && toolInput && typeof toolInput === 'object') {
    const input = toolInput as { subagent_type?: string; description?: string };
    const taskType = input.subagent_type || 'Task';
    const description = input.description || '';
    console.log(`   🤖 ${taskType}: ${description}`);
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
    settingSources = ['project'], // Default: Load CLAUDE.md from project
    resume,
    mcpServers,
  } = config;

  // Log the model being used
  console.log(`🤖 Using model: ${model}\n`);

  // Check if CLAUDE.md exists and warn if not (when loading from project)
  if (settingSources.includes('project')) {
    const claudePath = join(cwd, 'CLAUDE.md');
    if (!existsSync(claudePath)) {
      console.warn(
        '⚠️  CLAUDE.md not found in project directory. Agent will use general coding best practices.\n'
      );
    }
  }

  // Create AbortController for cleanup - the SDK spawns child processes
  // that need to be terminated after each query to prevent memory accumulation
  const abortController = new AbortController();

  const options: Options = {
    model,
    systemPrompt,
    maxTurns,
    cwd,
    permissionMode,
    settingSources,
    abortController, // Pass to SDK for process cleanup
    ...(resume && { resume }),
    ...(mcpServers && { mcpServers }),
  };

  const responseStream = query({ prompt, options });

  let response = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let fixCount = 0;
  const filesReferenced = new Set<string>();
  let sessionId: string | undefined;

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
    // Capture session ID from any message
    if (!sessionId && 'session_id' in message) {
      sessionId = message.session_id;
    }

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
          // Track fixes - count all file modification tools (case-insensitive)
          const toolNameLower = block.name.toLowerCase();
          const isFileModification =
            toolNameLower === 'write' ||
            toolNameLower === 'search_replace' ||
            toolNameLower === 'edit' ||
            toolNameLower === 'edit_notebook' ||
            toolNameLower === 'delete_file';

          if (isFileModification) {
            fixCount++;
            console.log(`   🔧 Applying fix ${fixCount}... (${block.name})`);
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
      const input = message.usage.input_tokens || 0;
      const output = message.usage.output_tokens || 0;
      const cacheCreation = message.usage.cache_creation_input_tokens || 0;
      const cacheRead = message.usage.cache_read_input_tokens || 0;

      inputTokens += input;
      outputTokens += output;
      cacheCreationTokens += cacheCreation;
      cacheReadTokens += cacheRead;

      // Debug logging for token tracking (only if verbose)
      if (verbosity === 'verbose' && (input > 0 || output > 0)) {
        console.log(
          `   📊 Turn tokens: ${input} in, ${output} out, ${cacheCreation} cache write, ${cacheRead} cache read`
        );
      }

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

  // Debug logging for final totals
  if (verbosity === 'verbose') {
    console.log(`\n   📊 Final totals:`);
    console.log(`      • Fixes applied: ${fixCount}`);
    console.log(`      • Total input tokens: ${inputTokens.toLocaleString()}`);
    console.log(`      • Total output tokens: ${outputTokens.toLocaleString()}`);
    console.log(`      • Total cost: $${cost.toFixed(4)}`);
  }

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
    sessionId,
  };

  // Include conversation if captured
  if (captureConversation && conversationMessages.length > 0) {
    result.conversationMessages = conversationMessages;
  }

  // Cleanup: Abort the controller to terminate any child processes spawned by the SDK
  // This prevents memory accumulation when running multiple agents sequentially (e.g., kosuke build)
  try {
    abortController.abort();
  } catch {
    // Ignore abort errors - cleanup is best-effort
  }

  return result;
}
