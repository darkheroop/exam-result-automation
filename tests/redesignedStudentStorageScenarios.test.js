'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const xlsx = require('xlsx');
const app = require('../src/app');
const { defaultAdminDbService } = require('../src/services/adminDbService');
const { defaultCredentialService } = require('../src/services/credentialService');
const { defaultAutomationService } = require('../src/services/automationService');

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
      req.write(typeof body === 'string' ? body : (Buffer.isBuffer(body) ? body : JSON.stringify(body)));
    }
    req.end();
  });
}

function buildMultipartBody(boundary, filename, fileBuffer) {
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return Buffer.concat([head, fileBuffer, tail]);
}

test('Comprehensive Verification: Scenarios A, B, C, D, and E for Redesigned Student Database Storage', async () => {
  const { server, url } = await startTestServer();
  const prevMockMode = defaultAutomationService.mockMode;
  const prevMockDelay = defaultAutomationService.mockDelayMs;
  defaultAutomationService.mockMode = true;
  defaultAutomationService.mockDelayMs = 10;

  try {
    // Admin login
    const loginRes = await requestJson(`${url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      username: 'inexpert_trifler',
      password: 'om sai 0987654321'
    });
    assert.equal(loginRes.statusCode, 200, 'Admin login must succeed');
    const token = loginRes.data.token;
    const adminHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };

    // =========================================================================
    // TEST A — EXCEL UPLOAD
    // =========================================================================
    // 1. Create an Excel workbook with Student A and Student B (with leading zeros)
    const wb = xlsx.utils.book_new();
    const wsData = [
      ['Student Name', 'Admission Number', 'Phone Number'],
      ['Student A', '2025010077', '8887416471'],
      ['Student B', '0025010078', '9876543210']
    ];
    const ws = xlsx.utils.aoa_to_sheet(wsData);
    xlsx.utils.book_append_sheet(wb, ws, 'CSE-Batch');
    const excelBuffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // 2. Upload Excel via preview & confirm
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const multipartBody = buildMultipartBody(boundary, 'batch_students.xlsx', excelBuffer);

    const previewRes = await requestJson(`${url}/api/admin/upload-preview`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': multipartBody.length
      }
    }, multipartBody);

    assert.equal(previewRes.statusCode, 200, 'Excel preview must succeed');
    assert.equal(previewRes.data.success, true);
    const previewToken = previewRes.data.previewToken;
    assert.ok(previewToken, 'Preview token must be generated');

    const confirmRes = await requestJson(`${url}/api/admin/upload-confirm`, {
      method: 'POST',
      headers: adminHeaders
    }, {
      previewToken
    });

    assert.equal(confirmRes.statusCode, 200, 'Excel confirm must succeed');
    assert.equal(confirmRes.data.success, true);
    const importStats = confirmRes.data.result || confirmRes.data.summary;
    assert.equal(importStats.added, 2, '2 students must be added from Excel');

    // 3. Confirm students appear in admin Student Records page
    const listA = await requestJson(`${url}/api/admin/students?search=2025010077`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(listA.statusCode, 200);
    assert.equal(listA.data.students.length, 1);
    const studentA = listA.data.students[0];
    assert.equal(studentA.student_name, 'Student A');
    assert.equal(studentA.admission_number, '2025010077');
    assert.equal(studentA.phone_number, '8887416471');
    assert.equal(studentA.portal_username, null, 'Portal username must initially be empty/null');
    assert.equal(studentA.portal_password, null, 'Portal password must initially be empty/null');

    // 4. Confirm leading zeros preserved as string for Student B
    const listB = await requestJson(`${url}/api/admin/students?search=0025010078`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(listB.statusCode, 200);
    assert.equal(listB.data.students.length, 1);
    const studentB = listB.data.students[0];
    assert.equal(studentB.student_name, 'Student B');
    assert.equal(studentB.admission_number, '0025010078', 'Leading zero string must be preserved');
    assert.equal(studentB.portal_username, null);
    assert.equal(studentB.portal_password, null);

    const initialTotalCount = (await requestJson(`${url}/api/admin/students`, { method: 'GET', headers: adminHeaders })).data.total;

    // =========================================================================
    // TEST B — PUBLIC SEARCH (MATCHING BY USER-ENTERED PHONE NUMBER)
    // =========================================================================
    // Configure lookup API mock for Student A and B using their phone numbers
    const originalFetch = defaultCredentialService.fetchCredentials;
    let studentAApiCalled = false;
    defaultCredentialService.fetchCredentials = async (phone) => {
      if (phone === '8887416471') {
        studentAApiCalled = true;
        return {
          success: true,
          username: 'studentA_portal',
          password: 'secretA123_pass',
          studentNumber: '8887416471'
        };
      }
      if (phone === '9876543210') {
        return {
          success: true,
          username: 'studentB_portal',
          password: 'secretB456_pass',
          studentNumber: '9876543210'
        };
      }
      return originalFetch.call(defaultCredentialService, phone);
    };

    // Public search for Student A using Student A's phone number
    const searchResA = await requestJson(`${url}/api/automation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      studentNumber: '8887416471'
    });
    assert.ok([200, 202].includes(searchResA.statusCode));
    const sessionAId = searchResA.data.sessionId;
    const sessionAToken = searchResA.data.sessionToken;

    // Poll until complete
    let pollAttempts = 0;
    let sessionAState = null;
    while (pollAttempts < 50) {
      await new Promise(r => setTimeout(r, 100));
      pollAttempts++;
      const poll = await requestJson(`${url}/api/automation/status/${sessionAId}?token=${sessionAToken}`);
      const st = poll.data?.data?.status || poll.data?.session?.status;
      if (st === 'ready' || st === 'error') {
        sessionAState = poll.data?.data || poll.data?.session;
        break;
      }
    }

    assert.ok(sessionAState, 'Public search must finish');
    assert.equal(sessionAState.status, 'ready', 'Result retrieval must succeed');
    assert.equal(studentAApiCalled, true, 'Credential lookup API must be called');

    // Confirm credentials updated in database by matching phone number and no duplicate row was created
    const studentAInDb = await defaultAdminDbService.getStudentByAdmissionNumber('2025010077');
    assert.equal(studentAInDb.id, studentA.id, 'Must update exact existing student row');
    assert.equal(studentAInDb.portal_username, 'studentA_portal');
    assert.equal(studentAInDb.portal_password, 'secretA123_pass');

    const totalAfterSearchA = (await requestJson(`${url}/api/admin/students`, { method: 'GET', headers: adminHeaders })).data.total;
    assert.equal(totalAfterSearchA, initialTotalCount, 'Total student rows must not increase; no duplicate created');

    // =========================================================================
    // TEST C — ADMIN VERIFICATION
    // =========================================================================
    // Open Student Records in admin page
    const adminCheckA = await requestJson(`${url}/api/admin/students?search=2025010077`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(adminCheckA.statusCode, 200);
    const displayedA = adminCheckA.data.students[0];
    assert.equal(displayedA.portal_username, 'studentA_portal', 'Admin table must display updated Portal Username');
    assert.equal(displayedA.portal_password, 'secretA123_pass', 'Admin table must display updated Portal Password');

    // Open Edit Student Record modal (GET /api/admin/students/:id)
    const editModalResA = await requestJson(`${url}/api/admin/students/${studentA.id}`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(editModalResA.statusCode, 200);
    assert.equal(editModalResA.data.student.portal_username, 'studentA_portal', 'Edit dialog must display Portal Username');
    assert.equal(editModalResA.data.student.portal_password, 'secretA123_pass', 'Edit dialog must display Portal Password');

    // Refresh the page (another GET /api/admin/students)
    const refreshedA = await requestJson(`${url}/api/admin/students?search=2025010077`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(refreshedA.data.students[0].portal_username, 'studentA_portal', 'Credentials must remain saved after page refresh');
    assert.equal(refreshedA.data.students[0].portal_password, 'secretA123_pass');

    // =========================================================================
    // TEST D — ISOLATION (MATCHING BY PHONE NUMBER & FAILING SEARCH SAFETY)
    // =========================================================================
    // Search for Student B using Student B's phone number
    const searchResB = await requestJson(`${url}/api/automation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      studentNumber: '9876543210'
    });
    assert.ok([200, 202].includes(searchResB.statusCode));
    let pollCountB = 0;
    while (pollCountB < 50) {
      await new Promise(r => setTimeout(r, 100));
      pollCountB++;
      const pollB = await requestJson(`${url}/api/automation/status/${searchResB.data.sessionId}?token=${searchResB.data.sessionToken}`);
      const st = pollB.data?.data?.status || pollB.data?.session?.status;
      if (st === 'ready' || st === 'error') break;
    }

    const studentBInDb = await defaultAdminDbService.getStudentByAdmissionNumber('0025010078');
    assert.equal(studentBInDb.portal_username, 'studentB_portal', 'Student B credentials must be updated');
    assert.equal(studentBInDb.portal_password, 'secretB456_pass');

    // Confirm Student A credentials remain unchanged
    const studentAStillSafe = await defaultAdminDbService.getStudentByAdmissionNumber('2025010077');
    assert.equal(studentAStillSafe.portal_username, 'studentA_portal', 'Student A credentials must remain untouched');
    assert.equal(studentAStillSafe.portal_password, 'secretA123_pass');

    // Test API failure: configure mock to throw error on Student A search
    defaultCredentialService.fetchCredentials = async () => {
      const err = new Error('Lookup upstream connection failure');
      err.code = 'API_ERROR';
      throw err;
    };

    const failedSearchRes = await requestJson(`${url}/api/automation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      studentNumber: '8887416471'
    });

    let pCountFail = 0;
    while (pCountFail < 30) {
      await new Promise(r => setTimeout(r, 100));
      pCountFail++;
      const pollFail = await requestJson(`${url}/api/automation/status/${failedSearchRes.data.sessionId}?token=${failedSearchRes.data.sessionToken}`);
      const st = pollFail.data?.data?.status || pollFail.data?.session?.status;
      if (st === 'error') break;
    }

    // Confirm failed search does NOT erase previously retrieved credentials
    const studentAAfterFailure = await defaultAdminDbService.getStudentByAdmissionNumber('2025010077');
    assert.equal(studentAAfterFailure.portal_username, 'studentA_portal', 'API failure must never erase stored credentials');
    assert.equal(studentAAfterFailure.portal_password, 'secretA123_pass');

    // =========================================================================
    // TEST E — REGRESSION
    // =========================================================================
    // 1. Upload Excel again (re-import with same admission numbers, new phone/section)
    const wb2 = xlsx.utils.book_new();
    const wsData2 = [
      ['Student Name', 'Admission Number', 'Phone Number'],
      ['Student A Updated', '2025010077', '9991112222'],
      ['Student B Updated', '0025010078', '9993334444']
    ];
    const ws2 = xlsx.utils.aoa_to_sheet(wsData2);
    xlsx.utils.book_append_sheet(wb2, ws2, 'CSE-Batch');
    const buffer2 = xlsx.write(wb2, { type: 'buffer', bookType: 'xlsx' });

    const boundary2 = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const body2 = buildMultipartBody(boundary2, 'batch_reimport.xlsx', buffer2);

    const prev2 = await requestJson(`${url}/api/admin/upload-preview`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary2}`,
        'Content-Length': body2.length
      }
    }, body2);

    assert.equal(prev2.statusCode, 200);
    const confirm2 = await requestJson(`${url}/api/admin/upload-confirm`, {
      method: 'POST',
      headers: adminHeaders
    }, {
      previewToken: prev2.data.previewToken
    });

    assert.equal(confirm2.statusCode, 200);
    const importStats2 = confirm2.data.result || confirm2.data.summary;
    assert.equal(importStats2.updated, 2, '2 students updated on re-import');

    // Confirm saved credentials remain intact after re-import!
    const reimportedA = await defaultAdminDbService.getStudentByAdmissionNumber('2025010077');
    assert.equal(reimportedA.student_name, 'Student A Updated', 'Name updated from Excel re-import');
    assert.equal(reimportedA.phone_number, '9991112222', 'Phone updated from Excel re-import');
    assert.equal(reimportedA.portal_username, 'studentA_portal', 'Saved Portal Username must remain intact after re-import');
    assert.equal(reimportedA.portal_password, 'secretA123_pass', 'Saved Portal Password must remain intact after re-import');

    // 2. Confirm public search logs still exist and work
    const logsRes = await requestJson(`${url}/api/admin/search-logs`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(logsRes.statusCode, 200, 'Search logs endpoint must work');
    assert.ok(logsRes.data.logs.length >= 2, 'Must record search logs for all searches');
    const logA = logsRes.data.logs.find(l => l.admission_number === '8887416471' || l.search_query === '8887416471' || l.admission_number === '2025010077');
    assert.ok(logA, 'Log entry for Student A search must exist');

    // 3. Confirm admin dashboard stats still compute correctly
    const statsRes = await requestJson(`${url}/api/admin/stats`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(statsRes.statusCode, 200, 'Admin stats endpoint must work');
    assert.ok(statsRes.data.stats.totalStudents >= 2);
    assert.ok(statsRes.data.stats.studentsWithUsername >= 2);

    defaultCredentialService.fetchCredentials = originalFetch;
    defaultAutomationService.mockMode = prevMockMode;
    defaultAutomationService.mockDelayMs = prevMockDelay;
  } finally {
    server.close();
  }
});
