# Xora AI Proxy

A small Node.js / Express 5 microservice that sits between the Angular
frontend and an LLM provider. Holds the API key, applies structured
prompts per endpoint, and returns JSON the frontend can consume.

**Scope**: This proxy is Interview-Prep-specific. It is NOT a shared Xora
service. All 6 endpoints are mock-interview / answer-coach / question-generator
endpoints.

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express 5 (ESM)
- **CORS**: configured origin allowlist (no longer wide-open)
- **Rate limit**: 60 req/min/IP (in-memory, sufficient for single-instance)
- **AI providers** (pick one):
  - **Cloudflare Workers AI** — FREE, 10k neurons/day, no credit card
  - **Z.ai / BigModel GLM-4.6** — paid, requires credits
- **Deployment**: Vercel serverless (`vercel.json` included) or any Node host

## Quick Start (Cloudflare — FREE)

1. Get a Cloudflare API token with Workers AI permission at
   https://dash.cloudflare.com -> My Profile -> API Tokens
2. Find your account ID on any Cloudflare dashboard page (right sidebar)
3. Copy the env template and fill in your values:
   ```bash
   cp .env.example .env
   # edit .env and set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
   ```
4. Install deps and run:
   ```bash
   npm install
   npm run dev   # node --watch server.js
   ```
5. Health check:
   ```bash
   curl http://localhost:3001/api/ai/health
   ```

## Environment Variables

Copy `.env.example` to `.env` (gitignored) and fill in.

| Variable                   | Required? | Description                                          |
| -------------------------- | --------- | ---------------------------------------------------- |
| `AI_PROVIDER`              | No        | `cloudflare` or `zai`. Auto-detects if unset.        |
| `CLOUDFLARE_API_TOKEN`     | If CF     | Cloudflare API token with Workers AI permission      |
| `CLOUDFLARE_ACCOUNT_ID`    | If CF     | Your Cloudflare account ID                           |
| `CLOUDFLARE_MODEL`         | No        | Model ID (default: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) |
| `ZAI_API_KEY`              | If Z.ai   | Z.ai / BigModel API key                              |
| `ZAI_BASE_URL`             | No        | Z.ai base URL (default: `https://open.bigmodel.cn/api/paas/v4`) |
| `ZAI_TOKEN`                | No        | Z.ai JWT (only for internal sandbox API)             |
| `PORT`                     | No        | Listen port (default: 3001)                          |
| `XORA_ALLOWED_ORIGINS`     | No        | Comma-separated allowed CORS origins (default: `http://localhost:4200,https://xora-frontend.vercel.app`) |

## API Endpoints

All endpoints accept JSON and return JSON.

| Method | Path                                | Description                          |
| ------ | ----------------------------------- | ------------------------------------ |
| GET    | `/api/ai/health`                    | Health check (returns active provider + model) |
| POST   | `/api/ai/mock-interview/start`      | Start a mock interview session       |
| POST   | `/api/ai/mock-interview/answer`     | Evaluate answer + return next Q      |
| POST   | `/api/ai/mock-interview/results`    | Final summary + weak areas           |
| POST   | `/api/ai/answer-coach/evaluate`     | Standalone answer evaluation         |
| POST   | `/api/ai/question-generator`        | Generate practice questions          |

### Request shapes

See `prompts.js` for the exact JSON contract per endpoint. The Angular
frontend's `AiPrepService` (`xora-frontend/src/app/home/interview/ai-prep/ai-prep.service.ts`)
is the canonical consumer — read it for the exact request/response shapes.

## Local Development

```bash
npm install
npm run dev    # starts with --watch for auto-reload on save
```

## Deployment

### Vercel (recommended)

The included `vercel.json` configures the project as a serverless Node
function. Push to GitHub and import the repo into Vercel, then set the
env vars in the Vercel dashboard.

The frontend's `environment.prod.ts` should point at the deployed proxy:

```typescript
aiProxyUrl: 'https://xora-ai-proxy.vercel.app',
```

### Other Node hosts

```bash
npm install --omit=optional    # skip z-ai-web-dev-sdk if using Cloudflare
npm start
```

## Security Notes

- **CORS**: restricted to known Xora frontend origins. Override via
  `XORA_ALLOWED_ORIGINS`.
- **Rate limit**: 60 req/min/IP, in-memory. Sufficient for single-instance
  Vercel deployments. For multi-instance, swap in Redis-backed rate limiting.
- **No API key auth on the proxy itself** — relies on CORS + rate limit.
  If you expose the proxy publicly (not through Vercel's private network),
  consider adding an API key header check.
- **Keys are read from env vars only** — never logged, never committed.

## Phase 2 Notes

This proxy will travel with the Interview Prep product when it splits into
its own repo (`xora-interview-prep`).
