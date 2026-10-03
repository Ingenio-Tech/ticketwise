import { env } from "./env";
import { AuthError, cwSessionHeaders, forgetSession, type MemberSession } from "./session";

/**
 * ConnectWise REST client. Every call runs as the signed-in member: it takes
 * the MemberSession that requireMember() returned and sends the same
 * credentials ConnectWise accepted when it verified the member. ConnectWise
 * then applies that member's security role. There is no integration key and
 * no call without a session.
 *
 * Errors:
 *   401 -> AuthError (session expired or invalid; the pod must re-authenticate)
 *   403 -> CwForbiddenError (the member's role does not allow it)
 *   other, or a body that is not JSON -> CwApiError (status only)
 * CW response bodies are never logged or passed on.
 */

type CWRequestOptions = {
  conditions?: string;
  orderBy?: string;
  pageSize?: number;
  page?: number;
  fields?: string[];
  columns?: string[];
  /** Overrides CW_TIMEOUT_MS for slow endpoints. Not sent to ConnectWise. */
  timeoutMs?: number;
};

const CW_TIMEOUT_MS = 15000;
// The Service report scans every ticket's config_recids; it takes 15 to 20
// seconds on Ingenio's tenant (measured 3 Oct 2026).
const CW_REPORT_TIMEOUT_MS = 60000;

export const CW_FORBIDDEN_MESSAGE = "Your ConnectWise security role does not allow this.";

/** ConnectWise refused the call because the member's security role lacks the rights. */
export class CwForbiddenError extends Error {
  constructor() {
    super(CW_FORBIDDEN_MESSAGE);
    this.name = "CwForbiddenError";
  }
}

/** Any other failed ConnectWise call. Carries the status, never the body. */
export class CwApiError extends Error {
  constructor(public readonly status: number) {
    super(status ? `ConnectWise request failed (${status})` : "ConnectWise could not be reached");
    this.name = "CwApiError";
  }
}

function buildUrl(endpoint: string, options?: CWRequestOptions): string {
  const base = `https://${env.CW_COMPANY_URL}/${env.CW_CODE_BASE}/apis/3.0`;
  const url = new URL(`${base}${endpoint}`);

  if (options?.columns?.length) {
    url.searchParams.set("columns", options.columns.join(","));
  }
  if (options?.conditions) {
    url.searchParams.set("conditions", options.conditions);
  }
  if (options?.orderBy) {
    url.searchParams.set("orderBy", options.orderBy);
  }
  if (options?.pageSize) {
    url.searchParams.set("pageSize", String(options.pageSize));
  }
  if (options?.page) {
    url.searchParams.set("page", String(options.page));
  }
  if (options?.fields?.length) {
    url.searchParams.set("fields", options.fields.join(","));
  }

  return url.toString();
}

/** The one place that sends a request to ConnectWise. */
async function cwRequest<T>(
  session: MemberSession,
  method: "GET" | "POST",
  endpoint: string,
  options?: CWRequestOptions,
  body?: unknown
): Promise<T> {
  // Throws AuthError unless this is a session verifyMember issued.
  const headers = cwSessionHeaders(session);
  if (body !== undefined) headers["Content-Type"] = "application/json";

  // Log method, path and status only: no query string (it can hold ticket
  // text), no hash, no context, no response body.
  const label = `[cw] ${method} ${endpoint} as ${session.memberId}`;

  let response: Response;
  try {
    response = await fetch(buildUrl(endpoint, options), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(options?.timeoutMs ?? CW_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    console.warn(`${label} -> ${timedOut ? "timed out" : "network error"}`);
    throw new CwApiError(0);
  }

  if (response.ok) {
    try {
      const data = (await response.json()) as T;
      console.info(`${label} -> ${response.status}`);
      return data;
    } catch {
      // A JSON parse error quotes part of the body, so drop it.
      console.warn(`${label} -> ${response.status} (invalid JSON)`);
      throw new CwApiError(response.status);
    }
  }

  console.warn(`${label} -> ${response.status}`);
  // Drain the body without reading it into logs or errors.
  await response.body?.cancel().catch(() => undefined);

  if (response.status === 401) {
    // The member session has expired or is no longer valid. Drop it from the
    // cache so the next requireMember asks ConnectWise again.
    forgetSession(session);
    throw new AuthError("Your ConnectWise session has expired. Reload the ticket and try again.");
  }
  if (response.status === 403) {
    throw new CwForbiddenError();
  }
  throw new CwApiError(response.status);
}

export async function cwGet<T>(session: MemberSession, endpoint: string, options?: CWRequestOptions): Promise<T> {
  return cwRequest<T>(session, "GET", endpoint, options);
}

export async function cwPost<T>(session: MemberSession, endpoint: string, body: unknown): Promise<T> {
  return cwRequest<T>(session, "POST", endpoint, undefined, body);
}

// ============ Ticket Types ============

export interface CWTicket {
  id: number;
  summary: string;
  initialDescription?: string;
  initialInternalAnalysis?: string;
  initialResolution?: string;
  board?: { id: number; name: string };
  status?: { id: number; name: string };
  priority?: { id: number; name: string };
  company?: { id: number; identifier: string; name: string };
  contact?: { id: number; name: string };
  contactName?: string;
  contactPhoneNumber?: string;
  contactEmailAddress?: string;
  type?: { id: number; name: string };
  subType?: { id: number; name: string };
  item?: { id: number; name: string };
  resources?: string;
  owner?: { id: number; identifier: string; name: string };
  dateEntered?: string;
  lastUpdated?: string;
  requiredDate?: string;
  budgetHours?: number;
  actualHours?: number;
  recordType?: string;
  severity?: string;
  impact?: string;
  externalXRef?: string;
  poNumber?: string;
  customFields?: Array<{ id: number; caption: string; value: string }>;
  _info?: { lastUpdated: string };
}

export interface CWTicketNote {
  id: number;
  ticketId: number;
  text: string;
  detailDescriptionFlag?: boolean;
  internalAnalysisFlag?: boolean;
  resolutionFlag?: boolean;
  issueFlag?: boolean;
  member?: { id: number; identifier: string; name: string };
  contact?: { id: number; name: string };
  customerUpdatedFlag?: boolean;
  processNotifications?: boolean;
  dateCreated?: string;
  createdBy?: string;
  internalFlag?: boolean;
  externalFlag?: boolean;
}

export interface CWConfiguration {
  id: number;
  name: string;
  type?: { id: number; name: string };
  status?: { id: number; name: string };
  company?: { id: number; identifier: string; name: string };
  contact?: { id: number; name: string };
  site?: { id: number; name: string };
  serialNumber?: string;
  modelNumber?: string;
  tagNumber?: string;
  vendorNotes?: string;
  notes?: string;
  lastLoginName?: string;
  osType?: string;
  osInfo?: string;
  cpuSpeed?: string;
  ram?: string;
  localHardDrives?: string;
  questions?: Array<{ questionId: number; question: string; answer: string }>;
}

// ============ API Functions ============

// IDs go into URL paths and conditions, so they must be plain positive
// integers (a string like "1/../../system" must never get through).
function assertId(id: unknown): asserts id is number {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Invalid ConnectWise record id");
  }
}

export async function getTicket(session: MemberSession, ticketId: number): Promise<CWTicket> {
  assertId(ticketId);
  return cwGet<CWTicket>(session, `/service/tickets/${ticketId}`);
}

export async function getTicketNotes(session: MemberSession, ticketId: number): Promise<CWTicketNote[]> {
  assertId(ticketId);
  // Use allNotes endpoint to get all note types (description, internal, resolution, etc.)
  // Note: allNotes doesn't support orderBy, so we sort client-side
  const notes = await cwGet<CWTicketNote[]>(session, `/service/tickets/${ticketId}/allNotes`, {
    pageSize: 100,
  });
  
  // Sort by dateCreated ascending
  return notes.sort((a, b) => {
    const dateA = a.dateCreated ? new Date(a.dateCreated).getTime() : 0;
    const dateB = b.dateCreated ? new Date(b.dateCreated).getTime() : 0;
    return dateA - dateB;
  });
}

export async function getTicketConfigurations(session: MemberSession, ticketId: number): Promise<CWConfiguration[]> {
  assertId(ticketId);
  return cwGet<CWConfiguration[]>(session, `/service/tickets/${ticketId}/configurations`);
}

export async function searchTickets(
  session: MemberSession,
  conditions: string,
  options?: Omit<CWRequestOptions, "conditions">
): Promise<CWTicket[]> {
  return cwGet<CWTicket[]>(session, "/service/tickets", { conditions, ...options });
}

export async function getConfiguration(session: MemberSession, configId: number): Promise<CWConfiguration> {
  assertId(configId);
  return cwGet<CWConfiguration>(session, `/company/configurations/${configId}`);
}

// Report API response structure
interface ServiceReportResponse {
  column_definitions: Array<Record<string, { type: string; isNullable: boolean; identityColumn: boolean }>>;
  row_values: Array<Array<string | number | boolean | null>>;
}

/**
 * True when a Report API config_recids value lists exactly this config id.
 * config_recids is a comma-separated list of integer ids with no spaces
 * ("12", "5,12", "5,12,7"), so 12 must not match "112", "120" or "1,2".
 */
export function configRecidsInclude(recids: unknown, configId: number): boolean {
  if (typeof recids !== "string" && typeof recids !== "number") return false;
  const wanted = String(configId);
  return String(recids)
    .split(",")
    .some((part) => part.trim() === wanted);
}

export async function getConfigurationTickets(
  session: MemberSession,
  configId: number,
  limit: number = 30
): Promise<CWTicket[]> {
  assertId(configId);
  // Use the Service Report API to query tickets by config_recids
  // This is MUCH more efficient than checking each ticket individually.
  // Needs Report API rights in the member's security role; a 403 throws
  // CwForbiddenError. The rows are then re-checked against /service/tickets
  // (keepVisibleTickets), so the member only sees tickets they can open.

  // config_recids is a comma-separated list, so match the id as a whole
  // list item: alone, first, last or in the middle. A bare like '%12%'
  // also matches 112, 120 and 312 (other devices, other clients).
  const id = String(configId);
  const conditions =
    `(config_recids = '${id}' or config_recids like '${id},%' or ` +
    `config_recids like '%,${id}' or config_recids like '%,${id},%')`;

  const report = await cwGet<ServiceReportResponse>(session, "/system/reports/Service", {
    // config_recids contains comma-separated config IDs
    columns: ["TicketNbr", "Summary", "date_entered", "Closed_Flag", "status_description", "config_recids"],
    conditions,
    orderBy: "TicketNbr desc",
    pageSize: limit,
    timeoutMs: CW_REPORT_TIMEOUT_MS,
  });

  // Map column names to indices
  const colNames = report.column_definitions.map(def => Object.keys(def)[0]);
  const getColIndex = (name: string) => colNames.indexOf(name);
  const recidsCol = getColIndex("config_recids");

  // Keep only rows whose config_recids really lists this id, so a wrong
  // server-side match can never leak another device's ticket in.
  const rows = recidsCol < 0 ? [] : report.row_values.filter(row => configRecidsInclude(row[recidsCol], configId));

  // Convert report rows to ticket objects
  // Report returns: TicketNbr, Summary, date_entered, Closed_Flag, status_description, config_recids
  const reported: CWTicket[] = rows.map(row => {
    const ticketId = row[getColIndex("TicketNbr")] as number;
    const summary = row[getColIndex("Summary")] as string;
    const dateEntered = row[getColIndex("date_entered")] as string;
    const closedFlag = row[getColIndex("Closed_Flag")] as boolean;
    const statusName = row[getColIndex("status_description")] as string;
    
    return {
      id: ticketId,
      summary: summary || "",
      dateEntered,
      status: statusName ? { id: 0, name: closedFlag ? `${statusName} (Closed)` : statusName } : undefined,
    };
  });

  // The Report API may not apply the same ticket limits (boards, "My"
  // tickets) as /service/tickets. Ask /service/tickets, as the same member,
  // which of these tickets they can open, and keep only those.
  const tickets = await keepVisibleTickets(session, reported);
  
  // Sort to put closed/resolved tickets first (they have solutions!)
  const closedStatuses = ["closed", "resolved", "completed"];
  return tickets.sort((a, b) => {
    const aIsClosed = closedStatuses.some(s => a.status?.name?.toLowerCase().includes(s));
    const bIsClosed = closedStatuses.some(s => b.status?.name?.toLowerCase().includes(s));
    if (aIsClosed && !bIsClosed) return -1;
    if (!aIsClosed && bIsClosed) return 1;
    return 0;
  });
}

/**
 * Keep only the tickets this member can open through /service/tickets.
 * Ids that are not plain positive integers are dropped before they reach the
 * conditions string.
 */
async function keepVisibleTickets(session: MemberSession, tickets: CWTicket[]): Promise<CWTicket[]> {
  const candidates = tickets.filter(t => Number.isSafeInteger(t.id) && t.id > 0);
  if (candidates.length === 0) return [];

  const ids = [...new Set(candidates.map(t => t.id))];
  const visible = await searchTickets(session, `id in (${ids.join(",")})`, {
    fields: ["id"],
    pageSize: ids.length,
  });
  const allowed = new Set(visible.map(t => t.id));
  return candidates.filter(t => allowed.has(t.id));
}

// Common words to exclude from keyword matching
const STOP_WORDS = new Set([
  "user", "issue", "problem", "help", "need", "please", "urgent", "asap",
  "working", "work", "able", "unable", "cannot", "error", "having", "getting",
  "need", "wants", "requested", "request", "support", "ticket", "client",
  "customer", "company", "staff", "employee", "team", "office", "site",
]);

/**
 * Keywords from ticket text that are safe inside a CW conditions string
 * literal: lower-case letters and digits only, so quotes, brackets and
 * operators in the summary can never break out of the "..." literal.
 */
export function summaryKeywords(summary: string): string[] {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 3 && /^[a-z0-9]+$/.test(w) && !STOP_WORDS.has(w))
    .slice(0, 4);
}

export async function searchSimilarTickets(
  session: MemberSession,
  summary: string,
  companyId?: number,
  excludeTicketId?: number,
  daysBack: number = 90
): Promise<CWTicket[]> {
  // These go into the conditions string unquoted, so they must be integers.
  if (companyId) assertId(companyId);
  if (excludeTicketId) assertId(excludeTicketId);
  if (!Number.isSafeInteger(daysBack) || daysBack <= 0) throw new Error("Invalid search window");

  // Build conditions - search in summary and look for similar issues
  const dateThreshold = new Date();
  dateThreshold.setDate(dateThreshold.getDate() - daysBack);
  const dateStr = dateThreshold.toISOString().split("T")[0];
  
  // Extract meaningful keywords (filter stop words)
  const keywords = summaryKeywords(summary);
  
  // If no meaningful keywords, don't search
  if (keywords.length === 0) {
    return [];
  }
  
  let conditions = `dateEntered>=[${dateStr}]`;
  
  if (companyId) {
    conditions += ` and company/id=${companyId}`;
  }
  
  if (excludeTicketId) {
    conditions += ` and id!=${excludeTicketId}`;
  }
  
  // Add keyword search - CW uses 'like' for partial matches
  const keywordCondition = keywords.map(k => `summary like "%${k}%"`).join(" or ");
  conditions += ` and (${keywordCondition})`;
  
  // Fetch tickets - we'll sort to prioritise closed ones
  const tickets = await searchTickets(session, conditions, {
    orderBy: "dateEntered desc",
    pageSize: 20,
    fields: ["id", "summary", "status", "company", "dateEntered", "type", "initialDescription", "initialResolution"],
  });
  
  // Sort to put closed/resolved tickets first (they have solutions!)
  const closedStatuses = ["closed", "resolved", "completed"];
  return tickets.sort((a, b) => {
    const aIsClosed = closedStatuses.some(s => a.status?.name?.toLowerCase().includes(s));
    const bIsClosed = closedStatuses.some(s => b.status?.name?.toLowerCase().includes(s));
    if (aIsClosed && !bIsClosed) return -1;
    if (!aIsClosed && bIsClosed) return 1;
    return 0;
  });
}
