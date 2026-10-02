import type { CWTicket, CWTicketNote, CWConfiguration } from "./connectwise";

export interface TicketContext {
  ticket: CWTicket;
  notes: CWTicketNote[];
  configurations: CWConfiguration[];
  /** Parts the member's ConnectWise security role does not let them read. */
  hidden?: Array<"notes" | "configurations">;
}

/**
 * Format ticket context as text for AI prompt.
 */
export function formatTicketForAI(context: TicketContext): string {
  const { ticket, notes, configurations, hidden = [] } = context;
  
  let text = `# Ticket #${ticket.id}: ${ticket.summary}\n\n`;
  
  // Ticket metadata
  text += `## Details\n`;
  text += `- **Company:** ${ticket.company?.name || "Unknown"}\n`;
  text += `- **Contact:** ${ticket.contactName || ticket.contact?.name || "Unknown"}\n`;
  text += `- **Board:** ${ticket.board?.name || "Unknown"}\n`;
  text += `- **Status:** ${ticket.status?.name || "Unknown"}\n`;
  text += `- **Priority:** ${ticket.priority?.name || "Unknown"}\n`;
  text += `- **Type:** ${ticket.type?.name || "Unknown"}${ticket.subType ? ` > ${ticket.subType.name}` : ""}\n`;
  text += `- **Assigned To:** ${ticket.resources || ticket.owner?.name || "Unassigned"}\n`;
  text += `- **Created:** ${ticket.dateEntered || "Unknown"}\n`;
  text += `- **Last Updated:** ${ticket.lastUpdated || ticket._info?.lastUpdated || "Unknown"}\n`;
  
  if (ticket.budgetHours) {
    text += `- **Budget Hours:** ${ticket.budgetHours}\n`;
  }
  if (ticket.actualHours) {
    text += `- **Actual Hours:** ${ticket.actualHours}\n`;
  }
  
  // Custom fields
  if (ticket.customFields?.length) {
    text += `\n### Custom Fields\n`;
    for (const field of ticket.customFields) {
      if (field.value) {
        text += `- **${field.caption}:** ${field.value}\n`;
      }
    }
  }
  
  // Initial description from ticket (if present and not empty)
  if (ticket.initialDescription?.trim()) {
    text += `\n## Initial Description (Customer Submitted)\n`;
    text += `${ticket.initialDescription}\n`;
  }
  
  if (ticket.initialInternalAnalysis?.trim()) {
    text += `\n## Initial Internal Analysis\n`;
    text += `${ticket.initialInternalAnalysis}\n`;
  }
  
  // Notes/conversation
  if (notes.length > 0) {
    text += `\n## Ticket Notes (${notes.length})\n\n`;
    
    for (const note of notes) {
      const noteType = note.detailDescriptionFlag ? "Description" :
                       note.internalAnalysisFlag ? "Internal" :
                       note.resolutionFlag ? "Resolution" : "Note";
      const author = note.member?.name || note.contact?.name || note.createdBy || "Unknown";
      const date = note.dateCreated ? new Date(note.dateCreated).toLocaleString() : "";
      
      text += `### ${noteType} by ${author}${date ? ` (${date})` : ""}\n`;
      text += `${note.text || "(empty)"}\n\n`;
    }
  }
  
  // Configurations
  if (configurations.length > 0) {
    text += `\n## Attached Configurations (${configurations.length})\n\n`;
    
    for (const config of configurations) {
      text += `### ${config.name} (${config.type?.name || "Unknown type"})\n`;
      text += `- **Status:** ${config.status?.name || "Unknown"}\n`;
      if (config.serialNumber) text += `- **Serial:** ${config.serialNumber}\n`;
      if (config.modelNumber) text += `- **Model:** ${config.modelNumber}\n`;
      if (config.osType || config.osInfo) text += `- **OS:** ${config.osType || ""} ${config.osInfo || ""}\n`;
      if (config.lastLoginName) text += `- **Last Login:** ${config.lastLoginName}\n`;
      if (config.notes) text += `- **Notes:** ${config.notes}\n`;
      text += `\n`;
    }
  }

  // Say what the member's role hides, so the AI does not report it as empty.
  if (hidden.length > 0) {
    text += `\n## Not Available\n`;
    for (const part of hidden) {
      text += `- The technician's ConnectWise security role does not allow reading this ticket's ${part}.\n`;
    }
  }
  
  return text;
}

/**
 * Format similar tickets for AI context - includes resolution info.
 */
export function formatSimilarTickets(tickets: CWTicket[], includeDescription = false): string {
  if (tickets.length === 0) return "No similar tickets found.";
  
  let text = "";
  for (const ticket of tickets.slice(0, 8)) {
    text += `## Ticket #${ticket.id}: ${ticket.summary}\n`;
    text += `- Status: ${ticket.status?.name || "Unknown"}\n`;
    text += `- Company: ${ticket.company?.name || "Unknown"}\n`;
    text += `- Date: ${ticket.dateEntered || "Unknown"}\n`;
    
    // Include initial description if requested (for better matching)
    if (includeDescription && ticket.initialDescription?.trim()) {
      const desc = ticket.initialDescription.trim().slice(0, 300);
      text += `- Description: ${desc}${ticket.initialDescription.length > 300 ? "..." : ""}\n`;
    }
    
    // Include resolution if available - this is the gold!
    if (ticket.initialResolution?.trim()) {
      const resolution = ticket.initialResolution.trim().slice(0, 500);
      text += `- **Resolution:** ${resolution}${ticket.initialResolution.length > 500 ? "..." : ""}\n`;
    }
    
    text += `\n`;
  }
  return text;
}

/**
 * Format similar tickets WITH their notes for full context.
 * Used when we need to find the actual resolution buried in notes.
 */
export function formatSimilarTicketsWithNotes(
  ticketsWithNotes: Array<{ ticket: CWTicket; notes: CWTicketNote[] }>
): string {
  if (ticketsWithNotes.length === 0) return "No similar tickets found.";
  
  let text = "";
  for (const { ticket, notes } of ticketsWithNotes) {
    text += `## Ticket #${ticket.id}: ${ticket.summary}\n`;
    text += `- Status: ${ticket.status?.name || "Unknown"}\n`;
    text += `- Company: ${ticket.company?.name || "Unknown"}\n`;
    text += `- Date: ${ticket.dateEntered || "Unknown"}\n`;
    
    // Include initial description
    if (ticket.initialDescription?.trim()) {
      const desc = ticket.initialDescription.trim().slice(0, 300);
      text += `- Problem: ${desc}${ticket.initialDescription.length > 300 ? "..." : ""}\n`;
    }
    
    // Include initialResolution if available
    if (ticket.initialResolution?.trim()) {
      text += `- **Resolution Field:** ${ticket.initialResolution.trim().slice(0, 500)}\n`;
    }
    
    // Include ALL notes - the resolution is often buried and tokens are cheaper than tech time
    if (notes.length > 0) {
      text += `\n### All Notes (${notes.length}):\n`;
      
      for (const note of notes.filter(n => n.text?.trim())) {
        const noteType = note.resolutionFlag ? "**RESOLUTION**" :
                         note.internalAnalysisFlag ? "Internal" : "Note";
        const author = note.member?.name || note.createdBy || "Tech";
        const noteText = (note.text || "").trim();
        text += `- [${noteType}] ${author}: ${noteText}\n`;
      }
    }
    
    text += `\n---\n\n`;
  }
  return text;
}
