'use strict';
// Failure limiter for sign-in. Only failed attempts count (no sign-in, or an invite-only refusal). Once a caller
// has failed `max` times in the window, further requests get 429 until it ends. Successful sign-ins never count.
// In-memory: each serverless instance keeps its own counts, so this is a brake on guessing, not a global quota.
// Add a platform limit (for example Vercel Firewall) in front as well.
function createFailureLimiter({ windowMs, max, key, now = () => Date.now(), maxKeys = 10000 }) {
  const buckets = new Map(); // key -> { count, resetAt }

  const prune = (t) => {
    for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
  };

  const bucketFor = (req) => {
    const t = now();
    const k = key(req);
    let bucket = buckets.get(k);
    if (!bucket || bucket.resetAt <= t) {
      if (buckets.size >= maxKeys) prune(t);
      bucket = { count: 0, resetAt: t + windowMs };
      buckets.set(k, bucket);
    }
    return bucket;
  };

  return {
    // Seconds to wait when this caller is blocked, or 0 when it may try.
    retryAfterSeconds(req) {
      const bucket = bucketFor(req);
      if (bucket.count < max) return 0;
      return Math.max(1, Math.ceil((bucket.resetAt - now()) / 1000));
    },
    failed(req) {
      bucketFor(req).count += 1;
    },
  };
}

module.exports = { createFailureLimiter };
