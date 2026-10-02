// ConnectWise data calls must run as the verified member, never with an
// integration key, and /config must only return tickets for that exact device.
// Run: npx tsx tests/member-session-calls.test.mts
import { createServer } from "node:http";

process.env.CW_CLIENT_ID = "test-client";
process.env.CW_COMPANY_ID = "acme";
process.env.CW_COMPANY_URL = "cw.example.test";
process.env.CW_CODE_BASE = "v4_6_release";
// Set on purpose: even when an old integration key is still in the
// environment, no request may carry it.
process.env.CW_PUBLIC_KEY = "INTEGRATION-PUB"; process.env.CW_PRIVATE_KEY = "INTEGRATION-PRIV";

// The OpenAI SDK uses node-fetch, not globalThis.fetch, so the LLM gets a
// local stub server that records each prompt and answers "stub answer".
const llmRequests: any[] = [];
const llm = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    llmRequests.push(JSON.parse(body || "{}"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "x", object: "chat.completion", created: 0, model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "stub answer" }, finish_reason: "stop" }],
    }));
  });
});
await new Promise<void>((r) => llm.listen(0, "127.0.0.1", () => r()));
process.env.OPENROUTER_API_KEY = "k";
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(llm.address() as any).port}/v1`;

type Reply = { status: number; body?: unknown; raw?: string };
type Seen = { url: string; path: string; method: string; headers: Record<string, string> };
const seen: Seen[] = [];
let dataReply: (s: Seen) => Reply = () => ({ status: 200, body: {} });
let infoReply: (s: Seen) => Reply = () => ({ status: 200, body: { identifier: "SSmyth" } });

(globalThis as any).fetch = async (url: string, init: any = {}) => {
  const u = new URL(url);
  const s: Seen = { url, path: u.pathname.replace("/v4_6_release/apis/3.0", ""), method: init.method ?? "GET", headers: { ...(init.headers ?? {}) } };
  seen.push(s);
  const r = s.path === "/system/myMembers/info" ? infoReply(s) : dataReply(s);
  return new Response(r.raw ?? (r.body === undefined ? "" : JSON.stringify(r.body)), { status: r.status });
};

const logs: string[] = [];
for (const level of ["log", "info", "warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
    if (level === "log") orig(...args);
  };
}

// Namespace imports so each test fails on its own if an export is missing.
const session = (await import("../src/lib/session.ts")) as any;
const cw = (await import("../src/lib/connectwise.ts")) as any;
const ticket = (await import("../src/actions/ticket.ts")) as any;
const chat = (await import("../src/actions/chat.ts")) as any;

let fails = 0;
async function t(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log("PASS", name); } catch (e: any) { fails++; console.log("FAIL", name, "-", e?.message); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const hash = (n: number) => `abcdef12-0000-4000-8000-${String(n).padStart(12, "0")}`;
const INTEGRATION_B64 = Buffer.from("acme+INTEGRATION-PUB:INTEGRATION-PRIV").toString("base64");
const dataCalls = () => seen.filter((s) => s.path !== "/system/myMembers/info");

function noIntegrationKey(calls: Seen[]) {
  for (const c of calls) {
    for (const [k, v] of Object.entries(c.headers)) {
      assert(!String(v).includes(INTEGRATION_B64), `integration key sent in ${k}`);
      assert(!String(v).includes("INTEGRATION-"), `integration key value sent in ${k}`);
      assert(!/^x-cw-/i.test(k), `old impersonation header ${k} sent`);
    }
  }
}

async function newSession(n: number, memberContext = "Q7z") {
  infoReply = () => ({ status: 200, body: { identifier: "SSmyth" } });
  return session.verifyMember({ memberId: "SSmyth", memberHash: hash(n), memberContext });
}

const REPORT_COLUMNS = ["TicketNbr", "Summary", "date_entered", "Closed_Flag", "status_description", "config_recids"];
function reportBody(recids: string[]) {
  return {
    column_definitions: REPORT_COLUMNS.map((k) => ({ [k]: { type: "x", isNullable: true, identityColumn: false } })),
    row_values: recids.map((r, i) => [1000 + i, `T${i}`, "2026-09-01", false, "New", r]),
  };
}
// Answers an "id in (a,b,c)" ticket search with the ids `canOpen` allows.
function visibleIds(c: Seen, canOpen: (id: number) => boolean) {
  const cond = new URL(c.url).searchParams.get("conditions") ?? "";
  const m = /^id in \(([0-9,]+)\)$/.exec(cond);
  if (!m) throw new Error("unexpected ticket search: " + cond);
  return m[1].split(",").map(Number).filter(canOpen).map((id) => ({ id }));
}

// ---------------------------------------------------------------------------

await t("data calls send the member's cookies and no Authorization / integration key", async () => {
  const s = await newSession(1);
  seen.length = 0;
  dataReply = () => ({ status: 200, body: { id: 5, summary: "x" } });
  await cw.getTicket(s, 5);
  const calls = dataCalls();
  assert(calls.length === 1, `expected 1 data call, got ${calls.length}`);
  const h = calls[0].headers;
  assert(calls[0].path === "/service/tickets/5", "wrong path " + calls[0].path);
  assert(h.clientId === "test-client", "clientId header missing");
  assert(h.Cookie === `companyName=acme; memberId=SSmyth; memberHash=${hash(1)}; memberContext=Q7z`, "cookie not the verified session: " + h.Cookie);
  assert(!("Authorization" in h), "Authorization header sent: " + h.Authorization);
  noIntegrationKey(calls);
});

await t("every helper in the ticket context runs with the member session", async () => {
  const s = await newSession(2);
  seen.length = 0;
  dataReply = (c) => ({ status: 200, body: c.path.endsWith("/allNotes") || c.path.endsWith("/configurations") ? [] : { id: 9, summary: "x" } });
  await ticket.getTicketContext(s, 9);
  const calls = dataCalls();
  assert(calls.length === 3, `expected 3 data calls, got ${calls.length}`);
  for (const c of calls) assert(c.headers.Cookie?.includes(`memberHash=${hash(2)}`), `${c.path} without member cookie`);
  noIntegrationKey(calls);
});

await t("a call without a verified session never reaches ConnectWise", async () => {
  seen.length = 0;
  const forged = { memberId: "SSmyth", memberHash: hash(3), memberContext: "Q7z", method: "cookie" };
  for (const bad of [undefined, null, forged]) {
    let err: unknown;
    try { await cw.getTicket(bad, 5); } catch (e) { err = e; }
    assert(err instanceof session.AuthError, `session ${JSON.stringify(bad)} not refused with AuthError`);
  }
  assert(seen.length === 0, `fetch was called ${seen.length} times`);
});

await t("a CW 401 on a data call throws AuthError and drops the cached session", async () => {
  const creds = { memberId: "SSmyth", memberHash: hash(4), memberContext: "Q7z" };
  infoReply = () => ({ status: 200, body: { identifier: "SSmyth" } });
  const s = await session.verifyMember(creds);
  dataReply = () => ({ status: 401, body: { code: "Unauthorized", message: "CW-BODY-SECRET" } });
  let err: any;
  try { await cw.getTicket(s, 5); } catch (e) { err = e; }
  assert(err instanceof session.AuthError, "not an AuthError: " + err?.name);
  assert(!String(err.message).includes("CW-BODY-SECRET"), "CW body leaked into the error");
  seen.length = 0;
  await session.verifyMember(creds);
  assert(seen.some((c) => c.path === "/system/myMembers/info"), "cached session reused after a 401");
});

await t("a CW 403 on a data call gives the plain role message, not CW's body", async () => {
  const s = await newSession(5);
  dataReply = () => ({ status: 403, body: { code: "Forbidden", message: "CW-BODY-SECRET" } });
  let err: any;
  try { await cw.getTicket(s, 5); } catch (e) { err = e; }
  assert(err instanceof cw.CwForbiddenError, "not a CwForbiddenError: " + err?.name);
  assert(err.message === "Your ConnectWise security role does not allow this.", "message: " + err.message);
});

await t("processChat: a CW 403 gives the user the friendly message", async () => {
  infoReply = () => ({ status: 200, body: { identifier: "SSmyth" } });
  dataReply = () => ({ status: 403, body: { code: "Forbidden", message: "CW-BODY-SECRET" } });
  const r = await chat.processChat(
    { ticketId: 77, messages: [], userMessage: "hello" },
    { memberId: "SSmyth", memberHash: hash(6), memberContext: "Q7z" }
  );
  assert(r.error === "forbidden", "error: " + r.error);
  assert(r.message === "Your ConnectWise security role does not allow this.", "message: " + r.message);
});

await t("processChat: a CW 401 on a data call asks for fresh auth (unauthorised)", async () => {
  infoReply = () => ({ status: 200, body: { identifier: "SSmyth" } });
  dataReply = () => ({ status: 401, body: { code: "Unauthorized", message: "CW-BODY-SECRET" } });
  const r = await chat.processChat(
    { ticketId: 78, messages: [], userMessage: "hello" },
    { memberId: "SSmyth", memberHash: hash(7), memberContext: "Q7z" }
  );
  assert(r.error === "unauthorised", "error: " + r.error);
  assert(!r.message.includes("CW-BODY-SECRET"), "CW body leaked");
});

await t("data calls log method, path, member and status only", async () => {
  const s = await newSession(8);
  logs.length = 0;
  dataReply = () => ({ status: 200, body: { id: 5, summary: "x" } });
  await cw.getTicket(s, 5);
  dataReply = () => ({ status: 403, body: { message: "CW-BODY-SECRET" } });
  await cw.getTicket(s, 6).catch(() => undefined);
  assert(logs.includes("[cw] GET /service/tickets/5 as SSmyth -> 200"), "missing 200 log line: " + JSON.stringify(logs));
  assert(logs.includes("[cw] GET /service/tickets/6 as SSmyth -> 403"), "missing 403 log line: " + JSON.stringify(logs));
  for (const line of logs) {
    assert(!line.includes(hash(8)), "hash logged: " + line);
    assert(!line.includes("Q7z"), "memberContext logged: " + line);
    assert(!line.includes("CW-BODY-SECRET"), "CW body logged: " + line);
  }
});

await t("config filter: 12 matches only whole list items", async () => {
  assert(typeof cw.configRecidsInclude === "function", "configRecidsInclude missing");
  for (const v of ["12", "12,5", "5,12", "5,12,7"]) assert(cw.configRecidsInclude(v, 12) === true, `'${v}' should match 12`);
  for (const v of ["112", "120", "312", "5,112", "1,2", "", null, undefined]) assert(cw.configRecidsInclude(v, 12) === false, `'${v}' should not match 12`);
});

await t("/config report: exact conditions sent and wrong rows dropped", async () => {
  const s = await newSession(9);
  seen.length = 0;
  const recids = ["12", "112", "5,12", "1,2", "120", "5,12,7", "312", "5,112", "12,5"];
  dataReply = (c) =>
    c.path === "/system/reports/Service"
      ? { status: 200, body: reportBody(recids) }
      : { status: 200, body: visibleIds(c, () => true) };
  const out = await cw.getConfigurationTickets(s, 12);
  const ids = out.map((x: any) => x.id).sort();
  assert(JSON.stringify(ids) === JSON.stringify([1000, 1002, 1005, 1008]), "wrong tickets: " + JSON.stringify(ids));
  const [call, recheck] = dataCalls();
  assert(call.path === "/system/reports/Service", "wrong path " + call.path);
  const conditions = new URL(call.url).searchParams.get("conditions");
  assert(
    conditions === "(config_recids = '12' or config_recids like '12,%' or config_recids like '%,12' or config_recids like '%,12,%')",
    "conditions: " + conditions
  );
  assert(call.headers.Cookie?.includes(`memberHash=${hash(9)}`), "report call without member cookie");
  // Only the exact matches are re-checked, as the same member.
  assert(recheck?.path === "/service/tickets", "no /service/tickets re-check");
  assert(new URL(recheck.url).searchParams.get("conditions") === "id in (1000,1002,1005,1008)", "re-check conditions: " + recheck.url);
  assert(recheck.headers.Cookie === call.headers.Cookie, "re-check not sent with the member session");
  noIntegrationKey([call, recheck]);
});

await t("/config: report rows the member cannot open through /service/tickets are dropped", async () => {
  const s = await newSession(13);
  seen.length = 0;
  dataReply = (c) =>
    c.path === "/system/reports/Service"
      ? { status: 200, body: reportBody(["12", "5,12", "12,7"]) }
      : { status: 200, body: visibleIds(c, (id) => id !== 1001) };
  const out = await cw.getConfigurationTickets(s, 12);
  const ids = out.map((x: any) => x.id).sort();
  assert(JSON.stringify(ids) === JSON.stringify([1000, 1002]), "ticket the member cannot open kept: " + JSON.stringify(ids));
});

await t("/config: no report rows means no re-check call", async () => {
  const s = await newSession(14);
  seen.length = 0;
  dataReply = () => ({ status: 200, body: reportBody(["112", "1,2"]) });
  const out = await cw.getConfigurationTickets(s, 12);
  assert(out.length === 0, "rows returned: " + out.length);
  assert(dataCalls().length === 1, "extra calls: " + dataCalls().map((c) => c.path).join(","));
});

await t("/config: a Report API 403 degrades to 'Unable to fetch configuration history'", async () => {
  const s = await newSession(10);
  dataReply = () => ({ status: 403, body: { message: "CW-BODY-SECRET" } });
  const text = await ticket.getConfigHistoryText(s, [{ id: 12, name: "PC-12" }], 77);
  assert(typeof text === "string" && text.startsWith("Unable to fetch configuration history"), "got: " + text);
  assert(!text.includes("CW-BODY-SECRET"), "CW body leaked");
});

await t("/config: when every lookup errors, say so rather than 'no history'", async () => {
  const s = await newSession(15);
  dataReply = () => ({ status: 500, body: { message: "CW-BODY-SECRET" } });
  const text = await ticket.getConfigHistoryText(s, [{ id: 12, name: "PC-12" }, { id: 13, name: "PC-13" }], 77);
  assert(text === "Unable to fetch configuration history due to an error.", "got: " + text);
});

await t("similar search: quotes in ticket text cannot break out of the conditions literal", async () => {
  const s = await newSession(11);
  seen.length = 0;
  dataReply = () => ({ status: 200, body: [] });
  await cw.searchSimilarTickets(s, `Printer" or company/id!=0 or summary like "jammed' paper`, 4, 77, 90);
  const conditions = new URL(dataCalls()[0].url).searchParams.get("conditions") ?? "";
  assert(!conditions.includes("'"), "single quote in conditions: " + conditions);
  const literals = conditions.match(/"[^"]*"/g) ?? [];
  for (const lit of literals) assert(/^"%[a-z0-9]+%"$/.test(lit), "unsafe literal " + lit);
  assert(conditions.split('"').length - 1 === literals.length * 2, "stray quote: " + conditions);
  assert(!conditions.includes("company/id!=0"), "injected condition survived: " + conditions);
  let err: unknown;
  try { await cw.searchSimilarTickets(s, "printer jammed paper", "4 or 1=1", 77, 90); } catch (e) { err = e; }
  assert(err, "non-integer companyId accepted");
});

await t("a cached member presented with a different hash goes back to CW and is refused", async () => {
  infoReply = () => ({ status: 200, body: { identifier: "Alice" } });
  const alice = await session.verifyMember({ memberId: "Alice", memberHash: hash(20), memberContext: "Q7z" });
  // CW now accepts only Alice's real hash.
  infoReply = (c) => {
    const basic = c.headers.Authorization ? Buffer.from(c.headers.Authorization.slice(6), "base64").toString() : "";
    return (c.headers.Cookie ?? basic).includes(hash(20)) ? { status: 200, body: { identifier: "Alice" } } : { status: 401 };
  };
  seen.length = 0;
  let err: unknown, got: unknown;
  try { got = await session.verifyMember({ memberId: "ALICE", memberHash: hash(21), memberContext: "Q7z" }); } catch (e) { err = e; }
  assert(err instanceof session.AuthError, "a different hash was accepted");
  assert(got !== alice, "the cached session was handed out");
  assert(seen.some((c) => c.path === "/system/myMembers/info"), "ConnectWise was not asked");
  // The real hash still gets the cached session without another CW call.
  seen.length = 0;
  const again = await session.verifyMember({ memberId: "alice", memberHash: hash(20), memberContext: "Q7z" });
  assert(again === alice, "cached session not reused for the same member and hash");
  assert(seen.length === 0, "CW asked again for a cached session");
});

await t("data calls send the memberId exactly as verified; logs use CW's spelling", async () => {
  infoReply = () => ({ status: 200, body: { identifier: "SSmyth" } });
  seen.length = 0;
  const s = await session.verifyMember({ memberId: "ssmyth", memberHash: hash(22), memberContext: "Q7z" });
  assert(s.memberId === "SSmyth", "session.memberId " + s.memberId);
  const proven = seen.find((c) => c.path === "/system/myMembers/info");
  assert(proven?.headers.Cookie?.includes("memberId=ssmyth;"), "verification cookie: " + proven?.headers.Cookie);
  seen.length = 0;
  logs.length = 0;
  dataReply = () => ({ status: 200, body: { id: 5, summary: "x" } });
  await cw.getTicket(s, 5);
  assert(dataCalls()[0].headers.Cookie === proven!.headers.Cookie, "data cookie differs from the one CW accepted: " + dataCalls()[0].headers.Cookie);
  assert(logs.includes("[cw] GET /service/tickets/5 as SSmyth -> 200"), "log line: " + JSON.stringify(logs));
});

await t("a session verified in the URL-encoded cookie form sends that exact cookie on data calls", async () => {
  const ctx = "a=b/c+d";
  const enc = encodeURIComponent(ctx);
  infoReply = (c) => (c.headers.Cookie?.includes(`memberContext=${enc}`) ? { status: 200, body: { identifier: "SSmyth" } } : { status: 401 });
  seen.length = 0;
  const s = await session.verifyMember({ memberId: "SSmyth", memberHash: hash(23), memberContext: ctx });
  assert(s.method === "cookie-encoded", "method " + s.method);
  const proven = seen.find((c) => c.path === "/system/myMembers/info" && c.headers.Cookie?.includes(enc));
  assert(proven, "no encoded verification call");
  seen.length = 0;
  dataReply = () => ({ status: 200, body: { id: 5, summary: "x" } });
  await cw.getTicket(s, 5);
  const h = dataCalls()[0].headers;
  assert(h.Cookie === proven!.headers.Cookie, "data cookie differs: " + h.Cookie);
  assert(!("Authorization" in h), "Authorization header sent");
  noIntegrationKey(dataCalls());
});

await t("a 200 with a body that is not JSON gives CwApiError and logs none of the body", async () => {
  const s = await newSession(15);
  logs.length = 0;
  dataReply = () => ({ status: 200, raw: "<!DOCTYPE html><p>CW-BODY-SECRET</p>" });
  let err: any;
  try { await cw.getTicket(s, 5); } catch (e) { err = e; }
  assert(err instanceof cw.CwApiError, "not a CwApiError: " + err?.name);
  assert(!/DOCTYPE|CW-BODY-SECRET/.test(err.message), "body in error: " + err.message);
  assert(logs.includes("[cw] GET /service/tickets/5 as SSmyth -> 200 (invalid JSON)"), "log line: " + JSON.stringify(logs));
  for (const line of logs) assert(!/DOCTYPE|CW-BODY-SECRET/.test(line), "body logged: " + line);
});

await t("a role without notes or configurations rights still gets an answer", async () => {
  infoReply = () => ({ status: 200, body: { identifier: "SSmyth" } });
  dataReply = (c) =>
    c.path === "/service/tickets/79"
      ? { status: 200, body: { id: 79, summary: "Printer offline" } }
      : { status: 403, body: { message: "CW-BODY-SECRET" } };
  llmRequests.length = 0;
  const r = await chat.processChat(
    { ticketId: 79, messages: [], userMessage: "hello" },
    { memberId: "SSmyth", memberHash: hash(16), memberContext: "Q7z" }
  );
  assert(!r.error, "error: " + r.error + " " + r.message);
  assert(r.message === "stub answer", "message: " + r.message);
  const prompt = JSON.stringify(llmRequests[0]?.messages ?? []);
  assert(prompt.includes("does not allow reading this ticket's notes"), "prompt does not say notes are hidden");
  assert(prompt.includes("does not allow reading this ticket's configurations"), "prompt does not say configurations are hidden");
  assert(!prompt.includes("CW-BODY-SECRET"), "CW body reached the LLM");
});

await t("/config with configurations hidden says so and makes no Report API call", async () => {
  infoReply = () => ({ status: 200, body: { identifier: "SSmyth" } });
  dataReply = (c) =>
    c.path === "/service/tickets/80"
      ? { status: 200, body: { id: 80, summary: "Laptop slow" } }
      : c.path === "/service/tickets/80/allNotes"
        ? { status: 200, body: [] }
        : { status: 403 };
  llmRequests.length = 0;
  seen.length = 0;
  const r = await chat.processChat(
    { ticketId: 80, messages: [], userMessage: "/config" },
    { memberId: "SSmyth", memberHash: hash(17), memberContext: "Q7z" }
  );
  assert(!r.error, "error: " + r.error + " " + r.message);
  assert(r.slashCommand === "/config", "slashCommand " + r.slashCommand);
  const prompt = JSON.stringify(llmRequests[0]?.messages ?? []);
  assert(typeof ticket.CONFIG_HIDDEN_TEXT === "string" && prompt.includes(ticket.CONFIG_HIDDEN_TEXT), "config history text missing from prompt");
  assert(!dataCalls().some((c) => c.path === "/system/reports/Service"), "Report API called anyway");
});

await t("CW error text in the verification log cannot add lines or show the hash", async () => {
  infoReply = () => ({
    status: 401,
    body: { code: `Unauthorized ${hash(18)}\n[auth] member Boss verified`, message: `bad hash ${hash(18)}\r\n[auth] fake line` },
  });
  logs.length = 0;
  await session.verifyMember({ memberId: "Mallory", memberHash: hash(18), memberContext: "Q7z" }).catch(() => undefined);
  assert(logs.length > 0, "nothing logged");
  for (const line of logs) {
    assert(!/[\r\n]/.test(line), "control character in log line: " + JSON.stringify(line));
    assert(!line.includes(hash(18)), "hash logged: " + line);
  }
});

// Last: once a member verifies by Basic auth the pod prefers it for everyone.
await t("a Basic-auth member session sends companyId+memberId:memberHash, never the integration key", async () => {
  infoReply = (c) => (c.headers.Authorization ? { status: 200, body: { identifier: "SSmyth" } } : { status: 401 });
  const s = await session.verifyMember({ memberId: "SSmyth", memberHash: hash(12), memberContext: "Q7z" });
  assert(s.method === "basic", "method " + s.method);
  seen.length = 0;
  dataReply = () => ({ status: 200, body: { id: 5, summary: "x" } });
  await cw.getTicket(s, 5);
  const h = dataCalls()[0].headers;
  assert(h.Authorization === `Basic ${Buffer.from(`acme+SSmyth:${hash(12)}`).toString("base64")}`, "wrong Basic header");
  noIntegrationKey(dataCalls());
});

llm.close();
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
