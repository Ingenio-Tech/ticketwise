# CLAUDE.md - TicketWise

TicketWise is an AI-powered assistant for ConnectWise PSA technicians. It runs as an iframe pod inside CW service tickets, using OpenRouter for LLM inference (via the OpenAI-compatible SDK). Built with Next.js 15, React 19, TypeScript, and Tailwind CSS 4.

## Quick Start

```bash
cp .env.example .env     # Fill in CW client/company settings and OpenRouter key
npm install
npm run dev              # http://localhost:3000
```

The app requires a ConnectWise iframe context to authenticate. Running standalone shows a "Pod Mode Only" message. For local development, you need a CW Hosted API entry pointing to your dev URL, or manually set auth cookies.

## Key Architecture

- **Client components** (`pod.tsx`, `chat.tsx`, `use-hosted-api.ts`): UI and CW postMessage handshake
- **Server actions** (`actions/auth.ts`, `actions/chat.ts`): cookie management, chat, AI calls. Every exported action is callable by anyone on the internet, so each one that reaches CW or the LLM must call `requireMember()` from `lib/session.ts` first. `actions/ticket.ts` holds plain server helpers (not `"use server"`), so they are not callable from the browser.
- **Member check** (`lib/session.ts`): proves the Hosted API memberId/memberHash/memberContext with a CW call to `/system/myMembers/info` (cookie auth, then Basic `companyId+memberId:memberHash`) and requires the identifier CW returns to match the claimed memberId. Company always from `CW_COMPANY_ID`. CW needs the memberContext cookie for browser sessions. Returns a `MemberSession`: CW's spelling of the memberId (for logs and rate limits), the hash, the context and the header form CW accepted. The exact credentials CW accepted (the memberId as the caller spelled it) stay in a private `WeakMap` beside the session, and data calls send those bytes. Good results (the session itself) are cached 5 minutes, keyed by a SHA-256 of company, member and hash; bad ones 1 minute, with per-member and global failure limits.
- **CW data calls** (`lib/connectwise.ts`): every function takes the `MemberSession` from `requireMember()` as its first argument and sends it with `cwSessionHeaders()`, the same header builder the member check uses. CW then applies the member's own security role. There is no integration key and no call without a session: `cwSessionHeaders()` refuses any object `verifyMember()` did not create. CW 401 throws `AuthError` and drops the cached session; `processChat` returns `unauthorised` and the pod calls `requestAuth()` for fresh credentials (`onAuthExpired` in `chat.tsx`). CW 403 throws `CwForbiddenError` ("Your ConnectWise security role does not allow this."). A 2xx whose body is not JSON throws `CwApiError`. CW error bodies are never logged or shown. Each call logs `[cw] GET /service/tickets/123 as <memberId> -> <status>` and nothing more.
- **Ticket context** (`actions/ticket.ts`): `getTicketContext` needs only the ticket. A 403 on notes or configurations leaves them out and lists them in `hidden`, which `formatTicketForAI` tells the AI about; a 403 on the ticket stops the request. `/similar` and `/config` degrade to a note in the AI context in the same way.
- **Logging**: anything from the client or from CW that goes into a log line passes through `logSafe()` (`lib/session.ts`), which strips control characters and caps the length.
- **Libraries** (`lib/ai.ts`, `lib/connectwise.ts`, `lib/env.ts`, `lib/format.ts`): OpenRouter client, CW REST client, env validation, data formatting

AI calls go through OpenRouter via the OpenAI-compatible SDK (`openai` npm package with `baseURL: "https://openrouter.ai/api/v1"`).

## Common Tasks

### Add a new slash command
1. Add entry to `SLASH_COMMANDS` in `src/lib/ai.ts` with `description` and `prompt`
2. If the command needs extra context (like `/similar` or `/config`), add data fetching in `src/actions/chat.ts` within `processChat()`
3. The command auto-appears in the UI dropdown — no changes needed in `chat.tsx`

### Change the LLM model
Set `OPENROUTER_MODEL` env var to any model available on OpenRouter (e.g. `anthropic/claude-sonnet-4`, `openai/gpt-4o`).

### Add a new CW API endpoint
1. Add types to `src/lib/connectwise.ts`
2. Create a function that takes `session: MemberSession` first and calls `cwGet<T>(session, ...)` or `cwPost<T>(session, ...)`
3. Call it from a server action in `src/actions/`, passing the session that action got from `requireMember()`
4. The member's CW security role decides what the call may do; handle `CwForbiddenError` where a feature should degrade instead of failing

### Modify the system prompt
Edit `SYSTEM_PROMPT` in `src/lib/ai.ts`. The prompt enforces British English, Markdown formatting, and strict data-only responses.

## Important Gotchas

- **CW postMessage protocol**: Messages must be `JSON.stringify`'d. Use `hosted_request` key, not `request`. CW silently ignores the wrong key.
- **CW auth response**: The response key is lowercase `"getmemberauthentication"` — case-insensitive comparison required.
- **X-Frame-Options**: Next.js 15 defaults to `SAMEORIGIN`, which blocks CW iframe embedding. Overridden in both `next.config.ts` and `middleware.ts`.
- **Cookie SameSite**: Must be `"none"` + `secure: true` for cross-site iframe cookies to work.
- **Rate limiting**: In-memory only (30 req/min/member). Does not survive restarts or work across multiple instances.
- **Clipboard in iframes**: `navigator.clipboard` API is blocked in cross-origin iframes. Use `document.execCommand('copy')` with range selection instead — copies rich text (HTML formatting preserved).
- **Reasoning models**: Models like `kimi-k2.5` spend most completion tokens on internal reasoning. `max_completion_tokens` must be high enough (4096+) to leave room for content output after reasoning, especially on complex prompts like `/5whys` with large ticket contexts.
- **Similar ticket search**: Extracts keywords from summary, filters stop words, searches CW with `like` conditions. Keywords are cut down to `a-z0-9`, and ids in the conditions must be integers, so ticket text cannot break out of the conditions string. Results sorted closed-first.
- **Report API**: Used for config ticket history (`/system/reports/Service`) because it supports querying by `config_recids`; the main tickets API doesn't. `config_recids` is a comma-separated list of integer ids with no spaces (`12`, `5,12`, `5,12,7`). Match the id as a whole list item (`= '12'`, `like '12,%'`, `like '%,12'`, `like '%,12,%'`) and re-check each row in code with `configRecidsInclude()`; `like '%12%'` also matched 112, 120 and 312, which mixed other devices' tickets into `/config`. `keepVisibleTickets()` then asks `/service/tickets` (`id in (...)`, same member) which of those tickets the member can open and drops the rest, in case the Report API applies looser limits than the tickets API. Needs Report API rights in the member's role; without them `/config` says "Unable to fetch configuration history".
- **Nixpacks start command**: Keep `"start": "next start"` in package.json. `node .next/standalone/server.js` breaks static file serving under Nixpacks.

- **Adding a Server Action**: start it with `await requireMember(credentials)` and validate its input with Zod. Never add `"use server"` to a module whose exports skip that check.

## Testing

Each test file mocks ConnectWise with a fake `fetch`. Run all three after any change to `lib/session.ts`, `lib/connectwise.ts`, `lib/env.ts` or `actions/`:

```bash
npx tsx tests/session-identity.test.mts      # member check: identity match, memberContext, refusals
npx tsx tests/member-session-calls.test.mts  # data calls send the member session, never a key; 401/403; hidden notes/configs; /config filter and re-check; conditions escaping; log safety
npx tsx tests/no-integration-key.test.mts    # the app loads with no CW_PUBLIC_KEY/CW_PRIVATE_KEY
```

Other testing is manual and requires a ConnectWise PSA instance with:
1. A Hosted API entry pointing to the app URL
2. At least one service ticket with notes
3. A technician whose security role can read service tickets, configurations and (for `/config`) the Report API

## Environment Variables

See `.env.example` for all required variables. Key ones:
- `OPENROUTER_API_KEY` — OpenRouter key (starts with `sk-or-v1-`)
- `OPENROUTER_MODEL` — defaults to `moonshotai/kimi-k2.5:nitro`
- `CW_CLIENT_ID`, `CW_COMPANY_ID`, `CW_COMPANY_URL`, `CW_CODE_BASE`: ConnectWise client and company settings. There are no CW API keys: calls run as the signed-in member. `CW_PUBLIC_KEY` and `CW_PRIVATE_KEY` are no longer read; the app logs a warning if they are still set
- `HOSTNAME=0.0.0.0` — required in production for container binding
