# TicketWise 🎫

An open-source AI chat assistant that lives inside ConnectWise PSA as a pod on the service ticket screen. Technicians can chat naturally about the ticket they're viewing — ask questions, get context, work through problems — and use slash commands for common tasks like summaries, similar ticket searches, and troubleshooting suggestions. All without leaving the ticket.

<img width="764" height="561" alt="image" src="https://github.com/user-attachments/assets/eecf824f-b14f-46f9-9090-48a481c825eb" />


## The Problem

Service desk technicians waste significant time context-switching: reading through long ticket note threads, searching for similar past issues, checking whether a device has a recurring problem, and figuring out what to try next. The information exists in ConnectWise, but it's scattered across notes, configurations, and historical tickets.

TicketWise pulls it all together and puts an AI assistant right where the tech is already working.

## How It Works

TicketWise embeds as a pod (iframe) directly in the ConnectWise service ticket screen. When a technician opens a ticket, it:

1. **Authenticates automatically** via ConnectWise's [Hosted API](https://developer.connectwise.com/Products/Manage/Hosted_APIs) (`postMessage`) — no separate login
2. **Pulls full ticket context** — summary, notes, configurations, custom fields — using the CW REST API
3. **Runs as the signed-in technician**: every ConnectWise call uses the technician's own Hosted API session, so ConnectWise applies their security role and they only see what that role allows
4. **Opens a chat interface** where the tech can ask anything about the ticket in plain English
5. **Sends context to an LLM** and streams the response back with Markdown formatting

The chat is conversational — ask follow-up questions, request clarification, work through a problem step by step. Slash commands (like `/summary`, `/similar`, `/config`) are shortcuts that trigger specialised prompts for common tasks. For example, `/similar` fetches matching tickets from the same company (90 days) and globally (14 days), pulls their notes to find buried resolutions, and asks the AI to identify genuinely relevant matches rather than keyword noise.

### AI Model

TicketWise uses the **OpenAI-compatible SDK** pointed at [OpenRouter](https://openrouter.ai), which gives you access to hundreds of models with a single API key.

We run it with **`moonshotai/kimi-k2.5:nitro`** — a reasoning model chosen for the balance of speed and accuracy in a pod context where technicians are waiting. Kimi K2.5 handles ticket analysis well: it reasons through the notes to find actual resolutions rather than just echoing the summary. The `:nitro` variant keeps latency low. The prompts are model-agnostic, so swap in whatever works for you.

Temperature is set to `0.3` for factual, consistent responses. `max_completion_tokens` is `4096` to give reasoning models enough headroom (they spend tokens on internal reasoning before producing output). The system prompt enforces strict rules: only reference information explicitly in the ticket data, never invent names/dates/steps, and use British English.

## Data Flow & Privacy

```
ConnectWise PSA  →  Your TicketWise Server  →  LLM Provider  →  Back to Browser
   (CW API)          (Next.js server)         (OpenRouter /    (response rendered)
                                               Azure / local)
```

- **No data is stored.** Chat history lives in React state (browser memory) and is gone when you close/refresh the tab.
- **No logging of ticket content.** Server-side processing is stateless.
- **Ticket data is sent to your configured LLM provider** for each request. Be aware of where the underlying model is hosted — OpenRouter routes to various providers, and the model you choose determines which company processes your data.
- **OpenRouter does not store prompts or completions by default**, but the LLM hosting company behind your chosen model has its own data policies. Check the model provider's terms.
- **If data residency matters** (e.g. GDPR, keeping data in the EU/UK), consider:
  - **Azure OpenAI** — lets you choose your region (UK South, West Europe, etc.) and keeps data within that region. Change the `baseURL` and `apiKey` in `src/lib/ai.ts` to point at your Azure OpenAI endpoint.
  - **Local/self-hosted models** — run an OpenAI-compatible model server (Ollama, vLLM, LiteLLM) and point TicketWise at it. Data never leaves your network.
- **You are responsible** for compliance with your own data protection obligations (GDPR, client agreements, etc.). TicketWise is a tool — how you deploy it and where you send data is your decision.

## Features

- **Ticket Summaries** — instant, structured summaries (different formats for open vs closed tickets)
- **Smart Suggestions** — AI-powered troubleshooting recommendations based on ticket context
- **Similar Ticket Search** — finds related issues from company history (90 days) and globally (14 days), fetches notes from closed tickets to surface actual resolutions
- **Configuration History**: shows past issues with attached devices using the CW Report API (the technician's ConnectWise role needs Report API rights)
- **Customer Response Drafts** — drafts professional replies with appropriate tone
- **Escalation Notes** — prepares structured handoff notes
- **5 Whys Analysis** — root cause analysis directly from ticket data
- **Copy to Clipboard** — every AI response has a copy button (rich text for Outlook/Teams)
- **Rate Limiting** — 30 requests/minute per user to control AI costs
- **Slash Commands** — quick actions with auto-complete dropdown

## Slash Commands

| Command | Description |
|---------|-------------|
| `/summary` | Summarise the current ticket — extracts issue, resolution (closed) or current status (open) |
| `/suggest` | AI-powered troubleshooting suggestions, prioritising quick wins |
| `/next` | Recommend next steps — what to do, who to contact, whether to escalate |
| `/similar` | Search for similar past tickets (same company first, then global). Shows what worked before |
| `/config` | Analyse the ticket history for attached configurations/devices |
| `/draft` | Draft a professional customer response |
| `/escalate` | Prepare structured escalation notes for handoff |
| `/5whys` | Root cause analysis using the 5 Whys methodology |
| `/refresh` | Clear chat history and start fresh (client-side only) |

## Setup

### Prerequisites

- **ConnectWise PSA** instance (cloud-hosted — EU, NA, or AU regions)
- **ConnectWise Developer Client ID** — [register here](https://developer.connectwise.com/ClientId)
- No ConnectWise API keys or API member: TicketWise calls ConnectWise as the signed-in technician
- **OpenRouter API key** — [sign up here](https://openrouter.ai)
- **Node.js 20+**

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# ConnectWise PSA
CW_CLIENT_ID=your-connectwise-developer-client-id
CW_COMPANY_ID=your-company-id
CW_COMPANY_URL=eu.myconnectwise.net        # or na.myconnectwise.net / au.myconnectwise.net
CW_CODE_BASE=v4_6_release

# OpenRouter (https://openrouter.ai)
OPENROUTER_API_KEY=sk-or-v1-your-openrouter-api-key
OPENROUTER_MODEL=moonshotai/kimi-k2.5:nitro

# App
NODE_ENV=production
HOSTNAME=0.0.0.0
```

> **Using a different LLM provider?** The app uses the OpenAI SDK pointed at OpenRouter's base URL. To use Azure OpenAI, a local model server, or another compatible provider, change the `baseURL` and `apiKey` in `src/lib/ai.ts`. For Azure OpenAI, your base URL will look like `https://your-resource.openai.azure.com/openai/deployments/your-deployment` — see the [Azure OpenAI docs](https://learn.microsoft.com/en-us/azure/ai-services/openai/reference).

### ConnectWise Security Roles

TicketWise has no API member and no API keys. Each call runs with the signed-in technician's own Hosted API session, so ConnectWise applies that technician's security role. A technician sees in TicketWise only what they can see in ConnectWise.

For every feature to work, a technician's role needs read (Inquire) access to:

- **Service tickets**, including notes
- **Configurations** attached to tickets
- **The Report API** (`/system/reports/Service`), for `/config` only

Only the ticket itself is required. If the role cannot read the ticket, TicketWise tells the technician their ConnectWise security role does not allow it. If it cannot read the notes or configurations, TicketWise answers without them and tells the AI they are hidden. Without Report API rights, `/config` says it cannot fetch configuration history; the other commands still work. `/config` checks each ticket the Report API returns against the service tickets API, as the same technician, and shows only the ones they can open.

TicketWise is read-only. It needs no write access.

**Upgrading from an older version?** Older versions called ConnectWise with an API member's key pair. Remove `CW_PUBLIC_KEY` and `CW_PRIVATE_KEY` from your deployment and revoke that key pair in ConnectWise. The app logs a warning while they are still set.

### Installation

```bash
git clone https://github.com/Ingenio-Tech/ticketwise.git
cd ticketwise
npm install
npm run dev
```

The app runs on `http://localhost:3000`. It requires a ConnectWise iframe context to authenticate — running standalone shows a "Pod Mode Only" message.

### ConnectWise Pod Configuration

1. In ConnectWise, go to **System → Setup Tables → Manage Hosted API**
2. Click **+** to create a new entry
3. Configure:
   - **Description:** TicketWise
   - **Screen:** Service Ticket
   - **Origin:** `https://your-domain.com` (or `*` for testing)
   - **URL:** `https://your-domain.com`
   - **Display:** Pod
   - **Pod Height:** 300 (adjust to preference)
4. Save

The pod communicates with ConnectWise via the [Hosted API (postMessage)](https://developer.connectwise.com/Products/Manage/Hosted_APIs) to get the ticket ID and authenticate the logged-in member.

## Deployment

### Hosting Recommendations

TicketWise handles ConnectWise ticket data, which may include client names, contact details, and issue descriptions. **Host it responsibly:**

- **Use a professional hosting provider** in your country of residence (or your clients' jurisdiction) to satisfy data residency requirements
- **Put Cloudflare in front** (free tier is fine) for DDoS protection, WAF, and TLS termination
- **Recommended Cloudflare settings:**
  - SSL/TLS → Full (Strict)
  - SSL/TLS → Minimum TLS Version → TLS 1.2
  - SSL/TLS → Always Use HTTPS → On
  - Security → WAF → Managed rules enabled
Any host that runs Docker or Node.js 20 works: a VPS, Azure App Service, AWS, Coolify, Unraid — your choice. The app is lightweight and stateless.

> **⚠️ Cloudflare Access / Zero Trust:** You **cannot** put Cloudflare Access in front of TicketWise. The pod loads inside a ConnectWise iframe, and CF Access would challenge the iframe load with a login redirect, which breaks inside iframes. The pod's security comes from ConnectWise's own authentication (the postMessage handshake, checked with ConnectWise on the server, and every call made as the signed-in member) and the origin validation built into the app. Tightening `frame-ancestors` in CSP (see Security section) is the correct way to restrict who can embed it.

### Docker

A multi-stage Dockerfile is included. Build and run:

```bash
docker build -t ticketwise .
docker run -p 3000:3000 --env-file .env ticketwise
```

The image uses Next.js standalone output with a non-root user.

### Coolify / Self-Hosted

1. Add new resource → Public Repository (or Private if forked)
2. Build Pack: Dockerfile (auto-detected) or Nixpacks
3. Environment variables: add all from `.env.example`
4. Domain: configure your subdomain
5. Deploy

> **Nixpacks note:** If using Nixpacks, keep `"start": "next start"` in `package.json`. Although Next.js warns about `output: "standalone"` + `next start`, it works under Nixpacks because Nixpacks handles static file serving. Using `node .next/standalone/server.js` breaks static assets.

### Azure App Service

If you're deploying to Azure (e.g. because your MSP is Azure-native), the general approach:

1. **Create a Linux App Service Plan** (basic tier is sufficient)
2. **Create a Web App** — either deploy the Docker image or use code deployment with Node 20 LTS
3. **Set environment variables** in Configuration → Application Settings (all vars from `.env.example`)
4. **Set `PORT=8080`** and **`HOSTNAME=0.0.0.0`** (Azure defaults)
5. **If using code deployment**, set startup command to `node .next/standalone/server.js`
6. **Configure custom domain + HTTPS** via Azure managed certificates or Cloudflare

This can also be done via `az` CLI — see the [Azure App Service docs](https://learn.microsoft.com/en-us/azure/app-service/quickstart-nodejs).

> **Tip:** If you're using [OpenClaw](https://openclaw.ai) or Claude Code, you can ask it to deploy this for you. Give it the repo URL, your `.env` values, and an authenticated `az` CLI session — it'll handle the resource creation, container build, and configuration.

#### Azure Notes

- ConnectWise cloud (*.myconnectwise.net) is reachable from Azure by default — no special networking needed
- Azure App Service doesn't add `X-Frame-Options` by default, so the iframe pod works out of the box
- If you use Azure Front Door or Application Gateway, check they don't add restrictive frame headers

## Security

TicketWise is designed to be safe by default, but **you are responsible for securing your own deployment**.

**What the app does right:**
- The LLM key stays server-side (validated by Zod, never in client bundles). There is no ConnectWise API key at all
- Every Server Action checks the member with ConnectWise first (`src/lib/session.ts`): the Hosted API memberId/memberHash pair must pass a CW API call, and CW must name the same member, before any ticket data is read or the LLM is called. Good checks are cached for 5 minutes
- Server Action input is validated with Zod (integer ticket IDs, `user`/`assistant` roles only, length caps)
- Every ConnectWise call runs with the signed-in member's own verified session, so ConnectWise applies their security role. No call can run without a verified session
- If ConnectWise says the session has expired (401), TicketWise drops it and the pod asks ConnectWise for a fresh sign-in, which the server checks again. If the member's role does not allow a call (403), the technician gets a plain message, never ConnectWise's error text
- ConnectWise calls are logged as method, path, member and status only (no ticket content, no credentials)
- PostMessage origin validation (only accepts messages from ConnectWise domains)
- HTTP-only, secure cookies with 8-hour expiry
- Rate limiting (30 req/min per verified member, 120 req/min overall)
- Non-root Docker container
- Read-only — no write operations to ConnectWise
- Security headers: CSP, X-Content-Type-Options, Referrer-Policy, Permissions-Policy

**What you need to do:**
- **Restrict `frame-ancestors`** — change `frame-ancestors *` to `frame-ancestors https://*.myconnectwise.net https://your-domain.com` in `next.config.ts` and `middleware.ts`. This is the primary way to control who can embed the pod.
- **Review your technicians' ConnectWise security roles**: TicketWise shows each technician only what their role allows, so the roles are the access control
- **Remove any old `CW_PUBLIC_KEY` / `CW_PRIVATE_KEY`** from your deployment and revoke that key pair in ConnectWise
- **Enforce TLS 1.2+** at your edge/reverse proxy
- **Review the [Security Report](SECURITY-REPORT.md)** for the full assessment

> **Note:** Traditional auth layers like Cloudflare Access or Azure AD App Proxy **cannot** be used here, because they break iframe-based pods. The security model relies on ConnectWise's own authentication (the postMessage handshake, checked server-side), calls made as the signed-in member, origin validation, and CSP `frame-ancestors`.

> **Disclaimer:** This software is provided as-is under the MIT licence. It is not production-hardened out of the box. You are responsible for securing your deployment, managing API credentials, and ensuring compliance with your data protection obligations. The authors accept no liability for security incidents arising from your use of this software.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed architecture documentation including data flow diagrams, the authentication handshake, and CW API integration details.

```
src/
├── app/
│   ├── page.tsx                # Entry point — renders Pod with URL params
│   ├── layout.tsx              # Root layout (Manrope font, metadata)
│   ├── globals.css             # Tailwind + brand colours + prose styles
│   └── api/health/route.ts     # Health check endpoint
├── components/
│   ├── pod.tsx                 # Pod wrapper — CW iframe auth + lifecycle
│   └── chat.tsx                # Chat UI — messages, slash commands, copy, input
├── hooks/
│   └── use-hosted-api.ts       # CW Hosted API (postMessage) integration
├── lib/
│   ├── ai.ts                   # OpenRouter client, system prompt, slash command prompts
│   ├── connectwise.ts          # CW REST API client (runs as the signed-in member): tickets, notes, configs, Report API
│   ├── session.ts              # Verifies the member with ConnectWise; builds the member session headers
│   ├── env.ts                  # Zod environment variable validation
│   └── format.ts               # Formats ticket/note/config data as text for AI context
├── actions/
│   ├── auth.ts                 # Cookie-based auth (CW member context, 8hr expiry)
│   ├── chat.ts                 # Chat processing — command detection, context assembly, rate limiting
│   └── ticket.ts               # Ticket data fetching (context, similar, config history)
└── middleware.ts               # Security headers (CSP, X-Content-Type-Options, etc.)
```

### Key Design Decisions

- **Server Actions over API routes**: chat processing happens server-side via Next.js Server Actions, keeping the LLM key secure and simplifying the architecture
- **ConnectWise Report API** for config history: the standard API cannot query tickets by configuration ID efficiently, so we use the Report API (`/system/reports/Service`). `config_recids` is a comma-separated list of ids. The query matches the id as a whole list item and the code checks every row again, so another device's tickets cannot slip in. The ticket ids are then checked against `/service/tickets` as the same member, so the Report API cannot show a ticket the member could not open
- **Calls run as the signed-in member**: every ConnectWise call sends the member's own Hosted API session, in the cookie or Basic form ConnectWise accepted when `src/lib/session.ts` verified it. ConnectWise then applies the member's security role, so TicketWise needs no access control and no API keys of its own
- **No database** — entirely stateless. Chat history lives in React state (client-side). No persistence needed
- **`frame-ancestors *`** in CSP — required for the pod to load in ConnectWise's iframe. Tighten this in production
- **Clipboard via `document.execCommand`** — `navigator.clipboard` is blocked in cross-origin iframes, so we use range selection + execCommand to copy rich text (HTML formatting preserved for Outlook/Teams)

## Tech Stack

- **Framework:** Next.js 15 (App Router, Server Actions, standalone output)
- **UI:** React 19, Tailwind CSS 4, react-markdown
- **AI:** OpenAI SDK → OpenRouter (compatible with any OpenAI-format provider)
- **Validation:** Zod (env vars, postMessage schemas)
- **Language:** TypeScript
- **Deployment:** Docker (multi-stage, non-root), Nixpacks, or any Node.js 20+ host

## Adding a Slash Command

1. Add an entry to `SLASH_COMMANDS` in `src/lib/ai.ts` with `description` and `prompt`
2. If the command needs extra context (like `/similar` fetches related tickets), add data fetching in `src/actions/chat.ts` within `processChat()`
3. The command auto-appears in the UI dropdown — no changes needed in `chat.tsx`

## Support

This is an open-source project released for the MSP community. **There is no official support.**

- Fork it, adapt it, make it yours
- PRs are welcome if you want to contribute improvements back
- If you hit a bug, open an issue — but no guarantees on response time
- For paid consulting or custom development, contact [Ingenio Technologies](https://ingeniotech.co.uk)

## License

[MIT](LICENSE)

---

Built by [Ingenio Technologies](https://ingeniotech.co.uk) • Open-sourced for the MSP community
