import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json({ limit: '10mb' }));

// CORS support so static frontends (e.g. GitHub Pages) can reach an external backend via VITE_API_BASE_URL
app.use('/api', (req, res, next) => {
  const configuredOrigins = (process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const reqOrigin = req.headers.origin;

  if (configuredOrigins.length > 0 && reqOrigin && configuredOrigins.includes(reqOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
  } else if (configuredOrigins.length === 1) {
    res.setHeader('Access-Control-Allow-Origin', configuredOrigins[0]);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Initialize GoogleGenAI SDK server-side
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

function unwrapErrorString(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'Unexpected AI service error.';
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.error === 'string') return unwrapErrorString(parsed.error);
      if (parsed?.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string') {
        return unwrapErrorString(parsed.error.message);
      }
      if (typeof parsed?.message === 'string') return unwrapErrorString(parsed.message);
    } catch {
      // keep raw
    }
  }
  return trimmed;
}

function parseGeminiErrorMessage(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as any).message)
        : String(err || 'Unexpected AI service error.');
  return unwrapErrorString(raw);
}

function isFallbackEligibleError(err: unknown): boolean {
  const status = typeof err === 'object' && err !== null && 'status' in err ? Number((err as any).status) : 0;
  const msg = parseGeminiErrorMessage(err) + ' ' + (err instanceof Error ? err.message : String(err || ''));
  return (
    status === 403 ||
    status === 404 ||
    status === 429 ||
    status === 500 ||
    status === 503 ||
    msg.includes('403') ||
    msg.includes('404') ||
    msg.includes('429') ||
    msg.includes('500') ||
    msg.includes('503') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('NOT_FOUND') ||
    msg.toLowerCase().includes('high demand') ||
    msg.toLowerCase().includes('quota')
  );
}

function stripJsonCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(process.env.GEMINI_API_KEY),
  });
});

/**
 * POST /api/ai/analyze-commit
 * Analyzes the diff, files, and architectural context of a commit using Gemini (with model fallback)
 */
app.post('/api/ai/analyze-commit', async (req: Request, res: Response) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the backend server.' });
    }

    const { commit, repositoryName, comparisonBaseShortSha } = req.body;

    if (!commit) {
      return res.status(400).json({ error: 'Commit data is required.' });
    }

    const filesSummary = (commit.files || [])
      .map((f: any) => {
        const previewPrev = (f.previousContent || '').slice(0, 1500);
        const previewNext = (f.content || '').slice(0, 1500);
        return `File: ${f.path} (${f.status})\nPrevious Snippet:\n${previewPrev}\n\nNew Snippet:\n${previewNext}\n---`;
      })
      .join('\n\n');

    const prompt = `You are a Principal Software Architect conducting an in-depth code evolution and architectural review.

Repository: ${repositoryName || 'Git Repository'}
Commit SHA: ${commit.sha} (${commit.shortSha})
Commit Title: ${commit.title}
Commit Description: ${commit.message || 'No description provided'}
Author: ${commit.author}
Category: ${commit.category}
${comparisonBaseShortSha ? `Comparison Base: Commit ${comparisonBaseShortSha}` : ''}

Files Changed & Code Snippets:
${filesSummary}

Existing ADR Context (if any):
Problem: ${commit.adr?.problemStatement || 'N/A'}
Decision: ${commit.adr?.decisionSummary || 'N/A'}
Outcome: ${commit.adr?.measurableOutcome || 'N/A'}

Provide a rigorous architectural and code evolution analysis. Explain:
1. Concise executive summary of what this commit actually changes.
2. The core architectural intent (why this refactoring/decision matters long-term, system topology effects).
3. Impact severity score (Low, Moderate, High, or Critical).
4. Concrete key code changes (bullet points).
5. Latent risks, trade-offs, and failure modes introduced (e.g. concurrency, memory, network latency, backward compatibility).
6. 2-3 deep questions an engineering team should ask during review.
7. Detected engineering patterns or antipatterns (e.g., "Optimistic Concurrency Control", "Volcano Iterator to Columnar SIMD", "Zero-Copy Buffer", "Memory Leak / Cache Bloat").`;

    const modelCandidates = ['gemini-4-carbon', 'gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
    let lastError: unknown = null;
    let parsedAnalysis: Record<string, unknown> | null = null;
    let modelUsed = modelCandidates[0];

    for (let i = 0; i < modelCandidates.length; i++) {
      const candidate = modelCandidates[i];
      try {
        const response = await ai.models.generateContent({
          model: candidate,
          contents: prompt,
          config: {
            systemInstruction:
              'You are an expert Principal Systems Architect. Output strictly structured JSON matching the provided schema with high engineering depth, clear trade-offs, and zero marketing fluff.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                summary: {
                  type: Type.STRING,
                  description: 'Clear, concise executive summary of what actually changed in the code.',
                },
                architecturalIntent: {
                  type: Type.STRING,
                  description:
                    'The deeper architectural rationale and why this change was made in the timeline.',
                },
                impactScore: {
                  type: Type.STRING,
                  description: 'One of: Low, Moderate, High, Critical',
                },
                keyChanges: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: 'Concrete technical code updates made.',
                },
                risksAndTradeoffs: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description:
                    'Technical risks, performance costs, or operational trade-offs introduced.',
                },
                suggestedQuestions: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: 'Hard architectural questions to ask in code review.',
                },
                detectedPatterns: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: 'Design patterns or system architectures detected in this change.',
                },
              },
              required: [
                'summary',
                'architecturalIntent',
                'impactScore',
                'keyChanges',
                'risksAndTradeoffs',
                'suggestedQuestions',
                'detectedPatterns',
              ],
            },
          },
        });

        parsedAnalysis = JSON.parse(stripJsonCodeFences(response.text || '{}'));
        modelUsed = candidate;
        break;
      } catch (candidateErr) {
        lastError = candidateErr;
        if (i < modelCandidates.length - 1 && isFallbackEligibleError(candidateErr)) {
          continue;
        }
        throw candidateErr;
      }
    }

    if (!parsedAnalysis) {
      throw lastError || new Error('Failed to generate architectural analysis.');
    }

    return res.json({ analysis: parsedAnalysis, modelUsed });
  } catch (err: any) {
    console.error('Error analyzing commit with Gemini:', err);
    return res.status(500).json({
      error: parseGeminiErrorMessage(err) || 'Failed to generate architectural analysis.',
    });
  }
});

/**
 * POST /api/ai/ask-diff
 * Fast single-turn Q&A about this specific commit's diff using Gemini with model fallback
 */
app.post('/api/ai/ask-diff', async (req: Request, res: Response) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the backend server.' });
    }

    const { question, commit, repositoryName, stream = false } = req.body;

    if (!question || !commit) {
      return res.status(400).json({ error: 'Question and commit context are required.' });
    }

    const filesSummary = (commit.files || [])
      .map((f: any) => `File ${f.path}:\n${(f.content || '').slice(0, 2000)}`)
      .join('\n\n');

    const prompt = `You are a Staff Engineer explaining a code commit in "${repositoryName}".
Commit: [${commit.shortSha}] ${commit.title}
Author: ${commit.author}
Category: ${commit.category}
Code content:
${filesSummary}

User question: "${question}"

Provide a direct, precise, technically accurate engineering answer in clean Markdown. Reference specific symbols, data structures, or algorithmic principles where relevant. Use fenced code blocks with language tags for code snippets.`;

    const modelCandidates = ['gemini-3.1-flash-lite', 'gemini-4-hydrogen'];

    if (stream) {
      let streamStarted = false;
      let usedModel = modelCandidates[0];

      for (let i = 0; i < modelCandidates.length; i++) {
        const candidate = modelCandidates[i];
        try {
          const responseStream = await ai.models.generateContentStream({
            model: candidate,
            contents: prompt,
          });

          for await (const chunk of responseStream) {
            const text = chunk.text;
            if (text) {
              if (!streamStarted) {
                streamStarted = true;
                res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache, no-transform');
                res.setHeader('Connection', 'keep-alive');
              }
              res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
            }
          }

          if (!streamStarted) {
            streamStarted = true;
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
          }
          usedModel = candidate;
          res.write(`data: ${JSON.stringify({ done: true, modelUsed: usedModel })}\n\n`);
          return res.end();
        } catch (candidateErr) {
          if (!streamStarted && i < modelCandidates.length - 1 && isFallbackEligibleError(candidateErr)) {
            continue;
          }
          throw candidateErr;
        }
      }
      return res.end();
    }

    let answerText = '';
    let usedModel = modelCandidates[0];
    for (let i = 0; i < modelCandidates.length; i++) {
      const candidate = modelCandidates[i];
      try {
        const response = await ai.models.generateContent({
          model: candidate,
          contents: prompt,
        });
        answerText = response.text || 'No answer generated.';
        usedModel = candidate;
        break;
      } catch (candidateErr) {
        if (i < modelCandidates.length - 1 && isFallbackEligibleError(candidateErr)) {
          continue;
        }
        throw candidateErr;
      }
    }

    return res.json({ answer: answerText, modelUsed: usedModel });
  } catch (err: any) {
    console.error('Error answering question with Gemini:', err);
    const message = parseGeminiErrorMessage(err) || 'Failed to answer architectural question.';
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      return res.end();
    }
    return res.status(500).json({ error: message });
  }
});

const PERSONA_CONFIG: Record<
  string,
  { model: string; roleTitle: string; systemInstruction: string }
> = {
  general: {
    model: 'gemini-4-hydrogen',
    roleTitle: 'Timeline Explorer',
    systemInstruction:
      'You are GitReplay Timeline Explorer, a senior software engineer helping developers navigate Git commit timelines, understand code evolution across revisions, and trace why specific changes happened. Keep answers crisp, structured in clean Markdown, and grounded in the provided commit and diff context.',
  },
  architect: {
    model: 'gemini-4-carbon',
    roleTitle: 'Principal Systems Architect',
    systemInstruction:
      'You are a Principal Systems Architect conducting deep architectural reasoning on code evolution. Analyze distributed consistency, concurrency invariants, memory/CPU complexity, failure modes, and long-term modular boundaries. Challenge assumptions and articulate explicit trade-offs in clean Markdown.',
  },
  mentor: {
    model: 'gemini-4-argon',
    roleTitle: 'Interactive Refactoring Mentor',
    systemInstruction:
      'You are an Interactive Staff Code Mentor guiding engineers through complex refactoring decisions, design pattern migrations, and API ergonomics. Provide concrete code-level comparisons in fenced code blocks, step-by-step mental models, and actionable next-step improvements.',
  },
  fast: {
    model: 'gemini-3.1-flash-lite',
    roleTitle: 'Rapid Diff Explainer',
    systemInstruction:
      'You are a Rapid Diff Explainer optimized for ultra-fast, high-signal responses. Summarize what changed, why it matters, and any immediate edge cases in concise Markdown bullet points with zero fluff.',
  },
};

/**
 * POST /api/ai/chat
 * Multi-turn Gemini chat endpoint maintaining conversation history and role-based system instructions
 */
app.post('/api/ai/chat', async (req: Request, res: Response) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the backend server.' });
    }

    const {
      message,
      history = [],
      persona = 'general',
      commit,
      repositoryName,
      totalCommits,
      stream = false,
    } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'A message string is required.' });
    }

    const config = PERSONA_CONFIG[persona] || PERSONA_CONFIG.general;

    const commitContext = commit
      ? `\n\nActive Timeline Context:\n- Repository: ${repositoryName || 'Unknown'}\n- Total Commits in Replay: ${totalCommits || 'Unknown'}\n- Current Commit: [${commit.shortSha}] ${commit.title}\n- Author: ${commit.author} (${commit.authorRole || 'Contributor'})\n- Timestamp: ${commit.timestamp}\n- Category: ${commit.category}\n- Message: ${commit.message || ''}\n- ADR Summary (${commit.adr?.id || 'ADR'}): ${commit.adr?.decisionSummary || 'N/A'}\n- Changed Files:\n${(
          commit.files || []
        )
          .map(
            (f: any) =>
              `  * ${f.path} (${f.status})\nPrevious:\n${(f.previousContent || '').slice(
                0,
                900
              )}\nCurrent:\n${(f.content || '').slice(0, 1200)}`
          )
          .join('\n\n')}`
      : '';

    const fullSystemInstruction = `${config.systemInstruction}${commitContext}`;

    const formattedHistory = Array.isArray(history)
      ? history
          .filter((h: any) => h && (h.role === 'user' || h.role === 'model') && typeof h.text === 'string')
          .slice(-20)
          .map((h: any) => ({
            role: h.role,
            parts: [{ text: h.text }],
          }))
      : [];

    const modelCandidates = Array.from(
      new Set([config.model, 'gemini-4-hydrogen', 'gemini-3.1-flash-lite'])
    );

    if (stream) {
      let streamStarted = false;
      let usedModel = modelCandidates[0];

      for (let i = 0; i < modelCandidates.length; i++) {
        const candidate = modelCandidates[i];
        try {
          const chat = ai.chats.create({
            model: candidate,
            history: formattedHistory,
            config: { systemInstruction: fullSystemInstruction },
          });
          const responseStream = await chat.sendMessageStream({ message });
          for await (const chunk of responseStream) {
            const text = chunk.text;
            if (text) {
              if (!streamStarted) {
                streamStarted = true;
                res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache, no-transform');
                res.setHeader('Connection', 'keep-alive');
              }
              res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
            }
          }

          if (!streamStarted) {
            streamStarted = true;
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
          }
          usedModel = candidate;
          res.write(
            `data: ${JSON.stringify({ done: true, modelUsed: usedModel, roleTitle: config.roleTitle })}\n\n`
          );
          return res.end();
        } catch (modelErr) {
          if (!streamStarted && i < modelCandidates.length - 1 && isFallbackEligibleError(modelErr)) {
            continue;
          }
          throw modelErr;
        }
      }
      return res.end();
    }

    let replyText = '';
    let usedModel = modelCandidates[0];

    for (let i = 0; i < modelCandidates.length; i++) {
      const candidate = modelCandidates[i];
      try {
        const chat = ai.chats.create({
          model: candidate,
          history: formattedHistory,
          config: {
            systemInstruction: fullSystemInstruction,
          },
        });
        const response = await chat.sendMessage({ message });
        replyText = response.text || 'No response generated.';
        usedModel = candidate;
        break;
      } catch (modelErr) {
        if (i < modelCandidates.length - 1 && isFallbackEligibleError(modelErr)) {
          continue;
        }
        throw modelErr;
      }
    }

    return res.json({
      reply: replyText,
      modelUsed: usedModel,
      roleTitle: config.roleTitle,
    });
  } catch (err: any) {
    console.error('Error in /api/ai/chat:', err);
    const message = parseGeminiErrorMessage(err) || 'Failed to generate chat response.';
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      return res.end();
    }
    return res.status(500).json({ error: message });
  }
});

// Mount Vite in development or serve static in production
async function startServer() {
  const isProd =
    process.env.NODE_ENV === 'production' ||
    __filename.endsWith(`${path.sep}dist${path.sep}server.js`);

  if (isProd) {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ...(hmrDisabled ? { hmr: false, ws: false } : {}),
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`GitReplay server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
