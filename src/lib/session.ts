import { cookies } from "next/headers";
import { createHash } from "crypto";
import { env } from "./env";

/**
 * Server-side check that the caller is a real, signed-in ConnectWise member.
 *
 * The CW Hosted API hands the pod a memberId and memberHash via postMessage.
 * Anyone can send those values to a Server Action, so the server must prove
 * them with ConnectWise before it touches CW data or the LLM.
 *
 * ConnectWise documents two ways to authenticate with a Hosted API memberHash:
 *   - Cookie auth: companyName, memberId, memberHash and memberContext cookies
 *   - Basic auth:  base64("<companyId>+<memberId>:<memberHash>")
 * We call /system/myMembers/info with each in turn. CW returns 401 for a wrong
 * or expired hash. A 200 also names the member the session belongs to, and
 * that identifier must match the memberId the caller claimed, so one member's
 * hash cannot be presented under a colleague's memberId.
 *
 * The company always comes from server env (CW_COMPANY_ID), never from the
 * client, so a member of another CW tenant on the same host cannot get in.
 */

export class AuthError extends Error {
  constructor(message = "ConnectWise session could not be verified") {
    super(message);
    this.name = "AuthError";
  }
}

export interface MemberCredentials {
  memberId: string;
  memberHash: string;
  memberContext?: string;
}

export interface VerifiedMember {
  memberId: string;
}

type Method = "cookie" | "basic" | "cookie-encoded" | "cookie-no-context";

// Values must be safe to place in a Cookie or Basic auth header:
// printable ASCII, no whitespace, and none of : ; , " \
const SAFE_ID = /^[\x21-\x7E]{1,100}$/;
const UNSAFE_ID_CHARS = /[:;,\\"]/;
const SAFE_TOKEN = /^[\x21-\x7E]{8,2048}$/;
const UNSAFE_TOKEN_CHARS = /[;,\\"]/;
// memberContext can be very short (3 characters seen for some members), and
// CW refuses the cookie check without it, so it gets its own length rule.
const SAFE_CONTEXT = /^[\x21-\x7E]{1,4096}$/;

const POSITIVE_TTL_MS = 5 * 60 * 1000; // re-check with CW every 5 minutes
const NEGATIVE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;
const MEMBER_FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_MEMBER = 10;
const GLOBAL_FAIL_WINDOW_MS = 60 * 1000;
const MAX_FAILS_GLOBAL = 30;
const CW_TIMEOUT_MS = 8000;

const verified = new Map<string, { memberId: string; expires: number }>();
const rejected = new Map<string, number>();
const memberFailures = new Map<string, { count: number; reset: number }>();
let globalFailures = { count: 0, reset: 0 };
let preferredMethod: Method = "cookie";

function trim<K, V>(map: Map<K, V>) {
  while (map.size > MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function cacheKey(c: MemberCredentials): string {
  return createHash("sha256")
    .update(`${env.CW_COMPANY_ID.toLowerCase()}\n${c.memberId.toLowerCase()}\n${c.memberHash}`)
    .digest("hex");
}

function isSafeToken(value: string): boolean {
  return SAFE_TOKEN.test(value) && !UNSAFE_TOKEN_CHARS.test(value);
}

function isSafeContext(value: string): boolean {
  return SAFE_CONTEXT.test(value) && !UNSAFE_TOKEN_CHARS.test(value);
}

export function credentialsAreWellFormed(c: MemberCredentials): boolean {
  if (!SAFE_ID.test(c.memberId) || UNSAFE_ID_CHARS.test(c.memberId)) return false;
  if (!isSafeToken(c.memberHash)) return false;
  return true;
}

function recordFailure(memberId: string) {
  const now = Date.now();
  const key = memberId.toLowerCase();
  const entry = memberFailures.get(key);
  if (!entry || now > entry.reset) {
    memberFailures.set(key, { count: 1, reset: now + MEMBER_FAIL_WINDOW_MS });
  } else {
    entry.count++;
  }
  trim(memberFailures);

  if (now > globalFailures.reset) {
    globalFailures = { count: 1, reset: now + GLOBAL_FAIL_WINDOW_MS };
  } else {
    globalFailures.count++;
  }
}

function tooManyFailures(memberId: string): boolean {
  const now = Date.now();
  if (now <= globalFailures.reset && globalFailures.count >= MAX_FAILS_GLOBAL) return true;
  const entry = memberFailures.get(memberId.toLowerCase());
  return !!entry && now <= entry.reset && entry.count >= MAX_FAILS_PER_MEMBER;
}

function buildHeaders(method: Method, c: MemberCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    clientId: env.CW_CLIENT_ID,
    Accept: "application/json",
  };
  if (method === "basic") {
    const basic = Buffer.from(`${env.CW_COMPANY_ID}+${c.memberId}:${c.memberHash}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  } else if (method === "cookie-encoded") {
    // Same cookies with URL-encoded values, memberContext always included.
    const parts = [
      `companyName=${encodeURIComponent(env.CW_COMPANY_ID)}`,
      `memberId=${encodeURIComponent(c.memberId)}`,
      `memberHash=${encodeURIComponent(c.memberHash)}`,
    ];
    if (c.memberContext) parts.push(`memberContext=${encodeURIComponent(c.memberContext)}`);
    headers.Cookie = parts.join("; ");
  } else if (method === "cookie-no-context") {
    headers.Cookie = [
      `companyName=${env.CW_COMPANY_ID}`,
      `memberId=${c.memberId}`,
      `memberHash=${c.memberHash}`,
    ].join("; ");
  } else {
    const parts = [
      `companyName=${env.CW_COMPANY_ID}`,
      `memberId=${c.memberId}`,
      `memberHash=${c.memberHash}`,
    ];
    if (c.memberContext && isSafeContext(c.memberContext)) {
      parts.push(`memberContext=${c.memberContext}`);
    }
    headers.Cookie = parts.join("; ");
  }
  return headers;
}

interface CwCheck {
  /** HTTP status from CW, 0 on a network error or timeout, 403 on an identity mismatch. */
  status: number;
  code: string;
  /** The member CW says the session belongs to (only on a matching 200). */
  identifier?: string;
}

/** Ask CW who the session belongs to, and require it to be the claimed member. */
async function callCw(method: Method, c: MemberCredentials): Promise<CwCheck> {
  const url = `https://${env.CW_COMPANY_URL}/${env.CW_CODE_BASE}/apis/3.0/system/myMembers/info`;
  try {
    const res = await fetch(url, {
      headers: buildHeaders(method, c),
      cache: "no-store",
      signal: AbortSignal.timeout(CW_TIMEOUT_MS),
    });
    let code = "";
    if (res.status !== 200) {
      // CW error bodies carry a code and message, never credentials.
      const body = await res.text().catch(() => "");
      try {
        const j = JSON.parse(body);
        code = `${j.code ?? ""}:${String(j.message ?? "").slice(0, 120)}`;
      } catch {
        code = body.slice(0, 80).replace(/\s+/g, " ");
      }
      return { status: res.status, code };
    }
    const info = (await res.json().catch(() => null)) as { identifier?: unknown } | null;
    const identifier = typeof info?.identifier === "string" ? info.identifier : "";
    if (!identifier || identifier.toLowerCase() !== c.memberId.toLowerCase()) {
      return { status: 403, code: `identity mismatch: CW says ${identifier || "(none)"}` };
    }
    return { status: 200, code: "", identifier };
  } catch {
    return { status: 0, code: "network" };
  }
}

/**
 * Describe the shape of the credentials without revealing them: lengths and
 * which special characters appear. Used to diagnose why CW rejects a member.
 */
function describe(c: MemberCredentials): string {
  const flags = (v: string) =>
    ["+", "/", "=", "%", "-", "_", " ", ",", ";", '"', "{", ":", "."]
      .filter((ch) => v.includes(ch))
      .map((ch) => (ch === " " ? "space" : ch))
      .join("");
  const ctx = c.memberContext ?? "";
  return [
    `hashLen=${c.memberHash.length}`,
    `hashChars=[${flags(c.memberHash)}]`,
    `ctxLen=${ctx.length}`,
    `ctxSent=${ctx ? isSafeContext(ctx) : false}`,
    `ctxChars=[${flags(ctx)}]`,
  ].join(" ");
}

const described = new Set<string>();

/** After a clear rejection, try the other documented cookie forms and log what CW says. */
async function diagnose(c: MemberCredentials): Promise<{ method: Method; identifier: string } | null> {
  const results: string[] = [];
  let winner: { method: Method; identifier: string } | null = null;
  for (const method of ["cookie-encoded", "cookie-no-context"] as Method[]) {
    const { status, code, identifier } = await callCw(method, c);
    results.push(`${method}=${status}${code ? `(${code})` : ""}`);
    if (status === 200 && identifier && !winner) winner = { method, identifier };
  }
  console.warn(`[auth] diagnose member ${c.memberId}: ${describe(c)} ${results.join(" ")}`);
  return winner;
}

/**
 * Prove a memberId/memberHash pair with ConnectWise. Positive results are
 * cached for 5 minutes, keyed by a SHA-256 of company, member and hash.
 */
export async function verifyMember(c: MemberCredentials): Promise<VerifiedMember> {
  if (!credentialsAreWellFormed(c)) {
    throw new AuthError();
  }

  const key = cacheKey(c);
  const now = Date.now();

  const hit = verified.get(key);
  if (hit && hit.expires > now) {
    return { memberId: hit.memberId };
  }
  if (hit) verified.delete(key);

  const neg = rejected.get(key);
  if (neg && neg > now) {
    throw new AuthError();
  }
  if (neg) rejected.delete(key);

  if (tooManyFailures(c.memberId)) {
    console.warn(`[auth] verification throttled for member ${c.memberId}`);
    throw new AuthError("Too many failed sign-in checks. Please wait a few minutes.");
  }

  const order: Method[] = preferredMethod === "cookie" ? ["cookie", "basic"] : ["basic", "cookie"];
  const statuses: number[] = [];
  const codes: string[] = [];

  for (const method of order) {
    const { status, code, identifier } = await callCw(method, c);
    statuses.push(status);
    if (code) codes.push(code);
    if (status === 200 && identifier) {
      preferredMethod = method;
      verified.set(key, { memberId: identifier, expires: now + POSITIVE_TTL_MS });
      trim(verified);
      console.info(`[auth] member ${identifier} verified with ConnectWise (${method}, identity matched)`);
      if (!described.has(identifier.toLowerCase())) {
        described.add(identifier.toLowerCase());
        console.info(`[auth] shape for ${identifier}: ${describe(c)}`);
      }
      return { memberId: identifier };
    }
  }

  // Only count a clear rejection from CW as a failure. Outages fail closed
  // but are not cached, so a CW blip does not lock people out for long.
  if (statuses.every((s) => s === 401 || s === 403)) {
    const alt = await diagnose(c);
    if (alt) {
      // CW accepted the same credentials in another documented cookie form
      // and named the claimed member, so the member is genuine.
      verified.set(key, { memberId: alt.identifier, expires: now + POSITIVE_TTL_MS });
      trim(verified);
      console.info(`[auth] member ${alt.identifier} verified with ConnectWise (${alt.method}, identity matched)`);
      return { memberId: alt.identifier };
    }
    recordFailure(c.memberId);
    rejected.set(key, now + NEGATIVE_TTL_MS);
    trim(rejected);
  }
  console.warn(
    `[auth] member ${c.memberId} not verified (CW status ${statuses.join(",")})${codes.length ? ` ${codes.join(" | ")}` : ""}`
  );
  throw new AuthError();
}

/** Read the auth cookies set by setAuthCookies. */
export async function readCredentialCookies(): Promise<MemberCredentials | null> {
  const store = await cookies();
  const memberId = store.get("memberId")?.value;
  const memberHash = store.get("memberHash")?.value;
  const memberContext = store.get("memberContext")?.value;
  if (!memberId || !memberHash) return null;
  return { memberId, memberHash, memberContext };
}

function parseExplicit(value: unknown): MemberCredentials | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.memberId !== "string" || typeof v.memberHash !== "string") return null;
  if (v.memberId.length > 100 || v.memberHash.length > 2048) return null;
  const memberContext =
    typeof v.memberContext === "string" && v.memberContext.length <= 4096 ? v.memberContext : undefined;
  return { memberId: v.memberId, memberHash: v.memberHash, memberContext };
}

/**
 * Gate for every Server Action that reaches ConnectWise or the LLM.
 * Throws AuthError unless ConnectWise confirms the member.
 *
 * The pod passes the Hosted API credentials it holds in memory with each
 * call, because browsers may block cookies in a cross-site iframe. When it
 * does not, the httpOnly cookies from setAuthCookies are used instead.
 */
export async function requireMember(explicit?: unknown): Promise<VerifiedMember> {
  const creds = parseExplicit(explicit) ?? (await readCredentialCookies());
  if (!creds) {
    throw new AuthError();
  }
  return verifyMember(creds);
}
