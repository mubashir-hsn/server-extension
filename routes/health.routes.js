// routes/health.routes.js
import { Router } from "express";
import { getProviderInfo } from "../services/ai.service.js";

const router = Router();

router.get("/", (req, res) => {
  res.json({
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    ...getProviderInfo(), // provider, model, keyConfigured — never the key itself
  });
});

export default router;
