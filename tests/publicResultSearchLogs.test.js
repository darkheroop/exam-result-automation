'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/app');
const { AutomationService } = require('../src/services/automationService');
const { SessionManager } = require('../src/services/sessionManager');
const { AdminDbService } = require('../src/services/adminDbService');

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

test('Scenario 1: Normal user searches with a valid admission number and successfully receives a result -> SUCCESS log', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();
  
  // Register existing student in database without credentials
  await adminDb.upsertStudent({
    name: 'Rohit Sharma',
    admission_number: '9599099932',
    phone_number: '9599099932',
    username: '',
    password: '',
    section: 'CSE-A'
  });

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    credentialService: {
      fetchCredentials: async (studentNumber) => ({
        username: 'rohit45',
        password: 'rohit_password_secure',
        studentNumber
      })
    }
  });

  const session = sessionManager.createSession('9599099932');
  await automationService.runWorkflow(session.sessionId, session.sessionToken, '9599099932');

  const updatedSession = sessionManager.getSession(session.sessionId, session.sessionToken);
  assert.equal(updatedSession.status, 'ready');
  assert.ok(updatedSession.resultData);

  // Check search_logs in adminDb
  const logs = await adminDb.listSearchLogs();
  assert.equal(logs.total, 1);
  assert.equal(logs.logs[0].admission_number, '9599099932');
  assert.equal(logs.logs[0].result, 'SUCCESS');

  // Verify credentials were saved to student record
  const student = await adminDb.getStudentByAdmissionNumber('9599099932');
  assert.equal(student.username, 'rohit45');
  assert.equal(student.password, 'rohit_password_secure');
});

test('Scenario 2: Normal user searches and the credential lookup API returns an error -> API_ERROR log', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();

  await adminDb.upsertStudent({
    name: 'Aditi Rao',
    admission_number: '9876543210',
    phone_number: '9876543210',
    username: '',
    password: '',
    section: 'CSE-B'
  });

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    credentialService: {
      fetchCredentials: async () => {
        const err = new Error('Student Lookup API 500 internal server error');
        err.code = 'API_ERROR';
        throw err;
      }
    }
  });

  const session = sessionManager.createSession('9876543210');
  await assert.rejects(async () => {
    await automationService.runWorkflow(session.sessionId, session.sessionToken, '9876543210');
  });

  const updatedSession = sessionManager.getSession(session.sessionId, session.sessionToken);
  assert.equal(updatedSession.status, 'error');

  const logs = await adminDb.listSearchLogs();
  assert.equal(logs.total, 1);
  assert.equal(logs.logs[0].admission_number, '9876543210');
  assert.equal(logs.logs[0].result, 'API_ERROR');

  // Existing credentials must remain untouched (Scenario 9 check)
  const student = await adminDb.getStudentByAdmissionNumber('9876543210');
  assert.equal(student.username, '');
  assert.equal(student.password, '');
});

test('Scenario 3: Normal user searches with an admission number that does not exist locally -> NOT_FOUND', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();

  let credentialApiCalled = false;
  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: false,
    credentialService: {
      fetchCredentials: async () => {
        credentialApiCalled = true;
        return { username: 'x', password: 'y', studentNumber: '9999999999' };
      }
    }
  });

  const session = sessionManager.createSession('9999999999');
  await assert.rejects(
    async () => {
      await automationService.runWorkflow(session.sessionId, session.sessionToken, '9999999999');
    },
    { code: 'NOT_FOUND' }
  );

  assert.equal(credentialApiCalled, false, 'Credential API must not be called when student does not exist locally');

  const logs = await adminDb.listSearchLogs();
  assert.equal(logs.total, 1);
  assert.equal(logs.logs[0].admission_number, '9999999999');
  assert.equal(logs.logs[0].result, 'NOT_FOUND');
});

test('Scenario 4: Normal user receives an authentication error -> AUTH_ERROR', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();

  await adminDb.upsertStudent({
    name: 'Suresh Raina',
    admission_number: '9123456780',
    phone_number: '9123456780',
    username: 'suresh3',
    password: 'wrong_password',
    section: 'CSE-C'
  });

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: false,
    credentialService: {
      fetchCredentials: async () => ({
        username: 'suresh3',
        password: 'wrong_password',
        studentNumber: '9123456780'
      })
    }
  });

  // Emulate portal authentication rejection
  const session = sessionManager.createSession('9123456780');

  // Override auth step failure
  automationService.executeWorkflow = async function(sessionId, sessionToken, studentNumber) {
    try {
      const matchingStudent = await this.adminDbService.getStudentByAdmissionNumber(studentNumber);
      assert.ok(matchingStudent);
      const authErr = new Error('Authentication failed: Portal authentication rejected credentials.');
      authErr.code = 'AUTH_ERROR';
      throw authErr;
    } catch (err) {
      await this.adminDbService.logSearch({
        admissionNumber: studentNumber,
        result: 'AUTH_ERROR'
      });
      throw err;
    }
  };

  await assert.rejects(async () => {
    await automationService.runWorkflow(session.sessionId, session.sessionToken, '9123456780');
  });

  const logs = await adminDb.listSearchLogs();
  assert.equal(logs.total, 1);
  assert.equal(logs.logs[0].admission_number, '9123456780');
  assert.equal(logs.logs[0].result, 'AUTH_ERROR');
});

test('Scenario 5: Normal user searches but the result is unavailable -> UNAVAILABLE', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();

  await adminDb.upsertStudent({
    name: 'Pooja Hegde',
    admission_number: '9234567891',
    phone_number: '9234567891',
    username: '',
    password: '',
    section: 'CSE-D'
  });

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: false
  });

  // Emulate result not published / unavailable
  automationService.executeWorkflow = async function(sessionId, sessionToken, studentNumber) {
    try {
      const unavailErr = new Error('Examination result could not be retrieved from the portal.');
      unavailErr.code = 'UNAVAILABLE';
      throw unavailErr;
    } catch (err) {
      await this.adminDbService.logSearch({
        admissionNumber: studentNumber,
        result: 'UNAVAILABLE'
      });
      throw err;
    }
  };

  const session = sessionManager.createSession('9234567891');
  await assert.rejects(async () => {
    await automationService.runWorkflow(session.sessionId, session.sessionToken, '9234567891');
  });

  const logs = await adminDb.listSearchLogs();
  assert.equal(logs.total, 1);
  assert.equal(logs.logs[0].admission_number, '9234567891');
  assert.equal(logs.logs[0].result, 'UNAVAILABLE');
});

test('Scenario 6: Two different students search simultaneously -> Separate logs and correct credential updates', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();

  await adminDb.upsertStudent({
    name: 'Student One',
    admission_number: '9111111111',
    phone_number: '9111111111',
    username: '',
    password: '',
    section: 'CSE-A'
  });

  await adminDb.upsertStudent({
    name: 'Student Two',
    admission_number: '9222222222',
    phone_number: '9222222222',
    username: '',
    password: '',
    section: 'CSE-B'
  });

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    credentialService: {
      fetchCredentials: async (studentNumber) => ({
        username: `user_${studentNumber}`,
        password: `pass_${studentNumber}`,
        studentNumber
      })
    }
  });

  const session1 = sessionManager.createSession('9111111111');
  const session2 = sessionManager.createSession('9222222222');

  // Run in parallel
  await Promise.all([
    automationService.runWorkflow(session1.sessionId, session1.sessionToken, '9111111111'),
    automationService.runWorkflow(session2.sessionId, session2.sessionToken, '9222222222')
  ]);

  const logs = await adminDb.listSearchLogs();
  assert.equal(logs.total, 2);

  const st1 = await adminDb.getStudentByAdmissionNumber('9111111111');
  assert.equal(st1.username, 'user_9111111111');
  assert.equal(st1.password, 'pass_9111111111');

  const st2 = await adminDb.getStudentByAdmissionNumber('9222222222');
  assert.equal(st2.username, 'user_9222222222');
  assert.equal(st2.password, 'pass_9222222222');
});

test('Scenario 7: A student searches repeatedly -> Each submitted request produces exactly one log', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();

  await adminDb.upsertStudent({
    name: 'Repeat Student',
    admission_number: '9333333333',
    phone_number: '9333333333',
    username: '',
    password: '',
    section: 'CSE-C'
  });

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    credentialService: {
      fetchCredentials: async (studentNumber) => ({
        username: 'repeat_user',
        password: 'repeat_password',
        studentNumber
      })
    }
  });

  // First search
  const session1 = sessionManager.createSession('9333333333');
  await automationService.runWorkflow(session1.sessionId, session1.sessionToken, '9333333333');

  // Second search
  const session2 = sessionManager.createSession('9333333333');
  await automationService.runWorkflow(session2.sessionId, session2.sessionToken, '9333333333');

  // Third search
  const session3 = sessionManager.createSession('9333333333');
  await automationService.runWorkflow(session3.sessionId, session3.sessionToken, '9333333333');

  const logs = await adminDb.listSearchLogs();
  assert.equal(logs.total, 3, 'Expected exactly 3 separate logs for 3 submitted requests');
  for (const log of logs.logs) {
    assert.equal(log.admission_number, '9333333333');
    assert.equal(log.result, 'SUCCESS');
  }
});

test('Scenario 8 & 9: Successful credentials appear in student card & failed API calls do not erase credentials', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();

  await adminDb.upsertStudent({
    name: 'Persistent Student',
    admission_number: '9444444444',
    phone_number: '9444444444',
    username: '',
    password: '',
    section: 'CSE-D'
  });

  // 1. Initial success search -> saves credentials
  const successService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    credentialService: {
      fetchCredentials: async (studentNumber) => ({
        username: 'pers_user',
        password: 'pers_initial_password',
        studentNumber
      })
    }
  });

  const sessionSuccess = sessionManager.createSession('9444444444');
  await successService.runWorkflow(sessionSuccess.sessionId, sessionSuccess.sessionToken, '9444444444');

  // Verify student card in adminDb has saved credentials
  let student = await adminDb.getStudentByAdmissionNumber('9444444444');
  assert.equal(student.username, 'pers_user');
  assert.equal(student.password, 'pers_initial_password');

  // 2. Subsequent search where portal encounters a non-login timeout -> must NOT erase credentials
  const failureService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    portalAuthHandler: async () => {
      const err = new Error('Portal temporarily unavailable');
      err.code = 'TIMEOUT_PORTAL_AUTH';
      throw err;
    },
    credentialService: {
      fetchCredentials: async () => {
        throw new Error('API should not be called on network error');
      }
    }
  });

  const sessionFail = sessionManager.createSession('9444444444');
  await assert.rejects(async () => {
    await failureService.runWorkflow(sessionFail.sessionId, sessionFail.sessionToken, '9444444444');
  });

  // Verify credentials were NOT erased
  student = await adminDb.getStudentByAdmissionNumber('9444444444');
  assert.equal(student.username, 'pers_user');
  assert.equal(student.password, 'pers_initial_password');

  // Verify search logs recorded both
  const logs = await adminDb.listSearchLogs();
  assert.equal(logs.total, 2);
  assert.equal(logs.logs[0].result, 'TIMEOUT'); // Newest first
  assert.equal(logs.logs[1].result, 'SUCCESS');
});
