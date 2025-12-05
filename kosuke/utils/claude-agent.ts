/**
 * Claude Agent - Centralized Claude SDK integration
 *
 * Provides unified agent initialization, execution, logging, and cost tracking
 * for all commands that use Claude Code Agent SDK.
 */

import {
  query,
  type Query,
  type Options,
  type PermissionMode,
  type SettingSource,
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
 * Claude SDK message structure (subset of properties we use)
 */
export interface ClaudeMessage {
  session_id?: string;
  type?: string;
  subtype?: string;
  text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  [key: string]: unknown; // Allow other properties
}

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
  allowedTools?: string[]; // Whitelist of allowed tool names (if set, all other tools blocked)
  disallowedTools?: string[]; // Blacklist of disallowed tool names
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
 * Parsed tool action with structured parameters
 */
export interface ParsedToolAction {
  action: string;
  params: Record<string, unknown>;
}

/**
 * Parse tool usage into structured action and params for streaming/display
 *
 * @param toolName - Name of the tool being used
 * @param toolInput - Input parameters for the tool
 * @returns Structured action and params object
 *
 * @example
 * parseToolAction('Read', { file_path: '/path/to/file.ts' })
 * // Returns: { action: 'Read', params: { path: '/path/to/file.ts' } }
 */
export function parseToolAction(
  toolName: string,
  toolInput: Record<string, unknown>
): ParsedToolAction {
  const params: Record<string, unknown> = {};

  switch (toolName) {
    case 'Read':
      params.path = toolInput.file_path || toolInput.target_file;
      break;

    case 'Grep':
      params.pattern = toolInput.pattern as string;
      if (toolInput.type) params.type = toolInput.type;
      if (toolInput.glob) params.glob = toolInput.glob;
      if (toolInput.path) params.path = toolInput.path;
      break;

    case 'Glob':
      params.pattern = toolInput.glob_pattern || toolInput.pattern;
      if (toolInput.target_directory) params.directory = toolInput.target_directory;
      break;

    case 'LS':
      params.path = toolInput.target_directory;
      break;

    case 'Task':
      {
        const description = toolInput.description as string;
        params.description = description?.substring(0, 100);
        if (toolInput.subagent_type) params.type = toolInput.subagent_type;
      }
      break;

    case 'WebSearch':
      params.query = toolInput.search_term as string;
      break;

    case 'WebFetch':
      {
        const url = toolInput.url as string;
        params.url = url;
        if (url) {
          try {
            params.domain = new URL(url).hostname;
          } catch {
            params.domain = undefined;
          }
        }
      }
      break;

    case 'Edit':
    case 'StrReplace':
    case 'Write':
    case 'Delete':
      params.path = toolInput.file_path || toolInput.path;
      break;

    case 'Bash':
    case 'Shell':
      {
        const command = toolInput.command as string;
        params.command = command?.substring(0, 100);
      }
      break;

    case 'CodebaseSearch':
      params.query = toolInput.query;
      if (toolInput.target_directories) {
        params.directories = toolInput.target_directories;
      }
      break;

    default:
      // For unknown tools, include all input params as fallback
      Object.assign(params, toolInput);
      break;
  }

  return { action: toolName, params };
}

/**
 * Log tool usage
 */
function logToolUsage(toolName: string, toolInput: unknown, filesReferenced: Set<string>): void {
  // Parse tool action using shared utility (handles normalization and params)
  const input =
    toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};

  const parsed = parseToolAction(toolName, input);

  // Skip logging for edit tools - fixCount will handle them
  const editTools = ['Edit', 'StrReplace', 'Write', 'Delete'];
  if (editTools.includes(parsed.action)) {
    return;
  }

  // Track file references for Read operations
  if (parsed.action === 'Read' && parsed.params.path) {
    filesReferenced.add(parsed.params.path as string);
  }

  // Format log output based on tool type
  let logMsg = '';

  switch (parsed.action) {
    case 'Read':
      logMsg = `   📄 Reading ${parsed.params.path || 'file'}`;
      break;

    case 'Grep':
      {
        const pathInfo = parsed.params.path ? ` in ${parsed.params.path}` : '';
        logMsg = `   🔍 Searching: ${parsed.params.pattern}${pathInfo}`;
      }
      break;

    case 'Glob':
      {
        const dirInfo = parsed.params.directory ? ` in ${parsed.params.directory}` : '';
        logMsg = `   📁 Finding: ${parsed.params.pattern}${dirInfo}`;
      }
      break;

    case 'LS':
      logMsg = `   📂 Listing: ${parsed.params.path || 'directory'}`;
      break;

    case 'Task':
      {
        const taskType = parsed.params.type || 'Task';
        logMsg = `   🤖 ${taskType}: ${parsed.params.description || ''}`;
      }
      break;

    case 'WebSearch':
      logMsg = `   🌐 Search: ${parsed.params.query}`;
      break;

    case 'WebFetch':
      logMsg = `   🌐 Fetching: ${parsed.params.domain || parsed.params.url}`;
      break;

    case 'Bash':
    case 'Shell':
      {
        const cmd = parsed.params.command as string;
        const displayCmd = cmd?.length > 60 ? cmd.substring(0, 57) + '...' : cmd;
        logMsg = `   💻 Running: ${displayCmd}`;
      }
      break;

    case 'CodebaseSearch':
      {
        const dirInfo =
          parsed.params.directories && Array.isArray(parsed.params.directories)
            ? ` in ${(parsed.params.directories as string[]).join(', ')}`
            : '';
        logMsg = `   🔎 Codebase search: ${parsed.params.query || 'query'}${dirInfo}`;
      }
      break;

    default:
      // Fallback: show full tool info for unknown tools
      const args = formatToolArgs(toolInput);
      logMsg = `   🔧 ${parsed.action}(${args})`;
      break;
  }

  console.log(logMsg);
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
 * Create Claude agent stream (thin wrapper around SDK query)
 * Returns raw Query (AsyncIterable) for direct stream consumption
 * Creates AbortController internally - stream lifecycle manages cleanup
 */
export function runAgentStream(prompt: string, config: AgentConfig): Query {
  const {
    systemPrompt,
    maxTurns = 20,
    model = 'claude-sonnet-4-5',
    cwd = process.cwd(),
    permissionMode = 'bypassPermissions',
    settingSources = ['project'],
    resume,
    allowedTools,
    disallowedTools,
  } = config;

  // Create AbortController for SDK cleanup
  const abortController = new AbortController();

  const options: Options = {
    model,
    systemPrompt,
    maxTurns,
    cwd,
    permissionMode,
    settingSources,
    abortController,
    ...(resume && { resume }),
    ...(allowedTools && { allowedTools }),
    ...(disallowedTools && { disallowedTools }),
  };

  return query({ prompt, options });
}

/**
 * Run Claude agent with unified configuration and logging
 * Processes stream and returns final result
 */
export async function runAgent(prompt: string, config: AgentConfig): Promise<AgentResult> {
  const {
    verbosity = 'normal',
    captureConversation = false,
    settingSources = ['project'],
    cwd = process.cwd(),
    model = 'claude-sonnet-4-5',
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

  // Get the stream (creates AbortController internally)
  const responseStream = runAgentStream(prompt, config);

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

  // Note: AbortController cleanup is handled by the SDK's stream lifecycle
  // When the stream ends, child processes are automatically terminated

  return result;
}
