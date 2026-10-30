'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { AutomationService } = require('../src/services/automationService');
const { CredentialService } = require('../src/services/credentialService');
const { SessionManager } = require('../src/services/sessionManager');
const { AdminDbService } = require('../src/services/adminDbService');
const app = require('../src/app');

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
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

test('Error 1: Student not found replaces with exact two-line message', async () => {
  const sessionManager = new SessionManager({ ttlMs: 60000 });
  const adminDbService = new AdminDbService();
  const automationService = new AutomationService({
    sessionManager,
    adminDbService,
    mockMode: false
  });

  const testNumbers = ['9450075283', '9112233445', '9876543219'];
  const expectedMsg = 'Given number is not a student number.\nTo get number search it below.';

  for (const number of testNumbers) {
    const session = sessionManager.createSession(number);

    await assert.rejects(
      async () => {
        await automationService.runWorkflow(session.sessionId, session.sessionToken, number);
      },
      (err) => {
        assert.equal(err.message, expectedMsg, `Error message for ${number} must match exact replacement`);
        assert.ok(!err.message.includes(number), `Error message must not include phone number ${number}`);
        assert.ok(!err.message.includes('identifier'), 'Error message must not include the word identifier');
        assert.ok(!err.message.includes('Student not found for identifier'), 'Must not display original error text');
        assert.equal(err.code, 'NOT_FOUND');
        assert.equal(err.statusCode, 404);
        return true;
      }
    );

    const s = sessionManager.getSession(session.sessionId, session.sessionToken);
    assert.equal(s.status, 'error');
    assert.equal(s.error.message, expectedMsg);
    assert.ok(!s.error.message.includes(number));
  }
});

test('Error 2: No authorized student record found replaces with exact password changed message', async () => {
  const testNumbers = ['9599099932', '9876501234', '9123456789'];
  const expectedMsg = 'The user has changed the password. An update will come to get the result.';

  const mockServer = await startMockServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: {
        code: 'STUDENT_NOT_FOUND',
        message: 'No student found'
      }
    }));
  });

  try {
    const credentialService = new CredentialService({
      apiUrl: mockServer.url,
      apiKey: 'test-key'
    });

    for (const number of testNumbers) {
      await assert.rejects(
        () => credentialService.fetchCredentials(number),
        (err) => {
          assert.equal(err.message, expectedMsg, `CredentialService error for ${number} must match exact replacement`);
          assert.ok(!err.message.includes(number), `CredentialService error must not include ${number}`);
          assert.ok(!err.message.includes('identifier'), 'Must not include identifier');
          assert.ok(!err.message.includes('No authorized student record found'), 'Must not display original error text');
          assert.equal(err.code, 'STUDENT_NOT_FOUND');
          assert.equal(err.statusCode, 404);
          return true;
        }
      );
    }
  } finally {
    mockServer.server.close();
  }
});

test('Error 2 in Public Workflow: Case 2 empty DB credentials calls API and catches STUDENT_NOT_FOUND', async () => {
  const sessionManager = new SessionManager({ ttlMs: 60000 });
  const adminDbService = new AdminDbService();
  const testNumber = '9599099932';
  const expectedMsg = 'The user has changed the password. An update will come to get the result.';

  // Insert student in DB with empty credentials
  await adminDbService.upsertStudent({
    name: 'Test Student',
    admission_number: testNumber,
    phone_number: testNumber,
    section: 'CSE-A',
    username: '',
    password: ''
  });

  const mockCredService = {
    fetchCredentials: async () => {
      const err = new Error(expectedMsg);
      err.code = 'STUDENT_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }
  };

  const automationService = new AutomationService({
    sessionManager,
    adminDbService,
    credentialService: mockCredService,
    mockMode: true
  });

  const session = sessionManager.createSession(testNumber);

  await assert.rejects(
    async () => {
      await automationService.runWorkflow(session.sessionId, session.sessionToken, testNumber);
    },
    (err) => {
      assert.equal(err.message, expectedMsg);
      assert.ok(!err.message.includes(testNumber));
      assert.ok(!err.message.includes('No authorized student record found'));
      return true;
    }
  );

  const s = sessionManager.getSession(session.sessionId, session.sessionToken);
  assert.equal(s.status, 'error');
  assert.equal(s.error.message, expectedMsg);
  assert.ok(!s.error.message.includes(testNumber));
});

test('Error 2 in Public Workflow: Case 1 portal auth failure with fallback API returning STUDENT_NOT_FOUND', async () => {
  const sessionManager = new SessionManager({ ttlMs: 60000 });
  const adminDbService = new AdminDbService();
  const testNumber = '9876501234';
  const expectedMsg = 'The user has changed the password. An update will come to get the result.';

  // Insert student with old credentials
  await adminDbService.upsertStudent({
    name: 'Old Password Student',
    admission_number: testNumber,
    phone_number: testNumber,
    section: 'IT-A',
    username: 'old_portal_user',
    password: 'old_password_123'
  });

  const mockCredService = {
    fetchCredentials: async () => {
      const err = new Error(expectedMsg);
      err.code = 'STUDENT_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }
  };

  const automationService = new AutomationService({
    sessionManager,
    adminDbService,
    credentialService: mockCredService,
    mockMode: true
  });

  // Mock portal auth to reject saved credentials
  automationService.attemptPortalAuthentication = async () => {
    const err = new Error('Invalid username or password supplied.');
    err.code = 'AUTH_ERROR';
    err.statusCode = 401;
    throw err;
  };

  const session = sessionManager.createSession(testNumber);

  await assert.rejects(
    async () => {
      await automationService.runWorkflow(session.sessionId, session.sessionToken, testNumber);
    },
    (err) => {
      assert.equal(err.message, expectedMsg);
      assert.ok(!err.message.includes(testNumber));
      return true;
    }
  );

  const s = sessionManager.getSession(session.sessionId, session.sessionToken);
  assert.equal(s.status, 'error');
  assert.equal(s.error.message, expectedMsg);
  assert.ok(!s.error.message.includes(testNumber));

  // Confirm database credentials were wiped for security as required by Case 1 rules
  const updated = await adminDbService.getStudentByPhoneNumber(testNumber);
  assert.ok(!updated.username, 'Username must be cleared');
  assert.ok(!updated.password, 'Password must be cleared');
});

test('End-to-End HTTP API: Non-existent student number returns exact error replacement in response/status', async () => {
  const { server, url } = await startMockServer(app);
  try {
    const testNumber = '9450075283';
    const expectedMsg = 'Given number is not a student number.\nTo get number search it below.';

    const startRes = await requestJson(`${url}/api/automation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { studentNumber: testNumber });

    assert.ok(startRes.data.sessionId);
    assert.ok(startRes.data.sessionToken);

    // Wait a brief tick for workflow to complete
    await new Promise(r => setTimeout(r, 200));

    const statusRes = await requestJson(`${url}/api/automation/status/${startRes.data.sessionId}`, {
      headers: { 'x-session-token': startRes.data.sessionToken }
    });

    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.data.data.status, 'error');
    assert.equal(statusRes.data.data.error.message, expectedMsg);
    assert.ok(!statusRes.data.data.error.message.includes(testNumber));
  } finally {
    server.close();
  }
});
