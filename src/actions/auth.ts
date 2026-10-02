"use server";

import { cookies } from "next/headers";
import { z } from "zod";
import { env } from "@/lib/env";
import { AuthError, logSafe, requireMember, verifyMember } from "@/lib/session";

const COOKIE_NAMES = ["memberContext", "memberId", "memberHash", "companyName", "memberEmail", "codeBase"] as const;

// Shape of the getMemberAuthentication payload from the CW Hosted API.
// Everything here is client-supplied, so it is checked before use.
const MemberAuthInput = z.object({
  codeBase: z.string().max(100).optional(),
  companyid: z.string().min(1).max(100),
  memberContext: z.string().max(4096),
  memberEmail: z.string().max(320),
  memberid: z.string().min(1).max(100),
  memberHash: z.string().min(1).max(2048),
  site: z.string().max(500).optional(),
});

type AuthResult = { success: boolean; error?: string };

async function deleteAuthCookies() {
  const cookieStore = await cookies();
  for (const name of COOKIE_NAMES) {
    cookieStore.delete(name);
  }
}

/**
 * Store ConnectWise member authentication in cookies, but only after
 * ConnectWise has confirmed the memberId/memberHash pair.
 */
export async function setAuthCookies(auth: unknown): Promise<AuthResult> {
  const parsed = MemberAuthInput.safeParse(auth);
  if (!parsed.success) {
    return { success: false, error: "Invalid authentication data from ConnectWise" };
  }
  const data = parsed.data;

  // verifyMember always checks against our own company (CW_COMPANY_ID from
  // server env), so a member of another CW tenant fails there. This log only
  // helps spot a misconfigured pod.
  if (data.companyid.toLowerCase() !== env.CW_COMPANY_ID.toLowerCase()) {
    console.warn("[auth] sign-in names a different ConnectWise company; checking against ours");
  }

  try {
    await verifyMember({
      memberId: data.memberid,
      memberHash: data.memberHash,
      memberContext: data.memberContext,
    });
  } catch (err) {
    // Non-secret context to diagnose rejected sign-ins. These values come
    // from the client unchecked, so logSafe stops them faking log lines.
    console.warn(
      `[auth] sign-in rejected for ${logSafe(data.memberid)}: site=${logSafe(data.site ?? "-")} ` +
        `codeBase=${logSafe(data.codeBase ?? "-")} ` +
        `companyMatch=${data.companyid.toLowerCase() === env.CW_COMPANY_ID.toLowerCase()}`
    );
    await deleteAuthCookies();
    const message = err instanceof AuthError ? err.message : "Could not verify your ConnectWise session";
    return { success: false, error: message };
  }

  const cookieStore = await cookies();
  const cookieOptions = {
    path: "/",
    expires: new Date(Date.now() + 1000 * 60 * 60 * 8), // 8 hours
    sameSite: "none" as const,
    secure: true,
    httpOnly: true,
  };

  cookieStore.set("memberContext", data.memberContext, cookieOptions);
  cookieStore.set("memberId", data.memberid, cookieOptions);
  cookieStore.set("memberHash", data.memberHash, cookieOptions);
  cookieStore.set("companyName", data.companyid, cookieOptions);
  cookieStore.set("memberEmail", data.memberEmail, cookieOptions);

  if (data.codeBase) {
    cookieStore.set("codeBase", data.codeBase, cookieOptions);
  }

  return { success: true };
}

/**
 * Clear authentication cookies (logout).
 */
export async function clearAuthCookies(): Promise<{ success: boolean }> {
  await deleteAuthCookies();
  return { success: true };
}

/**
 * Check if the user holds a session that ConnectWise has confirmed.
 * Stale or forged cookies are cleared so the pod asks CW for fresh auth.
 */
export async function checkAuth(): Promise<{ authenticated: boolean; memberId?: string; email?: string }> {
  try {
    const member = await requireMember();
    const cookieStore = await cookies();
    return {
      authenticated: true,
      memberId: member.memberId,
      email: cookieStore.get("memberEmail")?.value,
    };
  } catch (err) {
    if (err instanceof AuthError) {
      const cookieStore = await cookies();
      if (cookieStore.get("memberHash") || cookieStore.get("memberId")) {
        await deleteAuthCookies();
      }
      return { authenticated: false };
    }
    throw err;
  }
}
