/**
 * Requirements command - Interactive requirements gathering with Claude AI
 *
 * Strategy: Multi-turn conversation to build comprehensive requirements
 * - User provides product description
 * - Claude analyzes and extracts functionalities
 * - Claude asks clarification questions
 * - User answers questions (iterative until clear)
 * - Generate docs.md with complete requirements
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import * as readline from 'readline';
import { join } from 'path';
import { calculateCost } from '../utils/claude-agent.js';

interface RequirementsSession {
  productDescription: string;
  conversationHistory: string[];
  isFirstRequest: boolean;
}

/**
 * Options for programmatic requirements gathering
 */
export interface RequirementsOptions {
  workspaceRoot: string;
  userMessage: string;
  sessionId?: string | null;
  isFirstRequest?: boolean;
  onStream?: (text: string) => void;
}

/**
 * Result from programmatic requirements gathering
 */
export interface RequirementsResult {
  success: boolean;
  response: string;
  sessionId: string;
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

## Clarification Questions
1. [Question 1 - be specific]
2. [Question 2 - be specific]
3. [Question 3 - be specific]
...
---

2. **Iterative Refinement**: As the user answers questions:
   - Acknowledge their answers
   - Update your understanding based on new information
   - Ask follow-up questions for any remaining ambiguities
   - Continue the conversation until EVERYTHING is crystal clear

3. **Final Deliverable - docs.md**: Once ALL questions are answered and requirements are 100% clear, create the \`docs.md\` file. This is the FINAL DELIVERABLE that the user will review before implementation begins.

**docs.md MUST contain:**
   - **Product Overview** - High-level description and goals
   - **Core Functionalities** - Detailed feature descriptions
   - **Interface & Design** - ASCII wireframes for ALL major pages/screens
   - **Technical Architecture** - Tech stack, folder structure, key libraries
   - **User Flows** - Step-by-step user journeys for key features
   - **Database Schema** - Tables, fields, relationships, data types
   - **API Endpoints** - Routes, methods, request/response formats (if applicable)
   - **Business Logic** - Key algorithms, calculations, rules
   - **Implementation Notes** - Important technical considerations

**Critical Rules:**
- NEVER start implementation - you only gather requirements
- NEVER create docs.md until ALL clarification questions are answered
- ALWAYS ask specific, numbered questions for anything unclear
- ALWAYS create comprehensive ASCII wireframes to visualize interfaces
- Focus on WHAT the product should do, not HOW to code it
- Be conversational and help the user think through edge cases
- The docs.md file is your SUCCESS CRITERIA - make it comprehensive and clear

**Success = User reviews docs.md and says "Yes, this is exactly what I want to build"**`;

/**
 * Build the effective prompt for requirements gathering
 * Just returns the user message - all instructions are in the system prompt
 */
function buildRequirementsPrompt(userMessage: string, _isFirstRequest: boolean): string {
  // System prompt contains all instructions, so just return the user message
  return userMessage;
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
  sessionId: string | null,
  isFirstRequest: boolean
): Promise<{
  response: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}> {
  const workspaceRoot = process.cwd();

  // Build the effective prompt (just returns the user message now)
  const effectivePrompt = buildRequirementsPrompt(userInput, isFirstRequest);

  const options: Options = {
    model: 'claude-sonnet-4-5',
    maxTurns: 20,
    cwd: workspaceRoot,
    permissionMode: 'acceptEdits',
    resume: sessionId || undefined,
    allowedTools: ['Read', 'Write', 'Edit', 'LS', 'Grep', 'Glob', 'WebSearch'],
    systemPrompt: REQUIREMENTS_SYSTEM_PROMPT as string, // SDK accepts string despite TypeScript types
  };

  const responseStream = query({ prompt: effectivePrompt, options });

  let responseText = '';
  let newSessionId = sessionId || '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let isFirstOutput = true;

  // Process the async generator with streaming
  for await (const message of responseStream) {
    if (message.type === 'user') {
      if (!newSessionId) {
        newSessionId = message.session_id;
      }
    } else if (message.type === 'assistant') {
      const content = message.message.content;
      for (const block of content) {
        if (block.type === 'text') {
          // Stream text to console in real-time
          if (block.text) {
            if (isFirstOutput) {
              process.stdout.write('> Claude:\n');
              isFirstOutput = false;
            }
            process.stdout.write(block.text);
          }
          responseText += block.text;
        } else if (block.type === 'tool_use') {
          // Show tool usage
          if (block.name === 'Write' || block.name === 'Edit') {
            const input = block.input as Record<string, unknown>;
            if (input.path === 'docs.md' || (input.path as string)?.includes('docs.md')) {
              console.log('\n\n✍️  Generating docs.md...');
            }
          }
        }
      }
    } else if (message.type === 'result' && message.subtype === 'success') {
      // Track token usage
      if (message.usage) {
        inputTokens += message.usage.input_tokens || 0;
        outputTokens += message.usage.output_tokens || 0;
        cacheCreationTokens += message.usage.cache_creation_input_tokens || 0;
        cacheReadTokens += message.usage.cache_read_input_tokens || 0;
      }
    }
  }

  return {
    response: responseText,
    sessionId: newSessionId,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
  };
}

/**
 * Core requirements gathering function for programmatic use
 * This is the non-interactive API that can be used by kosuke-core
 */
export async function requirementsCore(options: RequirementsOptions): Promise<RequirementsResult> {
  const {
    workspaceRoot,
    userMessage,
    sessionId = null,
    isFirstRequest = false,
    onStream,
  } = options;

  try {
    // Validate API key
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    // Build the prompt (just returns the user message now - system prompt has all instructions)
    const effectivePrompt = buildRequirementsPrompt(userMessage, isFirstRequest);

    // Debug: Log environment details
    console.log('🐛 [requirementsCore] About to call query()');
    console.log('🐛 [requirementsCore] process.env.PATH:', process.env.PATH);
    console.log('🐛 [requirementsCore] process.execPath:', process.execPath);
    console.log('🐛 [requirementsCore] workspaceRoot:', workspaceRoot);

    // Query options with custom requirements gathering system prompt
    const queryOptions: Options = {
      model: 'claude-sonnet-4-5',
      maxTurns: 20,
      cwd: workspaceRoot,
      permissionMode: 'acceptEdits',
      resume: sessionId || undefined,
      allowedTools: ['Read', 'Write', 'Edit', 'LS', 'Grep', 'Glob', 'WebSearch'],
      systemPrompt: REQUIREMENTS_SYSTEM_PROMPT as string, // SDK accepts string despite TypeScript types
      // DON'T pass env - let SDK use its default {...process.env}
      // The issue might be that spreading process.env creates a plain object
      // that loses the prototype chain or some Node.js internals
    };

    console.log('🐛 [requirementsCore] queryOptions:', JSON.stringify(queryOptions, null, 2));

    // Execute query
    console.log('🐛 [requirementsCore] Calling query() now...');
    const responseStream = query({ prompt: effectivePrompt, options: queryOptions });
    console.log('🐛 [requirementsCore] query() returned, starting to process stream...');

    let responseText = '';
    let newSessionId = sessionId || '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    // Process the async generator with streaming
    try {
      for await (const message of responseStream) {
        console.log('🐛 [requirementsCore] Received message type:', message.type);

        if (message.type === 'user') {
          if (!newSessionId) {
            newSessionId = message.session_id;
          }
        } else if (message.type === 'assistant') {
          const content = message.message.content;
          for (const block of content) {
            if (block.type === 'text') {
              // Stream text if callback provided
              if (block.text && onStream) {
                onStream(block.text);
              }
              responseText += block.text;
            }
          }

          // Track token usage
          if (message.message.usage) {
            inputTokens += message.message.usage.input_tokens || 0;
            outputTokens += message.message.usage.output_tokens || 0;
            cacheCreationTokens += message.message.usage.cache_creation_input_tokens || 0;
            cacheReadTokens += message.message.usage.cache_read_input_tokens || 0;
          }
        }
      }
    } catch (streamError) {
      console.error('🐛 [requirementsCore] Error in stream processing:', streamError);
      throw streamError;
    }

    // Check if docs.md was created
    let docsCreated = false;
    let docsContent: string | undefined;
    const docsPath = join(workspaceRoot, 'docs.md');

    try {
      const fs = await import('fs/promises');
      docsContent = await fs.readFile(docsPath, 'utf-8');
      docsCreated = true;
    } catch {
      // docs.md not yet created
      docsCreated = false;
    }

    return {
      success: true,
      response: responseText,
      sessionId: newSessionId,
      docsCreated,
      docsContent,
      tokenUsage: {
        input: inputTokens,
        output: outputTokens,
        cacheCreation: cacheCreationTokens,
        cacheRead: cacheReadTokens,
      },
    };
  } catch (error) {
    return {
      success: false,
      response: '',
      sessionId: sessionId || '',
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
  console.log('✨ Tip: You can write multi-line responses. Press Enter twice to submit.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const session: RequirementsSession = {
    productDescription: '',
    conversationHistory: [],
    isFirstRequest: true,
  };

  let sessionId: string | null = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCost = 0;

  const askQuestion = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      const lines: string[] = [];
      let isFirstLine = true;

      console.log('(Press Enter twice to submit, or Ctrl+D when done)\n');

      const onLine = (line: string) => {
        if (isFirstLine) {
          isFirstLine = false;
          if (line.trim() === '') {
            // Empty first line, ask again
            rl.prompt();
            return;
          }
          lines.push(line);
          rl.prompt();
        } else if (line.trim() === '') {
          // Empty line signals submission
          rl.removeListener('line', onLine);
          rl.removeListener('close', onClose);
          const result = lines.join('\n').trim();
          resolve(result);
        } else {
          lines.push(line);
          rl.prompt();
        }
      };

      const onClose = () => {
        rl.removeListener('line', onLine);
        const result = lines.join('\n').trim();
        if (result) {
          resolve(result);
        } else {
          resolve('');
        }
      };

      rl.on('line', onLine);
      rl.once('close', onClose);
      rl.setPrompt('');
      process.stdout.write(prompt);
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
    session.conversationHistory.push(`User: ${productDescription}`);

    // Main conversation loop
    let continueConversation = true;

    while (continueConversation) {
      console.log('\n🤔 Claude is thinking...\n');

      // Get Claude's response with streaming
      const result = await processClaudeInteraction(
        session.isFirstRequest
          ? productDescription
          : session.conversationHistory[session.conversationHistory.length - 1].replace(
              'User: ',
              ''
            ),
        sessionId,
        session.isFirstRequest
      );

      sessionId = result.sessionId;
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

      session.conversationHistory.push(`Claude: ${result.response}`);

      // Check if docs.md was created
      const docsPath = join(process.cwd(), 'docs.md');
      try {
        const fs = await import('fs');
        if (fs.existsSync(docsPath)) {
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
      } catch {
        // docs.md not yet created, continue conversation
      }

      // Ask for user response
      console.log('💬 Your response (type "exit" to quit, or press Enter twice to submit):\n');
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

      session.conversationHistory.push(`User: ${userResponse}`);
    }
  } catch (error) {
    console.error('\n❌ Error during requirements gathering:', error);
    throw error;
  } finally {
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
