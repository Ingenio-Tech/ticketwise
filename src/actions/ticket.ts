// Server-side helpers for processChat. This file is deliberately NOT a
// "use server" module: its exports must never be callable from the browser.
// Only processChat (which checks the member first) calls them.

import {
  getTicket,
  getTicketNotes,
  getTicketConfigurations,
  searchSimilarTickets,
  getConfigurationTickets,
  type CWTicket,
} from "@/lib/connectwise";
import type { TicketContext } from "@/lib/format";

export type { TicketContext };

/**
 * Get full ticket context including notes and configurations.
 */
export async function getTicketContext(ticketId: number): Promise<TicketContext> {
  const [ticket, notes, configurations] = await Promise.all([
    getTicket(ticketId),
    getTicketNotes(ticketId),
    getTicketConfigurations(ticketId),
  ]);

  return { ticket, notes, configurations };
}

/**
 * Search for similar tickets at the same company.
 */
export async function findSimilarCompanyTickets(
  ticketId: number,
  summary: string,
  companyId: number
): Promise<CWTicket[]> {
  return searchSimilarTickets(summary, companyId, ticketId, 90);
}

/**
 * Search for similar tickets across all companies (recent).
 */
export async function findSimilarGlobalTickets(
  ticketId: number,
  summary: string
): Promise<CWTicket[]> {
  return searchSimilarTickets(summary, undefined, ticketId, 14);
}

/**
 * Get ticket history for a configuration.
 */
export async function getConfigTicketHistory(configId: number): Promise<CWTicket[]> {
  return getConfigurationTickets(configId);
}
