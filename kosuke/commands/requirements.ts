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
 * Process a single Claude interaction
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

  // Modify the prompt for the first request to enforce planning workflow
  let effectivePrompt = userInput;

  if (isFirstRequest) {
    effectivePrompt = `${userInput}

IMPORTANT INSTRUCTIONS FOR FIRST REQUEST:
This is a web application product implementation request. You MUST follow this workflow:

1. **Analyze the Request**: Understand what product needs to be built
2. **List Core Functionalities**: Present all features in clear bullet points
3. **Define Implementation Plan**: Create a detailed plan with all required components
4. **Ask NUMBERED Clarification Questions**: List any ambiguities or missing requirements with numbers

Format your response as:
---
## Product Analysis
[Brief description of what will be built]

## Core Functionalities
- [Functionality 1]
- [Functionality 2]
- [Functionality 3]
...

## Implementation Plan
[High-level technical approach and architecture]

## Clarification Questions
1. [Question 1]
2. [Question 2]
3. [Question 3]
...

---

WORKFLOW AFTER USER ANSWERS QUESTIONS:
When the user has answered all questions and requirements are clear, create a comprehensive requirements document in docs.md with:
   - Product Overview
   - Core Functionalities (detailed)
   - Technical Architecture
   - User Flows
   - Database Schema
   - API Endpoints
   - Implementation Notes

IMPORTANT: This is an INTERACTIVE conversation. After showing this plan, WAIT for the user's response. The conversation continues - do NOT stop the chat loop.`;
  }

  const options: Options = {
    model: 'claude-sonnet-4-5',
    maxTurns: 20,
    cwd: workspaceRoot,
    permissionMode: 'acceptEdits',
    resume: sessionId || undefined,
    allowedTools: ['Read', 'Write', 'Edit', 'LS', 'Grep', 'Glob', 'WebSearch'],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
    },
  };

  const responseStream = query({ prompt: effectivePrompt, options });

  let responseText = '';
  let newSessionId = sessionId || '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  // Process the async generator
  for await (const message of responseStream) {
    if (message.type === 'user') {
      if (!newSessionId) {
        newSessionId = message.session_id;
      }
    } else if (message.type === 'assistant') {
      const content = message.message.content;
      for (const block of content) {
        if (block.type === 'text') {
          responseText += block.text;
        } else if (block.type === 'tool_use') {
          // Show tool usage
          if (block.name === 'Write' || block.name === 'Edit') {
            const input = block.input as Record<string, unknown>;
            if (input.path === 'docs.md' || (input.path as string)?.includes('docs.md')) {
              console.log('\n✍️  Generating docs.md...');
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
 * Interactive requirements gathering loop
 */
async function interactiveSession(): Promise<void> {
  console.log(`\n${'═'.repeat(63)}`);
  console.log('║     Kosuke Requirements - Interactive Requirements Tool     ║');
  console.log(`${'═'.repeat(63)}\n`);

  console.log('💡 This tool will help you create comprehensive product requirements.\n');
  console.log("📝 I'll analyze your product idea, ask clarification questions,");
  console.log('   and generate a detailed docs.md file.\n');

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
      rl.question(prompt, (answer) => {
        resolve(answer.trim());
      });
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

      // Get Claude's response
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

      // Display Claude's response
      console.log('Claude:\n');
      console.log(result.response);
      console.log('\n' + '─'.repeat(60));
      console.log(
        formatTokenUsage(
          result.inputTokens,
          result.outputTokens,
          result.cacheCreationTokens,
          result.cacheReadTokens,
          batchCost
        )
      );
      console.log('─'.repeat(60) + '\n');

      session.conversationHistory.push(`Claude: ${result.response}`);

      // Check if docs.md was created
      const docsPath = join(process.cwd(), 'docs.md');
      try {
        const fs = await import('fs');
        if (fs.existsSync(docsPath)) {
          console.log('\n✅ Requirements document created: docs.md');
          console.log('\n📊 Total Session Cost:');
          console.log(
            formatTokenUsage(
              totalInputTokens,
              totalOutputTokens,
              totalCacheCreationTokens,
              totalCacheReadTokens,
              totalCost
            )
          );
          console.log('\n🎉 Requirements gathering complete!\n');
          continueConversation = false;
          break;
        }
      } catch {
        // docs.md not yet created, continue conversation
      }

      // Ask for user response
      console.log('💬 Your response (or type "exit" to quit):\n');
      const userResponse = await askQuestion('You: ');

      if (!userResponse) {
        console.log('\n⚠️  Empty response. Please provide an answer or type "exit".');
        continue;
      }

      if (userResponse.toLowerCase() === 'exit') {
        console.log('\n👋 Exiting requirements gathering.\n');
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
