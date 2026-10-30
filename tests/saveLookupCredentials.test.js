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

test('Save Lookup Credentials - Search 9599099932 saves username and password to existing student record', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();

  // 1. Existing database record: 9599099932 with empty credentials
  await adminDb.upsertStudent({
    name: 'Aarav Gupta',
    admission_number: '9599099932',
    phone_number: '9599099932',
    username: '',
    password: '',
    section: 'CSE-1'
  });

  // Also insert a control student to verify other records are never modified
  await adminDb.upsertStudent({
    name: 'Bhavna Sharma',
    admission_number: '8888888888',
    phone_number: '8888888888',
    username: 'bhavna_orig',
    password: 'bhavna_orig_pass',
    section: 'CSE-2'
  });

  const statsBefore = await adminDb.getDashboardStats();
  const totalBefore = statsBefore.totalStudents;

  // Mocked credential API response
  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    mockDelayMs: 5,
    credentialService: {
      fetchCredentials: async (studentNumber) => {
        assert.equal(studentNumber, '9599099932');
        return {
          success: true,
          username: 'student123',
          password: 'gaqhf',
          studentNumber: '9599099932'
        };
      }
    }
  });

  // Normal student submits public result search
  const session = sessionManager.createSession('9599099932');
  await automationService.runWorkflow(session.sessionId, session.sessionToken, '9599099932');

  const s = sessionManager.getSession(session.sessionId, session.sessionToken);
  assert.equal(s.status, 'ready');
  assert.ok(s.resultData);

  // Verify: Exactly the record matching admission_number = 9599099932 was updated
  const updatedStudent = await adminDb.getStudentByAdmissionNumber('9599099932');
  assert.ok(updatedStudent, 'Matching student record must exist');
  assert.equal(updatedStudent.admission_number, '9599099932');
  assert.equal(updatedStudent.username, 'student123');
  assert.equal(updatedStudent.password, 'gaqhf');
  assert.equal(updatedStudent.name, 'Aarav Gupta', 'Name must remain unchanged');
  assert.equal(updatedStudent.section, 'CSE-1', 'Section must remain unchanged');

  // Verify: No new student record was inserted
  const statsAfter = await adminDb.getDashboardStats();
  assert.equal(statsAfter.totalStudents, totalBefore, 'Student count must not increase; no duplicate record inserted');

  // Verify: Other student records were not modified
  const controlStudent = await adminDb.getStudentByAdmissionNumber('8888888888');
  assert.equal(controlStudent.username, 'bhavna_orig');
  assert.equal(controlStudent.password, 'bhavna_orig_pass');
});

test('Save Lookup Credentials - Strict matching rule: never matches by phone number or student name', async () => {
  const adminDb = new AdminDbService();

  // Student whose phone_number matches '9599099932' but admission_number is 'DIFF-999'
  await adminDb.upsertStudent({
    name: 'Phone Match Student',
    admission_number: 'DIFF-999',
    phone_number: '9599099932',
    username: '',
    password: '',
    section: 'CSE-3'
  });

  // Attempt to update credentials for admission number '9599099932'
  const res = await adminDb.updateStudentCredentials('9599099932', {
    username: 'should_not_save',
    password: 'should_not_save'
  });

  assert.equal(res, null, 'Must return null when admission number does not match, even if phone number matches');

  const diffStudent = await adminDb.getStudentByAdmissionNumber('DIFF-999');
  assert.equal(diffStudent.username, '', 'DIFF-999 username must remain empty');
  assert.equal(diffStudent.password, '', 'DIFF-999 password must remain empty');
});

test('Save Lookup Credentials - Data integrity: multiple duplicate records throw MULTIPLE_RECORDS_MATCH', async () => {
  const adminDb = new AdminDbService();

  // Manually simulate a corrupted duplicate in memory store
  adminDb.memoryStudents.set('DUP-1', {
    id: 101,
    admission_number: '9599099932',
    name: 'Duplicate 1',
    username: '',
    password: ''
  });
  adminDb.memoryStudents.set('DUP-2', {
    id: 102,
    admission_number: '9599099932',
    name: 'Duplicate 2',
    username: '',
    password: ''
  });

  await assert.rejects(
    async () => {
      await adminDb.updateStudentCredentials('9599099932', {
        username: 'student123',
        password: 'gaqhf'
      });
    },
    (err) => {
      assert.equal(err.code, 'MULTIPLE_RECORDS_MATCH');
      return true;
    }
  );
});

test('Save Lookup Credentials - Failed credential lookup preserves existing credentials without overwrite', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();

  await adminDb.upsertStudent({
    name: 'Pooja Verma',
    admission_number: '9777777777',
    phone_number: '9777777777',
    username: 'pooja_saved',
    password: 'pooja_secret_pass',
    section: 'CSE-1'
  });

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: false,
    credentialService: {
      fetchCredentials: async () => {
        const err = new Error('Student Lookup API 500 server error');
        err.code = 'API_ERROR';
        err.statusCode = 500;
        throw err;
      }
    }
  });

  const session = sessionManager.createSession('9777777777');
  await assert.rejects(
    async () => {
      await automationService.runWorkflow(session.sessionId, session.sessionToken, '9777777777');
    },
    { message: /500 server error/ }
  );

  // Existing credentials must remain completely untouched
  const student = await adminDb.getStudentByAdmissionNumber('9777777777');
  assert.equal(student.username, 'pooja_saved');
  assert.equal(student.password, 'pooja_secret_pass');
});

test('Save Lookup Credentials - Concurrent student searches update independent student records without mixing', async () => {
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
    mockDelayMs: 10,
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

  await Promise.all([
    automationService.runWorkflow(session1.sessionId, session1.sessionToken, '9111111111'),
    automationService.runWorkflow(session2.sessionId, session2.sessionToken, '9222222222')
  ]);

  const s1 = await adminDb.getStudentByAdmissionNumber('9111111111');
  assert.equal(s1.username, 'user_9111111111');
  assert.equal(s1.password, 'pass_9111111111');

  const s2 = await adminDb.getStudentByAdmissionNumber('9222222222');
  assert.equal(s2.username, 'user_9222222222');
  assert.equal(s2.password, 'pass_9222222222');
});
