/**
 * GetCode command - Explore GitHub repositories and fetch code implementations
 *
 * This command uses Claude Code Agent to explore any GitHub repository and
 * fetch code implementations based on natural language queries.
 *
 * Usage:
 *   kosuke getcode "owner/repo" "query"          # Explicit repository
 *   kosuke getcode "query"                       # Infer from query
 *   kosuke getcode --template "query"            # Use kosuke-template
 */

import { writeFileSync } from 'fs';
import { resolveRepository } from '../utils/repository-resolver.js';
import { ensureRepoReady } from '../utils/repository-manager.js';
import { runAgent, formatCostBreakdown } from '../utils/claude-agent.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';
import type { GetCodeOptions, CodeExplorationResult } from '../types.js';

/**
 * Parse arguments for getcode command
 * Handles multiple argument patterns:
 *   kosuke getcode "query"
 *   kosuke getcode "owner/repo" "query"
 *   kosuke getcode --template "query"
 */
export function parseGetCodeArgs(args: string[]): GetCodeOptions {
  const flags = {
    template: args.includes('--template') || args.includes('-t'),
    output: args.find((arg) => arg.startsWith('--output='))?.split('=')[1],
  };

  // Remove flags from args to get positional arguments
  const positionalArgs = args.filter(
    (arg) => !arg.startsWith('--') && !arg.startsWith('-') && arg !== 'getcode'
  );

  // Determine repo and query based on number of positional args
  let repo: string | undefined;
  let query: string;

  if (positionalArgs.length === 0) {
    throw new Error(
      'Missing query argument.\n' +
        'Usage:\n' +
        '  kosuke getcode "query"\n' +
        '  kosuke getcode "owner/repo" "query"\n' +
        '  kosuke getcode --template "query"'
    );
  } else if (positionalArgs.length === 1) {
    // Single argument: treat as query
    query = positionalArgs[0];
  } else {
    // Two or more arguments: first is repo, second is query
    repo = positionalArgs[0];
    query = positionalArgs[1];
  }

  return {
    repo,
    query,
    template: flags.template,
    output: flags.output,
  };
}

/**
 * Build system prompt for code exploration
 */
function buildExplorationSystemPrompt(repoName: string, repoPath: string): string {
  return `You are an expert code exploration agent analyzing the repository: ${repoName}

**Your Purpose:**
Users will ask you to find reference implementations they can learn from and adapt for
their own projects. Your job is to provide COMPLETE, USABLE code examples with full context.

**When a user asks about a feature/implementation:**

1. **Locate ALL relevant files** - Find the complete implementation, not just snippets
2. **Show COMPLETE code** - Include entire files or substantial sections, never truncate
3. **Include dependencies** - Show imports, types, configurations, utilities used
4. **Explain architecture** - How components connect, data flow, design patterns
5. **Provide context** - Related files, setup requirements, usage examples

**Response Structure:**

1. **Overview** - What you found and where it's located
2. **Complete Code Snippets** - Full, copy-ready implementations with file paths
3. **Implementation Details** - How it works, key patterns, important decisions
4. **Dependencies & Setup** - Required imports, configurations, related utilities
5. **Usage Examples** - How the feature is actually used in the codebase

**Critical Rules:**
- NEVER truncate code - show complete implementations
- ALWAYS include file paths in code blocks
- ALWAYS show imports and type definitions
- ALWAYS explain what makes this implementation work
- If a feature spans multiple files, show ALL of them
- Include configuration, setup, and initialization code

**Format all code snippets as:**
\`\`\`language
// Complete implementation from: path/to/file.ext
[full code here]
\`\`\`

Your goal: Provide reference implementations so complete that users can understand and
adapt them immediately.

**Repository Details:**
- Name: ${repoName}
- Local Path: ${repoPath}`;
}

/**
 * Core getcode logic (can be used programmatically by other commands)
 */
export async function getCodeCore(options: GetCodeOptions): Promise<CodeExplorationResult> {
  const { repo, query, template = false } = options;

  console.log('🔍 Resolving repository...');

  // Resolve repository (infer if needed)
  const repoIdentifier = await resolveRepository(repo, query, template, process.env.GITHUB_TOKEN);

  console.log(`   ✅ Repository: ${repoIdentifier}\n`);

  // Ensure repository is ready (clone or update)
  console.log('📥 Preparing repository...');
  const repoInfo = await ensureRepoReady(repoIdentifier);

  // Explore code with Claude
  console.log(`🤖 Exploring code with Claude...\n`);

  const systemPrompt = buildExplorationSystemPrompt(repoIdentifier, repoInfo.localPath);

  const agentResult = await runAgent(query, {
    systemPrompt,
    cwd: repoInfo.localPath,
    maxTurns: 20,
    verbosity: 'normal',
  });

  console.log(`\n✅ Exploration complete!\n`);

  return {
    repository: repoIdentifier,
    query,
    response: agentResult.response,
    filesReferenced: Array.from(agentResult.filesReferenced),
    tokensUsed: agentResult.tokensUsed,
    cost: agentResult.cost,
  };
}

/**
 * Format exploration result for display
 */
function formatExplorationResult(result: CodeExplorationResult): string {
  const header = `# Code from ${result.repository}

**Query:** ${result.query}

---

`;

  const footer = `

---

## Token Usage

- **Input:** ${result.tokensUsed.input.toLocaleString()} tokens
- **Output:** ${result.tokensUsed.output.toLocaleString()} tokens${
    result.tokensUsed.cacheCreation > 0
      ? `\n- **Cache Creation:** ${result.tokensUsed.cacheCreation.toLocaleString()} tokens`
      : ''
  }${
    result.tokensUsed.cacheRead > 0
      ? `\n- **Cache Read:** ${result.tokensUsed.cacheRead.toLocaleString()} tokens`
      : ''
  }
- **Cost:** $${result.cost.toFixed(4)}

${result.filesReferenced.length > 0 ? `**Files Referenced:** ${result.filesReferenced.join(', ')}` : ''}
`;

  return header + result.response + footer;
}

/**
 * Main getcode command
 */
export async function getCodeCommand(options: GetCodeOptions): Promise<void> {
  console.log('🚀 Starting Code Exploration...\n');

  // Initialize logging context
  const logContext = logger.createContext('getcode');
  const cleanupHandler = setupCancellationHandler(logContext);

  try {
    // Validate environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    // Execute core logic
    const result = await getCodeCore(options);

    // Track metrics
    logger.trackTokens(logContext, result.tokensUsed);
    logContext.filesModified = result.filesReferenced;

    // Display cost breakdown
    const costBreakdown = formatCostBreakdown({
      cost: result.cost,
      tokensUsed: result.tokensUsed,
      fixCount: 0,
      response: '',
      filesReferenced: new Set(result.filesReferenced),
    });
    console.log(`💰 Cost: ${costBreakdown}\n`);

    // Format and display result
    const formattedOutput = formatExplorationResult(result);

    // Save to file if --output flag is provided
    if (options.output) {
      writeFileSync(options.output, formattedOutput, 'utf-8');
      console.log(`📄 Output saved to: ${options.output}\n`);
    } else {
      // Display to stdout
      console.log('─'.repeat(60));
      console.log(formattedOutput);
      console.log('─'.repeat(60));
    }

    console.log('\n✅ Code exploration completed successfully!');

    // Log successful execution
    await logger.complete(logContext, 'success');
    cleanupHandler();
  } catch (error) {
    console.error('\n❌ Code exploration failed:', error);

    // Log failed execution
    await logger.complete(logContext, 'error', error as Error);
    cleanupHandler();

    throw error;
  }
}
