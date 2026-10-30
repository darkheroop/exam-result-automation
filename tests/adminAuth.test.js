'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AdminAuthService } = require('../src/services/adminAuthService');
const { AdminDbService } = require('../src/services/adminDbService');

test('AdminAuth - verifyCredentials with pre-configured PBKDF2 hash', () => {
  const dbService = new AdminDbService();
  const authService = new AdminAuthService(dbService);

  // Correct credentials
  assert.equal(authService.verifyCredentials('inexpert_trifler', 'om sai 0987654321'), true);

  // Invalid password
  assert.equal(authService.verifyCredentials('inexpert_trifler', 'wrong_password'), false);

  // Invalid username
  assert.equal(authService.verifyCredentials('admin_user', 'om sai 0987654321'), false);

  // Empty / null / non-string
  assert.equal(authService.verifyCredentials('', ''), false);
  assert.equal(authService.verifyCredentials(null, null), false);
  assert.equal(authService.verifyCredentials(undefined, '123'), false);
  assert.equal(authService.verifyCredentials(123, 456), false);
});

test('AdminAuth - ADMIN_PASSWORD environment variable override', () => {
  const originalEnv = process.env.ADMIN_PASSWORD;
  try {
    process.env.ADMIN_PASSWORD = 'override_secret_999';
    const dbService = new AdminDbService();
    const authService = new AdminAuthService(dbService);

    assert.equal(authService.verifyCredentials('inexpert_trifler', 'override_secret_999'), true);
    assert.equal(authService.verifyCredentials('inexpert_trifler', 'om sai 0987654321'), true); // PBKDF2 fallback also works
    assert.equal(authService.verifyCredentials('inexpert_trifler', 'wrong'), false);
  } finally {
    if (originalEnv !== undefined) {
      process.env.ADMIN_PASSWORD = originalEnv;
    } else {
      delete process.env.ADMIN_PASSWORD;
    }
  }
});

test('AdminAuth - createSession, verifySession, and destroySession lifecycle', async () => {
  const dbService = new AdminDbService();
  const authService = new AdminAuthService(dbService);

  const token = await authService.createSession('inexpert_trifler');
  assert.equal(typeof token, 'string');
  assert.equal(token.length, 64); // 32 random bytes as hex

  const verified = await authService.verifySession(token);
  assert.ok(verified);
  assert.equal(verified.username, 'inexpert_trifler');

  const destroyed = await authService.destroySession(token);
  assert.equal(destroyed, true);

  const verifiedAfter = await authService.verifySession(token);
  assert.equal(verifiedAfter, null);
});

test('AdminAuth - requireAdminAuth middleware authentication sources and protection', async () => {
  const dbService = new AdminDbService();
  const authService = new AdminAuthService(dbService);
  const middleware = authService.getMiddleware();

  const validToken = await authService.createSession('admin_test_user');

  // 1. Authorized via cookie
  let nextCalled1 = false;
  const req1 = {
    cookies: { admin_token: validToken },
    headers: {},
    originalUrl: '/api/admin/stats'
  };
  await middleware(req1, {}, () => { nextCalled1 = true; });
  assert.equal(nextCalled1, true);
  assert.equal(req1.adminUser.username, 'admin_test_user');

  // 2. Authorized via Bearer header
  let nextCalled2 = false;
  const req2 = {
    cookies: {},
    headers: { authorization: `Bearer ${validToken}` },
    originalUrl: '/api/admin/students'
  };
  await middleware(req2, {}, () => { nextCalled2 = true; });
  assert.equal(nextCalled2, true);
  assert.equal(req2.adminUser.username, 'admin_test_user');

  // 3. Authorized via x-admin-token header
  let nextCalled3 = false;
  const req3 = {
    cookies: {},
    headers: { 'x-admin-token': validToken },
    originalUrl: '/api/admin/me'
  };
  await middleware(req3, {}, () => { nextCalled3 = true; });
  assert.equal(nextCalled3, true);
  assert.equal(req3.adminUser.username, 'admin_test_user');

  // 4. Unauthorized API call returns 401 JSON
  let apiStatus = null;
  let apiJson = null;
  const resApi = {
    status(s) { apiStatus = s; return this; },
    json(j) { apiJson = j; return this; }
  };
  const reqApi = {
    cookies: {},
    headers: {},
    originalUrl: '/api/admin/students'
  };
  await middleware(reqApi, resApi, () => {});
  assert.equal(apiStatus, 401);
  assert.equal(apiJson.success, false);
  assert.equal(apiJson.error.code, 'UNAUTHORIZED');

  // 5. Unauthorized Page call redirects to /admin/login
  let redirectUrl = null;
  const resPage = {
    redirect(url) { redirectUrl = url; }
  };
  const reqPage = {
    cookies: {},
    headers: {},
    originalUrl: '/admin/dashboard'
  };
  await middleware(reqPage, resPage, () => {});
  assert.equal(redirectUrl, '/admin/login');
});
