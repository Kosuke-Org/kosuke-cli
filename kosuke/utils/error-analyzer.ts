/**
 * Error Analyzer - Analyze test failures and apply fixes
 *
 * Uses Claude to:
 * - Analyze browser test failures, console errors, and backend logs
 * - Identify root causes
 * - Apply fixes to the codebase
 */

import { runAgent } from './claude-agent.js';
import type { Ticket } from '../types.js';
import type { CollectedLogs } from './log-collector.js';

export interface AnalysisResult {
  rootCause: string;
  fixesApplied: number;
  tokensUsed: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  cost: number;
}

export interface TestFailure {
  testName: string;
  errorMessage: string;
  expected?: string;
  received?: string;
}

/**
 * Analyze browser test failures and apply fixes
 */
export async function analyzeAndFix(
  ticket: Ticket,
  testOutput: string,
  logs: {
    console: string[];
    errors: string[];
  },
  dockerLogs?: CollectedLogs,
  cwd: string = process.cwd()
): Promise<AnalysisResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔍 Analyzing Test Failures`);
  console.log(`${'='.repeat(60)}\n`);

  const systemPrompt = buildAnalysisPrompt(ticket, testOutput, logs, dockerLogs);

  const result = await runAgent(`Analyze and fix test failures for ticket ${ticket.id}`, {
    systemPrompt,
    cwd,
    maxTurns: 30,
    verbosity: 'normal',
  });

  console.log(`\n✨ Analysis complete`);
  console.log(`   🔧 Fixes applied: ${result.fixCount}`);

  return {
    rootCause: result.response,
    fixesApplied: result.fixCount,
    tokensUsed: result.tokensUsed,
    cost: result.cost,
  };
}

/**
 * Build system prompt for error analysis
 */
function buildAnalysisPrompt(
  ticket: Ticket,
  testOutput: string,
  logs: {
    console: string[];
    errors: string[];
  },
  dockerLogs?: CollectedLogs
): string {
  const sections: string[] = [];

  // Ticket context
  sections.push(`You are debugging a failed browser test for a feature implementation.

**Ticket Information:**
- ID: ${ticket.id}
- Title: ${ticket.title}
- Description:
${ticket.description}

**Your Task:**
1. Analyze the test output, console logs, and errors below
2. Identify the root cause of the test failure
3. Apply fixes to resolve the issues
4. Make minimal, targeted changes that align with the ticket requirements`);

  // Test output
  sections.push(`\n**Browser Test Output:**`);
  sections.push(testOutput);

  // Console logs
  if (logs.console.length > 0) {
    sections.push(`\n**Browser Console Logs (${logs.console.length}):**`);
    for (const log of logs.console) {
      sections.push(log);
    }
  }

  // Errors
  if (logs.errors.length > 0) {
    sections.push(`\n**Errors Found (${logs.errors.length}):**`);
    for (const error of logs.errors) {
      sections.push(error);
    }
  }

  // Docker logs (if provided)
  if (dockerLogs?.docker && dockerLogs.docker.length > 0) {
    sections.push(
      `\n**Backend Logs (Docker Compose - last ${dockerLogs.docker.length} entries):**`
    );
    for (const log of dockerLogs.docker) {
      sections.push(`[${log.service}] ${log.message}`);
    }
  }

  // Instructions
  sections.push(`\n**Critical Instructions:**
1. Read the relevant source files in the current workspace
2. Identify the root cause by analyzing:
   - What the test was trying to accomplish
   - What errors occurred in the browser console
   - Any backend errors from Docker logs
   - The current state of the codebase
3. Determine if the issue is:
   - Frontend code (React components, forms, routing, state, UI elements)
   - Backend code (API routes, database, validation, authentication)
   - Configuration (environment variables, API endpoints, CORS)
   - Missing implementation (feature not fully implemented)
4. Apply fixes using search_replace or write tools
5. Focus on the specific feature described in the ticket
6. Ensure fixes are production-ready and follow best practices

**Common Issues to Check:**
- Missing UI elements or incorrect component rendering
- Mismatched field names between frontend and backend
- Missing API route definitions
- Incorrect API endpoint URLs
- Missing form validation
- Async timing issues (missing awaits, race conditions)
- CORS or authentication issues
- Database schema mismatches
- Missing error handling

Begin by exploring the codebase, then identify and fix the root cause.`);

  return sections.join('\n');
}
