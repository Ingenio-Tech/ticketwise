import { z } from "zod";

const envSchema = z.object({
  // ConnectWise
  CW_CLIENT_ID: z.string().min(1, "ConnectWise Client ID required"),
  CW_COMPANY_ID: z.string().min(1, "ConnectWise Company ID required"),
  CW_COMPANY_URL: z.string().min(1, "ConnectWise Company URL required"),
  CW_CODE_BASE: z.string().default("v4_6_release"),
  // No API keys: every ConnectWise call runs with the signed-in member's own
  // Hosted API session (see lib/session.ts), so there is no integration key.
  
  // OpenRouter
  OPENROUTER_API_KEY: z.string().min(1, "OpenRouter API key required"),
  OPENROUTER_MODEL: z.string().default("moonshotai/kimi-k2.5:nitro"),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  
  // App
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

// Validate at runtime
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables");
}

// The old integration key is no longer read. Warn so it gets removed from
// the deployment (and revoked in ConnectWise) rather than left lying about.
if (process.env.CW_PUBLIC_KEY || process.env.CW_PRIVATE_KEY) {
  console.warn("[env] CW_PUBLIC_KEY / CW_PRIVATE_KEY are set but unused; remove them from the environment.");
}

export const env = parsed.data;
