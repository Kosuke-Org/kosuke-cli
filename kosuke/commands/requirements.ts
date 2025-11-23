/**
 * Requirements command - Interactive requirements gathering with Claude AI
 *
 * Strategy: Multi-turn conversation to build comprehensive requirements
 * - User provides product description
 * - Claude analyzes and extracts functionalities
 * - Claude asks clarification questions
 * - User answers questions (iterative until clear)
 * - Generate docs.md with complete requirements
 *
 * Implementation: Uses Anthropic SDK directly with two custom tools:
 * - write_docs: Create new docs.md file
 * - edit_docs: Update existing docs.md file
 */

import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as readline from 'readline';
import { calculateCost } from '../utils/claude-agent.js';

/**
 * Options for programmatic requirements gathering
 */
export interface RequirementsOptions {
  workspaceRoot: string;
  userMessage: string;
  previousMessages?: Anthropic.MessageParam[];
  isFirstRequest?: boolean;
  onStream?: (text: string) => void;
}

/**
 * Result from programmatic requirements gathering
 */
export interface RequirementsResult {
  success: boolean;
  response: string;
  messages: Anthropic.MessageParam[]; // Full message history for session continuity
  docsCreated: boolean;
  docsContent?: string;
  tokenUsage: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  error?: string;
}

/**
 * Session state for interactive mode
 */
interface RequirementsSession {
  productDescription: string;
  messages: Anthropic.MessageParam[];
  isFirstRequest: boolean;
}

/**
 * Tool definitions for docs.md management
 */
const REQUIREMENTS_TOOLS: Anthropic.Tool[] = [
  {
    name: 'write_docs',
    description:
      'Create a new docs.md file with comprehensive product requirements. Use this when creating the initial requirements document.',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            'Full markdown content for docs.md including all sections: Product Description (high-level overview and purpose), Core Functionalities (detailed feature descriptions), and Interface & Design (ASCII wireframes for all major pages/screens with component descriptions and user interactions). Do NOT include technical implementation details like database schemas, API endpoints, or code architecture.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'edit_docs',
    description:
      'Update an existing docs.md file with revised requirements. Use this when making changes to an existing requirements document.',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Full updated markdown content for docs.md with all revisions incorporated.',
        },
      },
      required: ['content'],
    },
  },
];

/**
 * Custom system prompt for requirements gathering
 */
const REQUIREMENTS_SYSTEM_PROMPT = `You are an expert product requirements analyst specializing in web applications.

**YOUR PRIMARY OBJECTIVE:** Create a comprehensive \`docs.md\` file that the user will review before implementation begins. This document must contain ALL requirements needed for developers to build the product.

**Your Workflow:**

1. **Initial Analysis (First User Request)**: When a user describes a product idea, analyze it carefully and present your understanding in this EXACT format:

---
## Product Description
[Brief description of what will be built - the core concept and purpose]

## Core Functionalities
- [Functionality 1]
- [Functionality 2]
- [Functionality 3]
...

## Interface & Design
Present the application structure as visual wireframes using markdown. For each page/screen:

### [Page Name]
\`\`\`
┌──────────────────────────────────────┐
│ Header/Navigation                    │
├──────────────────────────────────────┤
│                                      │
│  [Main Content Area]                 │
│  - Component 1                       │
│  - Component 2                       │
│                                      │
├──────────────────────────────────────┤
│ Footer                               │
└──────────────────────────────────────┘
\`\`\`

**Key Components:**
- Component descriptions
- User interactions
- Data displayed

## Clarification Questions & MVP Recommendations

For each clarification needed, provide BOTH a question AND a recommended approach for MVP:

1. **[Question topic]**
   - Question: [Specific question]
   - 💡 MVP Recommendation: [Simple, practical approach that reduces scope]

2. **[Question topic]**
   - Question: [Specific question]
   - 💡 MVP Recommendation: [Simple, practical approach that reduces scope]

3. **[Question topic]**
   - Question: [Specific question]
   - 💡 MVP Recommendation: [Simple, practical approach that reduces scope]

...

**Quick Response Option:** The user can reply "go for recommendations" or "use recommendations" to accept all MVP recommendations at once.
---

2. **Iterative Refinement**: As the user answers questions:
   - If user says "go for recommendations" or "use recommendations", immediately accept ALL MVP recommendations and proceed to creating docs.md
   - If user provides specific answers, acknowledge them and update your understanding
   - Ask follow-up questions ONLY for remaining ambiguities
   - Always prioritize simplicity and MVP scope
   - Continue the conversation until EVERYTHING is crystal clear

3. **Final Deliverable - docs.md**: Once ALL questions are answered and requirements are 100% clear, use the \`write_docs\` tool to create the \`docs.md\` file. This is the FINAL DELIVERABLE that the user will review before implementation begins.

**docs.md MUST contain:**
   - **Product Description** - High-level description of what will be built, the core concept and purpose
   - **Core Functionalities** - Detailed feature descriptions (what the product should do)
   - **Interface & Design** - ASCII wireframes for ALL major pages/screens with component descriptions and user interactions

**Critical Rules:**
- NEVER start implementation - you only gather requirements
- NEVER create docs.md until ALL clarification questions are answered (or user accepts recommendations)
- ALWAYS provide both questions AND MVP recommendations for each clarification point
- MVP recommendations should simplify scope, reduce complexity, and focus on core features
- If user says "go for recommendations" or similar, immediately accept ALL recommendations and create docs.md
- ALWAYS create comprehensive ASCII wireframes to visualize interfaces
- Focus on WHAT the product should do, not HOW to code it
- Be conversational and help the user think through edge cases
- Bias towards simplicity - this is an MVP, not a full-featured product
- Use the \`write_docs\` tool when creating the initial docs.md file
- Use the \`edit_docs\` tool if you need to update docs.md after user feedback
- The docs.md file is your SUCCESS CRITERIA - make it comprehensive and clear
- NEVER include technical implementation details (database schemas, API endpoints, code architecture, tech stack) in docs.md
- Keep docs.md focused on user-facing features, functionality, and interface design only

**Success = User reviews docs.md and says "Yes, this is exactly what I want to build"**`;

/**
 * Execute a tool call (write or edit docs.md)
 */
function executeToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  workspaceRoot: string
): string {
  const docsPath = join(workspaceRoot, 'docs.md');

  try {
    if (toolName === 'write_docs') {
      const content = toolInput.content as string;
      writeFileSync(docsPath, content, 'utf-8');
      console.log('\n✍️  Created docs.md with comprehensive requirements');
      return 'Successfully created docs.md file';
    } else if (toolName === 'edit_docs') {
      const content = toolInput.content as string;
      writeFileSync(docsPath, content, 'utf-8');
      console.log('\n✏️  Updated docs.md with revised requirements');
      return 'Successfully updated docs.md file';
    } else {
      return `Unknown tool: ${toolName}`;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error writing docs.md';
    console.error(`\n❌ Failed to write docs.md: ${errorMessage}`);
    return `Error: ${errorMessage}`;
  }
}

/**
 * Format token usage for display
 */
function formatTokenUsage(
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  cost: number
): string {
  const breakdown = [];
  if (inputTokens > 0) breakdown.push(`${inputTokens.toLocaleString()} input`);
  if (outputTokens > 0) breakdown.push(`${outputTokens.toLocaleString()} output`);
  if (cacheCreationTokens > 0)
    breakdown.push(`${cacheCreationTokens.toLocaleString()} cache write`);
  if (cacheReadTokens > 0) breakdown.push(`${cacheReadTokens.toLocaleString()} cache read`);

  return `💰 Cost: $${cost.toFixed(4)} (${breakdown.join(' + ')} tokens)`;
}

/**
 * Process a single Claude interaction with streaming support
 */
async function processClaudeInteraction(
  userInput: string,
  previousMessages: Anthropic.MessageParam[],
  workspaceRoot: string,
  onStream?: (text: string) => void
): Promise<{
  response: string;
  messages: Anthropic.MessageParam[];
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}> {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  // Build message history: previous messages + new user message
  const messages: Anthropic.MessageParam[] = [
    ...previousMessages,
    {
      role: 'user',
      content: userInput,
    },
  ];

  // Stream the response
  const stream = await anthropic.messages.stream({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8096,
    system: REQUIREMENTS_SYSTEM_PROMPT,
    tools: REQUIREMENTS_TOOLS,
    messages,
  });

  let responseText = '';
  const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  let isFirstOutput = true;

  // Process stream events
  for await (const event of stream) {
    if (event.type === 'content_block_start') {
      if (event.content_block.type === 'text') {
        if (isFirstOutput) {
          if (!onStream) {
            process.stdout.write('\n> Claude:\n');
          }
          isFirstOutput = false;
        }
      }
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        const delta = event.delta.text;
        responseText += delta;

        // Stream to console or callback
        if (onStream) {
          onStream(delta);
        } else {
          process.stdout.write(delta);
        }
      }
    } else if (event.type === 'content_block_stop') {
      // Content block finished
    }
  }

  // Get final message from stream
  const finalMessage = await stream.finalMessage();

  // Extract tool uses from the response
  for (const block of finalMessage.content) {
    if (block.type === 'tool_use') {
      toolUses.push({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    }
  }

  // Execute tools and build tool result messages
  const hasToolCalls = toolUses.length > 0;
  let updatedMessages = messages;

  if (hasToolCalls) {
    // Add assistant message with tool uses
    updatedMessages = [
      ...messages,
      {
        role: 'assistant',
        content: finalMessage.content,
      },
    ];

    // Execute each tool and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = toolUses.map((tool) => {
      const result = executeToolCall(tool.name, tool.input, workspaceRoot);
      return {
        type: 'tool_result',
        tool_use_id: tool.id,
        content: result,
      };
    });

    // Add tool results as user message
    updatedMessages = [
      ...updatedMessages,
      {
        role: 'user',
        content: toolResults,
      },
    ];

    // Continue conversation after tool execution to get final response
    const followupStream = await anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8096,
      system: REQUIREMENTS_SYSTEM_PROMPT,
      tools: REQUIREMENTS_TOOLS,
      messages: updatedMessages,
    });

    let followupText = '';
    for await (const event of followupStream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          const delta = event.delta.text;
          followupText += delta;

          // Stream followup response
          if (onStream) {
            onStream(delta);
          } else {
            process.stdout.write(delta);
          }
        }
      }
    }

    const followupMessage = await followupStream.finalMessage();

    // Update response and messages
    responseText += '\n' + followupText;
    updatedMessages = [
      ...updatedMessages,
      {
        role: 'assistant',
        content: followupMessage.content,
      },
    ];

    // Combine token usage from both calls
    const finalUsage = finalMessage.usage as unknown as {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    const followupUsage = followupMessage.usage as unknown as {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };

    const combinedUsage = {
      input_tokens: finalUsage.input_tokens + followupUsage.input_tokens,
      output_tokens: finalUsage.output_tokens + followupUsage.output_tokens,
      cache_creation_input_tokens:
        (finalUsage.cache_creation_input_tokens || 0) +
        (followupUsage.cache_creation_input_tokens || 0),
      cache_read_input_tokens:
        (finalUsage.cache_read_input_tokens || 0) + (followupUsage.cache_read_input_tokens || 0),
    };

    return {
      response: responseText,
      messages: updatedMessages,
      inputTokens: combinedUsage.input_tokens,
      outputTokens: combinedUsage.output_tokens,
      cacheCreationTokens: combinedUsage.cache_creation_input_tokens,
      cacheReadTokens: combinedUsage.cache_read_input_tokens,
    };
  } else {
    // No tool calls - just add assistant response to messages
    updatedMessages = [
      ...messages,
      {
        role: 'assistant',
        content: finalMessage.content,
      },
    ];

    const usage = finalMessage.usage as unknown as {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };

    return {
      response: responseText,
      messages: updatedMessages,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
    };
  }
}

/**
 * Core requirements gathering function for programmatic use
 * This is the non-interactive API that can be used by kosuke-core
 */
export async function requirementsCore(options: RequirementsOptions): Promise<RequirementsResult> {
  const {
    workspaceRoot,
    userMessage,
    previousMessages = [],
    isFirstRequest = false,
    onStream,
  } = options;

  try {
    // Validate API key
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    console.log(`📋 [RequirementsCore] Starting query`);
    console.log(`📋 [RequirementsCore] Is first request: ${isFirstRequest}`);
    console.log(`📋 [RequirementsCore] Previous messages: ${previousMessages.length}`);

    // Process interaction
    const result = await processClaudeInteraction(
      userMessage,
      previousMessages,
      workspaceRoot,
      onStream
    );

    // Check if docs.md was created
    let docsCreated = false;
    let docsContent: string | undefined;
    const docsPath = join(workspaceRoot, 'docs.md');

    if (existsSync(docsPath)) {
      docsContent = readFileSync(docsPath, 'utf-8');
      docsCreated = true;
    }

    console.log(`✅ [RequirementsCore] Interaction complete`);
    console.log(`✅ [RequirementsCore] Docs created: ${docsCreated}`);

    return {
      success: true,
      response: result.response,
      messages: result.messages,
      docsCreated,
      docsContent,
      tokenUsage: {
        input: result.inputTokens,
        output: result.outputTokens,
        cacheCreation: result.cacheCreationTokens,
        cacheRead: result.cacheReadTokens,
      },
    };
  } catch (error) {
    return {
      success: false,
      response: '',
      messages: previousMessages,
      docsCreated: false,
      tokenUsage: {
        input: 0,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
      },
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Interactive requirements gathering loop
 */
async function interactiveSession(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║              Kosuke Requirements - Interactive Requirements Tool             ║
╚══════════════════════════════════════════════════════════════════════════════╝
  `);

  console.log('💡 This tool will help you create comprehensive product requirements.\n');
  console.log("📝 I'll analyze your product idea, ask clarification questions,");
  console.log('   and generate a detailed docs.md file.\n');
  console.log('✨ Tip: Press Enter to submit, Shift+Enter for new lines.\n');

  // Set up global Ctrl+C handler for the entire interactive session
  const handleSigInt = () => {
    console.log('\n\n👋 Exiting requirements gathering...\n');
    process.exit(0);
  };
  process.on('SIGINT', handleSigInt);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const session: RequirementsSession = {
    productDescription: '',
    messages: [],
    isFirstRequest: true,
  };

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCost = 0;

  const askQuestion = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      const lines: string[] = [];
      let currentLine = '';
      let escapeBuffer = '';

      console.log('(Press Enter to submit, Shift+Enter for new line, or Ctrl+C to exit)\n');
      process.stdout.write(prompt);

      // Store original stdin state
      const wasRaw = process.stdin.isRaw;

      // Enable raw mode to capture key combinations and disable echo
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }

      // Remove all existing listeners to prevent duplicates
      process.stdin.removeAllListeners('data');

      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      const onData = (key: string) => {
        // Handle escape sequences (for Shift+Enter and other special keys)
        if (escapeBuffer.length > 0 || key === '\x1b') {
          escapeBuffer += key;

          // Check for Shift+Enter sequences
          // Common sequences: \x1b[13;2~ or \x1b\r or \x1bOM
          if (
            escapeBuffer === '\x1b\r' ||
            escapeBuffer === '\x1b\n' ||
            escapeBuffer.match(/\x1b\[13;2~/)
          ) {
            // Shift+Enter - add new line
            lines.push(currentLine);
            currentLine = '';
            process.stdout.write('\n' + ' '.repeat(prompt.length));
            escapeBuffer = '';
            return;
          }

          // If escape sequence is incomplete, wait for more
          if (escapeBuffer.length < 6) {
            return;
          }

          // Unknown escape sequence, ignore it
          escapeBuffer = '';
          return;
        }

        // Ctrl+C
        if (key === '\u0003') {
          cleanup();
          process.exit(0);
        }

        // Ctrl+D (EOF)
        if (key === '\u0004') {
          if (currentLine === '' && lines.length === 0) {
            cleanup();
            resolve('');
            return;
          }
        }

        // Regular Enter key (without Shift) - \r
        if (key === '\r') {
          // Submit the input
          if (currentLine.length > 0) {
            lines.push(currentLine);
          }
          process.stdout.write('\n');
          cleanup();
          resolve(lines.join('\n').trim());
          return;
        }

        // Backspace (127 or \b)
        if (key === '\u007f' || key === '\b' || key === '\x08') {
          if (currentLine.length > 0) {
            currentLine = currentLine.slice(0, -1);
            // Move cursor back, write space, move cursor back again
            process.stdout.write('\b \b');
          }
          return;
        }

        // Tab - insert 2 spaces
        if (key === '\t') {
          currentLine += '  ';
          process.stdout.write('  ');
          return;
        }

        // Ignore other control characters (except printable ones)
        if (key.charCodeAt(0) < 32) {
          return;
        }

        // Regular character
        currentLine += key;
        process.stdout.write(key);
      };

      const cleanup = () => {
        process.stdin.removeListener('data', onData);
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(wasRaw || false);
        }
        process.stdin.pause();
      };

      process.stdin.on('data', onData);
    });
  };

  try {
    // Initial product description
    console.log("🚀 Let's start! Describe the web application you want to build:\n");
    const productDescription = await askQuestion('You: ');

    if (!productDescription) {
      console.log('\n❌ No product description provided. Exiting.');
      rl.close();
      return;
    }

    session.productDescription = productDescription;

    // Main conversation loop
    let continueConversation = true;

    while (continueConversation) {
      console.log('\n🤔 Claude is thinking...\n');

      // Get current user message
      const userMessage =
        session.messages.length === 0
          ? productDescription
          : (session.messages[session.messages.length - 1].content as string);

      // Get Claude's response with streaming
      const result = await processClaudeInteraction(userMessage, session.messages, process.cwd());

      // Update session messages
      session.messages = result.messages;
      session.isFirstRequest = false;

      // Track costs
      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      totalCacheCreationTokens += result.cacheCreationTokens;
      totalCacheReadTokens += result.cacheReadTokens;
      const batchCost = calculateCost(
        result.inputTokens,
        result.outputTokens,
        result.cacheCreationTokens,
        result.cacheReadTokens
      );
      totalCost += batchCost;

      // Display cost information (response already streamed)
      console.log('\n' + '─'.repeat(90));
      console.log(
        formatTokenUsage(
          result.inputTokens,
          result.outputTokens,
          result.cacheCreationTokens,
          result.cacheReadTokens,
          batchCost
        )
      );
      console.log('─'.repeat(90) + '\n');

      // Check if docs.md was created
      const docsPath = join(process.cwd(), 'docs.md');
      if (existsSync(docsPath)) {
        console.log('\n✅ Requirements document created: docs.md');
        console.log('\n' + '═'.repeat(90));
        console.log('📊 Total Session Cost:');
        console.log(
          formatTokenUsage(
            totalInputTokens,
            totalOutputTokens,
            totalCacheCreationTokens,
            totalCacheReadTokens,
            totalCost
          )
        );
        console.log('═'.repeat(90));
        console.log('\n🎉 Requirements gathering complete!\n');
        continueConversation = false;
        break;
      }

      // Ask for user response
      console.log('💬 Your response (type "exit" to quit):\n');
      const userResponse = await askQuestion('You: ');

      if (!userResponse) {
        console.log('\n⚠️  Empty response. Please provide an answer or type "exit".');
        continue;
      }

      if (userResponse.toLowerCase() === 'exit') {
        console.log('\n👋 Exiting requirements gathering.\n');
        console.log('═'.repeat(90));
        console.log('📊 Session Cost:');
        console.log(
          formatTokenUsage(
            totalInputTokens,
            totalOutputTokens,
            totalCacheCreationTokens,
            totalCacheReadTokens,
            totalCost
          )
        );
        console.log('═'.repeat(90) + '\n');
        continueConversation = false;
        break;
      }

      // Add user response to messages
      session.messages = [
        ...session.messages,
        {
          role: 'user',
          content: userResponse,
        },
      ];
    }
  } catch (error) {
    console.error('\n❌ Error during requirements gathering:', error);
    throw error;
  } finally {
    // Clean up signal handler
    process.removeListener('SIGINT', handleSigInt);
    rl.close();
  }
}

/**
 * Main requirements command
 */
export async function requirementsCommand(): Promise<void> {
  try {
    // Validate environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    // Start interactive session
    await interactiveSession();
  } catch (error) {
    console.error('\n❌ Requirements command failed:', error);
    throw error;
  }
}
