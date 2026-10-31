'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const { defaultAdminDbService } = require('../src/services/adminDbService');
const { defaultAdminAuthService } = require('../src/services/adminAuthService');

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

function requestBuffer(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(u, options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(buffer.toString('utf8'));
        } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          buffer,
          json
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

function parseWorkbook(buffer) {
  const wb = xlsx.read(buffer, { type: 'buffer', raw: false });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  // Parse rows as raw array of arrays to verify exact headings and cell contents
  const aoa = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  // Parse objects for easy key-value checking
  const records = xlsx.utils.sheet_to_json(sheet, { raw: false, defval: '' });
  return { wb, sheet, aoa, records };
}

test('Admin Export - Security: Unauthenticated request returns 401', async () => {
  const { server, url } = await startTestServer();
  try {
    const res = await requestBuffer(`${url}/api/admin/students/export`);
    assert.equal(res.statusCode, 401, 'Unauthenticated export request must return 401');
    assert.equal(res.json?.success, false);
  } finally {
    server.close();
  }
});

test('Admin Export - Three Options: All Students, With Credentials, and Without Credentials', async () => {
  const { server, url } = await startTestServer();
  try {
    // 1. Authenticate to obtain admin token
    const token = await defaultAdminAuthService.createSession('inexpert_trifler');

    // 2. Prepare seed students:
    // - Both credentials
    // - Missing both
    // - Missing password only (has username only)
    // - Missing username only (has password only)
    const testSeed = [
      {
        name: 'Aaron Aaronson',
        admission_number: '0012345678', // Leading zeros in admission
        phone_number: '0987654321',     // Leading zero in phone
        section: 'CSE-A',
        username: 'aaron_user',
        password: 'aaronPassword123'
      },
      {
        name: 'Bob Builder',
        admission_number: '2023CS001',
        phone_number: '9123456780',
        section: 'CSE-A',
        username: 'bob_user',
        password: 'bobPassword456'
      },
      {
        name: 'Charlie Chaplin',
        admission_number: '2023CS002',
        phone_number: '9123456781',
        section: 'IT-A',
        username: '',                   // Empty credentials (both missing)
        password: ''
      },
      {
        name: 'David UsernameOnly',
        admission_number: '2023CS010',
        phone_number: '9123456782',
        section: 'IT-A',
        username: 'david_user_only',    // Has username but missing password
        password: ''
      },
      {
        name: 'Elena PasswordOnly',
        admission_number: '2023CS011',
        phone_number: '9123456783',
        section: 'CSE-B',
        username: '',                   // Missing username but has password
        password: 'elena_pass_only'
      },
      {
        name: 'Zack Snyder',
        admission_number: '0098765432', // Leading zeros
        phone_number: '0112233445',     // Leading zero
        section: 'ECE-A',
        username: '',                   // Empty credentials (both missing)
        password: ''
      }
    ];

    for (const student of testSeed) {
      await defaultAdminDbService.upsertStudent(student);
    }

    const authHeaders = {
      'Authorization': `Bearer ${token}`
    };

    // ------------------------------------------------------------------------
    // Option 1: ALL STUDENTS (All_Students.xlsx)
    // ------------------------------------------------------------------------
    const resAll = await requestBuffer(`${url}/api/admin/students/export?exportFilter=all`, { headers: authHeaders });
    assert.equal(resAll.statusCode, 200, 'Authenticated export must return 200');
    assert.ok(resAll.headers['content-type'].includes('spreadsheetml.sheet'), 'Must return xlsx mime type');
    assert.ok(resAll.headers['content-disposition'].includes('filename="All_Students.xlsx"'), 'Filename must be All_Students.xlsx');

    const parsedAll = parseWorkbook(resAll.buffer);
    assert.ok(parsedAll.records.length >= 6, 'Must contain all matching student records');

    // Verify exact 5 column headings
    const headerRow = parsedAll.aoa[0];
    assert.deepEqual(headerRow, [
      'Student Name',
      'Admission Number',
      'Phone Number',
      'Username',
      'Password'
    ], 'Must have exactly the five required headers in exact order');

    // Verify excluded internal fields are NOT present
    assert.ok(!headerRow.includes('id'), 'Internal ID must not be exported');
    assert.ok(!headerRow.includes('created_at'), 'Created timestamp must not be exported');
    assert.ok(!headerRow.includes('updated_at'), 'Updated timestamp must not be exported');
    assert.ok(!headerRow.includes('section'), 'Section must not be exported in the 5 fields');

    // Verify Leading Zeros in Aaron's record
    const aaronAll = parsedAll.records.find(r => r['Student Name'] === 'Aaron Aaronson');
    assert.ok(aaronAll);
    assert.equal(aaronAll['Admission Number'], '0012345678', 'Leading zeros preserved');
    assert.equal(aaronAll['Phone Number'], '0987654321', 'Leading zeros preserved');

    // ------------------------------------------------------------------------
    // Option 2: STUDENTS WITH CREDENTIALS (Students_With_Credentials.xlsx)
    // Must only include students where both username AND password are present
    // ------------------------------------------------------------------------
    const resWith = await requestBuffer(`${url}/api/admin/students/export?exportFilter=with_credentials`, { headers: authHeaders });
    assert.equal(resWith.statusCode, 200);
    assert.ok(resWith.headers['content-disposition'].includes('filename="Students_With_Credentials.xlsx"'), 'Filename must be Students_With_Credentials.xlsx');

    const parsedWith = parseWorkbook(resWith.buffer);

    // Verify all records have both username AND password
    parsedWith.records.forEach(r => {
      assert.ok(r['Username'] && r['Username'].length > 0, `Record ${r['Student Name']} must have username`);
      assert.ok(r['Password'] && r['Password'].length > 0, `Record ${r['Student Name']} must have password`);
    });

    // Both Aaron and Bob must be present
    assert.ok(parsedWith.records.some(r => r['Student Name'] === 'Aaron Aaronson'));
    assert.ok(parsedWith.records.some(r => r['Student Name'] === 'Bob Builder'));

    // Partial and missing credential students must NOT be present
    assert.ok(!parsedWith.records.some(r => r['Student Name'] === 'Charlie Chaplin'), 'Charlie (neither) must not appear in with_credentials');
    assert.ok(!parsedWith.records.some(r => r['Student Name'] === 'David UsernameOnly'), 'David (username only) must not appear in with_credentials');
    assert.ok(!parsedWith.records.some(r => r['Student Name'] === 'Elena PasswordOnly'), 'Elena (password only) must not appear in with_credentials');
    assert.ok(!parsedWith.records.some(r => r['Student Name'] === 'Zack Snyder'), 'Zack (neither) must not appear in with_credentials');

    // ------------------------------------------------------------------------
    // Option 3: STUDENTS WITHOUT CREDENTIALS (Students_Without_Credentials.xlsx)
    // Must include students where either username OR password is missing/empty
    // ------------------------------------------------------------------------
    const resWithout = await requestBuffer(`${url}/api/admin/students/export?exportFilter=without_credentials`, { headers: authHeaders });
    assert.equal(resWithout.statusCode, 200);
    assert.ok(resWithout.headers['content-disposition'].includes('filename="Students_Without_Credentials.xlsx"'), 'Filename must be Students_Without_Credentials.xlsx');

    const parsedWithout = parseWorkbook(resWithout.buffer);

    // Verify all records have at least one missing credential
    parsedWithout.records.forEach(r => {
      const hasBoth = Boolean(r['Username'] && r['Password']);
      assert.equal(hasBoth, false, `Record ${r['Student Name']} must have at least one credential missing`);
    });

    // Charlie (missing both) must be present
    assert.ok(parsedWithout.records.some(r => r['Student Name'] === 'Charlie Chaplin'));
    // David (has username only) must be present
    const davidRec = parsedWithout.records.find(r => r['Student Name'] === 'David UsernameOnly');
    assert.ok(davidRec, 'David (username only) must appear in without_credentials');
    assert.equal(davidRec['Username'], 'david_user_only');
    assert.equal(davidRec['Password'], '', 'Missing password must be empty cell');

    // Elena (has password only) must be present
    const elenaRec = parsedWithout.records.find(r => r['Student Name'] === 'Elena PasswordOnly');
    assert.ok(elenaRec, 'Elena (password only) must appear in without_credentials');
    assert.equal(elenaRec['Username'], '', 'Missing username must be empty cell');
    assert.equal(elenaRec['Password'], 'elena_pass_only');

    // Zack (missing both) must be present
    assert.ok(parsedWithout.records.some(r => r['Student Name'] === 'Zack Snyder'));

    // Aaron and Bob (both credentials present) must NOT be present
    assert.ok(!parsedWithout.records.some(r => r['Student Name'] === 'Aaron Aaronson'), 'Aaron (both present) must not appear in without_credentials');
    assert.ok(!parsedWithout.records.some(r => r['Student Name'] === 'Bob Builder'), 'Bob (both present) must not appear in without_credentials');

    // ------------------------------------------------------------------------
    // Scenario 4: Universal Search combined with Export Filter & Sorting
    // ------------------------------------------------------------------------
    // Search "Chaplin" with without_credentials
    const resSearchWithout = await requestBuffer(`${url}/api/admin/students/export?search=Chaplin&exportFilter=without_credentials`, { headers: authHeaders });
    assert.equal(resSearchWithout.statusCode, 200);
    const parsedSearchWithout = parseWorkbook(resSearchWithout.buffer);
    assert.equal(parsedSearchWithout.records.length, 1);
    assert.equal(parsedSearchWithout.records[0]['Student Name'], 'Charlie Chaplin');

    // Search "Bob" with without_credentials -> should return 0 records because Bob has both credentials
    const resSearchBobWithout = await requestBuffer(`${url}/api/admin/students/export?search=Bob&exportFilter=without_credentials`, { headers: authHeaders });
    assert.equal(resSearchBobWithout.statusCode, 200);
    const parsedSearchBobWithout = parseWorkbook(resSearchBobWithout.buffer);
    assert.equal(parsedSearchBobWithout.records.length, 0, 'Bob has both credentials so without_credentials must return 0 records');

    // Alphabetical Sorting in All Students
    const resSortAsc = await requestBuffer(`${url}/api/admin/students/export?exportFilter=all&sort=name_asc`, { headers: authHeaders });
    assert.equal(resSortAsc.statusCode, 200);
    const parsedSortAsc = parseWorkbook(resSortAsc.buffer);
    const namesAsc = parsedSortAsc.records.map(r => r['Student Name']);
    for (let i = 0; i < namesAsc.length - 1; i++) {
      assert.ok(namesAsc[i].localeCompare(namesAsc[i + 1]) <= 0, `Ascending sort: ${namesAsc[i]} <= ${namesAsc[i + 1]}`);
    }

    const resSortDesc = await requestBuffer(`${url}/api/admin/students/export?exportFilter=all&sort=name_desc`, { headers: authHeaders });
    assert.equal(resSortDesc.statusCode, 200);
    const parsedSortDesc = parseWorkbook(resSortDesc.buffer);
    const namesDesc = parsedSortDesc.records.map(r => r['Student Name']);
    for (let i = 0; i < namesDesc.length - 1; i++) {
      assert.ok(namesDesc[i].localeCompare(namesDesc[i + 1]) >= 0, `Descending sort: ${namesDesc[i]} >= ${namesDesc[i + 1]}`);
    }

  } finally {
    server.close();
  }
});

test('Admin Export - UI Components & Scripts: Selection Dialog Modal & Three Options', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../public/admin/index.html'), 'utf8');

  // Verify modal dialog structure
  assert.ok(html.includes('id="modal-export-students"'), 'Must contain modal-export-students dialog');
  assert.ok(html.includes('Export Student Records'), 'Must contain dialog title');

  // Verify the three filter options
  assert.ok(html.includes('value="all"'), 'Must have All Students option');
  assert.ok(html.includes('All_Students.xlsx'), 'Must display All_Students.xlsx badge');

  assert.ok(html.includes('value="with_credentials"'), 'Must have With Credentials option');
  assert.ok(html.includes('Students_With_Credentials.xlsx'), 'Must display Students_With_Credentials.xlsx badge');

  assert.ok(html.includes('value="without_credentials"'), 'Must have Without Credentials option');
  assert.ok(html.includes('Students_Without_Credentials.xlsx'), 'Must display Students_Without_Credentials.xlsx badge');

  assert.ok(html.includes('id="btn-confirm-export"'), 'Must have confirmation download button');

  // Verify JavaScript handler
  const js = fs.readFileSync(path.resolve(__dirname, '../public/admin/admin.js'), 'utf8');
  assert.ok(js.includes('openExportModal'), 'admin.js must implement openExportModal');
  assert.ok(js.includes('executeStudentExport'), 'admin.js must implement executeStudentExport');
  assert.ok(js.includes('exportFilter'), 'admin.js must send exportFilter query param');
  assert.ok(js.includes('btn-confirm-export'), 'admin.js must bind confirm export button');
});
