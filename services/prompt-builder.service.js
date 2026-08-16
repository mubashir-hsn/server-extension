// services/prompt-builder.service.js
//
// Builds the prompt sent to the LLM. Deliberately does NOT dump the user's
// entire resume/profile into every request — only the experience entries
// and skills that are actually relevant to the question + job description
// are included. This keeps prompts small (cheaper, faster) and keeps
// answers focused instead of rambling through an applicant's whole career.

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "at", "by", "from",
  "is", "are", "was", "were", "be", "been", "being", "this", "that", "these", "those", "it", "as",
  "we", "you", "your", "our", "will", "would", "should", "can", "could", "about", "into", "than",
  "then", "so", "if", "not", "have", "has", "had", "do", "does", "did", "how", "what", "why",
]);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9+.# ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function overlapScore(tokensA, tokenSetB) {
  if (!tokensA.length) return 0;
  let hits = 0;
  for (const t of tokensA) if (tokenSetB.has(t)) hits += 1;
  return hits / tokensA.length;
}

/**
 * Picks the experience entries most relevant to this specific question +
 * job, instead of forwarding the applicant's entire work history. Always
 * keeps the most recent role (for continuity/context), plus up to one more
 * strongly-matching role. Descriptions are trimmed so the prompt stays
 * compact.
 */
export function selectRelevantExperience(experience = [], question = "", jobDescription = "", maxEntries = 2) {
  if (!experience.length) return [];

  const contextTokens = new Set([...tokenize(question), ...tokenize(jobDescription)]);

  const scored = experience.map((exp, idx) => {
    const expTokens = tokenize(`${exp.jobTitle || ""} ${exp.techStack || ""} ${exp.description || ""}`);
    return { exp, idx, score: overlapScore(expTokens, contextTokens) };
  });

  // Always keep the most recent role (index 0) for continuity.
  const mostRecent = scored[0];
  const rest = scored.slice(1).sort((a, b) => b.score - a.score);

  const picked = [mostRecent, ...rest.slice(0, Math.max(0, maxEntries - 1))].filter(Boolean);
  // Restore chronological order (most recent first) rather than score order.
  picked.sort((a, b) => a.idx - b.idx);

  return picked.map(({ exp }) => ({
    ...exp,
    description: (exp.description || "").slice(0, 280),
  }));
}

/**
 * Picks skills that actually appear in the job description first, then
 * backfills with the applicant's other listed skills up to the cap — so
 * the model sees what's relevant without losing the rest of the list
 * entirely.
 */
export function selectRelevantSkills(skills = [], jobDescription = "", maxSkills = 12) {
  if (!skills.length) return [];
  const jdLower = (jobDescription || "").toLowerCase();

  const matching = skills.filter((s) => s && jdLower.includes(String(s).toLowerCase()));
  const remaining = skills.filter((s) => !matching.includes(s));

  return [...matching, ...remaining].slice(0, maxSkills);
}

function summarizeExperience(experience = []) {
  if (!experience.length) return "No relevant work experience on file.";
  return experience
    .map((exp, i) => {
      const range = [exp.startDate, exp.endDate || "Present"].filter(Boolean).join(" – ");
      return `${i + 1}. ${exp.jobTitle || "Role"} at ${exp.company || "Company"} (${range})\n   Tech: ${
        exp.techStack || "n/a"
      }\n   ${exp.description || ""}`.trim();
    })
    .join("\n");
}

export function buildSystemPrompt() {
  return [
    "You are helping a real job applicant write a short, honest, first-person answer to a job application question.",
    "Rules you must always follow:",
    "- Use ONLY the information given about the applicant. Never invent skills, employers, dates, achievements, or experience that isn't provided.",
    "- If the profile doesn't contain something relevant to the question, answer honestly with what IS available rather than fabricating detail.",
    "- Write in first person, as the applicant.",
    "- Sound like a real person, not a template: avoid generic AI phrasing, buzzwords, and filler ('passionate', 'dynamic environment', 'synergy', 'leverage').",
    "- Tailor the answer to the specific job title, company, and job description provided.",
    "- Be concise: 2–4 sentences, roughly 40–80 words, unless the question clearly needs more.",
    "- Return ONLY the answer text. No preamble, no quotation marks, no labels like 'Answer:', no markdown.",
  ].join("\n");
}

export function buildUserPrompt({ profile, resume, jobTitle, company, jobDescription, question }) {
  const personal = profile?.personal || {};
  const education = profile?.education || {};
  const links = profile?.links || {};

  const relevantSkills = selectRelevantSkills(profile?.skills, jobDescription);
  const relevantExperience = selectRelevantExperience(profile?.experience, question, jobDescription);

  return `
APPLICANT PROFILE (only the parts relevant to this question are included)
Name: ${[personal.firstName, personal.lastName].filter(Boolean).join(" ") || personal.fullName || "Not specified"}
Education: ${education.degree || ""} in ${education.fieldOfStudy || ""} — ${education.university || "Not specified"}
Relevant skills: ${relevantSkills.join(", ") || "Not specified"}
Links: ${[links.github, links.linkedin, links.portfolio].filter(Boolean).join(", ") || "Not specified"}
${resume ? `Resume note: ${resume}` : ""}

RELEVANT WORK EXPERIENCE
${summarizeExperience(relevantExperience)}

JOB BEING APPLIED TO
Title: ${jobTitle || "Not specified"}
Company: ${company || "Not specified"}
Description: ${(jobDescription || "Not specified").slice(0, 3000)}

QUESTION TO ANSWER
"${question}"

Write the applicant's answer now — concise, first person, grounded only in the profile above.
`.trim();
}

/** Very rough heuristic categorizer for the response payload's "category" field. */
export function categorizeQuestion(question) {
  const q = (question || "").toLowerCase();
  if (/react|javascript|python|code|technical|engineering|api|database/.test(q)) return "technical";
  if (/why.*(join|interested|company|role)/.test(q)) return "motivation";
  if (/yourself|about you/.test(q)) return "introduction";
  if (/hire you|fit/.test(q)) return "value_proposition";
  return "general";
}
