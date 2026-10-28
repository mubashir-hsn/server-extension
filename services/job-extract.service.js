import { HttpError, generateJson } from "./ai.service.js";

const KEYS = ["jobTitle", "company", "location", "state", "workMode", "remoteRestriction", "jobType", "postedDate", "salary", "contactEmails"];
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export async function extractJobFields({ url, text }) {
  const visibleText = String(text || "").slice(0, 12000);
  const system = "Extract only facts literally present in a job page. Return strict JSON with jobTitle, company, location, state, workMode, remoteRestriction, jobType, postedDate, salary, contactEmails. workMode must be remote, hybrid, onsite, or unknown. Never invent an email or other field.";
  const user = `URL: ${url}\n\nVISIBLE JOB PAGE TEXT:\n${visibleText}`;
  const parsed = await generateJson(system, user);
  if (!parsed || typeof parsed !== "object") throw new HttpError(502, "The AI did not return valid job data.");
  const visibleEmails = new Set((visibleText.match(EMAIL_RE) || []).map((email) => email.toLowerCase()));
  const fields = {};
  KEYS.forEach((key) => {
    if (key === "contactEmails") {
      const proposed = Array.isArray(parsed[key]) ? parsed[key] : [];
      fields[key] = proposed.map((email) => String(email).toLowerCase()).filter((email) => visibleEmails.has(email)).slice(0, 3);
    } else if (typeof parsed[key] === "string") fields[key] = parsed[key].trim().slice(0, 500);
  });
  if (fields.workMode && !["remote", "hybrid", "onsite", "unknown"].includes(fields.workMode)) fields.workMode = "unknown";
  return { fields };
}
