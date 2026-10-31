'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const xlsx = require('xlsx');
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

test('Admin Export - Full Lifecycle: Filtering, Sorting, Leading Zeros & Excel Formatting', async () => {
  const { server, url } = await startTestServer();
  try {
    // 1. Authenticate to obtain admin token
    const token = await defaultAdminAuthService.createSession('inexpert_trifler');

    // 2. Clear or prepare specific seed student records in database service
    // We add distinct students to test sorting, filters, and leading zeros
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
        username: '',                   // Empty credentials
        password: ''
      },
      {
        name: 'Zack Snyder',
        admission_number: '0098765432', // Leading zeros
        phone_number: '0112233445',     // Leading zero
        section: 'ECE-A',
        username: '',                   // Empty credentials
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
    // Scenario 1: Export ALL students without filters
    // ------------------------------------------------------------------------
    const resAll = await requestBuffer(`${url}/api/admin/students/export`, { headers: authHeaders });
    assert.equal(resAll.statusCode, 200, 'Authenticated export must return 200');
    assert.ok(resAll.headers['content-type'].includes('spreadsheetml.sheet'), 'Must return xlsx mime type');
    assert.ok(resAll.headers['content-disposition'].includes('Student_Records_'), 'Must contain proper filename in header');
    assert.ok(resAll.headers['content-disposition'].endsWith('.xlsx"'), 'Must have .xlsx extension');

    const parsedAll = parseWorkbook(resAll.buffer);
    assert.ok(parsedAll.records.length >= 4, 'Must contain all matching student records');

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

    // ------------------------------------------------------------------------
    // Scenario 2: Verify Leading Zeros & Empty Credentials in Exported Data
    // ------------------------------------------------------------------------
    const aaronRecord = parsedAll.records.find(r => r['Student Name'] === 'Aaron Aaronson');
    assert.ok(aaronRecord, 'Aaron record must be present');
    assert.equal(aaronRecord['Admission Number'], '0012345678', 'Leading zeros in admission number must be preserved as string');
    assert.equal(aaronRecord['Phone Number'], '0987654321', 'Leading zeros in phone number must be preserved as string');
    assert.equal(aaronRecord['Username'], 'aaron_user', 'Username must be exported');
    assert.equal(aaronRecord['Password'], 'aaronPassword123', 'Password must be exported for authenticated admin');

    const charlieRecord = parsedAll.records.find(r => r['Student Name'] === 'Charlie Chaplin');
    assert.ok(charlieRecord, 'Charlie record must be present');
    assert.equal(charlieRecord['Username'], '', 'Empty username must be exported as empty cell');
    assert.equal(charlieRecord['Password'], '', 'Empty password must be exported as empty cell');

    // ------------------------------------------------------------------------
    // Scenario 3: Universal Search Filter (e.g. ?search=Bob)
    // ------------------------------------------------------------------------
    const resSearch = await requestBuffer(`${url}/api/admin/students/export?search=Bob`, { headers: authHeaders });
    assert.equal(resSearch.statusCode, 200);
    const parsedSearch = parseWorkbook(resSearch.buffer);
    assert.equal(parsedSearch.records.length, 1, 'Search for "Bob" must return exactly 1 record');
    assert.equal(parsedSearch.records[0]['Student Name'], 'Bob Builder');

    // Search by 10-digit admission number with leading zeros
    const resAdmSearch = await requestBuffer(`${url}/api/admin/students/export?search=0012345678`, { headers: authHeaders });
    assert.equal(resAdmSearch.statusCode, 200);
    const parsedAdmSearch = parseWorkbook(resAdmSearch.buffer);
    assert.equal(parsedAdmSearch.records.length, 1);
    assert.equal(parsedAdmSearch.records[0]['Student Name'], 'Aaron Aaronson');

    // ------------------------------------------------------------------------
    // Scenario 4: Credential Filter - With Credentials
    // ------------------------------------------------------------------------
    const resWithCreds = await requestBuffer(`${url}/api/admin/students/export?credential=with_credentials`, { headers: authHeaders });
    assert.equal(resWithCreds.statusCode, 200);
    const parsedWithCreds = parseWorkbook(resWithCreds.buffer);
    parsedWithCreds.records.forEach(r => {
      assert.ok(r['Username'] && r['Username'].length > 0, `Record ${r['Student Name']} must have username`);
      assert.ok(r['Password'] && r['Password'].length > 0, `Record ${r['Student Name']} must have password`);
    });
    assert.ok(parsedWithCreds.records.some(r => r['Student Name'] === 'Aaron Aaronson'));
    assert.ok(!parsedWithCreds.records.some(r => r['Student Name'] === 'Charlie Chaplin'));
    assert.ok(!parsedWithCreds.records.some(r => r['Student Name'] === 'Zack Snyder'));

    // ------------------------------------------------------------------------
    // Scenario 5: Credential Filter - Without Credentials
    // ------------------------------------------------------------------------
    const resWithoutCreds = await requestBuffer(`${url}/api/admin/students/export?credential=without_credentials`, { headers: authHeaders });
    assert.equal(resWithoutCreds.statusCode, 200);
    const parsedWithoutCreds = parseWorkbook(resWithoutCreds.buffer);
    parsedWithoutCreds.records.forEach(r => {
      assert.ok(!r['Username'] || !r['Password'], `Record ${r['Student Name']} must have empty credentials`);
    });
    assert.ok(parsedWithoutCreds.records.some(r => r['Student Name'] === 'Charlie Chaplin'));
    assert.ok(parsedWithoutCreds.records.some(r => r['Student Name'] === 'Zack Snyder'));
    assert.ok(!parsedWithoutCreds.records.some(r => r['Student Name'] === 'Aaron Aaronson'));

    // ------------------------------------------------------------------------
    // Scenario 6: Sorting - A-Z (name_asc) and Z-A (name_desc)
    // ------------------------------------------------------------------------
    const resSortAsc = await requestBuffer(`${url}/api/admin/students/export?sort=name_asc`, { headers: authHeaders });
    assert.equal(resSortAsc.statusCode, 200);
    const parsedSortAsc = parseWorkbook(resSortAsc.buffer);
    const namesAsc = parsedSortAsc.records.map(r => r['Student Name']);
    // Verify names are in ascending order
    for (let i = 0; i < namesAsc.length - 1; i++) {
      assert.ok(namesAsc[i].localeCompare(namesAsc[i + 1]) <= 0, `Ascending sort: ${namesAsc[i]} <= ${namesAsc[i + 1]}`);
    }

    const resSortDesc = await requestBuffer(`${url}/api/admin/students/export?sort=name_desc`, { headers: authHeaders });
    assert.equal(resSortDesc.statusCode, 200);
    const parsedSortDesc = parseWorkbook(resSortDesc.buffer);
    const namesDesc = parsedSortDesc.records.map(r => r['Student Name']);
    // Verify names are in descending order
    for (let i = 0; i < namesDesc.length - 1; i++) {
      assert.ok(namesDesc[i].localeCompare(namesDesc[i + 1]) >= 0, `Descending sort: ${namesDesc[i]} >= ${namesDesc[i + 1]}`);
    }

    // ------------------------------------------------------------------------
    // Scenario 7: Combined Search + Filters + Sorting
    // ------------------------------------------------------------------------
    // Search "Aar" with credentials and name_asc
    const resCombined = await requestBuffer(`${url}/api/admin/students/export?search=Aar&credential=with_credentials&sort=name_asc`, { headers: authHeaders });
    assert.equal(resCombined.statusCode, 200);
    const parsedCombined = parseWorkbook(resCombined.buffer);
    assert.equal(parsedCombined.records.length, 1);
    assert.equal(parsedCombined.records[0]['Student Name'], 'Aaron Aaronson');

  } finally {
    server.close();
  }
});

test('Admin Export - UI Components & Scripts: Button exists and is properly wired', () => {
  const fs = require('fs');
  const path = require('path');

  const html = fs.readFileSync(path.resolve(__dirname, '../public/admin/index.html'), 'utf8');
  assert.ok(html.includes('id="btn-export-students"'), 'index.html must contain btn-export-students');
  assert.ok(html.includes('Export Students'), 'Button text must be Export Students');

  const js = fs.readFileSync(path.resolve(__dirname, '../public/admin/admin.js'), 'utf8');
  assert.ok(js.includes('exportStudents'), 'admin.js must implement exportStudents');
  assert.ok(js.includes('/api/admin/students/export'), 'admin.js must call /api/admin/students/export');
  assert.ok(js.includes('btn-export-students'), 'admin.js must bind btn-export-students');
});
