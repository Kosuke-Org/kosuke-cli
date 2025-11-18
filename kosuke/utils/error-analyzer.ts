/**
 * Error Analyzer - Analyze test failures and apply fixes
 *
 * Uses Claude to:
 * - Analyze test failures, console errors, network failures, and backend logs
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
 * Analyze test failures and apply fixes
 */
export async function analyzeAndFix(
  ticket: Ticket,
  testFailures: TestFailure[],
  logs: CollectedLogs,
  tracePath: string,
  cwd: string = process.cwd()
): Promise<AnalysisResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔍 Analyzing Test Failures`);
  console.log(`${'='.repeat(60)}\n`);

  const systemPrompt = buildAnalysisPrompt(ticket, testFailures, logs, tracePath);

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
  testFailures: TestFailure[],
  logs: CollectedLogs,
  tracePath: string
): string {
  const sections: string[] = [];

  // Ticket context
  sections.push(`You are debugging failed end-to-end tests for a feature implementation.

**Ticket Information:**
- ID: ${ticket.id}
- Title: ${ticket.title}
- Description:
${ticket.description}

**Your Task:**
1. Analyze the test failures, logs, and errors below
2. Identify the root cause of the failures
3. Apply fixes to resolve the issues
4. Make minimal, targeted changes that align with the ticket requirements`);

  // Test failures
  if (testFailures.length > 0) {
    sections.push(`\n**Test Failures (${testFailures.length}):**`);
    for (const failure of testFailures) {
      sections.push(`\nTest: ${failure.testName}`);
      sections.push(`Error: ${failure.errorMessage}`);
      if (failure.expected) {
        sections.push(`Expected: ${failure.expected}`);
      }
      if (failure.received) {
        sections.push(`Received: ${failure.received}`);
      }
    }
  }

  // Console errors
  if (logs.console.length > 0) {
    sections.push(`\n**Console Errors (${logs.console.length}):**`);
    for (const log of logs.console) {
      const location = log.location ? ` (${log.location})` : '';
      sections.push(`[${log.type.toUpperCase()}]${location} ${log.message}`);
    }
  }

  // Network failures
  if (logs.network.length > 0) {
    sections.push(`\n**Network Failures (${logs.network.length}):**`);
    for (const log of logs.network) {
      sections.push(`\n[${log.method}] ${log.url}`);
      sections.push(`Status: ${log.status} ${log.statusText}`);
      if (log.requestBody) {
        sections.push(`Request: ${log.requestBody.substring(0, 300)}`);
      }
      if (log.responseBody) {
        sections.push(`Response: ${log.responseBody.substring(0, 300)}`);
      }
    }
  }

  // Docker logs
  if (logs.docker.length > 0) {
    sections.push(`\n**Backend Logs (Docker Compose - last ${logs.docker.length} entries):**`);
    for (const log of logs.docker) {
      sections.push(`[${log.service}] ${log.message}`);
    }
  }

  // Trace information
  sections.push(`\n**Playwright Trace:**`);
  sections.push(`Available at: ${tracePath}`);
  sections.push(`(Contains detailed timeline, screenshots, network activity)`);

  // Instructions
  sections.push(`\n**Critical Instructions:**
1. Read the relevant source files in the current workspace
2. Identify the root cause by correlating:
   - Test failures (what the test expected vs what happened)
   - Console errors (frontend runtime issues)
   - Network failures (API/backend issues)
   - Backend logs (server-side errors)
3. Determine if the issue is:
   - Frontend code (React components, forms, routing, state)
   - Backend code (tRPC routes, database, validation)
   - Test code (incorrect selectors, wrong assertions, timing issues)
   - Configuration (environment, API endpoints, CORS)
4. Apply fixes using search_replace or write tools
5. Focus on the specific feature described in the ticket
6. Ensure fixes are production-ready and follow best practices

**Common Issues to Check:**
- Mismatched field names between frontend and backend
- Missing tRPC route definitions
- Incorrect API endpoint URLs
- Missing form validation
- Async timing issues (missing awaits, race conditions)
- Incorrect Playwright selectors (wrong role, text, or ID)
- CORS or authentication issues
- Database schema mismatches

Begin by exploring the codebase, then identify and fix the root cause.`);

  return sections.join('\n');
}
