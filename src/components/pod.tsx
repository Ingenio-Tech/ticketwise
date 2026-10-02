"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useHostedApi, type MemberAuth } from "@/hooks/use-hosted-api";
import { setAuthCookies, checkAuth } from "@/actions/auth";
import { Chat } from "./chat";

interface PodProps {
  ticketId?: number;
  screen?: string;
}

export function Pod({ ticketId: propTicketId, screen: propScreen }: PodProps) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  
  // Check for existing auth cookies on mount (CW sets these automatically)
  useEffect(() => {
    checkAuth().then((result) => {
      if (result.authenticated) {
        setIsAuthenticated(true);
      }
    });
  }, []);
  
  const handleAuth = useCallback(async (auth: MemberAuth) => {
    try {
      // Send only what the server needs to verify the member (no SSO tokens).
      const result = await setAuthCookies({
        codeBase: auth.codeBase,
        companyid: auth.companyid,
        memberContext: auth.memberContext,
        memberEmail: auth.memberEmail,
        memberid: auth.memberid,
        memberHash: auth.memberHash,
        site: auth.site,
      });
      if (!result.success) {
        setIsAuthenticated(false);
        setAuthError(result.error || "Could not verify your ConnectWise session");
        return;
      }
      setIsAuthenticated(true);
      setAuthError(null);
    } catch (err) {
      console.error("Auth error:", err);
      setAuthError("Failed to authenticate with ConnectWise");
    }
  }, []);

  const handleReady = useCallback(() => {
    // Pod ready - auth check happens via useEffect
  }, []);

  const handleError = useCallback((error: Error) => {
    console.error("TicketWise: API error", error);
    setAuthError(error.message);
  }, []);

  const { isReady, requestAuth, requestScreenObject, auth, screenObject } = useHostedApi({
    onReady: handleReady,
    onAuth: handleAuth,
    onError: handleError,
  });
  
  // Hosted API credentials held in memory. Chat sends them with each server
  // call so the server can verify the member even if the browser blocks
  // cookies in this cross-site iframe.
  const credentials = useMemo(
    () =>
      auth
        ? { memberId: auth.memberid, memberHash: auth.memberHash, memberContext: auth.memberContext }
        : undefined,
    [auth]
  );

  // A Server Action said the ConnectWise session expired (CW 401 or a failed
  // re-check). The server has already dropped it; ask ConnectWise for fresh
  // credentials, which handleAuth verifies as on first load.
  const handleAuthExpired = useCallback(() => {
    setIsAuthenticated(false);
    requestAuth();
  }, [requestAuth]);

  // Derive ticket ID from screen object or props
  const ticketId = screenObject?.id ? Number(screenObject.id) : propTicketId;
  const screen = screenObject?.screen || propScreen || "ticket";

  // Check if running standalone (not in iframe)
  useEffect(() => {
    if (typeof window !== "undefined") {
      setIsStandalone(window === window.parent);
    }
  }, []);

  // Request auth (if not already authenticated) and screen object when ready
  useEffect(() => {
    if (isReady) {
      // Only request auth via postMessage if we don't have cookies
      if (!auth && !isAuthenticated) {
        requestAuth();
      }
      if (!screenObject) {
        requestScreenObject();
      }
    }
  }, [isReady, auth, isAuthenticated, screenObject, requestAuth, requestScreenObject]);

  // Standalone mode - show login prompt
  if (isStandalone) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="bg-white rounded-lg shadow-lg p-8 max-w-md w-full text-center">
          <div className="mb-6">
            <svg className="w-16 h-16 mx-auto text-[#222E40]" fill="currentColor" viewBox="0 0 24 24">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
            </svg>
          </div>
          <h1 className="text-xl font-bold text-[#222E40] mb-2">TicketWise</h1>
          <p className="text-gray-600 mb-6">
            AI-powered ticket assistant for ConnectWise PSA
          </p>
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
            <p className="font-medium mb-1">Pod Mode Only</p>
            <p>
              This application is designed to run as a pod within ConnectWise PSA. 
              Please access it through a service ticket in ConnectWise.
            </p>
          </div>
          <div className="mt-6 text-xs text-gray-400">
            Ticket #{ticketId} • Screen: {screen}
          </div>
        </div>
      </div>
    );
  }

  // Loading state - wait for ready and screen object (auth can come later)
  if (!isReady || !ticketId) {
    return (
      <div className="flex items-center justify-center h-full bg-white">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-[#222E40] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-gray-500">
            {!isReady ? "Connecting to ConnectWise..." : "Loading ticket..."}
          </p>
          <p className="text-xs text-gray-400 mt-2 font-mono">
            ready: {String(isReady)} | auth: {String(!!auth)} | screen: {JSON.stringify(screenObject)}
          </p>
        </div>
      </div>
    );
  }

  // No ticket ID available
  if (!ticketId) {
    return (
      <div className="flex items-center justify-center h-full bg-white p-4">
        <div className="text-center max-w-md">
          <div className="text-amber-500 mb-2">
            <svg className="w-8 h-8 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <p className="text-sm text-gray-700 font-medium">No Ticket Context</p>
          <p className="text-xs text-gray-500 mt-1">
            Could not retrieve ticket information from ConnectWise.
            Please ensure this pod is opened from a service ticket.
          </p>
          <div className="mt-3 text-xs text-gray-400 font-mono">
            Screen: {screenObject ? JSON.stringify(screenObject) : "null"}
          </div>
        </div>
      </div>
    );
  }

  // Auth error
  if (authError) {
    return (
      <div className="flex items-center justify-center h-full bg-white p-4">
        <div className="text-center">
          <div className="text-red-500 mb-2">
            <svg className="w-8 h-8 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <p className="text-sm text-red-600 font-medium">Authentication Error</p>
          <p className="text-xs text-gray-500 mt-1">{authError}</p>
          <button
            onClick={() => {
              setAuthError(null);
              requestAuth();
            }}
            className="mt-3 px-4 py-1 bg-[#222E40] text-white rounded text-sm hover:bg-[#1a2433]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full">
      <Chat
        ticketId={ticketId}
        isAuthenticated={isAuthenticated}
        credentials={credentials}
        onAuthExpired={handleAuthExpired}
      />
    </div>
  );
}
