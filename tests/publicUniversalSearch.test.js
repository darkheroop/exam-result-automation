'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const { defaultAdminDbService } = require('../src/services/adminDbService');
const { defaultSessionManager } = require('../src/services/sessionManager');

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

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(u, { method: 'GET', ...options }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        let json = null;
        try {
          if (raw) json = JSON.parse(raw);
        } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          raw,
          json
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('Public Universal Student Search - Endpoint accessibility & Aliases', async () => {
  const { server, url } = await startTestServer();
  try {
    // 1. Direct /api/students/search
    const res1 = await requestJson(`${url}/api/students/search`);
    assert.equal(res1.statusCode, 200, '/api/students/search must be publicly accessible without auth');
    assert.equal(res1.json?.success, true);
    assert.equal(res1.json?.count, 0);

    // 2. Alias /api/public/students/search
    const res2 = await requestJson(`${url}/api/public/students/search`);
    assert.equal(res2.statusCode, 200, '/api/public/students/search alias must be accessible');
    assert.equal(res2.json?.success, true);

    // 3. Automation path /api/automation/students/search
    const res3 = await requestJson(`${url}/api/automation/students/search`);
    assert.equal(res3.statusCode, 200, '/api/automation/students/search must be accessible');
    assert.equal(res3.json?.success, true);
  } finally {
    server.close();
  }
});

test('Public Universal Student Search - Empty or whitespace query returns 0 without leaking data', async () => {
  const { server, url } = await startTestServer();
  try {
    // Seed at least one student in DB service
    await defaultAdminDbService.upsertStudent({
      name: 'Confidential Test Student',
      admission_number: 'ADM_CONF_001',
      phone_number: '9998887771',
      username: 'secret_user',
      password: 'secret_password_xyz'
    });

    // Empty query param
    const resEmpty = await requestJson(`${url}/api/students/search?q=`);
    assert.equal(resEmpty.statusCode, 200);
    assert.equal(resEmpty.json?.count, 0);
    assert.deepEqual(resEmpty.json?.students, []);

    // Whitespace query param
    const resSpaces = await requestJson(`${url}/api/students/search?q=%20%20%20`);
    assert.equal(resSpaces.statusCode, 200);
    assert.equal(resSpaces.json?.count, 0);
    assert.deepEqual(resSpaces.json?.students, []);
  } finally {
    server.close();
  }
});

test('Public Universal Student Search - Zero sensitive data exposure (Privacy & Security Test)', async () => {
  const { server, url } = await startTestServer();
  try {
    const sensitivePassword = 'SuperSecretUnrevealedPassword123!';
    const sensitiveUsername = 'top_secret_username_99';
    const testAdm = '0098765432';
    const testPhone = '0888123456';
    const testName = 'Aarav Gupta';

    await defaultAdminDbService.upsertStudent({
      name: testName,
      admission_number: testAdm,
      phone_number: testPhone,
      username: sensitiveUsername,
      password: sensitivePassword
    });

    const res = await requestJson(`${url}/api/students/search?q=${encodeURIComponent('Aarav')}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json?.success, true);
    assert.ok(res.json?.count >= 1);

    const match = res.json.students.find(s => s.student_name === testName);
    assert.ok(match, 'Matching student must be returned');

    // CRITICAL PRIVACY CHECKS:
    // Only student_name, admission_number, and phone_number must exist.
    const allowedKeys = new Set(['student_name', 'admission_number', 'phone_number']);
    const actualKeys = Object.keys(match);
    for (const key of actualKeys) {
      assert.ok(allowedKeys.has(key), `Disallowed property '${key}' found in public search result`);
    }

    assert.equal(match.username, undefined, 'username must never be exposed');
    assert.equal(match.password, undefined, 'password must never be exposed');
    assert.equal(match.portal_username, undefined, 'portal_username must never be exposed');
    assert.equal(match.portal_password, undefined, 'portal_password must never be exposed');
    assert.equal(match.id, undefined, 'internal ID must never be exposed');
    assert.equal(match.created_at, undefined, 'created_at timestamp must never be exposed');
    assert.equal(match.updated_at, undefined, 'updated_at timestamp must never be exposed');

    // Verify raw HTTP response string contains neither username nor password
    assert.ok(!res.raw.includes(sensitivePassword), 'Raw response must never contain the password');
    assert.ok(!res.raw.includes(sensitiveUsername), 'Raw response must never contain the username');

    // Verify leading zeros are preserved as strings
    assert.equal(match.admission_number, testAdm, 'Leading zeros in admission number must be preserved');
    assert.equal(match.phone_number, testPhone, 'Leading zeros in phone number must be preserved');
  } finally {
    server.close();
  }
});

test('Public Universal Student Search - Search across Name, Admission, and Phone with partial and case-insensitive matching', async () => {
  const { server, url } = await startTestServer();
  try {
    const studentA = {
      name: 'Priya Sharma',
      admission_number: 'ADM-2024-PS01',
      phone_number: '9876500001',
      username: 'psharma',
      password: 'psharmapassword'
    };
    const studentB = {
      name: 'Rohan Verma',
      admission_number: 'ADM-2024-RV02',
      phone_number: '9876500002',
      username: 'rverma',
      password: 'rvermapassword'
    };

    await defaultAdminDbService.upsertStudent(studentA);
    await defaultAdminDbService.upsertStudent(studentB);

    // 1. Partial Name search (case-insensitive: "priya")
    const resName = await requestJson(`${url}/api/students/search?q=priya`);
    assert.equal(resName.statusCode, 200);
    assert.ok(resName.json.students.some(s => s.student_name === 'Priya Sharma'));
    assert.ok(!resName.json.students.some(s => s.student_name === 'Rohan Verma'));

    // 2. Case-insensitive search ("rOhAn")
    const resCase = await requestJson(`${url}/api/students/search?q=rOhAn`);
    assert.equal(resCase.statusCode, 200);
    assert.ok(resCase.json.students.some(s => s.student_name === 'Rohan Verma'));

    // 3. Partial Admission Number ("PS01")
    const resAdm = await requestJson(`${url}/api/students/search?q=PS01`);
    assert.equal(resAdm.statusCode, 200);
    assert.ok(resAdm.json.students.some(s => s.admission_number === 'ADM-2024-PS01'));

    // 4. Partial Phone Number ("500002")
    const resPhone = await requestJson(`${url}/api/students/search?q=500002`);
    assert.equal(resPhone.statusCode, 200);
    assert.ok(resPhone.json.students.some(s => s.phone_number === '9876500002'));

    // 5. Query with leading and trailing whitespace ("   verma   ")
    const resTrim = await requestJson(`${url}/api/students/search?q=%20%20%20verma%20%20%20`);
    assert.equal(resTrim.statusCode, 200);
    assert.ok(resTrim.json.students.some(s => s.student_name === 'Rohan Verma'));

    // 6. Query with no matches
    const resNone = await requestJson(`${url}/api/students/search?q=nonexistentstudentxyz999`);
    assert.equal(resNone.statusCode, 200);
    assert.equal(resNone.json.count, 0);
    assert.deepEqual(resNone.json.students, []);
  } finally {
    server.close();
  }
});

test('Public Universal Student Search - Does NOT trigger credential lookup or portal session creation', async () => {
  const { server, url } = await startTestServer();
  try {
    const initialSessionCount = defaultSessionManager.sessions.size;

    await defaultAdminDbService.upsertStudent({
      name: 'Unaccessed Candidate',
      admission_number: 'ADM-NO-TRIGGER',
      phone_number: '9123400099',
      username: 'cand_usr',
      password: 'cand_pwd'
    });

    const res = await requestJson(`${url}/api/students/search?q=Candidate`);
    assert.equal(res.statusCode, 200);
    assert.ok(res.json.count >= 1);

    // Verify sessionManager was never touched
    const finalSessionCount = defaultSessionManager.sessions.size;
    assert.equal(finalSessionCount, initialSessionCount, 'Directory search must NEVER create portal sessions');
  } finally {
    server.close();
  }
});

test('Public Universal Student Search - Frontend HTML and CSS integrity', () => {
  const htmlPath = path.resolve(__dirname, '../public/index.html');
  const cssPath = path.resolve(__dirname, '../public/styles.css');
  const jsPath = path.resolve(__dirname, '../public/app.js');

  const html = fs.readFileSync(htmlPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  const js = fs.readFileSync(jsPath, 'utf8');

  // Verify section placement & structure
  assert.ok(html.includes('id="searchStudentsSection"'), 'index.html must have #searchStudentsSection');
  assert.ok(html.includes('Search Students</h2>'), 'index.html must display title "Search Students"');
  assert.ok(
    html.includes('placeholder="Search by student name, phone number or admission number..."'),
    'index.html must contain exact placeholder'
  );
  assert.ok(html.includes('id="publicStudentSearchInput"'), 'index.html must contain #publicStudentSearchInput');
  assert.ok(html.includes('id="publicStudentSearchClearBtn"'), 'index.html must contain clear button');
  assert.ok(html.includes('id="publicStudentSearchSubmitBtn"'), 'index.html must contain search button');
  assert.ok(
    html.includes('Enter a student name, phone number, or admission number to search.'),
    'index.html must have prompt message'
  );
  assert.ok(html.includes('No matching students found.'), 'index.html must have empty state message');

  // Table header checks: must display only 3 fields and NEVER display username/password
  assert.ok(html.includes('>Student Name</th>'), 'Table must have Student Name header');
  assert.ok(html.includes('>Admission Number</th>'), 'Table must have Admission Number header');
  assert.ok(html.includes('>Phone Number</th>'), 'Table must have Phone Number header');
  assert.ok(!html.includes('>Username</th>'), 'Table must NEVER have Username header');
  assert.ok(!html.includes('>Password</th>'), 'Table must NEVER have Password header');

  // Verify CSS styles exist
  assert.ok(css.includes('.public-directory-card'), 'styles.css must contain .public-directory-card');
  assert.ok(css.includes('.directory-search-input'), 'styles.css must contain .directory-search-input');
  assert.ok(css.includes('.directory-table'), 'styles.css must contain .directory-table');

  // Verify JS logic exists
  assert.ok(js.includes('initPublicUniversalSearch'), 'app.js must contain initPublicUniversalSearch');
  assert.ok(js.includes('/api/students/search'), 'app.js must call /api/students/search');
  assert.ok(js.includes('publicStudentSearchClearBtn'), 'app.js must handle search clear button');
  assert.ok(js.includes('phone-action-btn'), 'app.js must wire phone action button to populate studentNumberInput');
});
