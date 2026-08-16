// middleware/error-handler.js

export function notFoundHandler(req, res, next) {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  console.error("Unhandled error:", err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.publicMessage || "Internal server error",
  });
}
