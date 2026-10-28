'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RateLimiter } = require('../src/middleware/rateLimiter');

test('RateLimiter - Blocks requests exceeding limit and sets Retry-After header', () => {
  const limiter = new RateLimiter(60000, 3); // 3 requests per minute
  const middleware = limiter.middleware();

  let status = null;
  let responseData = null;
  const headers = {};

  const createReqRes = () => ({
    req: {
      ip: '192.168.1.100',
      headers: { 'x-test-ratelimit': 'true' }
    },
    res: {
      setHeader: (k, v) => { headers[k] = v; },
      status: (s) => {
        status = s;
        return {
          json: (data) => { responseData = data; }
        };
      }
    }
  });

  // Call 1: Success
  let nextCalled = false;
  const c1 = createReqRes();
  middleware(c1.req, c1.res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(headers['RateLimit-Remaining'], 2);

  // Call 2: Success
  nextCalled = false;
  const c2 = createReqRes();
  middleware(c2.req, c2.res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(headers['RateLimit-Remaining'], 1);

  // Call 3: Success (Limit reached)
  nextCalled = false;
  const c3 = createReqRes();
  middleware(c3.req, c3.res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(headers['RateLimit-Remaining'], 0);

  // Call 4: Blocked (HTTP 429)
  nextCalled = false;
  const c4 = createReqRes();
  middleware(c4.req, c4.res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(status, 429);
  assert.equal(responseData.success, false);
  assert.equal(responseData.error.code, 'RATE_LIMIT_EXCEEDED');
  assert.ok(headers['Retry-After']);
});
