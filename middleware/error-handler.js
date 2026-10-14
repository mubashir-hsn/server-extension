// middleware/error-handler.js

export function notFoundHandler(req, res) {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  // Expected provider/config problems are logged as one line, not a stack trace.
  if (err.publicMessage) console.warn(`[${status}] ${err.publicMessage}`);
  else console.error("Unhandled error:", err);

  if (err.type === "entity.too.large") return res.status(413).json({ error: "Request too large." });
  res.status(status).json({ error: err.publicMessage || "Internal server error" });
}
