// The app must load with no ConnectWise integration key in the environment:
// every CW call runs with the signed-in member's session instead.
// Run: npx tsx tests/no-integration-key.test.mts
process.env.CW_CLIENT_ID = "test-client";
process.env.CW_COMPANY_ID = "acme";
process.env.CW_COMPANY_URL = "cw.example.test";
process.env.CW_CODE_BASE = "v4_6_release";
delete process.env.CW_PUBLIC_KEY;
delete process.env.CW_PRIVATE_KEY;
process.env.OPENROUTER_API_KEY = "k";

(globalThis as any).fetch = async () => {
  throw new Error("no network in this test");
};

let fails = 0;
async function t(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log("PASS", name); } catch (e: any) { fails++; console.log("FAIL", name, e?.message); }
}

for (const mod of [
  "../src/lib/env.ts",
  "../src/lib/session.ts",
  "../src/lib/connectwise.ts",
  "../src/actions/ticket.ts",
  "../src/actions/chat.ts",
  "../src/actions/auth.ts",
]) {
  await t(`${mod} imports with CW_PUBLIC_KEY/CW_PRIVATE_KEY unset`, async () => {
    await import(mod);
  });
}

await t("env no longer carries an integration key", async () => {
  const { env } = (await import("../src/lib/env.ts")) as any;
  if ("CW_PUBLIC_KEY" in env || "CW_PRIVATE_KEY" in env) throw new Error("env still has CW_PUBLIC_KEY/CW_PRIVATE_KEY");
});

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
