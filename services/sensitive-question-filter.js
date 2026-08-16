// services/sensitive-question-filter.js

const SENSITIVE_PATTERNS = [
  { category: "work_authorization", pattern: /work authoriz|authorized to work|legally (permitted|able) to work/i },
  { category: "visa_sponsorship", pattern: /visa sponsor|require sponsorship|sponsorship (now|in the future)/i },
  { category: "salary_expectations", pattern: /salary expect|expected salary|desired salary|compensation expect|expected compensation|expected pay|salary range|current salary|current ctc|expected ctc|ctc expect/i },
  { category: "gender", pattern: /\bgender\b|\bsex\b(?!ual experience)/i },
  { category: "race", pattern: /\brace\b|ethnicity/i },
  { category: "religion", pattern: /\breligion\b|religious belief/i },
  { category: "disability", pattern: /disabilit|accommodat/i },
  { category: "criminal_history", pattern: /criminal (record|history|conviction)|felony|convicted/i },
  { category: "relocation", pattern: /willing to relocate|relocation/i },
  { category: "legal_eligibility", pattern: /eligib(le|ility) to work|legally eligible/i },
];

export function detectSensitiveCategory(text) {
  if (!text) return null;
  for (const { category, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return null;
}
