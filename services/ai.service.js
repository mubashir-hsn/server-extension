// services/ai.service.js
import { buildSystemPrompt, buildUserPrompt, categorizeQuestion } from "./prompt-builder.service.js";

const PROVIDER = (process.env.AI_PROVIDER || "gemini").toLowerCase();

class HttpError extends Error {
  constructor(status, publicMessage) {
    super(publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

/**
 * Gemini 2.5+ models "think" before answering by default, and those
 * thinking tokens are drawn from the SAME maxOutputTokens budget as the
 * visible answer. With a low token cap (e.g. 400) the model can burn the
 * entire budget on internal reasoning and get cut off (finishReason:
 * MAX_TOKENS) with little or no visible text left — which shows up exactly
 * as "only the first line/half the answer came through". Fixed here by:
 *   1. Disabling thinking (thinkingBudget: 0) — we just need a short,
 *      grounded answer, not multi-step reasoning.
 *   2. Giving a generous maxOutputTokens ceiling so a normal ~40-80 word
 *      answer can never legitimately run out of room.
 */
async function callGemini(systemPrompt, userPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new HttpError(500, "Server is missing GEMINI_API_KEY. Set it in server/.env.");

  // gemini-2.5-flash is Google's current free-tier chat model as of writing
  // (gemini-2.0-flash was deprecated/retired). Override via GEMINI_MODEL in
  // .env if you want gemini-2.5-flash-lite (higher free daily quota, slightly
  // lower quality) or a newer model once one is available to your key.
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          maxOutputTokens: 800,
          temperature: 0.7,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new HttpError(502, `AI provider error (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];

  // finishReason "SAFETY" / "RECITATION" means Gemini refused to answer —
  // surface that clearly instead of returning an empty/blank answer.
  if (candidate?.finishReason && candidate.finishReason === "SAFETY") {
    throw new HttpError(502, "The AI provider declined to answer this question (safety filter). Try editing the question or answering manually.");
  }

  const text = (candidate?.content?.parts || []).map((p) => p.text || "").join("");
  return text.trim();
}

async function callAnthropic(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new HttpError(500, "Server is missing ANTHROPIC_API_KEY. Set it in server/.env.");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new HttpError(502, `AI provider error (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  return textBlock ? textBlock.text.trim() : "";
}

async function callOpenAI(systemPrompt, userPrompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new HttpError(500, "Server is missing OPENAI_API_KEY. Set it in server/.env.");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      max_tokens: 400,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new HttpError(502, `AI provider error (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

/**
 * Generates a first-person application answer grounded strictly in the
 * applicant's profile, resume notes, and the target job. Note that
 * buildUserPrompt() (in prompt-builder.service.js) already trims this down
 * to only the experience/skills relevant to the question — the full
 * resume/profile is never forwarded to the model.
 */
export async function generateApplicationAnswer({ profile, resume, jobTitle, company, jobDescription, question }) {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({ profile, resume, jobTitle, company, jobDescription, question });

  let answer;
  if (PROVIDER === "openai") {
    answer = await callOpenAI(systemPrompt, userPrompt);
  } else if (PROVIDER === "anthropic") {
    answer = await callAnthropic(systemPrompt, userPrompt);
  } else {
    answer = await callGemini(systemPrompt, userPrompt);
  }

  if (!answer) {
    throw new HttpError(502, "AI provider returned an empty response.");
  }

  return {
    answer,
    category: categorizeQuestion(question),
    // Simple confidence heuristic: higher when we had real profile signal to ground the answer in.
    confidence: estimateConfidence(profile, answer),
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
