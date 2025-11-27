/**
 * Prompt Generator - Generate structured test prompts from tickets
 */

import type { Ticket } from '../types.js';

/**
 * Generate a structured test prompt from a ticket
 */
export function generateTestPrompt(ticket: Ticket): string {
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
