'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/app');

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`
      });
    });
  });
}

function requestJson(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(u, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { if (data) json = JSON.parse(data); } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: json,
          raw: data
        });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

test('API Endpoints - GET /api/health returns ok', async () => {
  const { server, url } = await startTestServer();
  try {
    const res = await requestJson(`${url}/api/health`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.data.status, 'ok');
    assert.equal(res.data.service, 'exam-result-automation');
  } finally {
    server.close();
  }
});

test('API Endpoints - POST /api/automation/start rejects empty and invalid numbers', async () => {
  const { server, url } = await startTestServer();
  try {
    // Empty
    const resEmpty = await requestJson(`${url}/api/automation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { studentNumber: '' });
    assert.equal(resEmpty.statusCode, 400);
    assert.equal(resEmpty.data.success, false);

    // Too short
    const resShort = await requestJson(`${url}/api/automation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { studentNumber: '123' });
    assert.equal(resShort.statusCode, 400);

    // Non-numeric
    const resAlpha = await requestJson(`${url}/api/automation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { studentNumber: '95990abc32' });
    assert.equal(resAlpha.statusCode, 400);
  } finally {
    server.close();
  }
});

test('API Endpoints - POST /api/automation/start accepts valid 10-digit number and returns session details', async () => {
  const { server, url } = await startTestServer();
  try {
    const res = await requestJson(`${url}/api/automation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { studentNumber: '0012345678' });

    assert.equal(res.statusCode, 202);
    assert.equal(res.data.success, true);
    assert.ok(res.data.sessionId);
    assert.ok(res.data.sessionToken);

    // Check status endpoint with matching token
    const statusRes = await requestJson(`${url}/api/automation/status/${res.data.sessionId}`, {
      headers: { 'x-session-token': res.data.sessionToken }
    });

    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.data.success, true);
    assert.equal(statusRes.data.data.sessionId, res.data.sessionId);

    // Check status endpoint with unauthorized token
    const unauthRes = await requestJson(`${url}/api/automation/status/${res.data.sessionId}`, {
      headers: { 'x-session-token': 'wrong_attacker_token' }
    });
    assert.equal(unauthRes.statusCode, 403);
  } finally {
    server.close();
  }
});

test('API Endpoints - Nonexistent session returns 404', async () => {
  const { server, url } = await startTestServer();
  try {
    const res = await requestJson(`${url}/api/automation/status/non-existent-session-id`, {
      headers: { 'x-session-token': 'token123' }
    });
    assert.equal(res.statusCode, 404);
  } finally {
    server.close();
  }
});
