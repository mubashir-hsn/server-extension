// routes/ai.routes.js
import { Router } from "express";
import { aiRateLimiter } from "../middleware/rate-limiter.js";
import { generateAnswerRules, handleValidationErrors } from "../middleware/validators.js";
import { generateApplicationAnswer } from "../services/ai.service.js";
import { detectSensitiveCategory } from "../services/sensitive-question-filter.js";

const router = Router();

router.post("/generate-answer", aiRateLimiter, generateAnswerRules, handleValidationErrors, async (req, res, next) => {
  try {
    const { profile, resume, jobTitle, company, jobDescription, question } = req.body;

    // Server-side defense in depth: never let a sensitive question reach the
    // model, even if the extension's client-side filter is bypassed or stale.
    const sensitiveCategory = detectSensitiveCategory(question);
    if (sensitiveCategory) {
      return res.status(422).json({
        error: `This question ("${sensitiveCategory.replace(/_/g, " ")}") requires manual review and cannot be auto-answered by AI.`,
        category: sensitiveCategory,
      });
    }

    const result = await generateApplicationAnswer({
      profile,
      resume,
      jobTitle,
      company,
      jobDescription,
      question,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
