'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const app = require('../src/app');
const { AdminDbService } = require('../src/services/adminDbService');
const { DbService } = require('../src/services/dbService');
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

test('Admin Page Data Retrieval - Dynamic getSql re-evaluates connection string', () => {
  const origEnv = process.env.DATABASE_URL;
  try {
    delete process.env.DATABASE_URL;
    const adminDb = new AdminDbService();
    assert.equal(adminDb.sql, null);

    // Now populate DATABASE_URL
    process.env.DATABASE_URL = 'postgres://fake_user:fake_pass@ep-cool-db.us-east-2.aws.neon.tech/neondb?sslmode=require';
    const sql = adminDb.getSql();
    // Neon tag is created because @neondatabase/serverless is installed
    assert.ok(typeof sql === 'function', 'getSql() must return function once DATABASE_URL is set');
    assert.equal(adminDb.isNeonActive, true);
  } finally {
    if (origEnv) {
      process.env.DATABASE_URL = origEnv;
    } else {
      delete process.env.DATABASE_URL;
    }
  }
});

test('Admin Page Data Retrieval - listStudents returns students, total, pages, and sections', async () => {
  const adminDb = new AdminDbService();

  await adminDb.upsertStudent({
    name: 'Student One',
    admission_number: 'ADM_001',
    phone_number: '9111111111',
    section: 'CSE-Alpha',
    username: 'user001',
    password: 'pass001'
  });

  await adminDb.upsertStudent({
    name: 'Student Two',
    admission_number: 'ADM_002',
    phone_number: '9222222222',
    section: 'CSE-Beta',
    username: '',
    password: ''
  });

  const res = await adminDb.listStudents({ page: 1, limit: 10 });
  assert.equal(res.total, 2);
  assert.equal(res.students.length, 2);
  assert.ok(Array.isArray(res.sections));
  assert.ok(res.sections.includes('CSE-Alpha'));
  assert.ok(res.sections.includes('CSE-Beta'));

  // Section filter
  const filterAlpha = await adminDb.listStudents({ section: 'CSE-Alpha' });
  assert.equal(filterAlpha.total, 1);
  assert.equal(filterAlpha.students[0].admission_number, 'ADM_001');

  // Credential filter: complete
  const completeCreds = await adminDb.listStudents({ credential: 'complete' });
  assert.equal(completeCreds.total, 1);
  assert.equal(completeCreds.students[0].admission_number, 'ADM_001');

  // Credential filter: missing_username
  const missingUser = await adminDb.listStudents({ credential: 'missing_username' });
  assert.equal(missingUser.total, 1);
  assert.equal(missingUser.students[0].admission_number, 'ADM_002');
});

test('Admin Page Data Retrieval - Full Dashboard Stats computation', async () => {
  const adminDb = new AdminDbService();

  await adminDb.upsertStudent({
    name: 'Alice',
    admission_number: 'ALICE01',
    username: 'alice_u',
    password: 'alice_p',
    section: 'IT-A'
  });

  await adminDb.upsertStudent({
    name: 'Bob',
    admission_number: 'BOB02',
    username: 'bob_u',
    password: '',
    section: 'IT-B'
  });

  const stats = await adminDb.getDashboardStats();
  assert.equal(stats.totalStudents, 2);
  assert.equal(stats.totalSections, 2);
  assert.equal(stats.studentsWithUsername, 2);
  assert.equal(stats.studentsWithoutUsername, 0);
  assert.equal(stats.studentsWithPassword, 1);
  assert.equal(stats.studentsWithoutPassword, 1);
  assert.ok(Array.isArray(stats.sectionBreakdown));
  assert.equal(stats.sectionBreakdown.length, 2);
});

test('Admin Page Data Retrieval - Search activity logs and stats reflection', async () => {
  const adminDb = new AdminDbService();

  await adminDb.logSearch({
    admissionNumber: '9599099932',
    result: 'SUCCESS'
  });

  await adminDb.logSearch({
    admissionNumber: '8888888888',
    result: 'API_ERROR'
  });

  await adminDb.logSearch({
    admissionNumber: '7777777777',
    result: 'NOT_FOUND'
  });

  const listRes = await adminDb.listSearchLogs({ page: 1, limit: 10 });
  assert.equal(listRes.total, 3);
  assert.equal(listRes.logs.length, 3);
  assert.equal(listRes.logs[0].admission_number, '7777777777'); // LIFO

  const statsRes = await adminDb.getSearchLogStats();
  assert.equal(statsRes.totalSearches, 3);
  assert.equal(statsRes.successCount, 1);
  assert.equal(statsRes.apiErrors, 1);
  assert.equal(statsRes.studentsNotFound, 1);
});

test('Admin Page Data Retrieval - HTTP API Endpoints deliver data to admin dashboard', async () => {
  const { server, url } = await startTestServer();

  try {
    // 1. Login to obtain session token
    const loginRes = await requestJson(`${url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      username: 'inexpert_trifler',
      password: process.env.ADMIN_PASSWORD || 'om sai 0987654321'
    });

    assert.equal(loginRes.statusCode, 200);
    assert.ok(loginRes.data.token, 'Must return session token');
    const token = loginRes.data.token;

    // 2. Fetch /api/admin/students
    const studentsRes = await requestJson(`${url}/api/admin/students`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });

    assert.equal(studentsRes.statusCode, 200);
    assert.equal(studentsRes.data.success, true);
    assert.ok(Array.isArray(studentsRes.data.students));

    // 3. Fetch /api/admin/stats
    const statsRes = await requestJson(`${url}/api/admin/stats`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });

    assert.equal(statsRes.statusCode, 200);
    assert.equal(statsRes.data.success, true);
    assert.ok(statsRes.data.stats);
    assert.ok(typeof statsRes.data.stats.totalStudents === 'number');

    // 4. Fetch /api/admin/search-logs
    const logsRes = await requestJson(`${url}/api/admin/search-logs`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });

    assert.equal(logsRes.statusCode, 200);
    assert.equal(logsRes.data.success, true);
    assert.ok(Array.isArray(logsRes.data.logs));

    // 5. Fetch /api/admin/search-logs/stats
    const searchStatsRes = await requestJson(`${url}/api/admin/search-logs/stats`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });

    assert.equal(searchStatsRes.statusCode, 200);
    assert.equal(searchStatsRes.data.success, true);
    assert.ok(searchStatsRes.data.stats);
    assert.ok(typeof searchStatsRes.data.stats.totalSearches === 'number');

  } finally {
    server.close();
  }
});

test('Admin Page Data Retrieval - Synchronization check between public/admin/admin.js and public/admin.js', () => {
  const p1 = path.resolve(__dirname, '../public/admin/admin.js');
  const p2 = path.resolve(__dirname, '../public/admin.js');

  const c1 = fs.readFileSync(p1, 'utf8');
  const c2 = fs.readFileSync(p2, 'utf8');

  assert.equal(c1, c2, 'public/admin/admin.js and public/admin.js must be 100% byte-for-byte identical');
});
