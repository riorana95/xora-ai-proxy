/**
 * Xora AI Proxy — Server
 *
 * A small Express microservice that sits between the Angular frontend
 * and an LLM provider (Cloudflare Workers AI or Z.ai). Holds the API
 * key, applies structured prompts per endpoint, and returns JSON the
 * frontend can consume.
 *
 * Endpoints:
 *   POST /api/ai/mock-interview/start    — start a mock interview session
 *   POST /api/ai/mock-interview/answer   — evaluate answer + return next Q
 *   POST /api/ai/mock-interview/results  — final summary
 *   POST /api/ai/answer-coach/evaluate   — standalone answer evaluation
 *   POST /api/ai/question-generator      — generate practice questions
 *   GET  /api/ai/health                  — health check
 *
 * The proxy is stateless — session context (transcript, question bank
 * subset) is passed from the frontend on each call. This keeps the
 * proxy horizontally scalable and avoids session storage.
 *
 * ---------- CONFIGURATION ----------
 * Two providers are supported. Set the AI_PROVIDER env var to pick one.
 *
 * 1. Cloudflare Workers AI (FREE tier — 10k neurons/day, no credit card)
 *    Required env vars:
 *      AI_PROVIDER=cloudflare
 *      CLOUDFLARE_API_TOKEN=your_token
 *      CLOUDFLARE_ACCOUNT_ID=your_account_id
 *    Optional:
 *      CLOUDFLARE_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast  (default)
 *      # Other working models:
 *      #   @cf/moonshotai/kimi-k2.6
 *      #   @cf/meta/llama-3.1-8b-instruct  (faster, smaller)
 *      #   @cf/qwen/qwen2.5-coder-32b-instruct  (good for code)
 *
 * 2. Z.ai (paid — requires credits)
 *    Required env vars:
 *      AI_PROVIDER=zai
 *      ZAI_API_KEY=your_api_key
 *    Optional:
 *      ZAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4  (default)
 *      ZAI_TOKEN=your_jwt_token  (only for internal sandbox API)
 *
 * If AI_PROVIDER is not set, the proxy auto-detects based on which
 * env vars are present (Cloudflare wins if both are configured).
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {
  MOCK_START_SYSTEM,
  MOCK_ANSWER_SYSTEM,
  MOCK_RESULTS_SYSTEM,
  COACH_SYSTEM,
  GENERATOR_SYSTEM,
} from './prompts.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ---------- Process-level error handlers ----------
// Never let the proxy crash silently. These catch unhandled rejections
// and log them so the proxy stays alive even if a single request fails.
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err?.message || err);
  // Don't exit — keep serving other requests. The Express error
  // handler in each route will return a 500 to the failed request.
});

// ---------- Middleware ----------
// Restrict CORS to known Xora frontend origins. Configurable via env var
// XORA_ALLOWED_ORIGINS (comma-separated). Defaults to Angular dev server
// + the production Vercel deployment.
const allowedOrigins = (process.env.XORA_ALLOWED_ORIGINS
  || 'http://localhost:4200,https://xora-dev.vercel.app')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    // allow same-origin / curl / server-side requests with no Origin header
    if (!origin || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '2mb' }));

// Minimal per-IP rate limiter — protects the free Cloudflare quota from
// being burned by a single client. 60 requests / minute / IP.
const requestCounts = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
app.use((req, res, next) => {
  if (req.path === '/api/ai/health') return next();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = requestCounts.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  entry.count += 1;
  requestCounts.set(ip, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' });
  }
  next();
});

// ============================================================
// Provider abstraction
// ============================================================

/**
 * A provider is anything that can take a system prompt + user message
 * and return a string (the model's text response). Each provider
 * implementation handles its own auth, URL, and HTTP format.
 */

// ---------- Cloudflare Workers AI provider ----------
class CloudflareProvider {
  constructor() {
    this.name = 'cloudflare';
    this.apiToken = process.env.CLOUDFLARE_API_TOKEN;
    this.accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    this.model = process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

    if (!this.apiToken || !this.accountId) {
      throw new Error(
        'Cloudflare provider requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID env vars. ' +
        'Get them at https://dash.cloudflare.com → My Profile → API Tokens.'
      );
    }
  }

  async chat(systemPrompt, userMessage) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`;

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.7,
          max_tokens: 2048,
        }),
      });
    } catch (err) {
      throw new Error(`Cloudflare network error: ${err.message}`);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      let message = `Cloudflare API error (${response.status})`;
      try {
        const parsed = JSON.parse(errorBody);
        if (parsed.errors?.[0]?.message) {
          message += `: ${parsed.errors[0].message}`;
        }
      } catch {
        message += `: ${errorBody.slice(0, 200)}`;
      }
      throw new Error(message);
    }

    const data = await response.json();

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || 'Unknown Cloudflare error';
      throw new Error(`Cloudflare error: ${errMsg}`);
    }

    const content = data.result?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Cloudflare returned no content');
    }
    return content;
  }
}

// ---------- Z.ai provider (kept for backward compatibility) ----------
class ZaiProvider {
  constructor() {
    this.name = 'zai';
    this.model = 'glm-4.6';
    this.apiKey = process.env.ZAI_API_KEY;
    this.baseUrl = process.env.ZAI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
    this.token = process.env.ZAI_TOKEN;

    if (!this.apiKey) {
      throw new Error('Z.ai provider requires ZAI_API_KEY env var. Get one at https://z.ai');
    }
  }

  async chat(systemPrompt, userMessage) {
    // Dynamic import so Cloudflare-only users don't need z-ai-web-dev-sdk installed
    const ZAI = (await import('z-ai-web-dev-sdk')).default;

    const config = {
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      ...(this.token && { token: this.token }),
    };
    const zai = new ZAI(config);

    let response;
    try {
      response = await zai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.7,
        thinking: { type: 'disabled' },
      });
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('status 401')) {
        throw new Error('Z.ai rejected the API key (401). Check ZAI_API_KEY.');
      }
      if (msg.includes('status 429') && msg.includes('1113')) {
        throw new Error('Z.ai account has insufficient credits (429: 余额不足). Add credits at z.ai, or switch to Cloudflare (free) by setting AI_PROVIDER=cloudflare.');
      }
      if (msg.includes('status 429')) {
        throw new Error('Z.ai rate limit hit (429). Wait and retry, or switch to Cloudflare (free) by setting AI_PROVIDER=cloudflare.');
      }
      throw err;
    }

    return response.choices?.[0]?.message?.content || '';
  }
}

// ---------- Provider factory ----------
let activeProvider = null;

function getProvider() {
  if (activeProvider) return activeProvider;

  const explicit = process.env.AI_PROVIDER?.toLowerCase();

  if (explicit === 'cloudflare') {
    activeProvider = new CloudflareProvider();
  } else if (explicit === 'zai') {
    activeProvider = new ZaiProvider();
  } else if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
    // Auto-detect: Cloudflare wins if both configured (free tier preferred)
    activeProvider = new CloudflareProvider();
  } else if (process.env.ZAI_API_KEY) {
    activeProvider = new ZaiProvider();
  } else {
    throw new Error(
      'No AI provider configured. Set one of:\n' +
      '  • AI_PROVIDER=cloudflare + CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (FREE)\n' +
      '  • AI_PROVIDER=zai + ZAI_API_KEY (paid, needs credits)\n\n' +
      'See README.md for setup details.'
    );
  }

  console.log(`[AI] Using provider: ${activeProvider.name} (model: ${activeProvider.model})`);
  return activeProvider;
}

// ---------- JSON extraction helper ----------
/**
 * Calls the active provider, then extracts and parses JSON from the
 * response. Strips markdown fences and extracts the first { ... }
 * block as a safety net (LLMs occasionally wrap JSON in prose).
 */
async function callAI(systemPrompt, userMessage) {
  const provider = getProvider();
  const raw = await provider.chat(systemPrompt, userMessage);

  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  }

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('AI did not return valid JSON: ' + cleaned.slice(0, 200));
  }

  return JSON.parse(jsonMatch[0]);
}

// ============================================================
// Endpoints
// ============================================================

// ---------- Health ----------
app.get('/api/ai/health', (req, res) => {
  let providerStatus = 'not-configured';
  try {
    const p = getProvider();
    providerStatus = `${p.name} (${p.model})`;
  } catch (err) {
    providerStatus = `error: ${err.message.split('\n')[0]}`;
  }
  res.json({
    status: 'ok',
    provider: providerStatus,
    timestamp: new Date().toISOString(),
  });
});

// ---------- Mock Interview: Start ----------
app.post('/api/ai/mock-interview/start', async (req, res) => {
  try {
    const { role, skills, difficulty, questionCount, source, questionBank } = req.body;

    if (!role || !skills || !difficulty || !questionCount) {
      return res.status(400).json({ error: 'Missing required fields: role, skills, difficulty, questionCount' });
    }

    const userMessage = JSON.stringify({
      role,
      skills,
      difficulty,
      questionCount,
      source: source || 'hybrid',
      questionBank: questionBank || [],
      instruction: 'Start the interview. Return the first question as per the system prompt.',
    });

    const result = await callAI(MOCK_START_SYSTEM, userMessage);
    res.json(result);
  } catch (err) {
    console.error('mock-interview/start error:', err.message);
    res.status(500).json({ error: 'Failed to start mock interview', detail: err.message });
  }
});

// ---------- Mock Interview: Answer ----------
app.post('/api/ai/mock-interview/answer', async (req, res) => {
  try {
    const {
      sessionId,
      currentQuestion,
      userAnswer,
      questionNumber,
      totalQuestions,
      transcript,
      source,
      questionBank,
    } = req.body;

    if (!currentQuestion || !userAnswer) {
      return res.status(400).json({ error: 'Missing required fields: currentQuestion, userAnswer' });
    }

    const userMessage = JSON.stringify({
      sessionId,
      currentQuestion,
      userAnswer,
      questionNumber,
      totalQuestions,
      transcript: transcript || [],
      source: source || 'hybrid',
      questionBank: questionBank || [],
      instruction: `Evaluate the user's answer. This is question ${questionNumber} of ${totalQuestions}. ${questionNumber >= totalQuestions ? 'This is the last question — after evaluating, set next.type to "complete".' : 'After evaluating, ask the next question.'}`,
    });

    const result = await callAI(MOCK_ANSWER_SYSTEM, userMessage);
    res.json(result);
  } catch (err) {
    console.error('mock-interview/answer error:', err.message);
    res.status(500).json({ error: 'Failed to evaluate answer', detail: err.message });
  }
});

// ---------- Mock Interview: Results ----------
app.post('/api/ai/mock-interview/results', async (req, res) => {
  try {
    const { sessionId, transcript, role, skills } = req.body;

    if (!transcript || !Array.isArray(transcript)) {
      return res.status(400).json({ error: 'Missing required field: transcript (array)' });
    }

    const userMessage = JSON.stringify({
      sessionId,
      role,
      skills,
      transcript,
      instruction: 'Generate the final summary as per the system prompt.',
    });

    const result = await callAI(MOCK_RESULTS_SYSTEM, userMessage);
    res.json(result);
  } catch (err) {
    console.error('mock-interview/results error:', err.message);
    res.status(500).json({ error: 'Failed to generate results', detail: err.message });
  }
});

// ---------- Answer Coach: Evaluate ----------
app.post('/api/ai/answer-coach/evaluate', async (req, res) => {
  try {
    const { question, userAnswer, idealAnswer, difficulty } = req.body;

    if (!question || !userAnswer) {
      return res.status(400).json({ error: 'Missing required fields: question, userAnswer' });
    }

    const userMessage = JSON.stringify({
      question,
      userAnswer,
      idealAnswer: idealAnswer || null,
      difficulty: difficulty || 'intermediate',
      instruction: 'Evaluate the answer as per the system prompt.',
    });

    const result = await callAI(COACH_SYSTEM, userMessage);
    res.json(result);
  } catch (err) {
    console.error('answer-coach/evaluate error:', err.message);
    res.status(500).json({ error: 'Failed to evaluate answer', detail: err.message });
  }
});

// ---------- Question Generator ----------
app.post('/api/ai/question-generator', async (req, res) => {
  try {
    const { topic, difficulty, count } = req.body;

    if (!topic || !difficulty || !count) {
      return res.status(400).json({ error: 'Missing required fields: topic, difficulty, count' });
    }

    const userMessage = JSON.stringify({
      topic,
      difficulty,
      count,
      instruction: `Generate ${count} questions on "${topic}" at ${difficulty} difficulty.`,
    });

    const result = await callAI(GENERATOR_SYSTEM, userMessage);
    res.json(result);
  } catch (err) {
    console.error('question-generator error:', err.message);
    res.status(500).json({ error: 'Failed to generate questions', detail: err.message });
  }
});

// ---------- Start ----------
// On Vercel, this file is imported as a serverless function — Vercel
// calls the exported app for each request. Locally, we start the
// Express server with app.listen() so you can hit it in your browser.
//
// Vercel sets process.env.VERCEL automatically, so we use that to
// detect the serverless environment.
const isVercel = !!process.env.VERCEL;

if (!isVercel) {
  app.listen(PORT, () => {
    console.log(`Xora AI proxy listening on http://localhost:${PORT}`);
    console.log(`Health: http://localhost:${PORT}/api/ai/health`);
    try {
      const p = getProvider();
      console.log(`[AI] Provider: ${p.name} | Model: ${p.model}`);
    } catch (err) {
      console.error('\n[AI] No provider configured. The proxy is running but AI calls will fail.');
      console.error(err.message);
      console.error('\nSet one of:');
      console.error('  AI_PROVIDER=cloudflare + CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID  (FREE)');
      console.error('  AI_PROVIDER=zai + ZAI_API_KEY  (paid)');
    }
  });
} else {
  // Vercel: log provider at cold start so you can see it in the logs
  try {
    const p = getProvider();
    console.log(`[AI] Provider: ${p.name} | Model: ${p.model}`);
  } catch (err) {
    console.error('[AI] Provider config error:', err.message);
  }
}

// Export the Express app for Vercel's serverless runtime.
// Vercel's @vercel/node builder picks this up automatically.
export default app;
