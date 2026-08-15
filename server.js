/**
 * Xora AI Proxy
 *
 * Providers:
 * - Google Gemini
 * - Cloudflare Workers AI
 * - Z.ai
 *
 * Voice:
 * - Gemini Live API
 * - Short-lived ephemeral token
 * - Browser connects directly to Gemini Live
 *
 * Node.js >= 20
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';

import {
  MOCK_START_SYSTEM,
  MOCK_ANSWER_SYSTEM,
  MOCK_RESULTS_SYSTEM,
  COACH_SYSTEM,
  GENERATOR_SYSTEM,
  VOICE_RESULTS_SYSTEM,
} from './prompts.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================================
// Process error handlers
// ============================================================

process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err?.message || err);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err?.message || err);
});

// ============================================================
// Middleware
// ============================================================

const allowedOrigins = (
  process.env.XORA_ALLOWED_ORIGINS ||
  'http://localhost:4200,https://xora-dev.vercel.app'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) {
        return cb(null, true);
      }

      return cb(new Error(`CORS blocked: ${origin}`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.use(express.json({ limit: '2mb' }));

// ============================================================
// Rate limiting
// ============================================================

const requestCounts = new Map();
const voiceSessionCounts = new Map();

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

app.use((req, res, next) => {
  if (req.path === '/api/ai/health') {
    return next();
  }

  const ip =
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown';

  const now = Date.now();

  const entry =
    requestCounts.get(ip) || {
      count: 0,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  entry.count += 1;

  requestCounts.set(ip, entry);

  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: 'Rate limit exceeded. Try again in a minute.',
    });
  }

  next();
});

function allowVoiceSession(req) {
  const ip =
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown';

  const now = Date.now();

  const entry =
    voiceSessionCounts.get(ip) || {
      count: 0,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  entry.count += 1;

  voiceSessionCounts.set(ip, entry);

  return entry.count <= 6;
}

// ============================================================
// Cloudflare provider
// ============================================================

class CloudflareProvider {
  constructor() {
    this.name = 'cloudflare';

    this.apiToken =
      process.env.CLOUDFLARE_API_TOKEN;

    this.accountId =
      process.env.CLOUDFLARE_ACCOUNT_ID;

    this.model =
      process.env.CLOUDFLARE_MODEL ||
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

    if (!this.apiToken || !this.accountId) {
      throw new Error(
        'Cloudflare provider requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.',
      );
    }
  }

  async chat(systemPrompt, userMessage) {
    const url =
      `https://api.cloudflare.com/client/v4/accounts/` +
      `${this.accountId}/ai/run/${this.model}`;

    let response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: systemPrompt,
            },
            {
              role: 'user',
              content: userMessage,
            },
          ],
          temperature: 0.7,
          max_tokens: 2048,
        }),
      });
    } catch (err) {
      throw new Error(
        `Cloudflare network error: ${err.message}`,
      );
    }

    if (!response.ok) {
      const errorBody = await response.text();

      let message =
        `Cloudflare API error (${response.status})`;

      try {
        const parsed = JSON.parse(errorBody);

        if (parsed.errors?.[0]?.message) {
          message += `: ${parsed.errors[0].message}`;
        }
      } catch {
        message += `: ${errorBody.slice(0, 300)}`;
      }

      throw new Error(message);
    }

    const data = await response.json();

    if (!data.success) {
      throw new Error(
        `Cloudflare error: ${
          data.errors?.[0]?.message ||
          'Unknown Cloudflare error'
        }`,
      );
    }

    const content =
      data.result?.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error(
        'Cloudflare returned no content',
      );
    }

    return content;
  }
}

// ============================================================
// Z.ai provider
// ============================================================

class ZaiProvider {
  constructor() {
    this.name = 'zai';
    this.model = 'glm-4.6';

    this.apiKey =
      process.env.ZAI_API_KEY;

    this.baseUrl =
      process.env.ZAI_BASE_URL ||
      'https://open.bigmodel.cn/api/paas/v4';

    this.token =
      process.env.ZAI_TOKEN;

    if (!this.apiKey) {
      throw new Error(
        'Z.ai provider requires ZAI_API_KEY.',
      );
    }
  }

  async chat(systemPrompt, userMessage) {
    const ZAI =
      (await import('z-ai-web-dev-sdk')).default;

    const config = {
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      ...(this.token && {
        token: this.token,
      }),
    };

    const zai = new ZAI(config);

    let response;

    try {
      response =
        await zai.chat.completions.create({
          model: this.model,
          messages: [
            {
              role: 'system',
              content: systemPrompt,
            },
            {
              role: 'user',
              content: userMessage,
            },
          ],
          temperature: 0.7,
          thinking: {
            type: 'disabled',
          },
        });
    } catch (err) {
      const msg = err.message || '';

      if (msg.includes('status 401')) {
        throw new Error(
          'Z.ai rejected the API key (401).',
        );
      }

      if (
        msg.includes('status 429') &&
        msg.includes('1113')
      ) {
        throw new Error(
          'Z.ai account has insufficient credits.',
        );
      }

      if (msg.includes('status 429')) {
        throw new Error(
          'Z.ai rate limit hit.',
        );
      }

      throw err;
    }

    return (
      response.choices?.[0]?.message?.content ||
      ''
    );
  }
}

// ============================================================
// Gemini text provider
// ============================================================

class GeminiProvider {
  constructor() {
    this.name = 'gemini';

    this.apiKey =
      process.env.GEMINI_API_KEY;

    this.model =
      process.env.GEMINI_MODEL ||
      'gemini-2.5-flash';

    if (!this.apiKey) {
      throw new Error(
        'Gemini provider requires GEMINI_API_KEY.',
      );
    }
  }

  async chat(systemPrompt, userMessage) {
    const url = new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${encodeURIComponent(this.model)}:generateContent`,
    );

    url.searchParams.set(
      'key',
      this.apiKey,
    );

    let response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: systemPrompt,
              },
            ],
          },

          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: userMessage,
                },
              ],
            },
          ],

          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048,
            responseMimeType:
              'application/json',
          },
        }),
      });
    } catch (err) {
      throw new Error(
        `Gemini network error: ${err.message}`,
      );
    }

    if (!response.ok) {
      const errorBody =
        await response.text();

      let message =
        `Gemini API error (${response.status})`;

      try {
        const parsed =
          JSON.parse(errorBody);

        message += `: ${
          parsed.error?.message ||
          'Unknown Gemini error'
        }`;
      } catch {
        message += `: ${errorBody.slice(0, 300)}`;
      }

      throw new Error(message);
    }

    const data =
      await response.json();

    const content =
      data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('')
        .trim();

    if (!content) {
      const blockReason =
        data.promptFeedback?.blockReason;

      throw new Error(
        blockReason
          ? `Gemini blocked the prompt: ${blockReason}`
          : 'Gemini returned no content',
      );
    }

    return content;
  }
}

// ============================================================
// Provider factory
// ============================================================

let activeProvider = null;

function getProvider() {
  if (activeProvider) {
    return activeProvider;
  }

  const explicit =
    process.env.AI_PROVIDER?.toLowerCase();

  if (explicit === 'cloudflare') {
    activeProvider =
      new CloudflareProvider();
  } else if (explicit === 'zai') {
    activeProvider =
      new ZaiProvider();
  } else if (explicit === 'gemini') {
    activeProvider =
      new GeminiProvider();
  } else if (process.env.GEMINI_API_KEY) {
    activeProvider =
      new GeminiProvider();
  } else if (
    process.env.CLOUDFLARE_API_TOKEN &&
    process.env.CLOUDFLARE_ACCOUNT_ID
  ) {
    activeProvider =
      new CloudflareProvider();
  } else if (process.env.ZAI_API_KEY) {
    activeProvider =
      new ZaiProvider();
  } else {
    throw new Error(
      'No AI provider configured.',
    );
  }

  console.log(
    `[AI] Using provider: ${activeProvider.name}` +
      ` (model: ${activeProvider.model})`,
  );

  return activeProvider;
}

// ============================================================
// JSON helper
// ============================================================

async function callAI(
  systemPrompt,
  userMessage,
) {
  const provider =
    getProvider();

  const raw =
    await provider.chat(
      systemPrompt,
      userMessage,
    );

  let cleaned =
    raw.trim();

  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();
  }

  const jsonMatch =
    cleaned.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error(
      'AI did not return valid JSON: ' +
        cleaned.slice(0, 300),
    );
  }

  return JSON.parse(
    jsonMatch[0],
  );
}

// ============================================================
// Gemini Live configuration
// ============================================================

function getGeminiLiveConfig({
  role,
  skills,
  difficulty,
}) {
  const model =
    process.env.GEMINI_LIVE_MODEL ||
    'gemini-3.1-flash-live-preview';

  const safeRole =
    String(role || '')
      .slice(0, 120);

  const safeSkills =
    Array.isArray(skills)
      ? skills
          .map((skill) =>
            String(skill).slice(0, 60),
          )
          .slice(0, 12)
      : [];

  const safeDifficulty =
    [
      'beginner',
      'intermediate',
      'advanced',
    ].includes(difficulty)
      ? difficulty
      : 'intermediate';

  const systemInstruction = `
You are Xora, a professional technical interviewer.

Candidate role:
${safeRole}

Difficulty:
${safeDifficulty}

Focus skills:
${safeSkills.join(', ') || 'general software engineering'}

INTERVIEW RULES:

1. You are conducting a real technical interview.
2. Ask exactly ONE question at a time.
3. Keep each question concise and natural when spoken.
4. Wait for the candidate's complete answer before continuing.
5. Do not interrupt the candidate.
6. After the candidate answers, briefly acknowledge the answer.
7. Ask one relevant follow-up OR move to the next topic.
8. Probe technical depth, trade-offs, implementation details and real-world experience.
9. If the candidate says they do not know, move on professionally.
10. Do not reveal the ideal answer during the interview.
11. Do not provide scores during the interview.
12. Do not give a final report during the interview.
13. The first interaction must be a spoken interview question.
14. Never ask multiple questions in one turn.
15. Keep spoken responses concise.

The browser controls whether the candidate is allowed to speak.
Do not attempt to interrupt the candidate.

The browser also displays your spoken output as live text.
`;

  return {
    model,

    config: {
      responseModalities: ['AUDIO'],

      inputAudioTranscription: {},

      outputAudioTranscription: {},

      realtimeInputConfig: {
        automaticActivityDetection: {
          endOfSpeechSensitivity:
            'END_SENSITIVITY_LOW',

          silenceDurationMs: 900,
        },
      },

      systemInstruction: {
        parts: [
          {
            text: systemInstruction,
          },
        ],
      },

      sessionResumption: {},

      contextWindowCompression: {
        triggerTokens: 25000,
        slidingWindow: {
          targetTokens: 8000,
        },
      },
    },
  };
}

// ============================================================
// Gemini ephemeral Live token
// ============================================================

async function createGeminiLiveToken(liveConfig) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      'Voice interview requires GEMINI_API_KEY.'
    );
  }

  const client = new GoogleGenAI({
    apiKey,
  });

  const expireTime =
    new Date(
      Date.now() + 30 * 60 * 1000
    ).toISOString();

  const newSessionExpireTime =
    new Date(
      Date.now() + 60 * 1000
    ).toISOString();

  console.log(
    '[Gemini Live] Creating ephemeral token...'
  );

  const token =
    await client.authTokens.create({
      config: {
        uses: 1,
        expireTime,
        newSessionExpireTime,

        liveConnectConstraints: {
          model: liveConfig.model,

          config: liveConfig.config,
        },
      },
    });

  if (!token?.name) {
    throw new Error(
      'Gemini did not return a Live ephemeral token.'
    );
  }

  console.log(
    '[Gemini Live] Ephemeral token created'
  );

  return token;
}

// ============================================================
// Health
// ============================================================

app.get(
  '/api/ai/health',
  (req, res) => {
    let providerStatus =
      'not-configured';

    try {
      const provider =
        getProvider();

      providerStatus =
        `${provider.name} (${provider.model})`;
    } catch (err) {
      providerStatus =
        `error: ${err.message}`;
    }

    res.json({
      status: 'ok',
      provider: providerStatus,
      voiceModel:
        process.env.GEMINI_LIVE_MODEL ||
        'gemini-3.1-flash-live-preview',
      timestamp:
        new Date().toISOString(),
    });
  },
);

// ============================================================
// Mock interview start
// ============================================================

app.post(
  '/api/ai/mock-interview/start',
  async (req, res) => {
    try {
      const {
        role,
        skills,
        difficulty,
        questionCount,
        source,
        questionBank,
      } = req.body;

      if (
        !role ||
        !skills ||
        !difficulty ||
        !questionCount
      ) {
        return res.status(400).json({
          error:
            'Missing required fields: role, skills, difficulty, questionCount',
        });
      }

      const result =
        await callAI(
          MOCK_START_SYSTEM,
          JSON.stringify({
            role,
            skills,
            difficulty,
            questionCount,
            source:
              source || 'hybrid',
            questionBank:
              questionBank || [],
          }),
        );

      res.json(result);
    } catch (err) {
      console.error(
        'mock-interview/start error:',
        err.message,
      );

      res.status(500).json({
        error:
          'Failed to start mock interview',
        detail: err.message,
      });
    }
  },
);

// ============================================================
// Mock interview answer
// ============================================================

app.post(
  '/api/ai/mock-interview/answer',
  async (req, res) => {
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

      if (
        !currentQuestion ||
        !userAnswer
      ) {
        return res.status(400).json({
          error:
            'Missing required fields: currentQuestion, userAnswer',
        });
      }

      const result =
        await callAI(
          MOCK_ANSWER_SYSTEM,
          JSON.stringify({
            sessionId,
            currentQuestion,
            userAnswer,
            questionNumber,
            totalQuestions,
            transcript:
              transcript || [],
            source:
              source || 'hybrid',
            questionBank:
              questionBank || [],
          }),
        );

      res.json(result);
    } catch (err) {
      console.error(
        'mock-interview/answer error:',
        err.message,
      );

      res.status(500).json({
        error:
          'Failed to evaluate answer',
        detail: err.message,
      });
    }
  },
);

// ============================================================
// Mock interview results
// ============================================================

app.post(
  '/api/ai/mock-interview/results',
  async (req, res) => {
    try {
      const {
        sessionId,
        transcript,
        role,
        skills,
      } = req.body;

      if (
        !transcript ||
        !Array.isArray(transcript)
      ) {
        return res.status(400).json({
          error:
            'Missing required field: transcript',
        });
      }

      const result =
        await callAI(
          MOCK_RESULTS_SYSTEM,
          JSON.stringify({
            sessionId,
            role,
            skills,
            transcript,
          }),
        );

      res.json(result);
    } catch (err) {
      console.error(
        'mock-interview/results error:',
        err.message,
      );

      res.status(500).json({
        error:
          'Failed to generate results',
        detail: err.message,
      });
    }
  },
);

// ============================================================
// Answer coach
// ============================================================

app.post(
  '/api/ai/answer-coach/evaluate',
  async (req, res) => {
    try {
      const {
        question,
        userAnswer,
        idealAnswer,
        difficulty,
      } = req.body;

      if (
        !question ||
        !userAnswer
      ) {
        return res.status(400).json({
          error:
            'Missing required fields: question, userAnswer',
        });
      }

      const result =
        await callAI(
          COACH_SYSTEM,
          JSON.stringify({
            question,
            userAnswer,
            idealAnswer:
              idealAnswer || null,
            difficulty:
              difficulty ||
              'intermediate',
          }),
        );

      res.json(result);
    } catch (err) {
      console.error(
        'answer-coach/evaluate error:',
        err.message,
      );

      res.status(500).json({
        error:
          'Failed to evaluate answer',
        detail: err.message,
      });
    }
  },
);

// ============================================================
// Question generator
// ============================================================

app.post(
  '/api/ai/question-generator',
  async (req, res) => {
    try {
      const {
        topic,
        difficulty,
        count,
      } = req.body;

      if (
        !topic ||
        !difficulty ||
        !count
      ) {
        return res.status(400).json({
          error:
            'Missing required fields: topic, difficulty, count',
        });
      }

      const result =
        await callAI(
          GENERATOR_SYSTEM,
          JSON.stringify({
            topic,
            difficulty,
            count,
          }),
        );

      res.json(result);
    } catch (err) {
      console.error(
        'question-generator error:',
        err.message,
      );

      res.status(500).json({
        error:
          'Failed to generate questions',
        detail: err.message,
      });
    }
  },
);

// ============================================================
// Voice interview session
// ============================================================

app.post(
  '/api/ai/voice/session',
  async (req, res) => {
    try {
      if (!allowVoiceSession(req)) {
        return res.status(429).json({
          error:
            'Too many voice-session requests. Try again in a minute.',
        });
      }

      const {
        role,
        skills,
        difficulty,
      } = req.body || {};

      if (
        !role ||
        !Array.isArray(skills) ||
        skills.length === 0
      ) {
        return res.status(400).json({
          error:
            'Missing required fields: role and skills',
        });
      }

      const liveConfig =
        getGeminiLiveConfig({
          role,
          skills,
          difficulty,
        });

      const token =
        await createGeminiLiveToken(
          liveConfig,
        );

      res.json({
        token: token.name,

        model:
          liveConfig.model,

        config:
          liveConfig.config,

        expiresAt:
          token.expireTime,

        newSessionExpiresAt:
          token.newSessionExpireTime,
      });
    } catch (err) {
      console.error(
        '[voice/session]',
        err,
      );

      res.status(500).json({
        error:
          'Failed to start voice interview',
        detail:
          err.message ||
          'Unknown Gemini Live error',
      });
    }
  },
);

// ============================================================
// Voice results
// ============================================================

app.post(
  '/api/ai/voice/results',
  async (req, res) => {
    try {
      const {
        role,
        skills,
        transcript,
        speechStats,
      } = req.body || {};

      if (
        !role ||
        !Array.isArray(skills) ||
        !Array.isArray(transcript) ||
        transcript.length === 0
      ) {
        return res.status(400).json({
          error:
            'Missing required fields: role, skills, transcript',
        });
      }

      const safeTranscript =
        transcript
          .slice(0, 100)
          .map((entry) => ({
            speaker:
              entry?.speaker ===
              'candidate'
                ? 'candidate'
                : 'interviewer',

            text: String(
              entry?.text || '',
            ).slice(0, 3000),
          }))
          .filter(
            (entry) =>
              entry.text,
          );

      const result =
        await callAI(
          VOICE_RESULTS_SYSTEM,
          JSON.stringify({
            role: String(
              role,
            ).slice(0, 120),

            skills: skills
              .map((skill) =>
                String(skill).slice(
                  0,
                  60,
                ),
              )
              .slice(0, 12),

            transcript:
              safeTranscript,

            speechStats:
              speechStats || null,
          }),
        );

      res.json(result);
    } catch (err) {
      console.error(
        'voice/results error:',
        err.message,
      );

      res.status(500).json({
        error:
          'Failed to generate voice interview results',
        detail: err.message,
      });
    }
  },
);

// ============================================================
// Start
// ============================================================

const isVercel =
  !!process.env.VERCEL;

if (!isVercel) {
  app.listen(
    PORT,
    () => {
      console.log(
        `Xora AI proxy listening on http://localhost:${PORT}`,
      );

      console.log(
        `Health: http://localhost:${PORT}/api/ai/health`,
      );

      try {
        const provider =
          getProvider();

        console.log(
          `[AI] Provider: ${provider.name}`,
        );
      } catch (err) {
        console.error(
          '[AI] Provider configuration error:',
          err.message,
        );
      }
    },
  );
}

export default app;