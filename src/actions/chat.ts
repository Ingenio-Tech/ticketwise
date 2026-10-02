"use server";

import { z } from "zod";
import { chat, SLASH_COMMANDS, type ChatMessage } from "@/lib/ai";
import {
  getTicketContext,
  findSimilarCompanyTickets,
  findSimilarGlobalTickets,
  getConfigTicketHistory,
} from "./ticket";
import { formatTicketForAI, formatSimilarTickets, formatSimilarTicketsWithNotes } from "@/lib/format";
import type { CWTicket } from "@/lib/connectwise";
import { AuthError, requireMember, type MemberCredentials } from "@/lib/session";

// Simple in-memory rate limiter, keyed on the ConnectWise-verified member.
// In production, consider using Redis for distributed rate limiting.
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 30; // requests per member per window
const GLOBAL_RATE_LIMIT = 120; // requests across all members per window
const RATE_WINDOW = 60 * 1000; // 1 minute
const MAX_TRACKED_MEMBERS = 1000;
let globalWindow = { count: 0, resetTime: 0 };

function checkRateLimit(identifier: string): { allowed: boolean; remaining: number } {
  const now = Date.now();

  if (now > globalWindow.resetTime) {
    globalWindow = { count: 0, resetTime: now + RATE_WINDOW };
  }
  if (globalWindow.count >= GLOBAL_RATE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  // Keep the map bounded: drop expired entries, then the oldest.
  if (rateLimitMap.size > MAX_TRACKED_MEMBERS) {
    for (const [key, value] of rateLimitMap) {
      if (now > value.resetTime) rateLimitMap.delete(key);
    }
    while (rateLimitMap.size > MAX_TRACKED_MEMBERS) {
      const oldest = rateLimitMap.keys().next().value;
      if (oldest === undefined) break;
      rateLimitMap.delete(oldest);
    }
  }

  const entry = rateLimitMap.get(identifier);

  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(identifier, { count: 1, resetTime: now + RATE_WINDOW });
    globalWindow.count++;
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }

  if (entry.count >= RATE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  entry.count++;
  globalWindow.count++;
  return { allowed: true, remaining: RATE_LIMIT - entry.count };
}

// Everything in a Server Action request is attacker-controlled, so check it.
const ChatRequestSchema = z.object({
  ticketId: z.number().int().positive().max(2_147_483_647),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(8000),
      })
    )
    .max(50),
  userMessage: z.string().min(1).max(4000),
});

export interface ChatRequest {
  ticketId: number;
  messages: ChatMessage[];
  userMessage: string;
}

export interface ChatResponse {
  message: string;
  slashCommand?: string;
  error?: "unauthorised" | "invalid" | "rate_limited";
}

/**
 * Detect slash command in user message.
 */
function detectSlashCommand(message: string): { command: string | null; content: string } {
  const trimmed = message.trim();
  
  for (const cmd of Object.keys(SLASH_COMMANDS)) {
    if (trimmed.toLowerCase().startsWith(cmd)) {
      const content = trimmed.slice(cmd.length).trim();
      return { command: cmd, content };
    }
  }
  
  return { command: null, content: message };
}

/**
 * Process a chat message and return AI response.
 */
export async function processChat(request: ChatRequest, auth?: MemberCredentials): Promise<ChatResponse> {
  // 1. Prove the caller is a signed-in ConnectWise member before any
  //    ConnectWise or LLM call.
  let memberId: string;
  try {
    ({ memberId } = await requireMember(auth));
  } catch (err) {
    if (err instanceof AuthError) {
      return {
        message: "Your ConnectWise session could not be verified. Reload the ticket and try again.",
        error: "unauthorised",
      };
    }
    throw err;
  }

  // 2. Rate limit on the verified member.
  const { allowed } = checkRateLimit(memberId.toLowerCase());

  if (!allowed) {
    return {
      message: "Rate limit exceeded. Please wait a moment before sending more messages.",
      slashCommand: undefined,
      error: "rate_limited",
    };
  }

  // 3. Validate the request body.
  const parsed = ChatRequestSchema.safeParse(request);
  if (!parsed.success) {
    return { message: "Invalid request.", error: "invalid" };
  }

  const { ticketId, messages, userMessage } = parsed.data;
  
  // Detect slash command
  const { command, content } = detectSlashCommand(userMessage);
  
  // Get ticket context
  const ticketContext = await getTicketContext(ticketId);
  const ticketText = formatTicketForAI(ticketContext);
  
  // Prepare chat options
  const chatOptions: Parameters<typeof chat>[1] = {
    ticketContext: ticketText,
    slashCommand: command || undefined,
  };
  
  // Add additional context based on slash command
  if (command === "/similar") {
    try {
      // Get similar tickets from same company first (prioritise closed/resolved)
      const companyTickets = await findSimilarCompanyTickets(
        ticketId,
        ticketContext.ticket.summary,
        ticketContext.ticket.company?.id || 0
      );
      
      // If not enough from company, search globally but only recent
      let globalTickets: CWTicket[] = [];
      if (companyTickets.length < 3) {
        globalTickets = await findSimilarGlobalTickets(
          ticketId,
          ticketContext.ticket.summary
        );
      }
      
      const allSimilar = [...companyTickets, ...globalTickets.slice(0, 5 - companyTickets.length)];
      
      // If no similar tickets found, short-circuit with a quick response
      if (allSimilar.length === 0) {
        return {
          message: "No similar tickets found for this specific issue.",
          slashCommand: command,
        };
      }
      
      // For closed/resolved tickets, fetch their notes to find the actual resolution
      // (resolution is often in notes, not the initialResolution field)
      const ticketsWithNotes = await Promise.all(
        allSimilar.slice(0, 5).map(async (ticket) => {
          try {
            const isClosed = ["closed", "resolved", "completed"].some(
              s => ticket.status?.name?.toLowerCase().includes(s)
            );
            // Only fetch notes for closed tickets (they have solutions)
            if (isClosed) {
              const { getTicketNotes } = await import("@/lib/connectwise");
              const notes = await getTicketNotes(ticket.id);
              return { ticket, notes };
            }
            return { ticket, notes: [] };
          } catch (err) {
            // If we can't fetch notes for this ticket, return without notes
            return { ticket, notes: [] };
          }
        })
      );
      
      chatOptions.similarTickets = formatSimilarTicketsWithNotes(ticketsWithNotes);
    } catch (err) {
      console.error("Failed to fetch similar tickets:", err);
      // Continue without similar tickets - AI will respond based on current ticket only
    }
  }
  
  if (command === "/config") {
    // Get config history if configurations are attached
    if (ticketContext.configurations.length > 0) {
      try {
        const configTickets: CWTicket[] = [];
        const configNames: string[] = [];
        
        for (const config of ticketContext.configurations.slice(0, 3)) {
          configNames.push(config.name || `Config #${config.id}`);
          try {
            const history = await getConfigTicketHistory(config.id);
            configTickets.push(...history.filter(t => t.id !== ticketId));
          } catch (err) {
            // Skip this config if we can't fetch its history
            console.error(`Failed to fetch history for config ${config.id}:`, err);
          }
        }
        
        if (configTickets.length > 0) {
          chatOptions.configHistory = formatSimilarTickets(configTickets);
        } else {
          // Configs exist but no historical tickets found - tell AI
          chatOptions.configHistory = `No historical tickets found mentioning these configurations: ${configNames.join(", ")}. This may be a new device or the configuration name doesn't typically appear in ticket summaries.`;
        }
      } catch (err) {
        console.error("Failed to fetch config history:", err);
        // Continue without config history - AI will work with current ticket only
        chatOptions.configHistory = "Unable to fetch configuration history due to an error.";
      }
    } else {
      // No configurations attached - let AI know
      chatOptions.configHistory = "No configurations/devices are attached to this ticket.";
    }
  }
  
  // Build messages array with user's message
  const allMessages: ChatMessage[] = [
    ...messages,
    { role: "user" as const, content: content || userMessage },
  ];
  
  // Get AI response
  const response = await chat(allMessages, chatOptions);
  
  return {
    message: response,
    slashCommand: command || undefined,
  };
}

/**
 * Get available slash commands.
 */
export async function getSlashCommands(auth?: MemberCredentials): Promise<Array<{ command: string; description: string }>> {
  try {
    await requireMember(auth);
  } catch (err) {
    if (err instanceof AuthError) return [];
    throw err;
  }
  return Object.entries(SLASH_COMMANDS).map(([cmd, info]) => ({
    command: cmd,
    description: info.description,
  }));
}
