process.env.CW_CLIENT_ID = "test-client";
process.env.CW_COMPANY_ID = "acme";
process.env.CW_COMPANY_URL = "cw.example.test";
process.env.CW_CODE_BASE = "v4_6_release";
process.env.CW_PUBLIC_KEY = "pub"; process.env.CW_PRIVATE_KEY = "priv";
process.env.OPENROUTER_API_KEY = "k";

type Reply = { status: number; body?: unknown };
let script: (url: string, headers: Record<string, string>) => Reply;
const seen: { url: string; cookie?: string; auth?: string }[] = [];
(globalThis as any).fetch = async (url: string, init: any) => {
  const h = init.headers as Record<string, string>;
  seen.push({ url, cookie: h.Cookie, auth: h.Authorization });
  const r = script(url, h);
  return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
};

const { verifyMember } = await import("../src/lib/session.ts");
let fails = 0;
async function t(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log("PASS", name); } catch (e: any) { fails++; console.log("FAIL", name, e?.message); }
}
const hash = (n: number) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;

await t("matching identity verifies, cookie carries 3-char memberContext, hits myMembers/info", async () => {
  seen.length = 0;
  script = () => ({ status: 200, body: { identifier: "SSmyth", id: 1 } });
  const r = await verifyMember({ memberId: "SSmyth", memberHash: hash(1), memberContext: "web" });
  if (r.memberId !== "SSmyth") throw new Error("wrong member " + r.memberId);
  if (!seen[0].url.endsWith("/system/myMembers/info")) throw new Error("wrong url " + seen[0].url);
  if (!seen[0].cookie?.includes("memberContext=web")) throw new Error("context not sent");
});
await t("hash of another member under a claimed memberId is refused", async () => {
  script = () => ({ status: 200, body: { identifier: "HCollier", id: 2 } });
  try { await verifyMember({ memberId: "SSmyth", memberHash: hash(2), memberContext: "web" }); } catch { return; }
  throw new Error("accepted a mismatched identity");
});
await t("identifier compare ignores case and returns CW's spelling", async () => {
  script = () => ({ status: 200, body: { identifier: "SSmyth" } });
  const r = await verifyMember({ memberId: "ssmyth", memberHash: hash(3), memberContext: "web" });
  if (r.memberId !== "SSmyth") throw new Error("got " + r.memberId);
});
await t("200 with no identifier is refused", async () => {
  script = () => ({ status: 200, body: { foo: 1 } });
  try { await verifyMember({ memberId: "SSmyth", memberHash: hash(4), memberContext: "web" }); } catch { return; }
  throw new Error("accepted");
});
await t("401 everywhere is refused", async () => {
  script = () => ({ status: 401, body: { code: "Unauthorized", message: "Authorization is required" } });
  try { await verifyMember({ memberId: "SSmyth", memberHash: hash(5), memberContext: "web" }); } catch { return; }
  throw new Error("accepted");
});
await t("only the encoded cookie form works: verified via diagnose with identity check", async () => {
  seen.length = 0;
  script = (_u, h) => (h.Cookie && h.Cookie.includes("memberHash=0000000") && h.Cookie.includes("%") ? { status: 200, body: { identifier: "HCollier" } } : { status: 401 });
  // context with a character that encodeURIComponent changes, so the encoded form differs
  const r = await verifyMember({ memberId: "HCollier", memberHash: hash(6), memberContext: "desk@top" }).catch(() => null);
  if (!r || r.memberId !== "HCollier") throw new Error("not verified via fallback");
});
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
