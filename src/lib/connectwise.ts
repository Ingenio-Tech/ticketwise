import { cookies } from "next/headers";
import { env } from "./env";

/**
 * ConnectWise API client that uses API key authentication
 * with member impersonation based on the logged-in user's cookies.
 */

type CWRequestOptions = {
  conditions?: string;
  orderBy?: string;
  pageSize?: number;
  page?: number;
  fields?: string[];
};

function buildUrl(endpoint: string, options?: CWRequestOptions): string {
  const base = `https://${env.CW_COMPANY_URL}/${env.CW_CODE_BASE}/apis/3.0`;
  const url = new URL(`${base}${endpoint}`);
  
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

async function getHeaders(): Promise<HeadersInit> {
  const cookieStore = await cookies();
  
  // Get the logged-in member's ID for impersonation
  const memberId = cookieStore.get("memberId")?.value;
  
  // Build Basic auth from API credentials
  // Format: companyId+publicKey:privateKey
  const authString = `${env.CW_COMPANY_ID}+${env.CW_PUBLIC_KEY}:${env.CW_PRIVATE_KEY}`;
  const basicAuth = Buffer.from(authString).toString("base64");
  
  const headers: HeadersInit = {
    "Authorization": `Basic ${basicAuth}`,
    "clientId": env.CW_CLIENT_ID,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  
  // Add member impersonation header if we have a logged-in member
  if (memberId) {
    headers["x-cw-usertype"] = "member";
    headers["x-cw-memberhash"] = memberId;
  }
  
  return headers;
}

export async function cwGet<T>(endpoint: string, options?: CWRequestOptions): Promise<T> {
  const url = buildUrl(endpoint, options);
  const headers = await getHeaders();
  
  const response = await fetch(url, { headers, cache: "no-store" });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ConnectWise API error (${response.status}): ${error}`);
  }
  
  return response.json();
}

export async function cwPost<T>(endpoint: string, body: unknown): Promise<T> {
  const url = buildUrl(endpoint);
  const headers = await getHeaders();
  
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ConnectWise API error (${response.status}): ${error}`);
  }
  
  return response.json();
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

// IDs go into URL paths and report conditions, so they must be plain
// positive integers (a string like "1/../../system" must never get through).
function assertId(id: unknown): asserts id is number {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Invalid ConnectWise record id");
  }
}

export async function getTicket(ticketId: number): Promise<CWTicket> {
  assertId(ticketId);
  return cwGet<CWTicket>(`/service/tickets/${ticketId}`);
}

export async function getTicketNotes(ticketId: number): Promise<CWTicketNote[]> {
  assertId(ticketId);
  // Use allNotes endpoint to get all note types (description, internal, resolution, etc.)
  // Note: allNotes doesn't support orderBy, so we sort client-side
  const notes = await cwGet<CWTicketNote[]>(`/service/tickets/${ticketId}/allNotes`, {
    pageSize: 100,
  });
  
  // Sort by dateCreated ascending
  return notes.sort((a, b) => {
    const dateA = a.dateCreated ? new Date(a.dateCreated).getTime() : 0;
    const dateB = b.dateCreated ? new Date(b.dateCreated).getTime() : 0;
    return dateA - dateB;
  });
}

export async function getTicketConfigurations(ticketId: number): Promise<CWConfiguration[]> {
  assertId(ticketId);
  return cwGet<CWConfiguration[]>(`/service/tickets/${ticketId}/configurations`);
}

export async function searchTickets(conditions: string, options?: Omit<CWRequestOptions, "conditions">): Promise<CWTicket[]> {
  return cwGet<CWTicket[]>("/service/tickets", { conditions, ...options });
}

export async function getConfiguration(configId: number): Promise<CWConfiguration> {
  assertId(configId);
  return cwGet<CWConfiguration>(`/company/configurations/${configId}`);
}

// Report API response structure
interface ServiceReportResponse {
  column_definitions: Array<Record<string, { type: string; isNullable: boolean; identityColumn: boolean }>>;
  row_values: Array<Array<string | number | boolean | null>>;
}

export async function getConfigurationTickets(configId: number, limit: number = 30): Promise<CWTicket[]> {
  assertId(configId);
  // Use the Service Report API to query tickets by config_recids
  // This is MUCH more efficient than checking each ticket individually
  
  const reportUrl = buildUrl("/system/reports/Service");
  const url = new URL(reportUrl);
  
  // Select columns we need - config_recids contains comma-separated config IDs
  url.searchParams.set("columns", "TicketNbr,Summary,date_entered,Closed_Flag,status_description,config_recids");
  // Query for tickets containing this config ID
  url.searchParams.set("conditions", `config_recids like '%${configId}%'`);
  url.searchParams.set("orderBy", "TicketNbr desc");
  url.searchParams.set("pageSize", String(limit));
  
  const headers = await getHeaders();
  const response = await fetch(url.toString(), { headers, cache: "no-store" });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ConnectWise Report API error (${response.status}): ${error}`);
  }
  
  const report: ServiceReportResponse = await response.json();
  
  // Map column names to indices
  const colNames = report.column_definitions.map(def => Object.keys(def)[0]);
  const getColIndex = (name: string) => colNames.indexOf(name);
  
  // Convert report rows to ticket objects
  // Report returns: TicketNbr, Summary, date_entered, Closed_Flag, status_description, config_recids
  const tickets: CWTicket[] = report.row_values.map(row => {
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

// Common words to exclude from keyword matching
const STOP_WORDS = new Set([
  "user", "issue", "problem", "help", "need", "please", "urgent", "asap",
  "working", "work", "able", "unable", "cannot", "error", "having", "getting",
  "need", "wants", "requested", "request", "support", "ticket", "client",
  "customer", "company", "staff", "employee", "team", "office", "site",
]);

export async function searchSimilarTickets(
  summary: string,
  companyId?: number,
  excludeTicketId?: number,
  daysBack: number = 90
): Promise<CWTicket[]> {
  // Build conditions - search in summary and look for similar issues
  const dateThreshold = new Date();
  dateThreshold.setDate(dateThreshold.getDate() - daysBack);
  const dateStr = dateThreshold.toISOString().split("T")[0];
  
  // Extract meaningful keywords (filter stop words)
  const keywords = summary
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w))
    .slice(0, 4);
  
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
  const tickets = await searchTickets(conditions, {
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
