'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/app');
const { DbService, defaultDbService } = require('../src/services/dbService');
const { SessionManager, defaultSessionManager } = require('../src/services/sessionManager');
const { AutomationService } = require('../src/services/automationService');

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

test('Neon DB Integration - GET /api/health includes database health status', async () => {
  const { server, url } = await startTestServer();
  try {
    const res = await requestJson(`${url}/api/health`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.data.status, 'ok');
    assert.ok(res.data.database);
    assert.ok('connected' in res.data.database);
    assert.ok('driver' in res.data.database);
  } finally {
    server.close();
  }
});

test('Neon DB Integration - SessionManager saves and restores session from DB store', async () => {
  const testDb = new DbService();
  const sessionManager = new SessionManager({ dbService: testDb });

  const session = sessionManager.createSession('1234567890');
  sessionManager.updateProgress(session.sessionId, 3, 'Processing step 3', 50, { customData: 'test' });

  // Evict from in-memory Map to simulate server restart / multi-instance deployment
  sessionManager.sessions.delete(session.sessionId);
  assert.equal(sessionManager.sessions.has(session.sessionId), false);

  // Restore from db
  const restored = await sessionManager.restoreSessionFromDb(session.sessionId, session.sessionToken);
  assert.ok(restored);
  assert.equal(restored.sessionId, session.sessionId);
  assert.equal(restored.studentIdentifier, '1234567890');
  assert.equal(restored.stage, 3);
  assert.equal(restored.stageMessage, 'Processing step 3');

  // Verify it is re-populated into sessionManager.sessions
  assert.ok(sessionManager.sessions.has(session.sessionId));

  // Verify closeSession cleans up from DB store as well
  await sessionManager.closeSession(session.sessionId);
  const afterClose = await testDb.getSession(session.sessionId, session.sessionToken);
  assert.equal(afterClose, null);
});

test('Neon DB Integration - automation routes restore session from DB when evicted from memory', async () => {
  const { server, url } = await startTestServer();
  try {
    // Create session in defaultSessionManager
    const session = defaultSessionManager.createSession('9876543210');
    defaultSessionManager.updateProgress(session.sessionId, 7, 'Examination result loaded successfully.', 100, {
      status: 'ready',
      resultData: {
        student: { name: 'DB Test Student', studentNumber: '9876543210' },
        annualSummary: { status: 'PASS', ygpa: '8.5' },
        semesters: []
      }
    });

    // Simulate eviction from memory Map
    defaultSessionManager.sessions.delete(session.sessionId);
    assert.equal(defaultSessionManager.sessions.has(session.sessionId), false);

    // Call /status/:sessionId
    const statusRes = await requestJson(`${url}/api/automation/status/${session.sessionId}`, {
      headers: { 'x-session-token': session.sessionToken }
    });
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.data.success, true);
    assert.equal(statusRes.data.data.sessionId, session.sessionId);
    assert.equal(statusRes.data.data.studentNumber, '9876543210');

    // Evict again and test /view/:sessionId
    defaultSessionManager.sessions.delete(session.sessionId);
    assert.equal(defaultSessionManager.sessions.has(session.sessionId), false);

    const viewRes = await requestJson(`${url}/api/automation/view/${session.sessionId}?token=${session.sessionToken}`);
    assert.equal(viewRes.statusCode, 200);
    assert.match(viewRes.raw, /DB Test Student/);
  } finally {
    server.close();
  }
});

test('Neon DB Integration - AutomationService cache hit serves cached result directly and logs audit', async () => {
  const testDb = new DbService();
  const sessionManager = new SessionManager({ dbService: testDb });
  const automationService = new AutomationService({
    sessionManager,
    dbService: testDb,
    mockMode: false
  });

  const studentNumber = '8887416471';
  const cachedData = {
    student: { name: 'CACHED ANSH', studentNumber, ygpa: '9.00', status: 'PASS' },
    annualSummary: { status: 'PASS', ygpa: '9.00' },
    semesters: []
  };

  // Pre-seed cache in testDb
  await testDb.setCachedResult(studentNumber, cachedData);

  const session = sessionManager.createSession(studentNumber);

  // Execute workflow - should hit cache and NOT attempt network credentials lookup
  await automationService.runWorkflow(session.sessionId, session.sessionToken, studentNumber);

  const updatedSession = sessionManager.getSession(session.sessionId, session.sessionToken);
  assert.equal(updatedSession.status, 'ready');
  assert.equal(updatedSession.resultData.student.name, 'CACHED ANSH');
  assert.equal(updatedSession.stageMessage, 'Examination result loaded from cache.');

  // Verify search audit log
  const logs = testDb.memoryLogs;
  const audit = logs.find(l => l.studentNumber === studentNumber);
  assert.ok(audit);
  assert.equal(audit.cacheHit, true);
  assert.equal(audit.status, 'SUCCESS');
});

test('Neon DB Integration - AutomationService error logs search audit with status ERROR', async () => {
  const testDb = new DbService();
  const sessionManager = new SessionManager({ dbService: testDb });
  const automationService = new AutomationService({
    sessionManager,
    dbService: testDb,
    mockMode: false
  });

  const studentNumber = '1122334455';
  automationService.credentialService = {
    fetchCredentials: async () => {
      const err = new Error('Connection refused');
      err.code = 'CONNECTION_REFUSED';
      throw err;
    }
  };

  const session = sessionManager.createSession(studentNumber);

  await assert.rejects(
    async () => {
      await automationService.runWorkflow(session.sessionId, session.sessionToken, studentNumber);
    },
    { message: /Connection refused/ }
  );

  const logs = testDb.memoryLogs;
  const audit = logs.find(l => l.studentNumber === studentNumber);
  assert.ok(audit);
  assert.equal(audit.cacheHit, false);
  assert.equal(audit.status, 'ERROR');
  assert.equal(audit.errorCode, 'CONNECTION_REFUSED');
});
