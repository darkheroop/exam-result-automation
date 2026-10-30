'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AdminDbService } = require('../src/services/adminDbService');
const { AutomationService } = require('../src/services/automationService');
const { SessionManager } = require('../src/services/sessionManager');

test('Phone Number Matching Rules - Exact matching updates student with different admission number', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();

  // Student with alphanumeric admission number and 10-digit phone number
  await adminDb.upsertStudent({
    student_name: 'Rahul Sharma',
    admission_number: '2025B0101077',
    phone_number: '9876543210',
    section: 'CSE-A'
  });

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    mockDelayMs: 5,
    credentialService: {
      fetchCredentials: async (searchedPhone) => {
        assert.equal(searchedPhone, '9876543210');
        return {
          success: true,
          username: 'rahul_portal',
          password: 'rahul_secret_pass',
          studentNumber: '9876543210'
        };
      }
    }
  });

  // Normal user searches using phone number 9876543210
  const session = sessionManager.createSession('9876543210');
  await automationService.runWorkflow(session.sessionId, session.sessionToken, '9876543210');

  // Verify student record with admission number '2025B0101077' got credentials saved
  const student = await adminDb.getStudentByAdmissionNumber('2025B0101077');
  assert.ok(student);
  assert.equal(student.phone_number, '9876543210');
  assert.equal(student.portal_username, 'rahul_portal');
  assert.equal(student.portal_password, 'rahul_secret_pass');
});

test('Phone Number Matching Rules - Never matches by admission number for credential update', async () => {
  const adminDb = new AdminDbService();

  // Student where admission_number is '9876500001' but phone_number is '9111111111'
  await adminDb.upsertStudent({
    student_name: 'Admit Only Match',
    admission_number: '9876500001',
    phone_number: '9111111111',
    portal_username: '',
    portal_password: '',
    section: 'CSE-B'
  });

  // Call updateStudentCredentialsByPhone with '9876500001' (which matches admission_number, NOT phone_number)
  const result = await adminDb.updateStudentCredentialsByPhone('9876500001', {
    portal_username: 'intruder_user',
    portal_password: 'intruder_pass'
  });

  assert.equal(result, null, 'Must return null and NOT match when admission number matches but phone number differs');

  const student = await adminDb.getStudentByAdmissionNumber('9876500001');
  assert.equal(student.portal_username, null, 'Portal username must remain null');
  assert.equal(student.portal_password, null, 'Portal password must remain null');
});

test('Phone Number Matching Rules - Never matches by student name', async () => {
  const adminDb = new AdminDbService();

  await adminDb.upsertStudent({
    student_name: '9876500002',
    admission_number: 'ADM-9876500002',
    phone_number: '9222222222',
    portal_username: '',
    portal_password: '',
    section: 'CSE-C'
  });

  // Call updateStudentCredentialsByPhone with '9876500002' (which is the student_name)
  const result = await adminDb.updateStudentCredentialsByPhone('9876500002', {
    portal_username: 'name_user',
    portal_password: 'name_pass'
  });

  assert.equal(result, null, 'Must return null and NOT match by student name');

  const student = await adminDb.getStudentByAdmissionNumber('ADM-9876500002');
  assert.equal(student.portal_username, null);
});

test('Phone Number Matching Rules - Zero matches safely handled without inserting student record', async () => {
  const adminDb = new AdminDbService();
  const beforeCount = (await adminDb.getDashboardStats()).totalStudents;

  const result = await adminDb.updateStudentCredentialsByPhone('9990009999', {
    portal_username: 'ghost_user',
    portal_password: 'ghost_pass'
  });

  assert.equal(result, null, 'Must return null when no record matches');

  const afterCount = (await adminDb.getDashboardStats()).totalStudents;
  assert.equal(afterCount, beforeCount, 'Student count must not increase; zero records safely handled');
});

test('Phone Number Matching Rules - Multiple duplicate phone numbers abort with MULTIPLE_RECORDS_MATCH', async () => {
  const adminDb = new AdminDbService();

  // Simulate multiple records with duplicate phone number
  adminDb.memoryStudents.set('ADM-DUP-1', {
    id: 901,
    student_name: 'Twin 1',
    admission_number: 'ADM-DUP-1',
    phone_number: '9555555555',
    portal_username: null,
    portal_password: null
  });

  adminDb.memoryStudents.set('ADM-DUP-2', {
    id: 902,
    student_name: 'Twin 2',
    admission_number: 'ADM-DUP-2',
    phone_number: '9555555555',
    portal_username: null,
    portal_password: null
  });

  await assert.rejects(
    async () => {
      await adminDb.updateStudentCredentialsByPhone('9555555555', {
        portal_username: 'twin_user',
        portal_password: 'twin_pass'
      });
    },
    (err) => {
      assert.equal(err.code, 'MULTIPLE_RECORDS_MATCH');
      return true;
    }
  );

  // Neither twin was modified
  const t1 = await adminDb.getStudentByAdmissionNumber('ADM-DUP-1');
  const t2 = await adminDb.getStudentByAdmissionNumber('ADM-DUP-2');
  assert.equal(t1.portal_username, null);
  assert.equal(t2.portal_password, null);
});

test('Phone Number Matching Rules - Concurrent searches update independent student records by phone', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager();

  await adminDb.upsertStudent({
    student_name: 'Concurrent A',
    admission_number: 'ADM-CONC-A',
    phone_number: '9888811111',
    section: 'CSE-1'
  });

  await adminDb.upsertStudent({
    student_name: 'Concurrent B',
    admission_number: 'ADM-CONC-B',
    phone_number: '9888822222',
    section: 'CSE-2'
  });

  const automationService = new AutomationService({
    sessionManager,
    adminDbService: adminDb,
    mockMode: true,
    mockDelayMs: 10,
    credentialService: {
      fetchCredentials: async (phone) => ({
        success: true,
        username: `user_${phone}`,
        password: `pass_${phone}`,
        studentNumber: phone
      })
    }
  });

  const sessA = sessionManager.createSession('9888811111');
  const sessB = sessionManager.createSession('9888822222');

  await Promise.all([
    automationService.runWorkflow(sessA.sessionId, sessA.sessionToken, '9888811111'),
    automationService.runWorkflow(sessB.sessionId, sessB.sessionToken, '9888822222')
  ]);

  const studentA = await adminDb.getStudentByAdmissionNumber('ADM-CONC-A');
  assert.equal(studentA.portal_username, 'user_9888811111');
  assert.equal(studentA.portal_password, 'pass_9888811111');

  const studentB = await adminDb.getStudentByAdmissionNumber('ADM-CONC-B');
  assert.equal(studentB.portal_username, 'user_9888822222');
  assert.equal(studentB.portal_password, 'pass_9888822222');
});
