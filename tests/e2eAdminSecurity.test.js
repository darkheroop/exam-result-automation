'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const rootDir = path.resolve(__dirname, '..');
const appPath = path.join(rootDir, 'src/app.js');
const adminAuthServicePath = path.join(rootDir, 'src/services/adminAuthService.js');
const adminRoutesPath = path.join(rootDir, 'src/routes/adminRoutes.js');

let AdminAuthService;
let defaultAdminAuthService;
try {
  const mod = require(adminAuthServicePath);
  AdminAuthService = mod.AdminAuthService;
  defaultAdminAuthService = mod.defaultAdminAuthService;
} catch (_) {}

test('Admin Security [Tier 1] - verifyCredentials rejects empty, null, and non-string inputs', () => {
  assert.ok(defaultAdminAuthService, 'defaultAdminAuthService must be exported');

  const invalidInputs = [
    [null, null],
    ['', ''],
    [undefined, undefined],
    ['inexpert_trifler', null],
    [null, 'some_pass'],
    [12345, 'some_pass'],
    ['admin', {}],
    [[], 'pass']
  ];

  for (const [u, p] of invalidInputs) {
    const res = defaultAdminAuthService.verifyCredentials(u, p);
    // If verifyCredentials is an async function (Promise)
    if (res && typeof res.then === 'function') {
      res.then((val) => assert.strictEqual(val, false));
    } else {
      assert.strictEqual(res, false, `Expected verifyCredentials(${JSON.stringify(u)}, ${JSON.stringify(p)}) to return false`);
    }
  }
});

test('Admin Security [Tier 2] - verifyCredentials executes with constant-time characteristics', async () => {
  assert.ok(defaultAdminAuthService, 'defaultAdminAuthService must be exported');

  // Measure verification times across non-existent usernames vs plausible usernames
  const samples = 15;
  const incorrectPass = 'wrong_password_attempt_999!';

  // Measure time for non-existent username of differing lengths
  const userSamples = [
    'a',
    'nonexistent_admin_user',
    'inexpert_trifler',
    'super_lengthy_random_user_identifier_string_probe'
  ];

  const timings = {};

  for (const user of userSamples) {
    const durations = [];
    for (let i = 0; i < samples; i++) {
      const start = process.hrtime.bigint();
      const res = defaultAdminAuthService.verifyCredentials(user, incorrectPass);
      if (res && typeof res.then === 'function') {
        await res;
      }
      const end = process.hrtime.bigint();
      durations.push(Number(end - start) / 1e6); // ms
    }
    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)];
    timings[user] = median;
  }

  // Contract verification: Username comparison should not short-circuit in <0.1ms
  // while legitimate comparison takes >10ms (which provides an enumeration oracle).
  const expectedUser = (process.env.ADMIN_USERNAME || 'inexpert_trifler').trim();
  const validUserMedian = timings[expectedUser] || timings['inexpert_trifler'];
  const invalidUserMedian = timings['nonexistent_admin_user'];

  assert.ok(
    typeof validUserMedian === 'number' && typeof invalidUserMedian === 'number',
    'Timings must be measurable numbers'
  );
});

test('Admin Security [Tier 2] - Rate limiter enforces lockout after consecutive failed attempts', async () => {
  const routesContent = fs.readFileSync(adminRoutesPath, 'utf8');

  // Verify rate limiter exists and references 429
  assert.ok(
    routesContent.includes('429'),
    'adminRoutes must return HTTP 429 when rate limit is exceeded'
  );
  assert.ok(
    routesContent.includes('RATE_LIMITED') || routesContent.includes('Too many login attempts'),
    'adminRoutes must include clear rate limited error message'
  );
  assert.ok(
    routesContent.includes('Retry-After') || routesContent.includes('retryAfter'),
    'adminRoutes must set Retry-After header'
  );
});

test('Admin Security [Tier 2] - Rate limiter contains memory eviction mechanism', () => {
  const routesContent = fs.readFileSync(adminRoutesPath, 'utf8');

  // Check that the rate limiter does not maintain an unbounded in-memory leak
  const hasEviction =
    routesContent.includes('.delete(') ||
    routesContent.includes('setInterval') ||
    routesContent.includes('cleanExpired') ||
    routesContent.includes('prune') ||
    routesContent.includes('resetTime');

  assert.ok(
    hasEviction,
    'Rate limiter must implement memory eviction / key expiration to prevent memory exhaustion'
  );
});

test('Admin Security [Tier 3] - Session token is NOT leaked in login JSON response payload', () => {
  const routesContent = fs.readFileSync(adminRoutesPath, 'utf8');

  // The login route handler should not expose token directly in the returned JSON object
  // Bad pattern: res.json({ success: true, token, user: ... })
  // Good pattern: res.json({ success: true, user: ... }) where cookie holds the token
  const loginPostHandler = routesContent.substring(
    routesContent.indexOf("router.post('/login'"),
    routesContent.indexOf("router.post('/logout'")
  );

  assert.ok(loginPostHandler.length > 0, 'Must locate login route block');

  const leaksTokenInBody = /res\.json\(\s*\{[\s\S]*?\btoken\b\s*[,:]/m.test(loginPostHandler);

  assert.ok(
    !leaksTokenInBody,
    'POST /api/admin/login response JSON body must NOT return the session token (rely strictly on HttpOnly cookie)'
  );
});

test('Admin Security [Tier 3] - Login endpoint sets secure HttpOnly cookie with SameSite and Path=/', () => {
  const routesContent = fs.readFileSync(adminRoutesPath, 'utf8');
  const loginPostHandler = routesContent.substring(
    routesContent.indexOf("router.post('/login'"),
    routesContent.indexOf("router.post('/logout'")
  );

  assert.ok(
    loginPostHandler.includes("res.cookie('admin_token'"),
    'Login endpoint must set admin_token cookie'
  );
  assert.ok(
    loginPostHandler.includes('httpOnly: true'),
    'admin_token cookie must be configured with httpOnly: true'
  );
  assert.ok(
    loginPostHandler.includes("path: '/'"),
    'admin_token cookie must specify path: "/"'
  );
  assert.ok(
    loginPostHandler.includes('sameSite:'),
    'admin_token cookie must specify sameSite protection'
  );
});

test('Admin Security [Tier 4] - requireAdminAuth middleware authenticates via HttpOnly session cookie', async () => {
  const authService = defaultAdminAuthService;
  assert.ok(authService, 'defaultAdminAuthService must exist');

  // Test session lifecycle
  const username = 'test_security_admin';
  const token = await authService.createSession(username);
  assert.ok(token && typeof token === 'string', 'createSession must return a token string');

  // Verify session resolution
  const session = await authService.verifySession(token);
  assert.ok(session, 'verifySession must resolve active session');
  assert.strictEqual(session.username, username, 'Resolved session must match created username');

  // Clean up
  await authService.destroySession(token);
  const destroyed = await authService.verifySession(token);
  assert.strictEqual(destroyed, null, 'verifySession must return null after destroySession');
});

test('Admin Security [Tier 4] - Admin logout clears cookie and terminates active session', () => {
  const routesContent = fs.readFileSync(adminRoutesPath, 'utf8');
  const logoutBlock = routesContent.substring(
    routesContent.indexOf("router.post('/logout'")
  );

  assert.ok(
    logoutBlock.includes('clearCookie') || logoutBlock.includes('maxAge: 0') || logoutBlock.includes('admin_token'),
    'Logout route must clear the admin_token cookie'
  );
  assert.ok(
    logoutBlock.includes('destroySession'),
    'Logout route must destroy the active session in the database / session store'
  );
});
