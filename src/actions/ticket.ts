// Server-side helpers for processChat. This file is deliberately NOT a
// "use server" module: its exports must never be callable from the browser.
// Only processChat (which checks the member first) calls them, passing the
// member session requireMember() returned, so every ConnectWise call runs as
// that member.

import {
  getTicket,
  getTicketNotes,
  getTicketConfigurations,
  searchSimilarTickets,
  getConfigurationTickets,
  CwForbiddenError,
  type CWTicket,
  type CWConfiguration,
} from "@/lib/connectwise";
import { formatSimilarTickets, type TicketContext } from "@/lib/format";
import { AuthError, type MemberSession } from "@/lib/session";

export type { TicketContext };

export const CONFIG_HIDDEN_TEXT =
  "Unable to fetch configuration history: the member's ConnectWise security role does not allow reading this ticket's configurations.";

/** null when the member's role does not allow the call; any other error is passed up. */
async function unlessForbidden<T>(call: Promise<T[]>): Promise<T[] | null> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof CwForbiddenError) return null;
    throw err;
  }
}

/**
 * Get full ticket context including notes and configurations.
 *
 * The ticket itself is required: a 403 on it stops the request. Notes and
 * configurations are extras: if the member's role does not allow them, the
 * context leaves them out and says so (hidden), and the chat carries on.
 */
export async function getTicketContext(session: MemberSession, ticketId: number): Promise<TicketContext> {
  const [ticket, notes, configurations] = await Promise.all([
    getTicket(session, ticketId),
    unlessForbidden(getTicketNotes(session, ticketId)),
    unlessForbidden(getTicketConfigurations(session, ticketId)),
  ]);

  const hidden: NonNullable<TicketContext["hidden"]> = [];
  if (notes === null) hidden.push("notes");
  if (configurations === null) hidden.push("configurations");

  return { ticket, notes: notes ?? [], configurations: configurations ?? [], hidden };
}

/**
 * Search for similar tickets at the same company.
 */
export async function findSimilarCompanyTickets(
  session: MemberSession,
  ticketId: number,
  summary: string,
  companyId: number
): Promise<CWTicket[]> {
  return searchSimilarTickets(session, summary, companyId, ticketId, 90);
}

/**
 * Search for similar tickets across all companies (recent).
 */
export async function findSimilarGlobalTickets(
  session: MemberSession,
  ticketId: number,
  summary: string
): Promise<CWTicket[]> {
  return searchSimilarTickets(session, summary, undefined, ticketId, 14);
}

/**
 * Get ticket history for a configuration.
 */
export async function getConfigTicketHistory(session: MemberSession, configId: number): Promise<CWTicket[]> {
  return getConfigurationTickets(session, configId);
}

/**
 * Configuration history text for the /config prompt. Uses the Report API, so
 * a member whose role lacks report rights gets the "Unable to fetch
 * configuration history" text rather than an error. An expired session
 * (AuthError) is passed up so the pod re-authenticates.
 */
export async function getConfigHistoryText(
  session: MemberSession,
  configurations: CWConfiguration[],
  ticketId: number,
  configurationsHidden = false
): Promise<string> {
  if (configurationsHidden) {
    return CONFIG_HIDDEN_TEXT;
  }
  if (configurations.length === 0) {
    return "No configurations/devices are attached to this ticket.";
  }

  try {
    const configTickets: CWTicket[] = [];
    const configNames: string[] = [];
    let failed = 0;

    for (const config of configurations.slice(0, 3)) {
      configNames.push(config.name || `Config #${config.id}`);
      try {
        const history = await getConfigTicketHistory(session, config.id);
        configTickets.push(...history.filter(t => t.id !== ticketId));
      } catch (err) {
        // A refused or expired session applies to every config, so stop.
        if (err instanceof AuthError || err instanceof CwForbiddenError) throw err;
        // Skip this config if we can't fetch its history
        failed++;
        console.error(`Failed to fetch history for config ${Number(config.id) || "?"}:`, err);
      }
    }

    if (configTickets.length > 0) {
      return formatSimilarTickets(configTickets);
    }
    // Every lookup failed: say so rather than claiming there is no history.
    if (failed > 0 && failed === Math.min(configurations.length, 3)) {
      return "Unable to fetch configuration history due to an error.";
    }
    // Configs exist but no historical tickets found - tell AI
    return `No historical tickets found mentioning these configurations: ${configNames.join(", ")}. This may be a new device or the configuration name doesn't typically appear in ticket summaries.`;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    console.error("Failed to fetch config history:", err);
    // Continue without config history - AI will work with current ticket only
    if (err instanceof CwForbiddenError) {
      return "Unable to fetch configuration history: the member's ConnectWise security role does not allow Report API access.";
    }
    return "Unable to fetch configuration history due to an error.";
  }
}
