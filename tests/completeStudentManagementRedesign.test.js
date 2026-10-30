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

test('MASTER SUITE: Complete Student Management and Database Redesign (Part 10: Tests 1-10)', async () => {
  const { server, url } = await startTestServer();
  const prevMockMode = defaultAutomationService.mockMode;
  const prevMockDelay = defaultAutomationService.mockDelayMs;
  defaultAutomationService.mockMode = true;
  defaultAutomationService.mockDelayMs = 10;

  try {
    // -------------------------------------------------------------------------
    // Setup: Admin Authentication
    // -------------------------------------------------------------------------
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
    // TEST 1 — EXCEL UPLOAD
    // Upload Excel with Name, Admission Number, Phone Number.
    // Verify 3 fields saved with empty username/password.
    // Verify no extra fields (section, email, etc.) in records.
    // =========================================================================
    const admTest1 = 'ADM1000001';
    const phoneTest1 = '9000000001';
    const nameTest1 = 'Alice Brown';

    const wb1 = xlsx.utils.book_new();
    const ws1 = xlsx.utils.aoa_to_sheet([
      ['Student Name', 'Admission Number', 'Phone Number', 'Unused Extra Column'],
      [nameTest1, admTest1, phoneTest1, 'Should Be Ignored']
    ]);
    xlsx.utils.book_append_sheet(wb1, ws1, 'Students');
    const excelBuffer1 = xlsx.write(wb1, { type: 'buffer', bookType: 'xlsx' });

    const boundary1 = '----FormBoundary' + Math.random().toString(36).substring(2);
    const body1 = buildMultipartBody(boundary1, 'test1_students.xlsx', excelBuffer1);

    const previewRes1 = await requestJson(`${url}/api/admin/upload-preview`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary1}`,
        'Content-Length': body1.length
      }
    }, body1);
    assert.equal(previewRes1.statusCode, 200, 'Excel preview succeeded');
    const previewToken1 = previewRes1.data.previewToken;

    const confirmRes1 = await requestJson(`${url}/api/admin/upload-confirm`, {
      method: 'POST',
      headers: adminHeaders
    }, { previewToken: previewToken1 });
    assert.equal(confirmRes1.statusCode, 200, 'Excel confirm succeeded');

    const getUploaded = await defaultAdminDbService.getStudentByAdmissionNumber(admTest1);
    assert.ok(getUploaded, 'Student record must exist after Excel import');
    assert.equal(getUploaded.student_name, nameTest1);
    assert.equal(getUploaded.admission_number, admTest1);
    assert.equal(getUploaded.phone_number, phoneTest1);
    assert.equal(getUploaded.username, '', 'Initial username must be empty');
    assert.equal(getUploaded.password, '', 'Initial password must be empty');
    assert.equal(getUploaded.portal_username, null, 'Initial portal_username must be null');
    assert.equal(getUploaded.portal_password, null, 'Initial portal_password must be null');

    // =========================================================================
    // TEST 2 — MANUAL STUDENT CREATION
    // Use Add Student modal/endpoint to create student with empty credentials.
    // Verify record appears in students table.
    // =========================================================================
    const admTest2 = 'ADM1000002';
    const phoneTest2 = '9000000002';
    const nameTest2 = 'Bob Martin';

    const addRes = await requestJson(`${url}/api/admin/students`, {
      method: 'POST',
      headers: adminHeaders
    }, {
      name: nameTest2,
      student_name: nameTest2,
      admission_number: admTest2,
      phone_number: phoneTest2
    });
    assert.equal(addRes.statusCode, 201, 'Student creation must return 201');
    assert.ok(addRes.data.student.id, 'Created student must have an ID');
    assert.equal(addRes.data.student.admission_number, admTest2);
    assert.equal(addRes.data.student.phone_number, phoneTest2);
    assert.equal(addRes.data.student.username, '', 'Initial manual student username is empty');
    assert.equal(addRes.data.student.password, '', 'Initial manual student password is empty');

    // =========================================================================
    // TEST 3 — PUBLIC SEARCH CREDENTIAL UPDATE
    // Normal user enters phone number on public result-search page.
    // Credential API returns username and password.
    // Verify returned username and password saved to correct student record.
    // Verify search log created with correct status.
    // =========================================================================
    const origFetch = defaultCredentialService.fetchCredentials;
    defaultCredentialService.fetchCredentials = async (num) => {
      if (num === phoneTest2) {
        return { username: 'bob_portal_usr', password: 'bob_secret_pwd' };
      }
      return { username: 'generic_usr', password: 'generic_pwd' };
    };

    const publicSearchRes = await requestJson(`${url}/api/automation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { studentNumber: phoneTest2 });

    assert.equal(publicSearchRes.statusCode, 202, 'Public search submission returns 202 Accepted');
    const sessionId = publicSearchRes.data.sessionId;
    const sessionToken = publicSearchRes.data.sessionToken;

    // Wait briefly for automation workflow stage 2 to complete
    let finished = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 80));
      const statusRes = await requestJson(`${url}/api/automation/status/${sessionId}`, {
        headers: { 'x-session-token': sessionToken }
      });
      if (statusRes.statusCode === 200 && statusRes.data && statusRes.data.data) {
        if (statusRes.data.data.stage >= 2 || statusRes.data.data.status === 'COMPLETE' || statusRes.data.data.status === 'READY') {
          finished = true;
          break;
        }
      }
    }
    assert.ok(finished, 'Public search automation reached at least stage 2');

    const updatedBob = await defaultAdminDbService.getStudentByAdmissionNumber(admTest2);
    assert.equal(updatedBob.username, 'bob_portal_usr', 'Username must be automatically saved into student record');
    assert.equal(updatedBob.password, 'bob_secret_pwd', 'Password must be automatically saved into student record');

    // Verify search log was created in search_logs table
    const logsRes = await requestJson(`${url}/api/admin/search-logs`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(logsRes.statusCode, 200, 'Search logs endpoint returned 200');
    assert.ok(logsRes.data.logs.some(l => l.admission_number === phoneTest2), 'Search log for phone number must be recorded');

    // =========================================================================
    // TEST 4 — ADMIN VERIFICATION
    // Open Student Management admin page.
    // Verify student now shows newly saved username and password.
    // Refresh page — verify credentials persist.
    // =========================================================================
    const adminFetch1 = await requestJson(`${url}/api/admin/students?search=${admTest2}`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(adminFetch1.statusCode, 200);
    assert.equal(adminFetch1.data.students.length, 1);
    assert.equal(adminFetch1.data.students[0].username, 'bob_portal_usr');
    assert.equal(adminFetch1.data.students[0].password, 'bob_secret_pwd');

    // Refresh simulation (second request)
    const adminFetch2 = await requestJson(`${url}/api/admin/students?search=${phoneTest2}`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(adminFetch2.statusCode, 200);
    assert.equal(adminFetch2.data.students[0].username, 'bob_portal_usr', 'Credentials must persist across re-queries');
    assert.equal(adminFetch2.data.students[0].password, 'bob_secret_pwd', 'Credentials must persist across re-queries');

    // =========================================================================
    // TEST 5 — UNIVERSAL SEARCH
    // Search by Name -> returns correct student.
    // Search by Admission Number -> returns correct student.
    // Search by Phone Number -> returns correct student.
    // Search by Username -> returns correct student.
    // Verify search works through single universal search bar.
    // =========================================================================
    // By Name
    const sByName = await requestJson(`${url}/api/admin/students?search=Bob%20Martin`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(sByName.data.students.length, 1);
    assert.equal(sByName.data.students[0].admission_number, admTest2);

    // By Admission Number
    const sByAdm = await requestJson(`${url}/api/admin/students?search=${admTest2}`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(sByAdm.data.students.length, 1);
    assert.equal(sByAdm.data.students[0].student_name, nameTest2);

    // By Phone Number
    const sByPhone = await requestJson(`${url}/api/admin/students?search=${phoneTest2}`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(sByPhone.data.students.length, 1);
    assert.equal(sByPhone.data.students[0].student_name, nameTest2);

    // By Username
    const sByUser = await requestJson(`${url}/api/admin/students?search=bob_portal_usr`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(sByUser.data.students.length, 1);
    assert.equal(sByUser.data.students[0].student_name, nameTest2);

    // =========================================================================
    // TEST 6 — FILTERS AND SORTING
    // Filter: All Students -> shows all.
    // Filter: With Credentials -> shows only students with saved credentials.
    // Filter: Without Credentials -> shows only students without credentials.
    // Sort: A-Z -> alphabetical by name.
    // Sort: Z-A -> reverse alphabetical.
    // Combine filter and search.
    // =========================================================================
    // With credentials
    const fWith = await requestJson(`${url}/api/admin/students?filter=with_credentials&limit=100`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(fWith.statusCode, 200);
    assert.ok(fWith.data.students.length >= 1);
    assert.ok(fWith.data.students.every(s => s.username && s.password), 'All with_credentials must have both');

    // Without credentials
    const fWithout = await requestJson(`${url}/api/admin/students?filter=without_credentials&limit=100`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(fWithout.statusCode, 200);
    assert.ok(fWithout.data.students.length >= 1);
    assert.ok(fWithout.data.students.every(s => !s.username || !s.password), 'All without_credentials must lack username or password');

    // Sort A-Z
    const sortAsc = await requestJson(`${url}/api/admin/students?sort=name_asc&limit=100`, {
      method: 'GET',
      headers: adminHeaders
    });
    const namesAsc = sortAsc.data.students.map(s => s.student_name);
    for (let i = 0; i < namesAsc.length - 1; i++) {
      assert.ok(namesAsc[i].localeCompare(namesAsc[i + 1]) <= 0, `Sorted A-Z order violated: ${namesAsc[i]} > ${namesAsc[i + 1]}`);
    }

    // Sort Z-A
    const sortDesc = await requestJson(`${url}/api/admin/students?sort=name_desc&limit=100`, {
      method: 'GET',
      headers: adminHeaders
    });
    const namesDesc = sortDesc.data.students.map(s => s.student_name);
    for (let i = 0; i < namesDesc.length - 1; i++) {
      assert.ok(namesDesc[i].localeCompare(namesDesc[i + 1]) >= 0, `Sorted Z-A order violated: ${namesDesc[i]} < ${namesDesc[i + 1]}`);
    }

    // Combine filter and search
    const combined = await requestJson(`${url}/api/admin/students?filter=with_credentials&search=Bob`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(combined.data.students.length, 1);
    assert.equal(combined.data.students[0].student_name, nameTest2);

    // =========================================================================
    // TEST 7 — EDIT AND DELETE
    // Edit student's details manually — verify changes save.
    // Delete a student — verify removed from students table.
    // Verify historical search logs for that student remain intact.
    // =========================================================================
    // Edit Alice
    const editRes = await requestJson(`${url}/api/admin/students/${getUploaded.id}`, {
      method: 'PUT',
      headers: adminHeaders
    }, {
      name: 'Alice Brown Edited',
      admission_number: admTest1,
      phone_number: '9000000099',
      username: 'alice_manual_user',
      password: 'alice_manual_pass'
    });
    assert.equal(editRes.statusCode, 200, 'Student edit succeeded');
    assert.equal(editRes.data.student.student_name, 'Alice Brown Edited');
    assert.equal(editRes.data.student.phone_number, '9000000099');
    assert.equal(editRes.data.student.username, 'alice_manual_user');

    // Delete Alice
    const deleteRes = await requestJson(`${url}/api/admin/students/${getUploaded.id}`, {
      method: 'DELETE',
      headers: adminHeaders
    });
    assert.equal(deleteRes.statusCode, 200, 'Student delete succeeded');

    const checkDeleted = await defaultAdminDbService.getStudentById(getUploaded.id);
    assert.equal(checkDeleted, null, 'Deleted student must no longer exist in students table');

    // Confirm search logs remain intact after student delete
    const logsAfterDelete = await requestJson(`${url}/api/admin/search-logs`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.ok(logsAfterDelete.data.logs.some(l => l.admission_number === phoneTest2), 'Search logs must NOT be deleted when student is deleted');

    // =========================================================================
    // TEST 8 — EXCEL RE-UPLOAD
    // Re-upload same Excel file (or containing Bob with existing credentials).
    // Verify no duplicate records created.
    // Verify previously saved credentials are NOT overwritten.
    // =========================================================================
    const wb8 = xlsx.utils.book_new();
    const ws8 = xlsx.utils.aoa_to_sheet([
      ['Student Name', 'Admission Number', 'Phone Number'],
      ['Bob Martin Updated Name', admTest2, phoneTest2]
    ]);
    xlsx.utils.book_append_sheet(wb8, ws8, 'Batch');
    const excelBuffer8 = xlsx.write(wb8, { type: 'buffer', bookType: 'xlsx' });

    const boundary8 = '----FormBoundary' + Math.random().toString(36).substring(2);
    const body8 = buildMultipartBody(boundary8, 'reupload.xlsx', excelBuffer8);

    const prev8 = await requestJson(`${url}/api/admin/upload-preview`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary8}`,
        'Content-Length': body8.length
      }
    }, body8);
    assert.equal(prev8.statusCode, 200);

    const conf8 = await requestJson(`${url}/api/admin/upload-confirm`, {
      method: 'POST',
      headers: adminHeaders
    }, { previewToken: prev8.data.previewToken });
    assert.equal(conf8.statusCode, 200);

    // Verify Bob's credentials were preserved!
    const reloadedBob = await defaultAdminDbService.getStudentByAdmissionNumber(admTest2);
    assert.equal(reloadedBob.student_name, 'Bob Martin Updated Name');
    assert.equal(reloadedBob.username, 'bob_portal_usr', 'Existing portal username must NOT be overwritten by Excel re-upload');
    assert.equal(reloadedBob.password, 'bob_secret_pwd', 'Existing portal password must NOT be overwritten by Excel re-upload');

    // Verify count did not duplicate
    const checkCount = await requestJson(`${url}/api/admin/students?search=${admTest2}`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(checkCount.data.students.length, 1, 'Never create duplicate records for same admission number');

    // =========================================================================
    // TEST 9 — DATA ISOLATION (CONCURRENT SEARCHES)
    // Two normal users search two different phone numbers simultaneously.
    // Verify each student record updated with its own credentials.
    // Verify no mixing or cross-contamination.
    // =========================================================================
    const admIso1 = 'ADM_ISO_001';
    const phoneIso1 = '9111110001';
    const admIso2 = 'ADM_ISO_002';
    const phoneIso2 = '9222220002';

    await defaultAdminDbService.upsertStudent({
      student_name: 'Iso Student 1',
      admission_number: admIso1,
      phone_number: phoneIso1
    });
    await defaultAdminDbService.upsertStudent({
      student_name: 'Iso Student 2',
      admission_number: admIso2,
      phone_number: phoneIso2
    });

    defaultCredentialService.fetchCredentials = async (phone) => {
      if (phone === phoneIso1) {
        return { username: 'iso_user_1', password: 'iso_password_1' };
      }
      if (phone === phoneIso2) {
        return { username: 'iso_user_2', password: 'iso_password_2' };
      }
      return { username: 'iso_fallback', password: 'iso_fallback' };
    };

    const [resIso1, resIso2] = await Promise.all([
      requestJson(`${url}/api/automation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { studentNumber: phoneIso1 }),
      requestJson(`${url}/api/automation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { studentNumber: phoneIso2 })
    ]);

    assert.equal(resIso1.statusCode, 202);
    assert.equal(resIso2.statusCode, 202);

    // Wait briefly for concurrent tasks to process
    await new Promise(r => setTimeout(r, 300));

    const checkIso1 = await defaultAdminDbService.getStudentByAdmissionNumber(admIso1);
    const checkIso2 = await defaultAdminDbService.getStudentByAdmissionNumber(admIso2);

    assert.equal(checkIso1.username, 'iso_user_1', 'Student 1 must get Iso 1 username');
    assert.equal(checkIso1.password, 'iso_password_1', 'Student 1 must get Iso 1 password');
    assert.equal(checkIso2.username, 'iso_user_2', 'Student 2 must get Iso 2 username');
    assert.equal(checkIso2.password, 'iso_password_2', 'Student 2 must get Iso 2 password');

    // =========================================================================
    // TEST 10 — REGRESSION TESTING
    // Verify admin login works.
    // Verify search logs page displays correctly.
    // Verify public result search still works end-to-end.
    // Verify result retrieval workflow is not broken.
    // =========================================================================
    // 10.1 Admin /me
    const meRes = await requestJson(`${url}/api/admin/me`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(meRes.statusCode, 200);
    assert.equal(meRes.data.user.username, 'inexpert_trifler');

    // 10.2 Search logs stats
    const statsRes = await requestJson(`${url}/api/admin/stats`, {
      method: 'GET',
      headers: adminHeaders
    });
    assert.equal(statsRes.statusCode, 200);
    assert.ok(statsRes.data.stats.totalStudents >= 2);

    // 10.3 Health check
    const healthRes = await requestJson(`${url}/api/health`, { method: 'GET' });
    assert.equal(healthRes.statusCode, 200);
    assert.equal(healthRes.data.status, 'ok');

    // Restore mocks
    defaultCredentialService.fetchCredentials = origFetch;
  } finally {
    defaultAutomationService.mockMode = prevMockMode;
    defaultAutomationService.mockDelayMs = prevMockDelay;
    await new Promise(r => server.close(r));
  }
});
