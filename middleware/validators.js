// middleware/validators.js
import { body, validationResult } from "express-validator";

export const generateAnswerRules = [
  body("question").isString().trim().isLength({ min: 3, max: 2000 }).withMessage("question must be 3–2000 characters"),
  body("profile").isObject().withMessage("profile must be an object"),
  body("jobTitle").optional().isString().isLength({ max: 300 }),
  body("company").optional().isString().isLength({ max: 300 }),
  body("jobDescription").optional().isString().isLength({ max: 20000 }),
  body("resume").optional().isString().isLength({ max: 20000 }),
];

export function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const first = errors.array()[0];
    return res.status(400).json({ error: `Invalid input: ${first.msg || `${first.path} is invalid`}`, details: errors.array() });
  }
  next();
}
