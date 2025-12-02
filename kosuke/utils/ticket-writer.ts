/**
 * Shared ticket writing and validation utilities
 *
 * Used by both `plan` and `tickets` commands to ensure consistent
 * ticket structure, validation, and file output.
 */

import { writeFileSync } from 'fs';
import type { Ticket } from '../types.js';
import { runAgent } from './claude-agent.js';

/**
 * Review result structure from validation agent
 */
export interface TicketReviewResult {
  validationIssues: string[];
  fixedTickets: Ticket[];
}

/**
 * Parse tickets from a JSON string or response
 * Validates basic structure and normalizes data
 */
export function parseTickets(response: string): Ticket[] {
  // Extract JSON from response (in case Claude includes extra text)
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('No JSON array found in response');
  }

  const tickets = JSON.parse(jsonMatch[0]) as Ticket[];

  if (!Array.isArray(tickets)) {
    throw new Error(`Expected array of tickets, got ${typeof tickets}`);
  }

  const validTypes = ['schema', 'backend', 'frontend', 'test'];

  for (const ticket of tickets) {
    if (!ticket.id || !ticket.title || !ticket.description) {
      throw new Error(`Invalid ticket structure: ${JSON.stringify(ticket)}`);
    }
    if (!ticket.type || !validTypes.includes(ticket.type)) {
      throw new Error(`Invalid or missing type for ticket ${ticket.id}: ${ticket.type}`);
    }
    if (
      typeof ticket.estimatedEffort !== 'number' ||
      ticket.estimatedEffort < 1 ||
      ticket.estimatedEffort > 10
    ) {
      throw new Error(`Invalid estimatedEffort for ticket ${ticket.id}: ${ticket.estimatedEffort}`);
    }
    if (!ticket.status) {
      ticket.status = 'Todo';
    }
  }

  return tickets;
}

/**
 * Sort tickets by processing order
 */
export function sortTicketsByOrder(tickets: Ticket[]): Ticket[] {
  return [...tickets].sort((a, b) => {
    const getPhaseOrder = (id: string): number => {
      const upper = id.toUpperCase();
      // SCAFFOLD batch first
      if (upper.startsWith('SCAFFOLD-SCHEMA-')) return 1;
      if (upper.startsWith('SCAFFOLD-BACKEND-')) return 2;
      if (upper.startsWith('SCAFFOLD-FRONTEND-')) return 3;
      if (upper.startsWith('SCAFFOLD-WEB-TEST-')) return 4;
      // LOGIC batch second
      if (upper.startsWith('LOGIC-SCHEMA-')) return 5;
      if (upper.startsWith('LOGIC-BACKEND-')) return 6;
      if (upper.startsWith('LOGIC-FRONTEND-')) return 7;
      if (upper.startsWith('LOGIC-WEB-TEST-')) return 8;
      // PLAN batch (from plan command)
      if (upper.startsWith('PLAN-SCHEMA-')) return 10;
      if (upper.startsWith('PLAN-BACKEND-')) return 11;
      if (upper.startsWith('PLAN-FRONTEND-')) return 12;
      if (upper.startsWith('PLAN-WEB-TEST-')) return 13;
      return 14;
    };
    return getPhaseOrder(a.id) - getPhaseOrder(b.id);
  });
}

/**
 * Build the review/fix prompt for ticket validation
 */
function buildReviewPrompt(tickets: Ticket[]): string {
  return `You are a ticket validation and correction expert.

**Generated Tickets to Review:**
${JSON.stringify(tickets, null, 2)}

**Your Task: VALIDATE AND FIX the tickets according to these rules:**

**RULE 1: ONE Schema Ticket Per Batch**
- Each batch (SCAFFOLD, LOGIC, or simple SCHEMA) should have at most ONE schema ticket
- If multiple schema tickets exist, merge them into one
- ❌ WRONG: SCHEMA-1, SCHEMA-2, SCHEMA-3
- ✅ CORRECT: SCHEMA-1 (combines ALL schemas)

**RULE 2: Feature-by-Feature Ordering**
Each feature should follow this pattern when possible:
1. Backend ticket
2. Frontend ticket  
3. Test ticket (if applicable)

**RULE 3: Sequential Numbering**
- Ensure ticket IDs are numbered sequentially
- Example: BACKEND-1, BACKEND-2 (not BACKEND-1, BACKEND-5)

**RULE 4: Test Tickets Must Include Credentials**
- Every WEB-TEST ticket should include test user credentials if available
- Format: "**Test User Credentials:**\\n- Email: user+kosuke_test@example.com\\n- OTP Code: 424242"

**AUTOMATIC FIXES TO APPLY:**

1. **Combine Schema Tickets** if multiple exist
2. **Reorder Tickets** to follow feature-by-feature pattern
3. **Renumber Ticket IDs** to be sequential
4. **Add placeholder credentials** to test tickets if missing

**OUTPUT FORMAT:**
Return ONLY a valid JSON object with this exact structure:
{
  "validationIssues": [
    "Issue 1 found and fixed",
    "Issue 2 found and fixed"
  ],
  "fixedTickets": [
    { /* all ticket objects in corrected order */ }
  ]
}

**CRITICAL:**
- Return ONLY valid JSON (no markdown, no code blocks)
- fixedTickets array must contain ALL tickets
- Preserve all ticket content (descriptions, effort, category)
- Only fix structure, ordering, and numbering issues
- If no issues found, return empty validationIssues with original tickets`;
}

/**
 * Validate and fix tickets using Claude
 * Returns fixed tickets and list of issues found
 */
export async function validateAndFixTickets(
  tickets: Ticket[],
  projectPath: string
): Promise<TicketReviewResult> {
  console.log(`\n${'─'.repeat(60)}`);
  console.log('🔍 Validating ticket structure...');
  console.log(`${'─'.repeat(60)}\n`);

  const reviewPrompt = buildReviewPrompt(tickets);

  const reviewResult = await runAgent('Validate and fix ticket structure', {
    systemPrompt: reviewPrompt,
    maxTurns: 10,
    verbosity: 'minimal',
    cwd: projectPath,
  });

  try {
    const jsonMatch = reviewResult.response.match(/\{[\s\S]*"fixedTickets"[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No valid review result found');
    }

    const parsed = JSON.parse(jsonMatch[0]) as TicketReviewResult;

    if (!parsed.fixedTickets || !Array.isArray(parsed.fixedTickets)) {
      throw new Error('Invalid review result: fixedTickets must be an array');
    }

    // Validate fixed tickets
    const validTypes = ['schema', 'backend', 'frontend', 'test'];
    for (const ticket of parsed.fixedTickets) {
      if (!ticket.id || !ticket.title || !ticket.description || !ticket.type) {
        throw new Error(`Invalid ticket in review result: ${JSON.stringify(ticket)}`);
      }
      if (!validTypes.includes(ticket.type)) {
        throw new Error(`Invalid type in ticket ${ticket.id}: ${ticket.type}`);
      }
      // Ensure status is set
      if (!ticket.status) {
        ticket.status = 'Todo';
      }
    }

    // Display validation results
    if (parsed.validationIssues.length > 0) {
      console.log('🔧 Issues found and fixed:');
      parsed.validationIssues.forEach((issue, idx) => {
        console.log(`   ${idx + 1}. ${issue}`);
      });
      console.log('');
    } else {
      console.log('✅ No validation issues - tickets are correctly structured\n');
    }

    return parsed;
  } catch (error) {
    // If validation fails, return original tickets with warning
    console.warn('⚠️  Ticket validation failed, using original tickets');
    console.warn(`   Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return {
      validationIssues: [],
      fixedTickets: tickets,
    };
  }
}

/**
 * Write tickets to a JSON file
 */
export function writeTicketsFile(outputPath: string, tickets: Ticket[]): void {
  const outputData = {
    generatedAt: new Date().toISOString(),
    totalTickets: tickets.length,
    tickets,
  };

  writeFileSync(outputPath, JSON.stringify(outputData, null, 2), 'utf-8');
}

/**
 * Display tickets summary to console
 */
export function displayTicketsSummary(tickets: Ticket[]): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log('📋 Tickets Created');
  console.log(`${'='.repeat(60)}\n`);

  for (const ticket of tickets) {
    const emoji =
      ticket.type === 'schema'
        ? '🗄️'
        : ticket.type === 'backend'
          ? '⚙️'
          : ticket.type === 'frontend'
            ? '🎨'
            : '🧪';
    console.log(`${emoji} ${ticket.id}: ${ticket.title}`);
    console.log(`   Type: ${ticket.type} | Effort: ${ticket.estimatedEffort}/10`);
    if (ticket.category) {
      console.log(`   Category: ${ticket.category}`);
    }
    console.log('');
  }

  console.log(`${'='.repeat(60)}`);
  console.log(`✅ Total: ${tickets.length} ticket(s)`);
  console.log(`${'='.repeat(60)}\n`);
}

/**
 * Full pipeline: parse, validate, sort, and write tickets
 * Used by both plan.ts and tickets.ts
 */
export async function processAndWriteTickets(
  rawTickets: Ticket[],
  outputPath: string,
  projectPath: string,
  options: { skipValidation?: boolean; displaySummary?: boolean } = {}
): Promise<{ tickets: Ticket[]; validationIssues: string[] }> {
  const { skipValidation = false, displaySummary = true } = options;

  let finalTickets = sortTicketsByOrder(rawTickets);
  let validationIssues: string[] = [];

  // Run validation unless skipped
  if (!skipValidation) {
    const reviewResult = await validateAndFixTickets(finalTickets, projectPath);
    finalTickets = reviewResult.fixedTickets;
    validationIssues = reviewResult.validationIssues;
  }

  // Display summary
  if (displaySummary) {
    displayTicketsSummary(finalTickets);
  }

  // Write to file
  writeTicketsFile(outputPath, finalTickets);
  console.log(`💾 Saved to: ${outputPath}\n`);

  return { tickets: finalTickets, validationIssues };
}
