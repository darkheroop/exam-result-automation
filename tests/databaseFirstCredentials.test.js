'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AdminDbService } = require('../src/services/adminDbService');
const { AutomationService } = require('../src/services/automationService');
const { SessionManager } = require('../src/services/sessionManager');

test('Scenario 1: Saved credentials in database are valid - API is NOT called, results displayed', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();
  const phone = '9870000001';
  const adm = 'ADM-001';

  await adminDb.upsertStudent({
    student_name: 'Scenario One Student',
    admission_number: adm,
    phone_number: phone,
    username: 'valid_portal_usr',
    password: 'valid_portal_pwd'
  });

  const recordBefore = await adminDb.getStudentByAdmissionNumber(adm);
  const updatedAtBefore = recordBefore.updated_at;

  let apiCallCount = 0;
  let portalLoginCount = 0;

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    mockDelayMs: 2,
    portalAuthHandler: async (user, pass, num) => {
      portalLoginCount++;
      assert.equal(user, 'valid_portal_usr');
      assert.equal(pass, 'valid_portal_pwd');
      assert.equal(num, phone);
      return { id: '101', mobile: num, firstName: 'Scenario', lastName: 'One' };
    },
    credentialService: {
      fetchCredentials: async () => {
        apiCallCount++;
        throw new Error('API should NEVER be called when database credentials are valid!');
      }
    }
  });

  const session = sessionManager.createSession(phone);
  await automationService.runWorkflow(session.sessionId, session.sessionToken, phone);

  const finalSession = sessionManager.getSession(session.sessionId, session.sessionToken);
  assert.equal(finalSession.status, 'ready');
  assert.ok(finalSession.resultData);
  assert.equal(finalSession.progressPercent, 100);

  // Assert API was NEVER called
  assert.equal(apiCallCount, 0, 'Credential lookup API must NOT be called when saved credentials succeed');
  assert.equal(portalLoginCount, 1, 'Portal login must be attempted with saved credentials');

  // Assert database record remains intact and untouched
  const recordAfter = await adminDb.getStudentByAdmissionNumber(adm);
  assert.equal(recordAfter.username, 'valid_portal_usr');
  assert.equal(recordAfter.password, 'valid_portal_pwd');
  assert.equal(recordAfter.updated_at, updatedAtBefore, 'updated_at must remain unchanged');
});

test('Scenario 2: Saved credentials fail, API succeeds - DB updated, login retried, results displayed', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();
  const phone = '9870000002';
  const adm = 'ADM-002';

  await adminDb.upsertStudent({
    student_name: 'Scenario Two Student',
    admission_number: adm,
    phone_number: phone,
    username: 'old_expired_usr',
    password: 'old_expired_pwd'
  });

  let apiCallCount = 0;
  const loginAttempts = [];

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    mockDelayMs: 2,
    portalAuthHandler: async (user, pass, num) => {
      loginAttempts.push({ user, pass });
      if (user === 'old_expired_usr') {
        const err = new Error('Invalid portal username or password.');
        err.code = 'AUTH_REJECTED';
        throw err;
      }
      if (user === 'fresh_new_usr' && pass === 'fresh_new_pwd') {
        return { id: '102', mobile: num, firstName: 'Scenario', lastName: 'Two' };
      }
      throw new Error(`Unexpected user credentials: ${user}`);
    },
    credentialService: {
      fetchCredentials: async (studentNum) => {
        apiCallCount++;
        assert.equal(studentNum, phone);
        return {
          success: true,
          username: 'fresh_new_usr',
          password: 'fresh_new_pwd',
          studentNumber: phone
        };
      }
    }
  });

  const session = sessionManager.createSession(phone);
  await automationService.runWorkflow(session.sessionId, session.sessionToken, phone);

  const finalSession = sessionManager.getSession(session.sessionId, session.sessionToken);
  assert.equal(finalSession.status, 'ready');
  assert.equal(finalSession.progressPercent, 100);

  // Assert flow: 1st login attempt failed -> API called -> 2nd login attempt succeeded
  assert.equal(apiCallCount, 1, 'Credential lookup API must be called once as fallback');
  assert.equal(loginAttempts.length, 2, 'Portal login must be attempted twice (first failed, second succeeded)');
  assert.equal(loginAttempts[0].user, 'old_expired_usr');
  assert.equal(loginAttempts[1].user, 'fresh_new_usr');

  // Assert database was updated with fresh credentials
  const recordAfter = await adminDb.getStudentByAdmissionNumber(adm);
  assert.equal(recordAfter.username, 'fresh_new_usr');
  assert.equal(recordAfter.password, 'fresh_new_pwd');
});

test('Scenario 3: Saved credentials fail, API fails - credentials cleared from database', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();
  const phone = '9870000003';
  const adm = 'ADM-003';

  await adminDb.upsertStudent({
    student_name: 'Scenario Three Student',
    admission_number: adm,
    phone_number: phone,
    username: 'doomed_user',
    password: 'doomed_password'
  });

  let apiCallCount = 0;

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    mockDelayMs: 2,
    portalAuthHandler: async () => {
      const err = new Error('Portal authentication failed: incorrect password');
      err.code = 'AUTH_REJECTED';
      throw err;
    },
    credentialService: {
      fetchCredentials: async () => {
        apiCallCount++;
        const apiErr = new Error('Credential provider upstream service error 500');
        apiErr.code = 'API_ERROR';
        throw apiErr;
      }
    }
  });

  const session = sessionManager.createSession(phone);

  await assert.rejects(
    async () => {
      await automationService.runWorkflow(session.sessionId, session.sessionToken, phone);
    },
    (err) => {
      assert.ok(err.message.includes('credentials') || err.code === 'AUTH_CREDENTIALS_FAILED');
      return true;
    }
  );

  assert.equal(apiCallCount, 1);

  // Crucial check: Saved credentials MUST be cleared in database
  const recordAfter = await adminDb.getStudentByAdmissionNumber(adm);
  assert.equal(recordAfter.username, '', 'Username must be cleared in database');
  assert.equal(recordAfter.password, '', 'Password must be cleared in database');
  assert.equal(recordAfter.portal_username, null);
  assert.equal(recordAfter.portal_password, null);
});

test('Scenario 4: Saved credentials fail, API returns incomplete credentials - credentials cleared from database', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();
  const phone = '9870000004';
  const adm = 'ADM-004';

  await adminDb.upsertStudent({
    student_name: 'Scenario Four Student',
    admission_number: adm,
    phone_number: phone,
    username: 'failing_user_4',
    password: 'failing_pass_4'
  });

  let apiCallCount = 0;

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    mockDelayMs: 2,
    portalAuthHandler: async () => {
      const err = new Error('Portal rejected credentials');
      err.code = 'AUTH_REJECTED';
      throw err;
    },
    credentialService: {
      fetchCredentials: async () => {
        apiCallCount++;
        // Missing password in API response
        return {
          success: true,
          username: 'incomplete_user_only',
          password: '',
          studentNumber: phone
        };
      }
    }
  });

  const session = sessionManager.createSession(phone);

  await assert.rejects(
    async () => {
      await automationService.runWorkflow(session.sessionId, session.sessionToken, phone);
    },
    (err) => {
      assert.equal(err.code, 'INCOMPLETE_CREDENTIAL_DATA');
      return true;
    }
  );

  assert.equal(apiCallCount, 1);

  // Crucial check: Credentials must be cleared from database
  const recordAfter = await adminDb.getStudentByAdmissionNumber(adm);
  assert.equal(recordAfter.username, '');
  assert.equal(recordAfter.password, '');
});

test('Scenario 5: No credentials in database, API succeeds - credentials saved and login attempted', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();
  const phone = '9870000005';
  const adm = 'ADM-005';

  // Empty credentials initially in database
  await adminDb.upsertStudent({
    student_name: 'Scenario Five Student',
    admission_number: adm,
    phone_number: phone,
    username: '',
    password: ''
  });

  let apiCallCount = 0;
  let portalLoginCount = 0;

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    mockDelayMs: 2,
    portalAuthHandler: async (user, pass, num) => {
      portalLoginCount++;
      assert.equal(user, 'api_delivered_user');
      assert.equal(pass, 'api_delivered_pass');
      assert.equal(num, phone);
      return { id: '105', mobile: num, firstName: 'Scenario', lastName: 'Five' };
    },
    credentialService: {
      fetchCredentials: async (studentNum) => {
        apiCallCount++;
        assert.equal(studentNum, phone);
        return {
          success: true,
          username: 'api_delivered_user',
          password: 'api_delivered_pass',
          studentNumber: phone
        };
      }
    }
  });

  const session = sessionManager.createSession(phone);
  await automationService.runWorkflow(session.sessionId, session.sessionToken, phone);

  const finalSession = sessionManager.getSession(session.sessionId, session.sessionToken);
  assert.equal(finalSession.status, 'ready');

  assert.equal(apiCallCount, 1, 'API called immediately for student with no saved credentials');
  assert.equal(portalLoginCount, 1, 'Portal login attempted after retrieving credentials');

  // Assert database saved both username and password
  const recordAfter = await adminDb.getStudentByAdmissionNumber(adm);
  assert.equal(recordAfter.username, 'api_delivered_user');
  assert.equal(recordAfter.password, 'api_delivered_pass');
});

test('Scenario 6: No credentials in database, API fails - database remains empty, portal login NOT attempted', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();
  const phone = '9870000006';
  const adm = 'ADM-006';

  await adminDb.upsertStudent({
    student_name: 'Scenario Six Student',
    admission_number: adm,
    phone_number: phone,
    username: '',
    password: ''
  });

  let portalLoginAttempted = false;

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    mockDelayMs: 2,
    portalAuthHandler: async () => {
      portalLoginAttempted = true;
      throw new Error('Portal login should NOT be attempted when API fails');
    },
    credentialService: {
      fetchCredentials: async () => {
        const err = new Error('Student lookup upstream service down');
        err.code = 'API_ERROR';
        throw err;
      }
    }
  });

  const session = sessionManager.createSession(phone);

  await assert.rejects(
    async () => {
      await automationService.runWorkflow(session.sessionId, session.sessionToken, phone);
    },
    (err) => err.code === 'API_ERROR'
  );

  assert.equal(portalLoginAttempted, false, 'Portal login must NOT be attempted');

  // Database credentials must remain empty
  const recordAfter = await adminDb.getStudentByAdmissionNumber(adm);
  assert.equal(recordAfter.username, '');
  assert.equal(recordAfter.password, '');
});

test('Scenario 7: Portal/network error (non-login failure) - credentials NOT cleared, API NOT called', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();
  const phone = '9870000007';
  const adm = 'ADM-007';

  await adminDb.upsertStudent({
    student_name: 'Scenario Seven Student',
    admission_number: adm,
    phone_number: phone,
    username: 'stable_user',
    password: 'stable_password'
  });

  const recordBefore = await adminDb.getStudentByAdmissionNumber(adm);
  const updatedAtBefore = recordBefore.updated_at;

  let apiCalled = false;

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    mockDelayMs: 2,
    portalAuthHandler: async () => {
      // Simulate a network timeout or connection refused
      const timeoutErr = new Error('Operation Portal Direct Authentication timed out');
      timeoutErr.code = 'TIMEOUT_PORTAL_AUTH';
      throw timeoutErr;
    },
    credentialService: {
      fetchCredentials: async () => {
        apiCalled = true;
        throw new Error('API should NOT be called on network/timeout error');
      }
    }
  });

  const session = sessionManager.createSession(phone);

  await assert.rejects(
    async () => {
      await automationService.runWorkflow(session.sessionId, session.sessionToken, phone);
    },
    (err) => err.code === 'TIMEOUT_PORTAL_AUTH' || err.code === 'TIMEOUT'
  );

  assert.equal(apiCalled, false, 'API must NOT be called for non-authentication portal errors');

  // Database credentials must remain intact!
  const recordAfter = await adminDb.getStudentByAdmissionNumber(adm);
  assert.equal(recordAfter.username, 'stable_user');
  assert.equal(recordAfter.password, 'stable_password');
  assert.equal(recordAfter.updated_at, updatedAtBefore, 'updated_at must remain unchanged');
});

test('Scenario 8: Student record does not exist in database - no DB insert/modification', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();
  const phone = '9870000099';

  const statsBefore = await adminDb.getDashboardStats();

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: false,
    credentialService: {
      fetchCredentials: async () => {
        throw new Error('API should not be reached');
      }
    }
  });

  const session = sessionManager.createSession(phone);

  await assert.rejects(
    async () => {
      await automationService.runWorkflow(session.sessionId, session.sessionToken, phone);
    },
    (err) => err.code === 'NOT_FOUND' || err.statusCode === 404
  );

  const statsAfter = await adminDb.getDashboardStats();
  assert.equal(statsAfter.totalStudents, statsBefore.totalStudents, 'No new student record should be created');

  const checkStudent = await adminDb.getStudentByPhoneNumber(phone);
  assert.equal(checkStudent, null);
});

test('Scenario 9: Multiple matching student records in database - no DB modification', async () => {
  const adminDb = new AdminDbService();
  const duplicatePhone = '9555544444';

  // Seed two duplicate records with the exact same phone number
  adminDb.memoryStudents.set('DUP-1', {
    id: 501,
    student_name: 'Duplicate Student One',
    admission_number: 'DUP-1',
    phone_number: duplicatePhone,
    username: 'orig_dup1_user',
    password: 'orig_dup1_pass'
  });

  adminDb.memoryStudents.set('DUP-2', {
    id: 502,
    student_name: 'Duplicate Student Two',
    admission_number: 'DUP-2',
    phone_number: duplicatePhone,
    username: 'orig_dup2_user',
    password: 'orig_dup2_pass'
  });

  // Verify clearStudentCredentialsByPhone aborts without touching either record
  await assert.rejects(
    async () => {
      await adminDb.clearStudentCredentialsByPhone(duplicatePhone);
    },
    (err) => err.code === 'MULTIPLE_RECORDS_MATCH'
  );

  const check1 = await adminDb.getStudentByAdmissionNumber('DUP-1');
  const check2 = await adminDb.getStudentByAdmissionNumber('DUP-2');
  assert.equal(check1.username, 'orig_dup1_user');
  assert.equal(check2.username, 'orig_dup2_user');

  // Verify updateStudentCredentialsByPhone aborts without touching either record
  await assert.rejects(
    async () => {
      await adminDb.updateStudentCredentialsByPhone(duplicatePhone, {
        username: 'intruder',
        password: 'intruder_pass'
      });
    },
    (err) => err.code === 'MULTIPLE_RECORDS_MATCH'
  );

  assert.equal(check1.username, 'orig_dup1_user');
  assert.equal(check2.username, 'orig_dup2_user');
});

test('Scenario 10: Concurrent searches by different students - independent credentials used without crosstalk', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();

  const studentA = { phone: '9888800001', adm: 'CONC-01', user: 'alpha_user', pass: 'alpha_pass' };
  const studentB = { phone: '9888800002', adm: 'CONC-02', user: 'beta_user', pass: 'beta_pass' };

  await adminDb.upsertStudent({
    student_name: 'Concurrent Alpha',
    admission_number: studentA.adm,
    phone_number: studentA.phone,
    username: studentA.user,
    password: studentA.pass
  });

  await adminDb.upsertStudent({
    student_name: 'Concurrent Beta',
    admission_number: studentB.adm,
    phone_number: studentB.phone,
    username: '',
    password: ''
  });

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    mockDelayMs: 10,
    portalAuthHandler: async (user, pass, num) => {
      if (num === studentA.phone) {
        assert.equal(user, studentA.user);
        assert.equal(pass, studentA.pass);
      } else if (num === studentB.phone) {
        assert.equal(user, 'fresh_beta_user');
        assert.equal(pass, 'fresh_beta_pass');
      }
      return { id: num, mobile: num, firstName: 'Concurrent', lastName: num };
    },
    credentialService: {
      fetchCredentials: async (studentNum) => {
        if (studentNum === studentA.phone) {
          throw new Error('Student A already has valid credentials, API should not be called!');
        }
        return {
          success: true,
          username: 'fresh_beta_user',
          password: 'fresh_beta_pass',
          studentNumber: studentB.phone
        };
      }
    }
  });

  const sessA = sessionManager.createSession(studentA.phone);
  const sessB = sessionManager.createSession(studentB.phone);

  // Execute concurrently
  await Promise.all([
    automationService.runWorkflow(sessA.sessionId, sessA.sessionToken, studentA.phone),
    automationService.runWorkflow(sessB.sessionId, sessB.sessionToken, studentB.phone)
  ]);

  const stateA = sessionManager.getSession(sessA.sessionId, sessA.sessionToken);
  const stateB = sessionManager.getSession(sessB.sessionId, sessB.sessionToken);

  assert.equal(stateA.status, 'ready');
  assert.equal(stateB.status, 'ready');

  const recordA = await adminDb.getStudentByAdmissionNumber(studentA.adm);
  const recordB = await adminDb.getStudentByAdmissionNumber(studentB.adm);

  assert.equal(recordA.username, studentA.user, 'Student A credentials remained unchanged');
  assert.equal(recordB.username, 'fresh_beta_user', 'Student B credentials updated independently');
});

test('Scenario 11: Existing features unaffected - Search logs, Excel upload, and Admin Dashboard work normally', async () => {
  const adminDb = new AdminDbService();

  // 1. Search logs work
  const logResult = await adminDb.logSearch({
    admissionNumber: '9999900001',
    result: 'SUCCESS'
  });
  assert.ok(logResult);
  assert.equal(logResult.result, 'SUCCESS');

  const logsList = await adminDb.listSearchLogs({ page: 1, limit: 10 });
  assert.ok(logsList.logs.length >= 1);
  assert.equal(logsList.logs[0].admission_number, '9999900001');

  // 2. Batch student upsert (Excel upload simulation)
  const batchRes = await adminDb.batchUpsertStudents([
    { admission_number: 'EXCEL-01', student_name: 'Excel Student 1', phone_number: '9123456781' },
    { admission_number: 'EXCEL-02', student_name: 'Excel Student 2', phone_number: '9123456782' }
  ]);
  assert.equal(batchRes.added, 2);

  // 3. Dashboard stats work
  const stats = await adminDb.getDashboardStats();
  assert.ok(stats.totalStudents >= 2);
  assert.ok(stats.studentsWithoutUsername >= 2);

  // 4. Admin Student Management CRUD works
  const retrieved = await adminDb.getStudentByAdmissionNumber('EXCEL-01');
  assert.equal(retrieved.student_name, 'Excel Student 1');

  const updated = await adminDb.updateStudent(retrieved.id, { student_name: 'Excel Student 1 Renamed' });
  assert.equal(updated.student_name, 'Excel Student 1 Renamed');

  const deleted = await adminDb.deleteStudent(retrieved.id);
  assert.equal(deleted, true);

  const checkDeleted = await adminDb.getStudentByAdmissionNumber('EXCEL-01');
  assert.equal(checkDeleted, null);
});
