'use strict';
// Fixed-window rate limiter. `key(req)` picks the bucket (for example the signed-in member).
// In-memory: each serverless instance keeps its own counts, so this stops bursts from one caller.
// It is not a global quota; add a platform limit (for example Vercel Firewall) in front as well.
function createRateLimiter({ windowMs, max, key, now = () => Date.now(), maxKeys = 10000 }) {
  const buckets = new Map(); // key -> { count, resetAt }

  const prune = (t) => {
    for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
  };

  return (req, res, next) => {
    const t = now();
    const k = key(req);
    let bucket = buckets.get(k);
    if (!bucket || bucket.resetAt <= t) {
      if (buckets.size >= maxKeys) prune(t);
      bucket = { count: 0, resetAt: t + windowMs };
      buckets.set(k, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - t) / 1000))));
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    next();
  };
}

module.exports = { createRateLimiter };
