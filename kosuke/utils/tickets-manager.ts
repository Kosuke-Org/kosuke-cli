/**
 * Tickets file management utilities
 *
 * Handles loading, saving, and updating tickets from tickets.json
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { Ticket } from '../types.js';

export interface TicketsFile {
  generatedAt: string;
  totalTickets: number;
  tickets: Ticket[];
}

/**
 * Load tickets from file
 */
export function loadTicketsFile(ticketsPath: string): TicketsFile {
  if (!existsSync(ticketsPath)) {
    throw new Error(
      `Tickets file not found: ${ticketsPath}\n` +
        `Please generate tickets first using: kosuke tickets`
    );
  }

  try {
    const content = readFileSync(ticketsPath, 'utf-8');
    return JSON.parse(content) as TicketsFile;
  } catch (error) {
    throw new Error(
      `Failed to parse tickets file: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Save tickets to file
 */
export function saveTicketsFile(ticketsPath: string, ticketsData: TicketsFile): void {
  writeFileSync(ticketsPath, JSON.stringify(ticketsData, null, 2), 'utf-8');
}

/**
 * Find ticket by ID
 */
function findTicket(ticketsData: TicketsFile, ticketId: string): Ticket | undefined {
  return ticketsData.tickets.find((t) => t.id === ticketId);
}

/**
 * Update ticket status in file
 */
export function updateTicketStatus(
  ticketsPath: string,
  ticketId: string,
  status: Ticket['status'],
  error?: string
): void {
  const ticketsData = loadTicketsFile(ticketsPath);
  const ticket = findTicket(ticketsData, ticketId);

  if (!ticket) {
    console.warn(`⚠️  Ticket ${ticketId} not found, skipping status update`);
    return;
  }

  ticket.status = status;
  if (error) {
    ticket.error = error;
  } else {
    delete ticket.error;
  }

  saveTicketsFile(ticketsPath, ticketsData);
}
