import { Router } from "express";
import { body } from "express-validator";
import { aiRateLimiter } from "../middleware/rate-limiter.js";
import { handleValidationErrors } from "../middleware/validators.js";
import { extractJobFields } from "../services/job-extract.service.js";

const router = Router();
router.post("/extract-job", aiRateLimiter, [body("url").isString().isLength({ min: 1, max: 2000 }), body("text").isString().isLength({ min: 50, max: 12000 })], handleValidationErrors, async (req, res, next) => {
  try { res.json(await extractJobFields(req.body)); } catch (error) { next(error); }
});
export default router;
