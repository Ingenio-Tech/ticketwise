"use client";

import { useState, useRef, useEffect } from "react";
import { processChat, getSlashCommands } from "@/actions/chat";
import type { ChatMessage } from "@/lib/ai";
import type { MemberCredentials } from "@/lib/session";
import ReactMarkdown from "react-markdown";

interface ChatProps {
  ticketId: number;
  isAuthenticated: boolean;
  credentials?: MemberCredentials;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  slashCommand?: string;
}

interface SlashCommand {
  command: string;
  description: string;
}

export function Chat({ ticketId, isAuthenticated, credentials }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [showCommands, setShowCommands] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load slash commands (including client-side only commands).
  // The server only returns them once the member is verified.
  useEffect(() => {
    if (!isAuthenticated) return;
    getSlashCommands(credentials).then(serverCommands => {
      // Add client-side only commands
      const clientCommands = [
        { command: "/refresh", description: "Clear chat and start fresh" },
      ];
      setCommands([...clientCommands, ...serverCommands]);
    }).catch(err => console.error("Failed to load slash commands:", err));
  }, [isAuthenticated, credentials]);

  // Auto-scroll to bottom - only when new messages added, not on every render
  const prevMessagesLength = useRef(messages.length);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    // Only scroll if messages were actually added
    if (messages.length > prevMessagesLength.current) {
      // Use requestAnimationFrame to avoid layout thrashing
      requestAnimationFrame(() => {
        // Scroll the container directly instead of scrollIntoView
        // (scrollIntoView can affect parent iframe scroll)
        if (messagesContainerRef.current) {
          messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
        }
      });
    }
    prevMessagesLength.current = messages.length;
  }, [messages.length]);

  // Show commands dropdown when typing /
  useEffect(() => {
    setShowCommands(input.startsWith("/") && input.length > 0);
  }, [input]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!input.trim() || isLoading || !isAuthenticated) return;
    
    let userMessage = input.trim();
    setInput("");
    setError(null);
    setShowCommands(false);
    
    // Handle /refresh locally - clear chat without server call
    if (userMessage.toLowerCase() === "/refresh") {
      setMessages([]);
      return;
    }
    
    // Normalise "/5 whys" to "/5whys"
    if (userMessage.toLowerCase().startsWith("/5 whys")) {
      userMessage = "/5whys" + userMessage.slice(7);
    }
    
    // Add user message
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: userMessage,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMsg]);
    
    setIsLoading(true);
    
    try {
      // Convert messages to API format
      const chatHistory: ChatMessage[] = messages.map(m => ({
        role: m.role,
        content: m.content,
      }));
      
      const response = await processChat({
        ticketId,
        messages: chatHistory,
        userMessage,
      }, credentials);

      if (response.error) {
        setError(response.message);
        return;
      }
      
      // Add assistant message
      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: response.message,
        timestamp: new Date(),
        slashCommand: response.slashCommand,
      };
      setMessages(prev => [...prev, assistantMsg]);
      
    } catch (err) {
      console.error("Chat error:", err);
      setError(err instanceof Error ? err.message : "Failed to get response");
    } finally {
      setIsLoading(false);
    }
  };

  const handleCommandClick = (cmd: string) => {
    setInput(cmd + " ");
    setShowCommands(false);
    inputRef.current?.focus();
  };

  const filteredCommands = commands.filter(c => 
    c.command.toLowerCase().includes(input.toLowerCase())
  );

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Authenticating with ConnectWise...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Messages area */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 text-sm py-8">
            <p className="font-medium mb-2">Welcome to TicketWise</p>
            <p>Ask me anything about this ticket, or try:</p>
            <div className="flex flex-wrap justify-center gap-1 mt-2">
              {commands.slice(0, 4).map(cmd => (
                <button
                  key={cmd.command}
                  onClick={() => handleCommandClick(cmd.command)}
                  className="px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded text-xs transition-colors"
                >
                  {cmd.command}
                </button>
              ))}
            </div>
          </div>
        )}
        
        {messages.map(msg => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 ${
                msg.role === "user"
                  ? "bg-[#222E40] text-white"
                  : "bg-gray-100 text-gray-900"
              }`}
            >
              {msg.slashCommand && (
                <div className="text-xs opacity-60 mb-1">
                  {msg.slashCommand}
                </div>
              )}
              <div id={`msg-${msg.id}`} className={`text-sm prose prose-sm max-w-none ${msg.role === "user" ? "prose-invert" : ""}`}>
                {msg.role === "assistant" ? (
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                ) : (
                  <span>{msg.content}</span>
                )}
              </div>
              {msg.role === "assistant" && (
                <div className="mt-1.5 flex justify-start">
                  <button
                    onClick={(e) => {
                      const btn = e.currentTarget;
                      const el = document.getElementById(`msg-${msg.id}`);
                      if (!el) return;
                      try {
                        // Select the rendered HTML content and copy via execCommand
                        // (navigator.clipboard is blocked in cross-origin iframes)
                        const range = document.createRange();
                        range.selectNodeContents(el);
                        const sel = window.getSelection();
                        if (sel) {
                          sel.removeAllRanges();
                          sel.addRange(range);
                          document.execCommand("copy");
                          sel.removeAllRanges();
                        }
                        btn.textContent = "✓ Copied";
                      } catch {
                        btn.textContent = "✗ Failed";
                      }
                      setTimeout(() => { btn.textContent = "📋 Copy"; }, 1500);
                    }}
                    className="text-xs px-2 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-500 hover:text-gray-700 transition-colors cursor-pointer"
                  >
                    📋 Copy
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-lg px-3 py-2">
              <div className="flex space-x-1">
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:0.2s]" />
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:0.4s]" />
              </div>
            </div>
          </div>
        )}
        
        {error && (
          <div className="text-red-500 text-sm text-center">
            {error}
          </div>
        )}
      </div>
      
      {/* Input area */}
      <div className="border-t p-2 relative">
        {/* Commands dropdown */}
        {showCommands && filteredCommands.length > 0 && (
          <div className="absolute bottom-full left-2 right-2 mb-1 bg-white border rounded-lg shadow-lg max-h-40 overflow-y-auto">
            {filteredCommands.map(cmd => (
              <button
                key={cmd.command}
                onClick={() => handleCommandClick(cmd.command)}
                className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2"
              >
                <span className="font-mono text-sm text-[#222E40]">{cmd.command}</span>
                <span className="text-xs text-gray-500">{cmd.description}</span>
              </button>
            ))}
          </div>
        )}
        
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask about this ticket... (try /summary)"
            disabled={isLoading}
            className="flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#222E40] focus:border-transparent disabled:bg-gray-50"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="px-4 py-2 bg-[#222E40] text-white rounded-lg text-sm font-medium hover:bg-[#1a2433] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
