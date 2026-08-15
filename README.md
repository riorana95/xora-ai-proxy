# Xora AI Proxy

A small Node.js / Express 5 microservice that sits between the Angular
frontend and an LLM provider. Holds the API key, applies structured
prompts per endpoint, and returns JSON the frontend can consume.

**Scope**: This proxy is Interview-Prep-specific. It is NOT a shared Xora
service. Its eight endpoints cover mock interviews, answer coaching, question
generation, and voice interviews.

It also provides the Voice Interview endpoints. The proxy issues a short-lived,
one-use Gemini Live token; the browser then streams audio directly to Gemini.
The permanent `GEMINI_API_KEY` never reaches the frontend.

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express 5 (ESM)
- **CORS**: configured origin allowlist (no longer wide-open)
- **Rate limit**: 60 req/min/IP (in-memory, sufficient for single-instance)
- **AI providers** (pick one):
  - **Google Gemini 2.5 Flash** — recommended for interview training; free development tier, structured JSON, and a path to realtime voice
  - **Cloudflare Workers AI** — FREE fallback, 10k neurons/day, no credit card
  - **Z.ai / BigModel GLM-4.6** — paid, requires credits
- **Deployment**: Vercel serverless (`vercel.json` included) or any Node host

## Quick Start (Gemini — recommended)

1. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey).
2. Copy the env template and fill in your values:
   ```bash
   cp .env.example .env
   # edit .env and set GEMINI_API_KEY
   ```
3. Install deps and run:
   ```bash
   npm install
   npm run dev   # node --watch server.js
   ```
4. Health check:
   ```bash
   curl http://localhost:3001/api/ai/health
   ```

Gemini's free tier is suitable for development and a small pilot. Its pricing page says that free-tier inputs/outputs may be used to improve Google's products, so move to the paid tier before sending production resumes or interview transcripts.

## Environment Variables

Copy `.env.example` to `.env` (gitignored) and fill in.

| Variable                   | Required? | Description                                          |
| -------------------------- | --------- | ---------------------------------------------------- |
| `AI_PROVIDER`              | No        | `gemini`, `cloudflare`, or `zai`. Auto-detects if unset. |
| `GEMINI_API_KEY`           | If Gemini | Gemini API key from Google AI Studio.                |
| `GEMINI_MODEL`             | No        | Gemini model ID (default: `gemini-2.5-flash`).       |
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
| POST   | `/api/ai/voice/session`              | Create a secure Gemini Live session  |
| POST   | `/api/ai/voice/results`              | Evaluate a voice-interview transcript |

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
- **Voice tokens**: `/api/ai/voice/session` returns a constrained, one-use
  Gemini token that expires quickly. Add application-level user authentication
  before opening voice interviews to the public.

## Phase 2 Notes

This proxy will travel with the Interview Prep product when it splits into
its own repo (`xora-interview-prep`).
