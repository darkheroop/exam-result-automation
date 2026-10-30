'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AdminDbService } = require('../src/services/adminDbService');
const { AutomationService } = require('../src/services/automationService');
const { SessionManager } = require('../src/services/sessionManager');

test('Credential Comparison & Update - Full 14-Point Lifecycle Test', async (t) => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();

  // 1. Create a test student with an existing initial username and password
  const testPhone = '9876500001';
  const testAdm = '2025CS101';
  await adminDb.upsertStudent({
    student_name: 'Dev Student One',
    admission_number: testAdm,
    phone_number: testPhone,
    username: 'initial_user_v1',
    password: 'initial_pass_v1'
  });

  // Also create a control student to test that other records are never modified (Point 12)
  const controlPhone = '9876500002';
  const controlAdm = '2025CS102';
  await adminDb.upsertStudent({
    student_name: 'Control Student',
    admission_number: controlAdm,
    phone_number: controlPhone,
    username: 'control_user_fixed',
    password: 'control_pass_fixed'
  });

  let initialRecord = await adminDb.getStudentByAdmissionNumber(testAdm);
  assert.equal(initialRecord.username, 'initial_user_v1');
  assert.equal(initialRecord.password, 'initial_pass_v1');
  const initialUpdatedAt = initialRecord.updated_at;

  // Tiny delay to ensure subsequent timestamps are distinct
  await new Promise(r => setTimeout(r, 15));

  // -------------------------------------------------------------------------
  // 2, 3, 4. Mock API with different credentials, search, verify replacement & updated_at
  // -------------------------------------------------------------------------
  let currentMockCredentials = {
    success: true,
    username: 'second_user_v2',
    password: 'second_pass_v2',
    studentNumber: testPhone
  };

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    mockDelayMs: 5,
    credentialService: {
      fetchCredentials: async (phone) => {
        if (currentMockCredentials.fail) {
          const err = new Error('Upstream API Connection Error');
          err.code = 'API_ERROR';
          throw err;
        }
        return {
          ...currentMockCredentials,
          studentNumber: phone
        };
      }
    }
  });

  const sess1 = sessionManager.createSession(testPhone);
  await automationService.runWorkflow(sess1.sessionId, sess1.sessionToken, testPhone);

  const studentAfterV2 = await adminDb.getStudentByAdmissionNumber(testAdm);
  assert.equal(studentAfterV2.username, 'second_user_v2', 'Username must be replaced with v2 credentials');
  assert.equal(studentAfterV2.password, 'second_pass_v2', 'Password must be replaced with v2 credentials');
  assert.notEqual(studentAfterV2.updated_at, initialUpdatedAt, 'updated_at must be updated on replacement');
  const v2UpdatedAt = studentAfterV2.updated_at;

  await new Promise(r => setTimeout(r, 15));

  // -------------------------------------------------------------------------
  // 5, 6. Perform another search with a third set of credentials, verify replacement again
  // -------------------------------------------------------------------------
  currentMockCredentials = {
    success: true,
    username: 'third_user_v3',
    password: 'third_pass_v3'
  };

  const sess2 = sessionManager.createSession(testPhone);
  await automationService.runWorkflow(sess2.sessionId, sess2.sessionToken, testPhone);

  const studentAfterV3 = await adminDb.getStudentByAdmissionNumber(testAdm);
  assert.equal(studentAfterV3.username, 'third_user_v3', 'Username must be replaced with v3 credentials');
  assert.equal(studentAfterV3.password, 'third_pass_v3', 'Password must be replaced with v3 credentials');
  assert.notEqual(studentAfterV3.updated_at, v2UpdatedAt, 'updated_at must be updated on v3 replacement');
  const v3UpdatedAt = studentAfterV3.updated_at;

  await new Promise(r => setTimeout(r, 15));

  // -------------------------------------------------------------------------
  // 7, 8. Mock identical credentials, verify comparison skips unnecessary update
  // -------------------------------------------------------------------------
  currentMockCredentials = {
    success: true,
    username: 'third_user_v3',
    password: 'third_pass_v3'
  };

  const sess3 = sessionManager.createSession(testPhone);
  await automationService.runWorkflow(sess3.sessionId, sess3.sessionToken, testPhone);

  const studentAfterIdentical = await adminDb.getStudentByAdmissionNumber(testAdm);
  assert.equal(studentAfterIdentical.username, 'third_user_v3', 'Username must remain unchanged');
  assert.equal(studentAfterIdentical.password, 'third_pass_v3', 'Password must remain unchanged');
  assert.equal(studentAfterIdentical.updated_at, v3UpdatedAt, 'updated_at must NOT change when credentials are identical');

  await new Promise(r => setTimeout(r, 15));

  // Direct service test to verify returned flags
  const directIdenticalResult = await adminDb.updateStudentCredentialsByPhone(testPhone, {
    username: 'third_user_v3',
    password: 'third_pass_v3'
  });
  assert.ok(directIdenticalResult);
  assert.equal(directIdenticalResult.updated, false, 'Result must indicate updated = false when credentials are identical');
  assert.equal(directIdenticalResult.count, 1);

  // -------------------------------------------------------------------------
  // 9. Simulate API failure and verify saved credentials remain unchanged
  // -------------------------------------------------------------------------
  currentMockCredentials = {
    fail: true
  };

  const sessFail = sessionManager.createSession(testPhone);
  await assert.rejects(
    async () => {
      await automationService.runWorkflow(sessFail.sessionId, sessFail.sessionToken, testPhone);
    },
    (err) => err.code === 'API_ERROR' || Boolean(err.message)
  );

  const studentAfterFail = await adminDb.getStudentByAdmissionNumber(testAdm);
  assert.equal(studentAfterFail.username, 'third_user_v3', 'Credentials must not change on API failure');
  assert.equal(studentAfterFail.password, 'third_pass_v3', 'Credentials must not change on API failure');
  assert.equal(studentAfterFail.updated_at, v3UpdatedAt, 'updated_at must remain unchanged on API failure');

  // -------------------------------------------------------------------------
  // 10. Simulate an incomplete API response and verify saved credentials remain unchanged
  // -------------------------------------------------------------------------
  // Subcase A: Missing password
  currentMockCredentials = {
    success: true,
    username: 'incomplete_user_no_pass',
    password: ''
  };

  const sessIncompleteA = sessionManager.createSession(testPhone);
  await automationService.runWorkflow(sessIncompleteA.sessionId, sessIncompleteA.sessionToken, testPhone);

  const studentAfterIncompleteA = await adminDb.getStudentByAdmissionNumber(testAdm);
  assert.equal(studentAfterIncompleteA.username, 'third_user_v3', 'Saved credentials must remain unchanged when password is empty');
  assert.equal(studentAfterIncompleteA.password, 'third_pass_v3');
  assert.equal(studentAfterIncompleteA.updated_at, v3UpdatedAt);

  // Subcase B: Missing username
  currentMockCredentials = {
    success: true,
    username: '',
    password: 'incomplete_pass_no_user'
  };

  const sessIncompleteB = sessionManager.createSession(testPhone);
  await automationService.runWorkflow(sessIncompleteB.sessionId, sessIncompleteB.sessionToken, testPhone);

  const studentAfterIncompleteB = await adminDb.getStudentByAdmissionNumber(testAdm);
  assert.equal(studentAfterIncompleteB.username, 'third_user_v3', 'Saved credentials must remain unchanged when username is empty');
  assert.equal(studentAfterIncompleteB.password, 'third_pass_v3');
  assert.equal(studentAfterIncompleteB.updated_at, v3UpdatedAt);

  // -------------------------------------------------------------------------
  // 11. Searches with zero or multiple matching phone-number records do not update
  // -------------------------------------------------------------------------
  // Zero matching records
  const zeroResult = await adminDb.updateStudentCredentialsByPhone('9000000000', {
    username: 'ghost_user',
    password: 'ghost_password'
  });
  assert.equal(zeroResult, null, 'Must return null and not insert or update any record for unmatched phone');

  // Multiple matching duplicate records
  adminDb.memoryStudents.set('DUP-P1', {
    id: 881,
    student_name: 'Dup Phone 1',
    admission_number: 'DUP-P1',
    phone_number: '9111199999',
    username: 'dup_p1_user',
    password: 'dup_p1_pass'
  });
  adminDb.memoryStudents.set('DUP-P2', {
    id: 882,
    student_name: 'Dup Phone 2',
    admission_number: 'DUP-P2',
    phone_number: '9111199999',
    username: 'dup_p2_user',
    password: 'dup_p2_pass'
  });

  await assert.rejects(
    async () => {
      await adminDb.updateStudentCredentialsByPhone('9111199999', {
        username: 'intruder_dup_user',
        password: 'intruder_dup_pass'
      });
    },
    (err) => err.code === 'MULTIPLE_RECORDS_MATCH'
  );

  const checkDup1 = await adminDb.getStudentByAdmissionNumber('DUP-P1');
  const checkDup2 = await adminDb.getStudentByAdmissionNumber('DUP-P2');
  assert.equal(checkDup1.username, 'dup_p1_user', 'Duplicate record 1 must remain untouched');
  assert.equal(checkDup2.username, 'dup_p2_user', 'Duplicate record 2 must remain untouched');

  // -------------------------------------------------------------------------
  // 12. Verify that another student's record is never modified
  // -------------------------------------------------------------------------
  const controlStudentCheck = await adminDb.getStudentByAdmissionNumber(controlAdm);
  assert.equal(controlStudentCheck.username, 'control_user_fixed', 'Control student username must never be modified');
  assert.equal(controlStudentCheck.password, 'control_pass_fixed', 'Control student password must never be modified');

  // -------------------------------------------------------------------------
  // 13. Verify that concurrent searches cannot mix credentials between students
  // -------------------------------------------------------------------------
  await adminDb.upsertStudent({
    student_name: 'Concurrent Alpha',
    admission_number: 'CONC-ALPHA',
    phone_number: '9777711111',
    username: 'alpha_init',
    password: 'alpha_pass_init'
  });

  await adminDb.upsertStudent({
    student_name: 'Concurrent Beta',
    admission_number: 'CONC-BETA',
    phone_number: '9777722222',
    username: 'beta_init',
    password: 'beta_pass_init'
  });

  const concurrentAutomationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    mockDelayMs: 15,
    credentialService: {
      fetchCredentials: async (phone) => {
        // Return phone-bound credentials
        return {
          success: true,
          username: `user_for_${phone}`,
          password: `pass_for_${phone}`,
          studentNumber: phone
        };
      }
    }
  });

  const sessA = sessionManager.createSession('9777711111');
  const sessB = sessionManager.createSession('9777722222');

  await Promise.all([
    concurrentAutomationService.runWorkflow(sessA.sessionId, sessA.sessionToken, '9777711111'),
    concurrentAutomationService.runWorkflow(sessB.sessionId, sessB.sessionToken, '9777722222')
  ]);

  const studentA = await adminDb.getStudentByAdmissionNumber('CONC-ALPHA');
  const studentB = await adminDb.getStudentByAdmissionNumber('CONC-BETA');

  assert.equal(studentA.username, 'user_for_9777711111');
  assert.equal(studentA.password, 'pass_for_9777711111');

  assert.equal(studentB.username, 'user_for_9777722222');
  assert.equal(studentB.password, 'pass_for_9777722222');

  // -------------------------------------------------------------------------
  // 14. Confirm that result retrieval and existing search logs still work
  // -------------------------------------------------------------------------
  const sessAState = sessionManager.getSession(sessA.sessionId, sessA.sessionToken);
  assert.equal(sessAState.status, 'ready');
  assert.ok(sessAState.resultData);
  assert.equal(sessAState.progressPercent, 100);

  const logs = await adminDb.listSearchLogs({ limit: 10 });
  assert.ok(logs.logs.length > 0, 'Search logs must record searches');
  const testPhoneLog = logs.logs.find(l => l.admission_number === '9777711111' || l.search_query === '9777711111');
  assert.ok(testPhoneLog, 'Search log entry must be present for searched student');
  assert.equal(testPhoneLog.result, 'SUCCESS');
});
