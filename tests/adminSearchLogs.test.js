'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AdminDbService } = require('../src/services/adminDbService');
const { AdminSearchService } = require('../src/services/adminSearchService');

test('AdminSearchLogs - DB Service logging, pagination, filtering, and stats', async () => {
  const db = new AdminDbService();

  // 1. Initial empty logs
  const emptyLogs = await db.listSearchLogs();
  assert.equal(emptyLogs.total, 0);
  assert.deepEqual(emptyLogs.logs, []);

  // 2. Add search log entries
  const l1 = await db.logSearch({
    searchQuery: '2023CS001',
    searchType: 'Admission Number',
    result: 'SUCCESS'
  });
  assert.equal(l1.search_query, '2023CS001');
  assert.equal(l1.search_type, 'Admission Number');
  assert.equal(l1.result, 'SUCCESS');

  await db.logSearch({
    searchQuery: 'Rahul Sharma',
    searchType: 'Name',
    result: 'FOUND'
  });

  await db.logSearch({
    searchQuery: '2023CS999',
    searchType: 'Admission Number',
    result: 'NOT_FOUND'
  });

  await db.logSearch({
    searchQuery: '2023CS002',
    searchType: 'Admission Number',
    result: 'API_ERROR'
  });

  // 3. Stats check
  const stats = await db.getSearchLogStats();
  assert.equal(stats.totalSearches, 4);
  assert.equal(stats.successfulLookups, 1);
  assert.equal(stats.apiErrors, 1);
  assert.equal(stats.studentsNotFound, 1);
  assert.equal(stats.searchesToday, 4);

  // 4. Filtering by result
  const successList = await db.listSearchLogs({ result: 'SUCCESS' });
  assert.equal(successList.total, 1);
  assert.equal(successList.logs[0].search_query, '2023CS001');

  // 5. Filtering by search type
  const nameList = await db.listSearchLogs({ searchType: 'Name' });
  assert.equal(nameList.total, 1);
  assert.equal(nameList.logs[0].search_query, 'Rahul Sharma');

  // 6. Security verification: Search logs must NOT contain passwords or secret keys
  const allLogs = await db.listSearchLogs();
  for (const log of allLogs.logs) {
    assert.equal(log.password, undefined, 'Search log must not have a password field');
    assert.equal(log.token, undefined, 'Search log must not have a token field');
    assert.ok(!JSON.stringify(log).includes('sk_support'), 'Search log must not contain API keys');
  }

  // 7. Clear logs
  await db.clearSearchLogs();
  const clearedLogs = await db.listSearchLogs();
  assert.equal(clearedLogs.total, 0);
});

test('AdminSearchService - Admission number search triggers credential lookup & updates student', async () => {
  const db = new AdminDbService();

  // Create an existing student without credentials
  await db.upsertStudent({
    name: 'Ansh Singh',
    admission_number: '2023CS042',
    phone_number: '8887416471',
    username: '',
    password: '',
    section: 'CSE-A'
  });

  let credentialApiCalled = false;
  let requestedStudentNumber = null;

  const searchService = new AdminSearchService({
    dbService: db,
    mockMode: true,
    mockCredentialHandler: async (studentNumber) => {
      credentialApiCalled = true;
      requestedStudentNumber = studentNumber;
      return {
        status: 'SUCCESS',
        username: 'ansh14',
        password: 'secure_password_ansh'
      };
    }
  });

  // Search by admission number
  const result = await searchService.executeSearch({
    query: '2023CS042',
    searchType: 'Admission Number'
  });

  assert.equal(credentialApiCalled, true);
  assert.equal(requestedStudentNumber, '2023CS042');
  assert.equal(result.success, true);
  assert.equal(result.result, 'SUCCESS');
  assert.equal(result.updated, true);
  assert.equal(result.students.length, 1);
  assert.equal(result.students[0].username, 'ansh14');
  assert.equal(result.students[0].password, 'secure_password_ansh');
  assert.equal(result.students[0].section, 'CSE-A'); // Preserved
  assert.equal(result.students[0].name, 'Ansh Singh'); // Preserved

  // Verify DB record was updated permanently
  const verifiedStudent = await db.getStudentByAdmissionNumber('2023CS042');
  assert.equal(verifiedStudent.username, 'ansh14');
  assert.equal(verifiedStudent.password, 'secure_password_ansh');

  // Verify search log was recorded as SUCCESS
  const logs = await db.listSearchLogs();
  assert.equal(logs.total, 1);
  assert.equal(logs.logs[0].result, 'SUCCESS');
  assert.equal(logs.logs[0].search_query, '2023CS042');
  assert.equal(logs.logs[0].search_type, 'Admission Number');
  assert.ok(!JSON.stringify(logs.logs[0]).includes('secure_password_ansh'), 'Password must never be written to logs');
});

test('AdminSearchService - Non-existent student by admission number logs NOT_FOUND and does NOT call API', async () => {
  const db = new AdminDbService();
  let credentialApiCalled = false;

  const searchService = new AdminSearchService({
    dbService: db,
    mockMode: true,
    mockCredentialHandler: async () => {
      credentialApiCalled = true;
      return { status: 'SUCCESS', username: 'u', password: 'p' };
    }
  });

  const result = await searchService.executeSearch({
    query: '2023NONEXISTENT',
    searchType: 'Admission Number'
  });

  assert.equal(credentialApiCalled, false, 'Credential API must NOT be called if student does not exist locally');
  assert.equal(result.result, 'NOT_FOUND');
  assert.equal(result.students.length, 0);

  const logs = await db.listSearchLogs();
  assert.equal(logs.total, 1);
  assert.equal(logs.logs[0].result, 'NOT_FOUND');
});

test('AdminSearchService - Name, Phone, and Username searches do NOT call credential API', async () => {
  const db = new AdminDbService();
  await db.upsertStudent({
    name: 'Pooja Verma',
    admission_number: '2023CS099',
    phone_number: '9876543210',
    username: 'pooja99',
    password: 'existing_pass',
    section: 'CSE-B'
  });

  let credentialApiCalled = false;
  const searchService = new AdminSearchService({
    dbService: db,
    mockMode: true,
    mockCredentialHandler: async () => {
      credentialApiCalled = true;
      return { status: 'SUCCESS', username: 'new', password: 'new' };
    }
  });

  // 1. Search by Name
  const nameRes = await searchService.executeSearch({ query: 'Pooja', searchType: 'Name' });
  assert.equal(credentialApiCalled, false);
  assert.equal(nameRes.result, 'FOUND');
  assert.equal(nameRes.students.length, 1);

  // 2. Search by Phone
  const phoneRes = await searchService.executeSearch({ query: '9876543210', searchType: 'Phone Number' });
  assert.equal(credentialApiCalled, false);
  assert.equal(phoneRes.result, 'FOUND');

  // 3. Search by Username
  const userRes = await searchService.executeSearch({ query: 'pooja99', searchType: 'Username' });
  assert.equal(credentialApiCalled, false);
  assert.equal(userRes.result, 'FOUND');

  // 4. Missing Name search
  const missingRes = await searchService.executeSearch({ query: 'Nobody Here', searchType: 'Name' });
  assert.equal(credentialApiCalled, false);
  assert.equal(missingRes.result, 'NOT_FOUND');

  // Verify existing password was NOT modified
  const current = await db.getStudentByAdmissionNumber('2023CS099');
  assert.equal(current.password, 'existing_pass');

  // Verify logs
  const logs = await db.listSearchLogs();
  assert.equal(logs.total, 4);
});

test('AdminSearchService - Handles API errors and preserves existing credentials', async () => {
  const db = new AdminDbService();
  await db.upsertStudent({
    name: 'Vikas Kumar',
    admission_number: '2023CS077',
    username: 'vikas_orig',
    password: 'orig_password_123',
    section: 'CSE-C'
  });

  // 1. API_ERROR test
  const errorSearchService = new AdminSearchService({
    dbService: db,
    mockMode: true,
    mockCredentialHandler: async () => ({ status: 'API_ERROR', error: 'Upstream 500 error' })
  });

  const errRes = await errorSearchService.executeSearch({ query: '2023CS077', searchType: 'Admission Number' });
  assert.equal(errRes.result, 'API_ERROR');
  // Original credentials must NOT be overwritten!
  assert.equal(errRes.students[0].username, 'vikas_orig');
  assert.equal(errRes.students[0].password, 'orig_password_123');

  // 2. TIMEOUT test
  const timeoutSearchService = new AdminSearchService({
    dbService: db,
    mockMode: true,
    mockCredentialHandler: async () => ({ status: 'TIMEOUT' })
  });
  const timeoutRes = await timeoutSearchService.executeSearch({ query: '2023CS077', searchType: 'Admission Number' });
  assert.equal(timeoutRes.result, 'TIMEOUT');

  // 3. NETWORK_ERROR test
  const netSearchService = new AdminSearchService({
    dbService: db,
    mockMode: true,
    mockCredentialHandler: async () => ({ status: 'NETWORK_ERROR' })
  });
  const netRes = await netSearchService.executeSearch({ query: '2023CS077', searchType: 'Admission Number' });
  assert.equal(netRes.result, 'NETWORK_ERROR');

  // 4. INVALID_RESPONSE test (missing credentials)
  const invalidSearchService = new AdminSearchService({
    dbService: db,
    mockMode: true,
    mockCredentialHandler: async () => ({ status: 'INVALID_RESPONSE' })
  });
  const invRes = await invalidSearchService.executeSearch({ query: '2023CS077', searchType: 'Admission Number' });
  assert.equal(invRes.result, 'INVALID_RESPONSE');

  // Verify all 4 logs were logged with exact result status
  const logs = await db.listSearchLogs();
  const statuses = logs.logs.map(l => l.result);
  assert.ok(statuses.includes('API_ERROR'));
  assert.ok(statuses.includes('TIMEOUT'));
  assert.ok(statuses.includes('NETWORK_ERROR'));
  assert.ok(statuses.includes('INVALID_RESPONSE'));
});

test('AdminSearchService - Handles empty and invalid search inputs', async () => {
  const db = new AdminDbService();
  const searchService = new AdminSearchService({ dbService: db });

  const res1 = await searchService.executeSearch({ query: '' });
  assert.equal(res1.result, 'INVALID_INPUT');

  const res2 = await searchService.executeSearch({ query: '   ' });
  assert.equal(res2.result, 'INVALID_INPUT');

  const logs = await db.listSearchLogs();
  assert.equal(logs.total, 2);
  assert.equal(logs.logs[0].result, 'INVALID_INPUT');
});

test('AdminSearchService - Handles camelCase searchType and intelligent 10-digit admission resolution', async () => {
  const db = new AdminDbService();
  await db.upsertStudent({
    name: 'Kavita Joshi',
    admission_number: '9599099932',
    phone_number: '9876543210',
    username: '',
    password: '',
    section: 'CSE-D'
  });

  let credentialApiCalled = false;
  const searchService = new AdminSearchService({
    dbService: db,
    mockMode: true,
    mockCredentialHandler: async () => {
      credentialApiCalled = true;
      return { status: 'SUCCESS', username: 'kavita95', password: 'pass_kavita_123' };
    }
  });

  // 1. camelCase 'admissionNumber' forces Admission Number
  assert.equal(searchService.resolveSearchType('9599099932', 'admissionNumber'), 'Admission Number');
  assert.equal(searchService.resolveSearchType('9876543210', 'phoneNumber'), 'Phone Number');

  // 2. Querying 10-digit '9599099932' with 'all' resolves to Admission Number because student exists by adm
  const res = await searchService.executeSearch({
    query: '9599099932',
    searchType: 'all'
  });

  assert.equal(credentialApiCalled, true);
  assert.equal(res.result, 'SUCCESS');
  assert.equal(res.students[0].username, 'kavita95');
});

test('Admin API - Search and Search-Logs HTTP Endpoints with Auth', async () => {
  const http = require('node:http');
  const app = require('../src/app');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  function req(urlPath, options = {}, body = null) {
    return new Promise((resolve, reject) => {
      const u = new URL(urlPath, baseUrl);
      const request = http.request(u, options, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          let json = null;
          try { if (raw) json = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, data: json, raw });
        });
      });
      request.on('error', reject);
      if (body) {
        request.setHeader('Content-Type', 'application/json');
        request.write(JSON.stringify(body));
      }
      request.end();
    });
  }

  try {
    // 1. Unauthenticated requests must be rejected
    const unauthLogs = await req('/api/admin/search-logs');
    assert.equal(unauthLogs.status, 401);

    const unauthStats = await req('/api/admin/search-logs/stats');
    assert.equal(unauthStats.status, 401);

    // 2. Authenticate as admin
    const loginRes = await req('/api/admin/login', { method: 'POST' }, {
      username: 'inexpert_trifler',
      password: 'om sai 0987654321'
    });
    assert.equal(loginRes.status, 200);
    const token = loginRes.data.token;
    assert.ok(token);

    const authHeaders = { 'Authorization': `Bearer ${token}` };

    // 3. Clear existing logs first
    const clearRes = await req('/api/admin/search-logs', { method: 'DELETE', headers: authHeaders });
    assert.equal(clearRes.status, 200);

    // 4. Perform search via POST /api/admin/search
    const searchRes = await req('/api/admin/search', { method: 'POST', headers: authHeaders }, {
      query: '2023NonExistentAdm',
      searchType: 'Admission Number'
    });
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.data.result, 'NOT_FOUND');

    // 5. Query /api/admin/search-logs
    const listRes = await req('/api/admin/search-logs', { headers: authHeaders });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.data.success, true);
    assert.equal(listRes.data.total, 1);
    assert.equal(listRes.data.logs[0].search_query, '2023NonExistentAdm');
    assert.equal(listRes.data.logs[0].result, 'NOT_FOUND');

    // 6. Query /api/admin/search-logs/stats
    const statsRes = await req('/api/admin/search-logs/stats', { headers: authHeaders });
    assert.equal(statsRes.status, 200);
    assert.equal(statsRes.data.success, true);
    assert.equal(statsRes.data.stats.totalSearches, 1);
    assert.equal(statsRes.data.stats.studentsNotFound, 1);

    // 7. Cleanup
    await req('/api/admin/search-logs', { method: 'DELETE', headers: authHeaders });
  } finally {
    server.close();
  }
});
