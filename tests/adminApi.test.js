'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const xlsx = require('xlsx');
const app = require('../src/app');

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
      if (Buffer.isBuffer(body)) {
        req.write(body);
      } else if (typeof body === 'string') {
        req.write(body);
      } else {
        req.setHeader('Content-Type', 'application/json');
        req.write(JSON.stringify(body));
      }
    }
    req.end();
  });
}

function buildMultipartBody(boundary, filename, fileBuffer) {
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return Buffer.concat([prefix, fileBuffer, suffix]);
}

test('Admin API - Authentication Flow (Login, /me, Logout)', async () => {
  const { server, url } = await startTestServer();
  try {
    // 1. Unauthenticated /api/admin/me returns 401
    const unauthRes = await requestJson(`${url}/api/admin/me`);
    assert.equal(unauthRes.statusCode, 401);
    assert.equal(unauthRes.data.success, false);

    // 2. Failed login with wrong password
    const failLogin = await requestJson(`${url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'inexpert_trifler', password: 'wrong_password' });
    assert.equal(failLogin.statusCode, 401);
    assert.equal(failLogin.data.success, false);

    // 3. Successful login
    const loginRes = await requestJson(`${url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'inexpert_trifler', password: 'om sai 0987654321' });

    assert.equal(loginRes.statusCode, 200);
    assert.equal(loginRes.data.success, true);
    assert.ok(loginRes.data.token);
    assert.equal(loginRes.data.user.username, 'inexpert_trifler');

    // Cookie set
    const setCookie = loginRes.headers['set-cookie'];
    assert.ok(setCookie);
    assert.ok(setCookie[0].includes('admin_token='));

    const adminToken = loginRes.data.token;

    // 4. Authenticated /api/admin/me using Bearer token
    const meRes = await requestJson(`${url}/api/admin/me`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.equal(meRes.statusCode, 200);
    assert.equal(meRes.data.success, true);
    assert.equal(meRes.data.user.username, 'inexpert_trifler');

    // 5. Logout
    const logoutRes = await requestJson(`${url}/api/admin/logout`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.equal(logoutRes.statusCode, 200);
    assert.equal(logoutRes.data.success, true);

    // 6. Access after logout returns 401
    const meAfterLogout = await requestJson(`${url}/api/admin/me`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.equal(meAfterLogout.statusCode, 401);
  } finally {
    server.close();
  }
});

test('Admin API - Student CRUD & Dashboard Stats', async () => {
  const { server, url } = await startTestServer();
  try {
    // Login to obtain token
    const loginRes = await requestJson(`${url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'inexpert_trifler', password: 'om sai 0987654321' });
    const token = loginRes.data.token;
    const authHeaders = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    // 1. Create student
    const createRes = await requestJson(`${url}/api/admin/students`, {
      method: 'POST',
      headers: authHeaders
    }, {
      name: 'Vikas Gupta',
      admission_number: 'ADM_CRUD_01',
      phone_number: '9888877777',
      username: 'vikas_g',
      password: 'secret_password_vg',
      section: 'IT-A'
    });
    assert.equal(createRes.statusCode, 201);
    assert.equal(createRes.data.student.name, 'Vikas Gupta');
    const studentId = createRes.data.student.id;

    // 2. Get Student by ID
    const getRes = await requestJson(`${url}/api/admin/students/${studentId}`, {
      headers: authHeaders
    });
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.data.student.name, 'Vikas Gupta');
    assert.equal(getRes.data.student.username, 'vikas_g');

    // 3. Update student (omitting password preserves it)
    const updateRes = await requestJson(`${url}/api/admin/students/${studentId}`, {
      method: 'PUT',
      headers: authHeaders
    }, {
      name: 'Vikas Gupta Modified',
      section: 'IT-B'
    });
    assert.equal(updateRes.statusCode, 200);
    assert.equal(updateRes.data.student.name, 'Vikas Gupta Modified');
    assert.equal(updateRes.data.student.section, 'IT-B');
    assert.equal(updateRes.data.student.username, 'vikas_g');
    assert.equal(updateRes.data.student.password, 'secret_password_vg'); // Preserved!

    // 4. List students
    const listRes = await requestJson(`${url}/api/admin/students?search=Vikas`, {
      headers: authHeaders
    });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.data.students.length, 1);
    assert.equal(listRes.data.students[0].admission_number, 'ADM_CRUD_01');

    // 5. Dashboard Stats
    const statsRes = await requestJson(`${url}/api/admin/stats`, {
      headers: authHeaders
    });
    assert.equal(statsRes.statusCode, 200);
    assert.ok(statsRes.data.stats.totalStudents >= 1);
    assert.ok(statsRes.data.stats.studentsWithUsername >= 1);

    // 6. Delete Student
    const delRes = await requestJson(`${url}/api/admin/students/${studentId}`, {
      method: 'DELETE',
      headers: authHeaders
    });
    assert.equal(delRes.statusCode, 200);
    assert.equal(delRes.data.success, true);

    // Verify deleted
    const getDeleted = await requestJson(`${url}/api/admin/students/${studentId}`, {
      headers: authHeaders
    });
    assert.equal(getDeleted.statusCode, 404);
  } finally {
    server.close();
  }
});

test('Admin API - Excel Upload Preview & Confirmation Two-Step Workflow', async () => {
  const { server, url } = await startTestServer();
  try {
    // Admin login
    const loginRes = await requestJson(`${url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'inexpert_trifler', password: 'om sai 0987654321' });
    const token = loginRes.data.token;

    // Create an in-memory Excel workbook with 2 sheets
    const wb = xlsx.utils.book_new();
    const ws1Data = [
      ['Student Name', 'Admission No', 'Phone No'],
      ['Priya Sharma', '2023CS010', '9811111110'],
      ['Rahul Verma', '2023CS020', '9811111120']
    ];
    const ws1 = xlsx.utils.aoa_to_sheet(ws1Data);
    xlsx.utils.book_append_sheet(wb, ws1, 'CS-1');

    const ws2Data = [
      ['Candidate Name', 'Adm No', 'Mobile'],
      ['Sameer Khan', '2023CS030', '9811111130']
    ];
    const ws2 = xlsx.utils.aoa_to_sheet(ws2Data);
    xlsx.utils.book_append_sheet(wb, ws2, 'CS-2');

    const excelBuffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // Step 1: POST /api/admin/upload-preview
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const multipartBody = buildMultipartBody(boundary, 'students_batch.xlsx', excelBuffer);

    const previewRes = await requestJson(`${url}/api/admin/upload-preview`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': multipartBody.length
      }
    }, multipartBody);

    assert.equal(previewRes.statusCode, 200);
    assert.equal(previewRes.data.success, true);
    assert.ok(previewRes.data.previewToken);
    assert.equal(previewRes.data.summary.validRecordsCount, 3);
    assert.equal(previewRes.data.summary.sectionsFound.length, 2);

    const previewToken = previewRes.data.previewToken;

    // Step 2: POST /api/admin/upload-confirm
    const confirmRes = await requestJson(`${url}/api/admin/upload-confirm`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }, { previewToken });

    assert.equal(confirmRes.statusCode, 200);
    assert.equal(confirmRes.data.success, true);
    assert.equal(confirmRes.data.result.added, 3);

    // Verify imported records exist in list
    const listRes = await requestJson(`${url}/api/admin/students?search=2023CS010`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.data.students.length, 1);
    assert.equal(listRes.data.students[0].name, 'Priya Sharma');
    assert.equal(listRes.data.students[0].section, 'CS-1');

    // Confirming again with same previewToken fails with 410 (already consumed)
    const secondConfirm = await requestJson(`${url}/api/admin/upload-confirm`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }, { previewToken });
    assert.equal(secondConfirm.statusCode, 410);
  } finally {
    server.close();
  }
});

test('Admin API - Excel Upload accepts .xlxs extension variation', async () => {
  const { server, url } = await startTestServer();
  try {
    const loginRes = await requestJson(`${url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'inexpert_trifler', password: 'om sai 0987654321' });
    const token = loginRes.data.token;

    const wb = xlsx.utils.book_new();
    const wsData = [
      ['Name', 'Admission No', 'Phone'],
      ['Rahul Verma', '2024XLXS01', '9811119999']
    ];
    const ws = xlsx.utils.aoa_to_sheet(wsData);
    xlsx.utils.book_append_sheet(wb, ws, 'Section A');
    const excelBuffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // Filename ending with .xlxs
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const multipartBody = buildMultipartBody(boundary, 'students_list.xlxs', excelBuffer);

    const previewRes = await requestJson(`${url}/api/admin/upload-preview`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': multipartBody.length
      }
    }, multipartBody);

    assert.equal(previewRes.statusCode, 200);
    assert.equal(previewRes.data.success, true);
    assert.ok(previewRes.data.previewToken);
    assert.equal(previewRes.data.summary.validRecordsCount, 1);
  } finally {
    server.close();
  }
});

test('Admin API - Excel Upload accepts JSON Base64 payload', async () => {
  const { server, url } = await startTestServer();
  try {
    const loginRes = await requestJson(`${url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'inexpert_trifler', password: 'om sai 0987654321' });
    const token = loginRes.data.token;

    const wb = xlsx.utils.book_new();
    const wsData = [
      ['Student Name', 'Admission No', 'Student Mob.'],
      ['B64 Student', '2025B64001', '9899123456']
    ];
    const ws = xlsx.utils.aoa_to_sheet(wsData);
    xlsx.utils.book_append_sheet(wb, ws, 'CSE-11');
    const base64Data = xlsx.write(wb, { type: 'base64', bookType: 'xlsx' });

    const previewRes = await requestJson(`${url}/api/admin/upload-preview`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }, {
      filename: 'base64_upload.xlsx',
      fileBase64: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${base64Data}`
    });

    assert.equal(previewRes.statusCode, 200);
    assert.equal(previewRes.data.success, true);
    assert.ok(previewRes.data.previewToken);
    assert.equal(previewRes.data.summary.validRecordsCount, 1);
    assert.equal(previewRes.data.sample[0].name, 'B64 Student');
    assert.equal(previewRes.data.sample[0].admission_number, '2025B64001');
    assert.equal(previewRes.data.sample[0].phone_number, '9899123456');
  } finally {
    server.close();
  }
});

test('Admin API - Excel Upload supports stateless confirm with direct records payload', async () => {
  const { server, url } = await startTestServer();
  try {
    const loginRes = await requestJson(`${url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'inexpert_trifler', password: 'om sai 0987654321' });
    const token = loginRes.data.token;

    // Direct confirmation without prior preview in memory (simulating new serverless container)
    const directRecords = [
      {
        name: 'Stateless Student',
        admission_number: '2025STATELESS01',
        phone_number: '9877778888',
        section: 'CSE-12'
      }
    ];

    const confirmRes = await requestJson(`${url}/api/admin/upload-confirm`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }, {
      previewToken: 'expired-or-nonexistent-token',
      records: directRecords
    });

    assert.equal(confirmRes.statusCode, 200);
    assert.equal(confirmRes.data.success, true);
    assert.equal(confirmRes.data.result.added, 1);

    // Verify record in database/memory
    const getRes = await requestJson(`${url}/api/admin/students?search=2025STATELESS01`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.data.students.length, 1);
    assert.equal(getRes.data.students[0].name, 'Stateless Student');
  } finally {
    server.close();
  }
});
