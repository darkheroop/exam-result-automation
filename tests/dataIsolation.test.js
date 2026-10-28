'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { SessionManager } = require('../src/services/sessionManager');
const { CredentialService } = require('../src/services/credentialService');
const { AutomationService } = require('../src/services/automationService');
const { normalizeResultData } = require('../src/services/resultNormalizer');

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let parsed = null;
        try { if (body) parsed = JSON.parse(body); } catch {}
        handler(req, res, parsed);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`
      });
    });
  });
}

test('Data Isolation 1: Search A then Search B sequentially never mixes data', async () => {
  const sessionManager = new SessionManager();
  const automationService = new AutomationService({
    sessionManager,
    credentialService: new CredentialService({ mockMode: true }),
    mockMode: true,
    mockDelayMs: 10
  });

  const sessionA = sessionManager.createSession('1000000001');
  await automationService.runWorkflow(sessionA.sessionId, sessionA.sessionToken, '1000000001');
  const resA = sessionManager.getSession(sessionA.sessionId, sessionA.sessionToken);

  assert.strictEqual(resA.studentIdentifier, '1000000001');
  assert.strictEqual(resA.resultData.student.studentNumber, '1000000001');

  const sessionB = sessionManager.createSession('1000000002');
  await automationService.runWorkflow(sessionB.sessionId, sessionB.sessionToken, '1000000002');
  const resB = sessionManager.getSession(sessionB.sessionId, sessionB.sessionToken);

  assert.strictEqual(resB.studentIdentifier, '1000000002');
  assert.strictEqual(resB.resultData.student.studentNumber, '1000000002');
  assert.notStrictEqual(resB.resultData.student.studentNumber, resA.resultData.student.studentNumber);
});

test('Data Isolation 2: Search B then Search A sequentially never mixes data', async () => {
  const sessionManager = new SessionManager();
  const automationService = new AutomationService({
    sessionManager,
    credentialService: new CredentialService({ mockMode: true }),
    mockMode: true,
    mockDelayMs: 10
  });

  const sessionB = sessionManager.createSession('8887416471');
  await automationService.runWorkflow(sessionB.sessionId, sessionB.sessionToken, '8887416471');
  const resB = sessionManager.getSession(sessionB.sessionId, sessionB.sessionToken);

  assert.strictEqual(resB.studentIdentifier, '8887416471');
  assert.strictEqual(resB.resultData.student.studentNumber, '8887416471');

  const sessionA = sessionManager.createSession('9919741137');
  await automationService.runWorkflow(sessionA.sessionId, sessionA.sessionToken, '9919741137');
  const resA = sessionManager.getSession(sessionA.sessionId, sessionA.sessionToken);

  assert.strictEqual(resA.studentIdentifier, '9919741137');
  assert.strictEqual(resA.resultData.student.studentNumber, '9919741137');
  assert.notStrictEqual(resA.resultData.student.studentNumber, resB.resultData.student.studentNumber);
});

test('Data Isolation 3: Concurrent searches for A, B, C with varying delays maintain strict isolation', async () => {
  const sessionManager = new SessionManager();
  const automationService = new AutomationService({
    sessionManager,
    credentialService: new CredentialService({ mockMode: true }),
    mockMode: true,
    mockDelayMs: 15
  });

  const students = ['1000000001', '1000000002', '1000000003'];
  const sessions = students.map(s => sessionManager.createSession(s));

  await Promise.all(
    sessions.map((s, idx) => automationService.runWorkflow(s.sessionId, s.sessionToken, students[idx]))
  );

  for (let i = 0; i < students.length; i++) {
    const s = sessionManager.getSession(sessions[i].sessionId, sessions[i].sessionToken);
    assert.strictEqual(s.studentIdentifier, students[i]);
    assert.strictEqual(s.resultData.student.studentNumber, students[i]);
  }
});

test('Data Isolation 4: Fast B completing before slow A isolates correctly without cross-contamination', async () => {
  const sessionManager = new SessionManager();
  const automationService = new AutomationService({
    sessionManager,
    credentialService: new CredentialService({ mockMode: true }),
    mockMode: true,
    mockDelayMs: 5
  });

  const sessionA = sessionManager.createSession('1000000001');
  const sessionB = sessionManager.createSession('1000000002');

  // Launch A and B simultaneously
  const promiseA = automationService.runWorkflow(sessionA.sessionId, sessionA.sessionToken, '1000000001');
  const promiseB = automationService.runWorkflow(sessionB.sessionId, sessionB.sessionToken, '1000000002');

  await Promise.all([promiseA, promiseB]);

  const finalA = sessionManager.getSession(sessionA.sessionId, sessionA.sessionToken);
  const finalB = sessionManager.getSession(sessionB.sessionId, sessionB.sessionToken);

  assert.strictEqual(finalA.studentIdentifier, '1000000001');
  assert.strictEqual(finalA.resultData.student.studentNumber, '1000000001');
  assert.strictEqual(finalB.studentIdentifier, '1000000002');
  assert.strictEqual(finalB.resultData.student.studentNumber, '1000000002');
});

test('Data Isolation 5: Student A succeeds, Student B lookup fails — no fallback to Student A', async () => {
  const sessionManager = new SessionManager();
  const mockCredService = {
    fetchCredentials: async (num) => {
      if (num === '1000000001') {
        return { username: 'student_1', password: 'pass', studentNumber: '1000000001' };
      }
      const err = new Error('Student not found in institutional directory.');
      err.code = 'STUDENT_NOT_FOUND';
      throw err;
    }
  };

  const automationService = new AutomationService({
    sessionManager,
    credentialService: mockCredService,
    mockMode: true,
    mockDelayMs: 5
  });

  // Student A succeeds
  const sessionA = sessionManager.createSession('1000000001');
  await automationService.runWorkflow(sessionA.sessionId, sessionA.sessionToken, '1000000001');
  const resA = sessionManager.getSession(sessionA.sessionId, sessionA.sessionToken);
  assert.strictEqual(resA.status, 'ready');
  assert.ok(resA.resultData);

  // Student B fails
  const sessionB = sessionManager.createSession('1000000002');
  await assert.rejects(
    async () => {
      await automationService.runWorkflow(sessionB.sessionId, sessionB.sessionToken, '1000000002');
    },
    { message: /Student not found/ }
  );

  const resB = sessionManager.getSession(sessionB.sessionId, sessionB.sessionToken);
  assert.strictEqual(resB.status, 'error');
  assert.strictEqual(resB.resultData, null);
  assert.strictEqual(resB.downloadedFile, null);
});

test('Data Isolation 6: Workflow error wipes all partial/stale result data', async () => {
  const sessionManager = new SessionManager();
  const automationService = new AutomationService({
    sessionManager,
    mockMode: false
  });

  const session = sessionManager.createSession('1000000001');
  // Intentionally inject pre-existing data
  session.resultData = { student: { name: 'LEAKED' } };
  session.renderedHtml = '<div>stale</div>';

  // Force workflow error
  automationService.credentialService = {
    fetchCredentials: async () => {
      throw new Error('Connection reset by peer');
    }
  };

  await assert.rejects(
    async () => {
      await automationService.runWorkflow(session.sessionId, session.sessionToken, '1000000001');
    }
  );

  const updatedSession = sessionManager.getSession(session.sessionId, session.sessionToken);
  assert.strictEqual(updatedSession.status, 'error');
  assert.strictEqual(updatedSession.resultData, null);
  assert.strictEqual(updatedSession.renderedHtml, null);
  assert.strictEqual(updatedSession.downloadedFile, null);
});

test('Data Isolation 7: CredentialService rejects credential studentNumber mismatch', async () => {
  const mockServer = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      username: 'other_user',
      password: 'other_password',
      studentNumber: '9999999999'
    }));
  });

  try {
    const credService = new CredentialService({
      apiUrl: `${mockServer.url}/api/lookup`,
      apiKey: 'test_token'
    });

    await assert.rejects(
      async () => {
        await credService.fetchCredentials('1000000001');
      },
      (err) => {
        assert.strictEqual(err.code, 'CREDENTIAL_STUDENT_MISMATCH');
        return true;
      }
    );
  } finally {
    mockServer.server.close();
  }
});

test('Data Isolation 8: AutomationService rejects credential studentNumber mismatch during workflow', async () => {
  const sessionManager = new SessionManager();
  const mockCredService = {
    fetchCredentials: async () => ({
      username: 'other_user',
      password: 'pass',
      studentNumber: '9999999999'
    })
  };

  const automationService = new AutomationService({
    sessionManager,
    credentialService: mockCredService,
    mockMode: false
  });

  const session = sessionManager.createSession('1000000001');
  await assert.rejects(
    async () => {
      await automationService.runWorkflow(session.sessionId, session.sessionToken, '1000000001');
    },
    (err) => {
      assert.strictEqual(err.code, 'CREDENTIAL_STUDENT_MISMATCH');
      return true;
    }
  );

  const s = sessionManager.getSession(session.sessionId, session.sessionToken);
  assert.strictEqual(s.resultData, null);
});

test('Data Isolation 9: normalizeResultData throws STUDENT_IDENTITY_MISMATCH if authenticated user mobile does not match', () => {
  const mockAnnualCard = {
    collection: {
      response: {
        data: [{ academicYearDesc: '2024-2025', seatNo: 'SEAT123', fullName: 'John Doe', ygpa: '8.5' }]
      }
    }
  };

  // Expected 1000000001, but auth mobile is 8887416471
  assert.throws(
    () => {
      normalizeResultData({
        annualwiseCardDetails: mockAnnualCard,
        manageExamInfoDetails: null,
        expectedStudentNumber: '1000000001',
        authenticatedUserData: { mobile: '8887416471' }
      });
    },
    (err) => {
      assert.strictEqual(err.code, 'STUDENT_IDENTITY_MISMATCH');
      return true;
    }
  );

  // Matching mobile succeeds
  const result = normalizeResultData({
    annualwiseCardDetails: mockAnnualCard,
    manageExamInfoDetails: null,
    expectedStudentNumber: '1000000001',
    authenticatedUserData: { mobile: '1000000001' }
  });
  assert.strictEqual(result.student.studentNumber, '1000000001');
});

test('Data Isolation 10: Repeated searches for the same student consistently maintain correct identity', async () => {
  const sessionManager = new SessionManager();
  const automationService = new AutomationService({
    sessionManager,
    credentialService: new CredentialService({ mockMode: true }),
    mockMode: true,
    mockDelayMs: 10
  });

  for (let i = 0; i < 3; i++) {
    const session = sessionManager.createSession('1000000001');
    await automationService.runWorkflow(session.sessionId, session.sessionToken, '1000000001');
    const res = sessionManager.getSession(session.sessionId, session.sessionToken);
    assert.strictEqual(res.studentIdentifier, '1000000001');
    assert.strictEqual(res.resultData.student.studentNumber, '1000000001');
  }
});
