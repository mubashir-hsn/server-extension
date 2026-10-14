// services/sensitive-question-filter.js
// Keep in sync with extension/content/question-detector.js (SENSITIVE_PATTERNS).

const SENSITIVE_PATTERNS = [
  { category: "work_authorization", pattern: /work authori[sz]|authori[sz]ed to work|legally (permitted|able|allowed|entitled) to work|right to work|work permit/i },
  { category: "visa_sponsorship", pattern: /\bvisa\b|sponsorship/i },
  { category: "salary_expectations", pattern: /salary|expected pay|compensation|remuneration|\bctc\b|pay expectation|hourly rate|desired pay/i },
  { category: "gender", pattern: /\bgender\b|\bsex\b(?!ual experience)|pronouns?/i },
  { category: "race", pattern: /\brace\b|racial|ethnic/i },
  { category: "religion", pattern: /\breligio/i },
  { category: "disability", pattern: /disabilit|handicap|impairment|accommodation/i },
  { category: "criminal_history", pattern: /criminal|felony|convict|arrest|conviction/i },
  { category: "relocation", pattern: /relocat/i },
  { category: "legal_eligibility", pattern: /eligib(le|ility) to work|legally eligible|legal eligibility|citizen(ship)? status|are you a citizen|\bveteran\b/i },
];

export function detectSensitiveCategory(text) {
  if (!text) return null;
  for (const { category, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return null;
}
