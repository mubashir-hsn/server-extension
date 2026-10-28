// services/ai.service.js
import { buildSystemPrompt, buildUserPrompt, categorizeQuestion } from "./prompt-builder.service.js";

const PROVIDER = (process.env.AI_PROVIDER || "gemini").toLowerCase();
const GEMINI_BASE = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
const TOTAL_BUDGET_MS = 55000; // stay under the extension's 70s client timeout
const ATTEMPT_TIMEOUT_MS = 25000;

export class HttpError extends Error {
  constructor(status, publicMessage) {
    super(publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function timedFetch(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new HttpError(504, "The AI provider took too long to respond.");
    throw new HttpError(502, `Couldn't reach the AI provider (${err.cause?.code || err.message}). Check the server's internet connection.`);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------------- *
 * Gemini
 * ---------------------------------------------------------------------- */

/** Models tried in order: your configured model first, then dependable free-tier ones. */
function geminiModelChain() {
  const chain = [process.env.GEMINI_MODEL, "gemini-2.5-flash", "gemini-2.5-flash-lite"].filter(Boolean);
  return [...new Set(chain)];
}

/**
 * Generation settings, from "ideal" to "most compatible". Newer Gemini models
 * "think" before answering and those thinking tokens come out of the SAME
 * maxOutputTokens budget as the visible answer — with a small cap the answer
 * is cut off mid-sentence. So we ask for no/low thinking first, but if a model
 * rejects that option (Gemini 3 uses thinkingLevel, not thinkingBudget) or still
 * runs out of room, we fall back to plain settings with a much bigger budget.
 */
function generationVariants(model) {
  const isGemini3 = /^gemini-3/i.test(model);
  return [
    {
      name: "low-thinking",
      config: {
        maxOutputTokens: 1024,
        temperature: 0.7,
        thinkingConfig: isGemini3 ? { thinkingLevel: "low" } : { thinkingBudget: 0 },
      },
    },
    { name: "plain", config: { maxOutputTokens: 2048, temperature: 0.7 } },
    { name: "plain-large", config: { maxOutputTokens: 4096, temperature: 0.7 } },
  ];
}

function parseGoogleError(bodyText) {
  try {
    const j = JSON.parse(bodyText);
    return { message: j.error?.message || bodyText, status: j.error?.status || "", code: j.error?.code };
  } catch (e) {
    return { message: (bodyText || "").slice(0, 300), status: "", code: undefined };
  }
}

function friendlyGeminiError(httpStatus, err) {
  const msg = err.message || "";
  if (httpStatus === 400 && /api key/i.test(msg)) return "Gemini rejected the API key. Check GEMINI_API_KEY in server/.env (create one at aistudio.google.com/apikey).";
  if (httpStatus === 403 || httpStatus === 401) return "Gemini denied access with this API key. Make sure the key is valid and the Generative Language API is enabled for it.";
  if (httpStatus === 429) return "Gemini's free-tier rate limit was reached. Wait a minute and try again (or set GEMINI_MODEL=gemini-2.5-flash-lite for a higher free quota).";
  if (httpStatus === 404) return `Gemini model not found: ${msg.slice(0, 160)}`;
  return `Gemini error (${httpStatus}): ${msg.slice(0, 220)}`;
}

async function callGemini(systemPrompt, userPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new HttpError(500, "Server is missing GEMINI_API_KEY. Set it in server/.env and restart the server.");

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let lastError = null;

  for (const model of geminiModelChain()) {
    const variants = generationVariants(model);
    let variantIdx = 0;
    let transientRetries = 0;

    while (variantIdx < variants.length) {
      if (Date.now() > deadline) throw lastError || new HttpError(504, "The AI provider took too long to respond.");
      const variant = variants[variantIdx];

      const res = await timedFetch(
        `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            generationConfig: variant.config,
          }),
        },
        Math.min(ATTEMPT_TIMEOUT_MS, Math.max(3000, deadline - Date.now()))
      );

      if (!res.ok) {
        const err = parseGoogleError(await res.text().catch(() => ""));
        lastError = new HttpError(res.status === 429 ? 429 : 502, friendlyGeminiError(res.status, err));

        // Bad key / no access: no point trying other models.
        if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(err.message))) throw lastError;

        // This model doesn't accept our settings (e.g. thinking options): try the next, plainer variant.
        if (res.status === 400) {
          variantIdx += 1;
          continue;
        }
        // Model doesn't exist for this key: move on to the next model.
        if (res.status === 404) break;

        // Rate limit / overload: one short retry on the same model, then try the next model.
        if ((res.status === 429 || res.status >= 500) && transientRetries < 1) {
          transientRetries += 1;
          await sleep(1500);
          continue;
        }
        break;
      }

      const data = await res.json();
      const candidate = data?.candidates?.[0];
      const finishReason = candidate?.finishReason || "";
      const text = (candidate?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("").trim();

      if (data?.promptFeedback?.blockReason || finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") {
        throw new HttpError(502, "Gemini declined to answer this question (safety filter). Edit the question or write the answer yourself.");
      }

      // Cut off before finishing (thinking ate the budget) or nothing usable: retry with a bigger budget.
      if ((finishReason === "MAX_TOKENS" || !text) && variantIdx < variants.length - 1) {
        variantIdx += 1;
        continue;
      }
      if (!text) {
        lastError = new HttpError(502, "Gemini returned an empty answer.");
        break;
      }
      return { text, model, finishReason };
    }
  }

  throw lastError || new HttpError(502, "Gemini didn't return an answer.");
}

/* ---------------------------------------------------------------------- *
 * Anthropic / OpenAI (alternatives)
 * ---------------------------------------------------------------------- */

async function callAnthropic(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new HttpError(500, "Server is missing ANTHROPIC_API_KEY. Set it in server/.env.");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

  const res = await timedFetch(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 700, system: systemPrompt, messages: [{ role: "user", content: userPrompt }] }),
    },
    ATTEMPT_TIMEOUT_MS
  );
  if (!res.ok) throw new HttpError(502, `AI provider error (${res.status}): ${(await res.text().catch(() => "")).slice(0, 240)}`);
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === "text");
  return { text: block ? block.text.trim() : "", model };
}

async function callOpenAI(systemPrompt, userPrompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new HttpError(500, "Server is missing OPENAI_API_KEY. Set it in server/.env.");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const res = await timedFetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: 700, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }] }),
    },
    ATTEMPT_TIMEOUT_MS
  );
  if (!res.ok) throw new HttpError(502, `AI provider error (${res.status}): ${(await res.text().catch(() => "")).slice(0, 240)}`);
  const data = await res.json();
  return { text: (data.choices?.[0]?.message?.content || "").trim(), model };
}

async function callProvider(systemPrompt, userPrompt) {
  if (PROVIDER === "openai") return callOpenAI(systemPrompt, userPrompt);
  if (PROVIDER === "anthropic") return callAnthropic(systemPrompt, userPrompt);
  return callGemini(systemPrompt, userPrompt);
}

export async function generateJson(systemPrompt, userPrompt) {
  const { text } = await callProvider(`${systemPrompt}\nReturn JSON only. Do not use markdown fences.`, userPrompt);
  const candidate = String(text || "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(candidate); } catch (error) { throw new HttpError(502, "The AI returned invalid JSON."); }
}

/* ---------------------------------------------------------------------- *
 * Public API
 * ---------------------------------------------------------------------- */

/** Strips wrapper junk models sometimes add (quotes, "Answer:", markdown emphasis). */
export function cleanAnswer(text) {
  let t = (text || "").trim();
  t = t.replace(/^(here('| i)?s (my|the) answer|answer)\s*:\s*/i, "");
  t = t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^[*_`]+|[*_`]+$/g, "");
  if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1).trim();
  return t.trim();
}

export function getProviderInfo() {
  const keyConfigured =
    PROVIDER === "openai" ? !!process.env.OPENAI_API_KEY : PROVIDER === "anthropic" ? !!process.env.ANTHROPIC_API_KEY : !!process.env.GEMINI_API_KEY;
  const model =
    PROVIDER === "openai"
      ? process.env.OPENAI_MODEL || "gpt-4o-mini"
      : PROVIDER === "anthropic"
        ? process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6"
        : geminiModelChain()[0];
  return { provider: PROVIDER, model, keyConfigured };
}

/** Tiny real request, used by the dashboard's "Test AI" button to surface key/model/quota problems. */
export async function testProvider() {
  const started = Date.now();
  const { text, model } = await callProvider("You are a connectivity test. Reply with one short friendly sentence.", "Say that the autofill assistant is ready.");
  return { ok: true, provider: PROVIDER, model, sample: cleanAnswer(text).slice(0, 200), ms: Date.now() - started };
}

/**
 * Generates a first-person application answer grounded strictly in the
 * applicant's profile and the target job. buildUserPrompt() trims the profile
 * to the experience/skills relevant to the question — the full resume is
 * never forwarded to the model.
 */
export async function generateApplicationAnswer({ profile, resume, jobTitle, company, jobDescription, question }) {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({ profile, resume, jobTitle, company, jobDescription, question });

  const { text, model } = await callProvider(systemPrompt, userPrompt);
  const answer = cleanAnswer(text);
  if (!answer) throw new HttpError(502, "The AI provider returned an empty response.");

  return {
    answer,
    category: categorizeQuestion(question),
    confidence: estimateConfidence(profile, answer),
    model,
  };
}

function estimateConfidence(profile, answer) {
  const hasExperience = (profile?.experience || []).length > 0;
  const hasSkills = (profile?.skills || []).length > 0;
  let score = 0.6;
  if (hasExperience) score += 0.2;
  if (hasSkills) score += 0.1;
  if (answer.split(/\s+/).length >= 30) score += 0.05;
  return Math.min(0.98, Math.round(score * 100) / 100);
}
