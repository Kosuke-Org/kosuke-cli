/**
 * Prompt Generator - Generate structured test prompts from tickets
 */

import type { Ticket } from '../types.js';

/**
 * Generate a structured web test prompt from a ticket
 */
export function generateWebTestPrompt(ticket: Ticket): string {
  return `Test the following feature implementation:

**Feature:** ${ticket.title}

**Requirements:**
${ticket.description}

**Testing Instructions:**
1. Navigate to the relevant page(s) for this feature
2. Verify all functionality described in the requirements works correctly
3. Check for any console errors or warnings
4. Confirm the implementation matches the ticket description
5. Test both happy path and edge cases

**Success Criteria:**
- All functionality works as described
- No console errors
- User experience is smooth and intuitive
- Feature behaves correctly in different scenarios

Return a clear success or failure status with details about what was tested and any issues found.`;
}

/**
 * Generate a structured database test prompt from a ticket
 */
export function generateDBTestPrompt(ticket: Ticket): string {
  return `Validate the database schema implementation:

**Ticket:** ${ticket.title}

**Requirements:**
${ticket.description}

**Validation Instructions:**
1. Connect to the database
2. Verify all tables mentioned in requirements exist
3. Check table structure (column names and types)
4. Validate constraints and indexes if specified
5. Ensure no errors or inconsistencies

**Success Criteria:**
- All required tables exist
- Tables have correct structure
- No schema errors or warnings

Return a clear success or failure status with details about what was validated.`;
}
