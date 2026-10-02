import OpenRouterClient from "openai";
import { env } from "./env";

const llmClient = new OpenRouterClient({
  baseURL: env.OPENROUTER_BASE_URL,
  apiKey: env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "https://github.com/Ingenio-Tech/ticketwise",
    "X-Title": "TicketWise",
  },
});

// ============ System Prompts ============

const SYSTEM_PROMPT = `You are TicketWise, an AI assistant for IT service desk technicians using ConnectWise PSA.

Your role is to help technicians work more efficiently by:
- Summarising tickets clearly and concisely
- Suggesting troubleshooting steps and solutions
- Identifying patterns from similar past tickets
- Highlighting important details they might miss
- Recommending next actions

CRITICAL RULES:
- ONLY use information explicitly stated in the ticket data provided.
- NEVER invent technician names, dates, steps taken, or details not in the data.
- If information is missing or unclear, say "Not stated in ticket" or "Unknown".
- Quote specific notes/entries when referencing what was tried or discussed.
- If asked about something not in the ticket, clearly state the information is not available.

Guidelines:
- Be concise but thorough. Technicians are busy.
- Use bullet points and clear structure.
- When suggesting solutions, prioritise quick wins first.
- Reference specific details from ticket NOTES, not just the summary.
- Consider the full conversation history in the notes.
- Use British English spelling (e.g. colour, prioritise, organisation).

Format your responses in Markdown for readability.`;

// ============ Slash Command Prompts ============

export const SLASH_COMMANDS: Record<string, { description: string; prompt: string }> = {
  "/summary": {
    description: "Summarise this ticket",
    prompt: `Provide a clear, concise summary of this ticket.

For CLOSED/RESOLVED tickets, use this format:
**Issue:** [One-line description of the problem]
**Resolution:** [THE SPECIFIC ACTION that fixed it - dig through the notes to find exactly what worked]
**Details:** [Brief context if needed]

For OPEN tickets, use this format:
**Issue:** [One-line description of the problem]
**Tried so far:** [Bullet list of steps taken]
**Current status:** [Where things stand]
**Blockers:** [What's preventing progress, if any]

IMPORTANT: For closed tickets, the resolution is often buried in the notes, not marked as a "resolution". Look for phrases like "fixed it", "resolved", "that worked", "sorted", or the last technical action before the customer confirmed it was working.`,
  },
  "/suggest": {
    description: "Suggest troubleshooting steps",
    prompt: "Based on this ticket, suggest the most likely troubleshooting steps to resolve the issue. Prioritise quick wins and common solutions first. Consider what's already been tried.",
  },
  "/next": {
    description: "Recommend next steps",
    prompt: "What should the technician do next with this ticket? Consider: urgency, what's pending, who needs to be contacted, and any escalation needs.",
  },
  "/similar": {
    description: "Find similar resolved tickets",
    prompt: `You are helping a technician find similar past tickets to avoid reinventing the wheel.

TASK: Review the similar tickets provided and identify ONLY those that are genuinely relevant to the current issue.

RESPONSE FORMAT:
If you find relevant matches, respond with:

**Similar Tickets Found:**
- **#[ID]** - [Brief issue] → [How it was resolved]
- **#[ID]** - [Brief issue] → [How it was resolved]

**Recommendation:** [What the tech should try based on these]

If this appears to be a TREND (same issue recurring), note: "⚠️ Trend detected - [details]"

If NO tickets are genuinely similar, respond ONLY with:
"No similar tickets found for this specific issue."

RULES:
- ONLY include tickets where the issue genuinely matches
- Do NOT list tickets just because they share a keyword
- Focus on CLOSED/RESOLVED tickets that show what worked
- Be concise - ticket number, brief problem, brief solution
- If configuration data suggests a known hardware issue (e.g. specific laptop model), mention it`,
  },
  "/config": {
    description: "Analyse configuration history",
    prompt: `Analyse the ticket history for the attached configuration/device.

IF historical tickets are provided:
- List recurring issues (brief)
- Note any patterns
- Highlight solutions that worked before
- Flag underlying problems

IF NO historical tickets found:
Reply ONLY with: "No ticket history found for this configuration."
Do NOT analyse the current ticket - that's what /summary is for.

Keep response under 200 words.`,
  },
  "/draft": {
    description: "Draft a customer response",
    prompt: "Draft a professional, friendly response to send to the customer. Acknowledge their issue, explain what's being done or next steps, and set appropriate expectations.",
  },
  "/escalate": {
    description: "Prepare escalation notes",
    prompt: "Prepare concise escalation notes for this ticket. Include: issue summary, what's been tried, current findings, and specific questions for the escalation team.",
  },
  "/5whys": {
    description: "Root cause analysis (5 Whys)",
    prompt: `Perform a 5 Whys root cause analysis on this ticket to identify the underlying cause of the issue.

Structure your analysis as follows:

**Problem Statement:** Clearly state the problem from the ticket.

**The 5 Whys:**
1. **Why did [problem] occur?** → [Answer based on ticket evidence]
2. **Why did [answer 1] happen?** → [Answer based on ticket evidence or logical inference]
3. **Why did [answer 2] happen?** → [Continue drilling down]
4. **Why did [answer 3] happen?** → [Continue drilling down]
5. **Why did [answer 4] happen?** → [Root cause identified]

**Root Cause:** State the identified root cause clearly.

**Recommendations:** Based on this analysis, suggest:
- Immediate fix for this ticket
- Preventive measures to stop recurrence
- Any process/training improvements

IMPORTANT: Only use information from the ticket. Where you must infer or make assumptions, clearly state "Possible cause (not confirmed):" and explain your reasoning. If there isn't enough information to complete all 5 levels, stop where the evidence ends and note what additional investigation is needed.`,
  },
};

// ============ Chat Functions ============

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatOptions {
  ticketContext: string;
  similarTickets?: string;
  configHistory?: string;
  slashCommand?: string;
}

export async function chat(
  messages: ChatMessage[],
  options: ChatOptions
): Promise<string> {
  // Build context message
  let contextMessage = `# Current Ticket\n\n${options.ticketContext}`;
  
  if (options.similarTickets) {
    contextMessage += `\n\n# Similar Tickets\n\n${options.similarTickets}`;
  }
  
  if (options.configHistory) {
    contextMessage += `\n\n# Configuration History\n\n${options.configHistory}`;
  }

  // Build messages array
  const apiMessages: import("openai/resources/chat/completions").ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: contextMessage },
  ];

  // Add conversation history
  for (const msg of messages) {
    // If there's a slash command, inject its prompt
    if (msg.role === "user" && options.slashCommand && msg === messages[messages.length - 1]) {
      const command = SLASH_COMMANDS[options.slashCommand];
      if (command) {
        apiMessages.push({
          role: "user",
          content: `${command.prompt}\n\nUser query: ${msg.content || "(no additional context)"}`,
        });
        continue;
      }
    }
    
    apiMessages.push({
      role: msg.role,
      content: msg.content,
    });
  }

  const completion = await llmClient.chat.completions.create({
    model: env.OPENROUTER_MODEL,
    messages: apiMessages,
    temperature: 0.3,
    max_completion_tokens: 4096,
  });

  // Reasoning models (e.g. kimi-k2.5) spend most completion tokens on internal
  // reasoning, which can leave content empty on complex prompts like /5whys.
  const content = completion.choices[0]?.message?.content;
  if (content) return content;

  console.error("Empty AI content. Finish reason:", completion.choices[0]?.finish_reason,
    "Usage:", JSON.stringify(completion.usage));
  return "I couldn't generate a response — the model may have run out of tokens. Please try again.";
}

/**
 * Stream chat response for real-time display.
 */
export async function* chatStream(
  messages: ChatMessage[],
  options: ChatOptions
): AsyncGenerator<string> {
  // Build context message
  let contextMessage = `# Current Ticket\n\n${options.ticketContext}`;

  if (options.similarTickets) {
    contextMessage += `\n\n# Similar Tickets\n\n${options.similarTickets}`;
  }

  if (options.configHistory) {
    contextMessage += `\n\n# Configuration History\n\n${options.configHistory}`;
  }

  // Build messages array
  const apiMessages: import("openai/resources/chat/completions").ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: contextMessage },
  ];

  // Add conversation history
  for (const msg of messages) {
    if (msg.role === "user" && options.slashCommand && msg === messages[messages.length - 1]) {
      const command = SLASH_COMMANDS[options.slashCommand];
      if (command) {
        apiMessages.push({
          role: "user",
          content: `${command.prompt}\n\nUser query: ${msg.content || "(no additional context)"}`,
        });
        continue;
      }
    }

    apiMessages.push({
      role: msg.role,
      content: msg.content,
    });
  }

  const stream = await llmClient.chat.completions.create({
    model: env.OPENROUTER_MODEL,
    messages: apiMessages,
    temperature: 0.3,
    max_completion_tokens: 4096,
    stream: true,
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      yield content;
    }
  }
}
