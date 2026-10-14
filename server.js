// server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import healthRoutes from "./routes/health.routes.js";
import aiRoutes from "./routes/ai.routes.js";
import { notFoundHandler, errorHandler } from "./middleware/error-handler.js";

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*").split(",").map((o) => o.trim());

app.use(
  helmet({
    // Extension calls a JSON API only — a strict default CSP is safe here.
    contentSecurityPolicy: false,
  })
);

app.use(
  cors({
    origin: allowedOrigins.includes("*") ? true : allowedOrigins,
    methods: ["GET", "POST"],
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

app.use("/api/health", healthRoutes);
app.use("/api/ai", aiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Job Autofill backend listening on http://localhost:${PORT}`);
  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  const keyPresent =
    (provider === "gemini" && process.env.GEMINI_API_KEY) ||
    (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) ||
    (provider === "openai" && process.env.OPENAI_API_KEY);
  if (!keyPresent) {
    console.warn(
      `⚠️  No API key found for AI_PROVIDER="${provider}" — /api/ai/generate-answer will fail until you set the matching key in .env.`
    );
  }
});

export default app;
