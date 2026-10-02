"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { z } from "zod";

// Allowed origins for postMessage communication
const ALLOWED_ORIGINS = [
  "https://eu.myconnectwise.net",
  "https://na.myconnectwise.net",
  "https://au.myconnectwise.net",
  "https://staging.connectwisedev.com",
];

// ============ Type Definitions ============

const MemberAuthSchema = z.object({
  codeBase: z.string().optional(),
  companyid: z.string(),
  memberContext: z.string(),
  memberEmail: z.string(),
  memberid: z.string(),
  memberHash: z.string(),
  site: z.string(),
  ssoAccessToken: z.string().optional(),
  ssoIdToken: z.string().optional(),
});

export type MemberAuth = z.infer<typeof MemberAuthSchema>;

const ScreenObjectSchema = z.object({
  hostedAs: z.enum(["pod", "tab"]),
  id: z.union([z.string(), z.number()]),
  screen: z.enum(["ticket", "company", "contact", "salesorder"]),
});

export type ScreenObject = z.infer<typeof ScreenObjectSchema>;

// ============ Hook ============

interface UseHostedApiOptions {
  onReady?: () => void;
  onAuth?: (auth: MemberAuth) => void;
  onError?: (error: Error) => void;
}

interface UseHostedApiReturn {
  isReady: boolean;
  isAuthenticated: boolean;
  auth: MemberAuth | null;
  screenObject: ScreenObject | null;
  frameId: string | null;
  requestAuth: () => void;
  requestScreenObject: () => void;
  refreshScreen: () => void;
}

export function useHostedApi(options: UseHostedApiOptions = {}): UseHostedApiReturn {
  const [isReady, setIsReady] = useState(false);
  const [frameId, setFrameId] = useState<string | null>(null);
  const [auth, setAuth] = useState<MemberAuth | null>(null);
  const [screenObject, setScreenObject] = useState<ScreenObject | null>(null);
  const messageListenerRef = useRef<((e: MessageEvent) => void) | null>(null);
  
  // Use ref to avoid stale closure issues with frameId
  const frameIdRef = useRef<string | null>(null);
  const parentOriginRef = useRef<string | null>(null);
  
  const { onReady, onAuth, onError } = options;

  // Post message to parent ConnectWise window
  const postToParent = useCallback((message: object) => {
    if (typeof window === "undefined" || window === window.parent) {
      return;
    }
    
    // Use ref to get current frameId (avoids stale closure)
    const payload = { ...message, frameID: frameIdRef.current };
    // Send to verified parent origin, or "*" for initial ready message
    const targetOrigin = parentOriginRef.current || "*";
    // CW Hosted API expects: hosted_request (not request), and JSON.stringify'd
    const cwPayload = { ...payload };
    if ('request' in cwPayload) {
      (cwPayload as any).hosted_request = (cwPayload as any).request;
      delete (cwPayload as any).request;
    }
    const payloadStr = JSON.stringify(cwPayload);
    window.parent.postMessage(payloadStr, targetOrigin);
  }, []);

  // Request member authentication from CW
  const requestAuth = useCallback(() => {
    postToParent({ request: "getMemberAuthentication" });
  }, [postToParent]);

  // Request screen object (record ID, screen type)
  const requestScreenObject = useCallback(() => {
    postToParent({ request: "getScreenObject" });
  }, [postToParent]);

  // Request screen refresh
  const refreshScreen = useCallback(() => {
    postToParent({ request: "refreshScreen" });
  }, [postToParent]);

  // Set up message listener
  useEffect(() => {
    if (typeof window === "undefined") return;
    
    // Don't re-add listener
    if (messageListenerRef.current) return;

    const handleMessage = (event: MessageEvent) => {
      // Validate origin - only accept messages from ConnectWise domains
      // Exact match: startsWith would also accept https://eu.myconnectwise.net.evil.example
      if (!ALLOWED_ORIGINS.includes(event.origin)) {
        return; // Silently ignore messages from unknown origins
      }
      
      // Store the parent origin for secure postMessage responses
      if (!parentOriginRef.current) {
        parentOriginRef.current = event.origin;
      }
      
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        
        // Handle frame ID assignment (only process once)
        if (data.MessageFrameID) {
          if (frameIdRef.current === data.MessageFrameID) {
            return; // Ignore duplicate
          }
          frameIdRef.current = data.MessageFrameID;
          setFrameId(data.MessageFrameID);
          setIsReady(true);
          onReady?.();
          return;
        }
        
        // Handle auth response (CW sends lowercase response key)
        const responseKey = data.response?.toLowerCase();
        if (responseKey === "getmemberauthentication" && data.data) {
          const parsed = MemberAuthSchema.safeParse(data.data);
          if (parsed.success) {
            setAuth(parsed.data);
            onAuth?.(parsed.data);
          } else {
            console.error("TicketWise: Invalid auth data", parsed.error);
            onError?.(new Error("Invalid authentication data from ConnectWise"));
          }
          return;
        }
        
        // Handle screen object response
        if (data.response === "getscreenobject" && data.data) {
          const parsed = ScreenObjectSchema.safeParse(data.data);
          if (parsed.success) {
            setScreenObject(parsed.data);
          } else {
            // Try to extract manually if schema doesn't match exactly
            if (data.data.id || data.data.recordId) {
              setScreenObject({
                id: data.data.id || data.data.recordId,
                screen: data.data.screen || "ticket",
                hostedAs: data.data.hostedAs || "pod",
              } as ScreenObject);
            }
          }
          return;
        }
        
        // Handle events (onLoad, beforeSave)
        if (data.event) {
          // Extract screenObject from onLoad event
          if (data.event === "onLoad" && data.data?.screenObject) {
            const parsed = ScreenObjectSchema.safeParse(data.data.screenObject);
            if (parsed.success) {
              setScreenObject(parsed.data);
            } else {
              // Fallback: use raw data
              setScreenObject({
                id: data.data.screenObject.id,
                screen: data.data.screenObject.screen || "ticket",
                hostedAs: data.data.screenObject.hostedAs || "pod",
              } as ScreenObject);
            }
          }
          
          // Acknowledge the event (include frameID) — stringify per CW API
          window.parent.postMessage(JSON.stringify({
            event: data.event,
            _id: data._id,
            result: "success",
            frameID: frameIdRef.current,
          }), parentOriginRef.current || "*");
          return;
        }
      } catch (e) {
        // Not a JSON message or not for us - ignore
      }
    };

    messageListenerRef.current = handleMessage;
    window.addEventListener("message", handleMessage);

    // Send ready message to parent
    if (window !== window.parent) {
      window.parent.postMessage(JSON.stringify({ message: "ready" }), "*");
    }

    return () => {
      if (messageListenerRef.current) {
        window.removeEventListener("message", messageListenerRef.current);
        messageListenerRef.current = null;
      }
    };
  }, [onReady, onAuth, onError]);

  return {
    isReady,
    isAuthenticated: auth !== null,
    auth,
    screenObject,
    frameId,
    requestAuth,
    requestScreenObject,
    refreshScreen,
  };
}
