'use strict';

const config = require('../config');

class RateLimiter {
  constructor(windowMs = config.rateLimitWindowMs, maxRequests = config.rateLimitMaxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.hits = new Map();

    const cleanup = setInterval(() => {
      const now = Date.now();
      for (const [ip, record] of this.hits.entries()) {
        if (now - record.startTime > this.windowMs) {
          this.hits.delete(ip);
        }
      }
    }, 60000);

    if (cleanup.unref) cleanup.unref();
  }

  middleware() {
    return (req, res, next) => {
      // In test mode, allow tests to bypass rate limiter unless explicitly testing it
      if (process.env.NODE_ENV === 'test' && !req.headers['x-test-ratelimit']) {
        return next();
      }

      // Read-only status polling, health check, and rendered views should not consume rate limit
      const p = req.path || req.url || '';
      if (!req.headers['x-test-ratelimit'] && (
        p.includes('/status') ||
        p.includes('/health') ||
        p.includes('/view') ||
        p.includes('/file')
      )) {
        return next();
      }

      const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
      const now = Date.now();
      let record = this.hits.get(clientIp);

      if (!record || (now - record.startTime > this.windowMs)) {
        record = { count: 1, startTime: now };
        this.hits.set(clientIp, record);
      } else {
        record.count++;
      }

      const remaining = Math.max(0, this.maxRequests - record.count);
      const resetTimeSeconds = Math.ceil((record.startTime + this.windowMs - now) / 1000);

      res.setHeader('RateLimit-Limit', this.maxRequests);
      res.setHeader('RateLimit-Remaining', remaining);
      res.setHeader('RateLimit-Reset', resetTimeSeconds);

      if (record.count > this.maxRequests) {
        res.setHeader('Retry-After', resetTimeSeconds);
        return res.status(429).json({
          success: false,
          error: {
            message: 'Too many requests. Please wait a moment before trying again.',
            code: 'RATE_LIMIT_EXCEEDED'
          }
        });
      }

      next();
    };
  }

  reset() {
    this.hits.clear();
  }
}

const defaultRateLimiter = new RateLimiter();

module.exports = {
  RateLimiter,
  defaultRateLimiter,
  rateLimitMiddleware: defaultRateLimiter.middleware()
};
