# CoreStack AI Proxy

A small Node.js/Express microservice that sits between the Angular
frontend and an LLM provider. Holds the API key, applies structured
prompts per endpoint, and returns JSON the frontend can consume.

Supports **two providers** — pick the one that works for you:

| Provider | Cost | Setup | Recommended |
|----------|------|-------|-------------|
| **Cloudflare Workers AI** | FREE (10k neurons/day) | API token + account ID | ✅ Yes |
| Z.ai (BigModel) | Paid (needs credits) | API key | Only if you have credits |

## Quick start (Cloudflare — free)

1. Get a Cloudflare API token with Workers AI permission at
   https://dash.cloudflare.com → My Profile → API Tokens
2. Find your account ID on any Cloudflare dashboard page (right sidebar)
3. Set env vars and start:

```bash
cd ai-proxy
npm install

# Create .env file (or export these in your shell)
cat > .env << 'EOF'
AI_PROVIDER=cloudflare
CLOUDFLARE_API_TOKEN=your_token_here
CLOUDFLARE_ACCOUNT_ID=your_account_id_here
EOF

# Start (Node 20+)
node --env-file=.env server.js
```

Or without a .env file:

```bash
AI_PROVIDER=cloudflare \
CLOUDFLARE_API_TOKEN=your_token \
CLOUDFLARE_ACCOUNT_ID=your_account_id \
npm start
```

That's it. The proxy listens on http://localhost:3001.

## Why Cloudflare Workers AI?

- **Genuinely free tier** — 10,000 neurons per day at no cost
- **No credit card required** to start
- Multiple strong models available (llama-3.3-70b, kimi-k2.6, qwen2.5-coder)
- OpenAI-compatible response format
- Runs on Cloudflare's edge network (fast)

## Choosing a model

Set `CLOUDFLARE_MODEL` to any of these (all free-tier eligible):

| Model | Strengths | Default? |
|-------|-----------|----------|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Best overall quality, good reasoning | ✅ |
| `@cf/moonshotai/kimi-k2.6` | Strong reasoning, includes chain-of-thought | |
| `@cf/meta/llama-3.1-8b-instruct` | Faster, lighter, good for simple tasks | |
| `@cf/qwen/qwen2.5-coder-32b-instruct` | Best for code-related questions | |

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/ai/health` | Health check (shows active provider + model) |
| POST | `/api/ai/mock-interview/start` | Start a mock interview session |
| POST | `/api/ai/mock-interview/answer` | Evaluate answer + return next question |
| POST | `/api/ai/mock-interview/results` | Final summary + weak areas |
| POST | `/api/ai/answer-coach/evaluate` | Standalone answer evaluation |
| POST | `/api/ai/question-generator` | Generate practice questions |

## Using Z.ai instead (alternative)

If you have Z.ai credits and prefer it:

```bash
AI_PROVIDER=zai \
ZAI_API_KEY=your_zai_api_key \
npm start
```

The proxy will use Z.ai's GLM-4.6 model. Your account must have
credits or calls will fail with `429: 余额不足`.

## Deploy

### Deploy to Vercel (recommended)

The proxy is set up to run as a Vercel serverless function. Deploy
it as a **separate Vercel project** from your frontend.

#### Step 1 — Deploy the proxy

**Option A: Via Vercel dashboard (easiest)**

1. Push your repo to GitHub/GitLab/Bitbucket (if you haven't already)
2. Go to https://vercel.com/new
3. Import your repo
4. **Important:** set the **Root Directory** to `ai-proxy` (so Vercel
   only deploys that folder, not the frontend)
5. Framework Preset: Vercel auto-detects "Node.js" — leave as is
6. Add environment variables (see below)
7. Click Deploy

**Option B: Via Vercel CLI**

```bash
cd ai-proxy
npm i -g vercel   # if you don't have the CLI
vercel            # follow the prompts — link to a new or existing project
vercel env add AI_PROVIDER
vercel env add CLOUDFLARE_API_TOKEN
vercel env add CLOUDFLARE_ACCOUNT_ID
vercel --prod     # deploy to production
```

#### Step 2 — Set environment variables

In the Vercel project settings → Environment Variables, add:

| Name | Value |
|------|-------|
| `AI_PROVIDER` | `cloudflare` |
| `CLOUDFLARE_API_TOKEN` | your Cloudflare API token |
| `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account ID |

(Optional: `CLOUDFLARE_MODEL` to override the default model.)

#### Step 3 — Get the proxy URL

After deploy, Vercel gives you a URL like:
```
https://corestack-ai-proxy.vercel.app
```

Verify it works:
```bash
curl https://corestack-ai-proxy.vercel.app/api/ai/health
# → {"status":"ok","provider":"cloudflare (...)","timestamp":"..."}
```

#### Step 4 — Point the frontend at the deployed proxy

Edit `corestack-frontend/src/app/environments/environment.prod.ts`:

```ts
export const environment = {
  production: true,
  apiUrl: 'https://corestackapi.duckdns.org',
  aiProxyUrl: 'https://corestack-ai-proxy.vercel.app',  // ← your proxy URL
  googleClientId: '...',
};
```

Then redeploy the frontend. The AI Prep feature will now call the
Vercel-hosted proxy, which calls Cloudflare Workers AI.

#### Timeout note

Vercel's Hobby plan has a **10-second timeout** on serverless
functions. Most AI calls finish in 2-5 seconds, but long prompts
(mock interview results with a full transcript) can take 10-15s.

If you hit timeouts:
- Upgrade to Vercel **Pro** ($20/mo) for 60-second timeouts, OR
- Add `"maxDuration": 60` to the `builds[0].config` in `vercel.json`
  (works on Pro), OR
- Use a faster model like `@cf/meta/llama-3.1-8b-instruct` (sets
  `CLOUDFLARE_MODEL` env var)

### Deploy to other hosts

Any Node.js host works (Railway, Render, Fly.io, a VM).

```bash
cd ai-proxy
npm install
AI_PROVIDER=cloudflare \
CLOUDFLARE_API_TOKEN=your_token \
CLOUDFLARE_ACCOUNT_ID=your_account_id \
npm start
```

## Wire up the Angular frontend

In `corestack-frontend/src/environments/environment.ts`, set the proxy URL:

```ts
export const environment = {
  production: false,
  apiUrl: 'https://corestackapi.duckdns.org',
  aiProxyUrl: 'http://localhost:3001',  // ← your proxy URL
  googleClientId: '...',
};
```

## Troubleshooting

### "No AI provider configured"

Neither Cloudflare nor Z.ai credentials are set. See "Quick start" above.

### "Cloudflare API error (401)"

`CLOUDFLARE_API_TOKEN` is invalid or expired. Generate a new token at
https://dash.cloudflare.com → My Profile → API Tokens. Make sure the
token has permission to use Workers AI ("Account → Workers AI").

### "Cloudflare API error (403)"

Token doesn't have Workers AI permission, or wrong account ID. Verify
both `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set correctly.

### "Z.ai account has insufficient credits (429: 余额不足)"

Your Z.ai account is out of credits. Either add credits at z.ai, or
switch to Cloudflare (free) by setting `AI_PROVIDER=cloudflare`.

### "AI did not return valid JSON"

The model occasionally wraps its response in markdown fences despite
the prompt instructions. The proxy already strips fences and extracts
the JSON block. If it still fails, the prompt in `prompts.js` may need
tuning for your specific model.

### CORS errors in the browser

The proxy enables CORS for all origins by default. To lock it down,
change `app.use(cors())` to `app.use(cors({ origin: 'http://localhost:4200' }))`.

## Request/response shapes

See `prompts.js` for the exact JSON contract each endpoint returns.
The Angular `ai-prep.models.ts` has matching TypeScript interfaces.
