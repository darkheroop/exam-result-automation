'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/app');
const { defaultAdminDbService } = require('../src/services/adminDbService');
const { defaultAutomationService } = require('../src/services/automationService');
const { defaultCredentialService } = require('../src/services/credentialService');
const { defaultDbService } = require('../src/services/dbService');

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

test('E2E: Complete 10-Step Workflow — Public Result Search Credentials Saved into Existing Admin Student Records', async () => {
  const { server, url } = await startTestServer();
  const prevMockMode = defaultAutomationService.mockMode;
  const prevMockDelay = defaultAutomationService.mockDelayMs;
  defaultAutomationService.mockMode = true;
  defaultAutomationService.mockDelayMs = 10;

  try {
    // Step 1: Admin logs in to obtain admin session
    const loginRes = await requestJson(`${url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      username: 'inexpert_trifler',
      password: 'om sai 0987654321'
    });

    assert.equal(loginRes.statusCode, 200, 'Admin login must succeed');
    const token = loginRes.data.token;
    assert.ok(token, 'Must receive auth token');

    const adminHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };

    // Step 2: Admin imports/creates student record into existing Student Records table
    // with student name, admission number, phone number and section.
    // Initially, Portal Username and Portal Password are empty.
    const admissionNumber = '9876543210';
    const createStudentRes = await requestJson(`${url}/api/admin/students`, {
      method: 'POST',
      headers: adminHeaders
    }, {
      name: 'Rohan Mehra',
      admission_number: admissionNumber,
      phone_number: '9876543210',
      section: 'IT-A',
      username: '',
      password: ''
    });

    assert.equal(createStudentRes.statusCode, 201, 'Student creation must succeed');
    const createdStudent = createStudentRes.data.student;
    const studentDbId = createdStudent.id;
    assert.ok(studentDbId, 'Created student must have a valid DB id');
    assert.equal(createdStudent.admission_number, admissionNumber);
    assert.equal(createdStudent.username, '', 'Portal username initially empty');
    assert.equal(createdStudent.password, '', 'Portal password initially empty');

    // Verify initial student list in Admin Dashboard
    const initialListRes = await requestJson(`${url}/api/admin/students?search=${admissionNumber}`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(initialListRes.statusCode, 200);
    assert.equal(initialListRes.data.students.length, 1);
    assert.equal(initialListRes.data.students[0].username, '');
    assert.equal(initialListRes.data.students[0].password, '');
    const initialTotalCount = initialListRes.data.total;

    // Step 3-5: Configure mock credential lookup API for this admission number
    const originalFetchCredentials = defaultCredentialService.fetchCredentials;
    let credentialApiCallCount = 0;
    defaultCredentialService.fetchCredentials = async (num) => {
      if (num === admissionNumber) {
        credentialApiCallCount++;
        return {
          success: true,
          username: 'rohan_portal_user',
          password: 'rohan_portal_password_secret',
          studentNumber: admissionNumber
        };
      }
      return originalFetchCredentials.call(defaultCredentialService, num);
    };

    // Step 4: Normal user visits the public result-search page and searches for examination result
    // (Sends public POST /api/automation/start with their admission number)
    const publicSearchRes = await requestJson(`${url}/api/automation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      studentNumber: admissionNumber
    });

    assert.ok([200, 202].includes(publicSearchRes.statusCode), 'Public search submission must accept admission number');
    assert.equal(publicSearchRes.data.success, true);
    const { sessionId, sessionToken } = publicSearchRes.data;

    // Wait for the asynchronous public search workflow to complete
    let pollAttempts = 0;
    let finishedState = null;
    while (pollAttempts < 50) {
      await new Promise(r => setTimeout(r, 100));
      pollAttempts++;
      const pollRes = await requestJson(`${url}/api/automation/status/${sessionId}?token=${sessionToken}`);
      const sessionState = pollRes.data?.data || pollRes.data?.session;
      if (pollRes.statusCode === 200 && sessionState) {
        const status = sessionState.status;
        if (status === 'ready' || status === 'error') {
          finishedState = sessionState;
          break;
        }
      }
    }

    assert.ok(finishedState, 'Public search workflow must reach a finished state');
    assert.equal(finishedState.status, 'ready', 'Public search must successfully retrieve result');
    assert.equal(credentialApiCallCount, 1, 'Credential lookup API must have been called exactly once during public search');

    // Step 7 & 8: Verify the credentials were automatically saved into the student's EXISTING Neon database record
    // matching admission_number
    const studentInDb = await defaultAdminDbService.getStudentByAdmissionNumber(admissionNumber);
    assert.ok(studentInDb, 'Student must exist in database');
    assert.equal(studentInDb.id, studentDbId, 'Must update the exact same student record without creating a new row');
    assert.equal(studentInDb.admission_number, admissionNumber);
    assert.equal(studentInDb.username, 'rohan_portal_user', 'Portal Username must be automatically saved from API response');
    assert.equal(studentInDb.password, 'rohan_portal_password_secret', 'Portal Password must be automatically saved from API response');
    assert.equal(studentInDb.name, 'Rohan Mehra', 'Student name must remain intact');
    assert.equal(studentInDb.section, 'IT-A', 'Student section must remain intact');

    // Step 10: When admin opens Student Records and views or refreshes the page:
    // GET /api/admin/students displays the automatically saved credentials
    const refreshedListRes = await requestJson(`${url}/api/admin/students?search=${admissionNumber}`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(refreshedListRes.statusCode, 200);
    const displayedStudent = refreshedListRes.data.students.find(s => s.admission_number === admissionNumber);
    assert.ok(displayedStudent, 'Student must be returned in admin table');
    assert.equal(displayedStudent.username, 'rohan_portal_user', 'Admin table must display the saved Portal Username');
    assert.equal(displayedStudent.password, 'rohan_portal_password_secret', 'Admin table must display the saved Portal Password');
    assert.equal(refreshedListRes.data.total, initialTotalCount, 'Total student count must NOT have increased (no duplicates)');

    // Step 10 (cont.): Admin opens edit modal for this student (GET /api/admin/students/:id)
    const getSingleRes = await requestJson(`${url}/api/admin/students/${studentDbId}`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(getSingleRes.statusCode, 200);
    assert.equal(getSingleRes.data.student.username, 'rohan_portal_user', 'Edit modal data must show saved Portal Username');
    assert.equal(getSingleRes.data.student.password, 'rohan_portal_password_secret', 'Edit modal data must show saved Portal Password');

    // Step 11: Admin updates student section to IT-B while leaving password field blank
    // Credentials must be protected from being overwritten or erased
    const updateRes = await requestJson(`${url}/api/admin/students/${studentDbId}`, {
      method: 'PUT',
      headers: adminHeaders
    }, {
      name: 'Rohan Mehra',
      admission_number: admissionNumber,
      phone_number: '9876543210',
      section: 'IT-B',
      username: '', // Leaving blank in form
      password: ''  // Leaving blank in form
    });

    assert.equal(updateRes.statusCode, 200, 'Admin update must succeed');
    assert.equal(updateRes.data.student.section, 'IT-B', 'Section must be updated');
    assert.equal(updateRes.data.student.username, 'rohan_portal_user', 'Portal Username must NOT be erased');
    assert.equal(updateRes.data.student.password, 'rohan_portal_password_secret', 'Portal Password must NOT be erased');

    // Step 12: Verify that public search for a non-existent student does NOT insert any record into managed_students
    const nonExistentNumber = '9998887776';
    const nonExistentSearchRes = await requestJson(`${url}/api/automation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      studentNumber: nonExistentNumber
    });

    // Wait for the non-existent workflow to fail
    if (nonExistentSearchRes.data && nonExistentSearchRes.data.sessionId) {
      let pCount = 0;
      while (pCount < 20) {
        await new Promise(r => setTimeout(r, 50));
        pCount++;
        const pRes = await requestJson(`${url}/api/automation/status/${nonExistentSearchRes.data.sessionId}?token=${nonExistentSearchRes.data.sessionToken}`);
        const st = pRes.data?.data?.status || pRes.data?.session?.status;
        if (st === 'error') break;
      }
    }

    const nonExistentCheck = await defaultAdminDbService.getStudentByAdmissionNumber(nonExistentNumber);
    assert.equal(nonExistentCheck, null, 'Public search for unknown student must never insert a student record into Neon database');

    // Restore original method
    defaultCredentialService.fetchCredentials = originalFetchCredentials;
    defaultAutomationService.mockMode = prevMockMode;
    defaultAutomationService.mockDelayMs = prevMockDelay;

  } finally {
    server.close();
  }
});

test('E2E: Cached Marksheet with Missing Student Record Credentials Fetches and Saves Credentials', async () => {
  const { server, url } = await startTestServer();

  try {
    const loginRes = await requestJson(`${url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      username: 'inexpert_trifler',
      password: 'om sai 0987654321'
    });
    const token = loginRes.data.token;
    const adminHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };

    // 1. Create a student with NO credentials
    const adm = '9123456780';
    await requestJson(`${url}/api/admin/students`, {
      method: 'POST',
      headers: adminHeaders
    }, {
      name: 'Pre-cached Student',
      admission_number: adm,
      phone_number: adm,
      section: 'ME-1',
      username: '',
      password: ''
    });

    // 2. Pre-seed a cached marksheet in dbService
    await defaultDbService.setCachedResult(adm, {
      student: { name: 'Pre-cached Student', studentNumber: adm, ygpa: '8.50', status: 'PASS' },
      annualSummary: { status: 'PASS', ygpa: '8.50' },
      semesters: []
    });

    // 3. Mock credential lookup API
    const originalFetch = defaultCredentialService.fetchCredentials;
    let fetchCalled = false;
    defaultCredentialService.fetchCredentials = async (num) => {
      if (num === adm) {
        fetchCalled = true;
        return {
          success: true,
          username: 'cached_stud_user',
          password: 'cached_stud_pass',
          studentNumber: adm
        };
      }
      return originalFetch.call(defaultCredentialService, num);
    };

    // 4. Public search is performed
    const publicRes = await requestJson(`${url}/api/automation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      studentNumber: adm
    });
    assert.ok([200, 202].includes(publicRes.statusCode));

    const { sessionId, sessionToken } = publicRes.data;
    let pollCount = 0;
    while (pollCount < 40) {
      await new Promise(r => setTimeout(r, 100));
      pollCount++;
      const poll = await requestJson(`${url}/api/automation/status/${sessionId}?token=${sessionToken}`);
      const st = poll.data?.data?.status || poll.data?.session?.status;
      if (st === 'ready' || st === 'error') break;
    }

    assert.equal(fetchCalled, true, 'Lookup API must be called even if marksheet was cached because student credentials were missing');

    // 5. Verify credentials were saved to student record
    const updated = await defaultAdminDbService.getStudentByAdmissionNumber(adm);
    assert.equal(updated.username, 'cached_stud_user');
    assert.equal(updated.password, 'cached_stud_pass');

    defaultCredentialService.fetchCredentials = originalFetch;
  } finally {
    server.close();
  }
});
