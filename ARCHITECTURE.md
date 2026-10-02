# TicketWise - Architecture

## System Overview

```
┌─────────────────────────────────────────────────────┐
│  ConnectWise PSA (Browser)                          │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │  Service Ticket View                        │    │
│  │                                             │    │
│  │  ┌───────────────────────────────────────┐  │    │
│  │  │  TicketWise Pod (iframe)              │  │    │
│  │  │  https://your-domain.com              │  │    │
│  │  └───────────────┬───────────────────────┘  │    │
│  └──────────────────┼──────────────────────────┘    │
│                     │ postMessage                    │
└─────────────────────┼───────────────────────────────┘
                      │
         ┌────────────▼────────────┐
         │  Next.js App            │
         │  Server Actions         │
         │                         │
         │  ┌───────┐ ┌─────────┐  │
         │  │ Auth  │ │  Chat   │  │
         │  └───┬───┘ └────┬────┘  │
         │      │          │       │
         └──────┼──────────┼───────┘
                │          │
        ┌───────▼──┐  ┌────▼──────┐
        │ CW API   │  │ OpenRouter│
        │ (REST)   │  │ (LLM)    │
        └──────────┘  └──────────┘
```

## Data Flow

### Authentication Flow

```
1. Page loads → Pod component mounts
2. useHostedApi hook sends: { message: "ready" } to parent (targetOrigin: "*")
3. CW parent responds with: { MessageFrameID: "..." }
4. App stores frameID, marks ready
5. App sends: { hosted_request: "getMemberAuthentication", frameID: "..." }
6. CW responds with: { response: "getmemberauthentication", data: MemberAuth }
7. Server checks the credentials with CW (/system/myMembers/info, identity must match), then stores them in HTTP-only cookies (8hr expiry)
8. Each Server Action re-checks the member (cached 5 min) and runs every CW call with that member's verified session
```

Key protocol details:
- CW sends/expects JSON **strings** (must `JSON.parse`/`JSON.stringify`)
- Outgoing requests use `hosted_request` key, not `request` (CW silently ignores `request`)
- Auth response key is lowercase: `"getmemberauthentication"`
- Origin validation against allowed CW domains only

### Chat / Slash Command Flow

```
User types message
    │
    ▼
Chat component (client)
    │ processChat() server action
    ▼
Rate limit check (30/min per member)
    │
    ▼
Detect slash command (if starts with /)
    │
    ▼
Fetch ticket context (parallel), as the member:
  ├── getTicket(id)                  (403 stops the request)
  ├── getTicketNotes(id)             (403: left out, marked hidden)
  └── getTicketConfigurations(id)    (403: left out, marked hidden)
    │
    ▼
Format ticket as markdown for AI
    │
    ▼
If /similar: searchSimilarTickets()
  ├── Company tickets (90-day window)
  ├── Global tickets (14-day window, if <3 company results)
  └── Fetch notes for closed matches (to find actual resolution)
    │
If /config: getConfigurationTickets()
  ├── Report API query by config_recids (whole list item, re-checked in code)
  └── /service/tickets?conditions=id in (...) keeps only tickets the member can open
    │
    ▼
Build LLM chat messages:
  [system prompt, ticket context, conversation history, slash command prompt]
    │
    ▼
OpenRouter API call (via OpenAI-compatible SDK)
  model: OPENROUTER_MODEL (default: moonshotai/kimi-k2.5:nitro)
  temperature: 0.3
  max_completion_tokens: 4096
    │
    ▼
Return response to client → render as Markdown
```

## Key Files

```
src/
├── app/
│   ├── page.tsx                # Entry point — renders Pod with URL params
│   ├── layout.tsx              # Root layout (Manrope font, metadata)
│   └── api/health/route.ts     # GET /api/health → { status: "healthy" }
│
├── components/
│   ├── pod.tsx                 # Pod wrapper — auth flow, loading/error states
│   └── chat.tsx                # Chat UI — messages, input, slash command dropdown, copy
│
├── hooks/
│   └── use-hosted-api.ts       # CW postMessage handshake, origin validation
│
├── lib/
│   ├── env.ts                  # Zod env validation (CW settings, OpenRouter, Node)
│   ├── ai.ts                   # OpenRouter client, system prompt, slash commands
│   ├── connectwise.ts          # CW REST API client, types, search functions
│   └── format.ts               # Ticket/note/config → markdown for AI context
│
├── actions/
│   ├── auth.ts                 # setAuthCookies, clearAuthCookies, checkAuth
│   ├── chat.ts                 # processChat (rate limit, context, AI call)
│   └── ticket.ts               # getTicketContext, findSimilar*, getConfigHistory
│
└── middleware.ts               # Security headers (CSP, X-Frame-Options removal)
```

### Server vs Client Boundary

| File | Side | Why |
|------|------|-----|
| `pod.tsx`, `chat.tsx` | Client (`"use client"`) | Interactive UI, postMessage, DOM |
| `use-hosted-api.ts` | Client | Browser postMessage API |
| `auth.ts`, `chat.ts` | Server (`"use server"`) | Cookies, member check, chat. Each action calls `requireMember()` first |
| `ticket.ts` | Server helpers (never `"use server"`) | Called only by `processChat`, with a verified member session |
| `ai.ts`, `connectwise.ts`, `env.ts`, `format.ts`, `session.ts` | Server (imported by actions) | LLM key, member session, external APIs. The only CW credentials are the member's own session |

## ConnectWise API Integration

### Authentication Method

Every call runs as the signed-in member, with the Hosted API credentials ConnectWise accepted when `lib/session.ts` verified them. ConnectWise applies the member's security role. There is no integration key.

```
clientId: CW_CLIENT_ID
Cookie: companyName=<CW_COMPANY_ID>; memberId=<member>; memberHash=<hash>; memberContext=<context>
```

If ConnectWise accepted another form during verification (URL-encoded cookies, cookies without memberContext, or `Authorization: Basic base64(companyId+memberId:memberHash)`), data calls use that same form. A 401 means the session expired: the pod asks ConnectWise for fresh credentials and the server verifies them again. A 403 means the member's role does not allow the call.

### API Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `GET /service/tickets/{id}` | Fetch ticket details |
| `GET /service/tickets/{id}/allNotes` | All notes (description, internal, resolution) |
| `GET /service/tickets/{id}/configurations` | Attached configurations |
| `GET /service/tickets?conditions=...` | Search similar tickets |
| `GET /company/configurations/{id}` | Configuration details |
| `GET /system/reports/Service` | Query tickets by config_recids (Report API; needs Report API rights in the member's role) |

### Similar Ticket Search

Keywords are extracted from the ticket summary (stop words filtered), then searched via CW conditions:
```
dateEntered>=[date] and company/id=X and (summary like "%keyword1%" or summary like "%keyword2%")
```

Results are sorted to prioritise closed/resolved tickets (they have solutions).

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `CW_CLIENT_ID` | Yes | — | ConnectWise Developer Client ID |
| `CW_COMPANY_ID` | Yes | — | Company ID for API auth |
| `CW_COMPANY_URL` | Yes | — | CW cloud instance (e.g. `eu.myconnectwise.net`) |
| `CW_CODE_BASE` | No | `v4_6_release` | CW API version path |
| `OPENROUTER_API_KEY` | Yes | — | OpenRouter API key (`sk-or-v1-...`) |
| `OPENROUTER_MODEL` | No | `moonshotai/kimi-k2.5:nitro` | LLM model identifier |
| `NODE_ENV` | No | `development` | Environment mode |
| `HOSTNAME` | Yes (prod) | — | Must be `0.0.0.0` for container binding |
