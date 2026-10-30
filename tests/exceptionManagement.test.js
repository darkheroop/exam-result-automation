'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = require('../src/app');
const { AdminDbService, defaultAdminDbService } = require('../src/services/adminDbService');
const { AutomationService } = require('../src/services/automationService');
const { SessionManager } = require('../src/services/sessionManager');
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
      if (typeof body === 'string') {
        req.write(body);
      } else {
        req.setHeader('Content-Type', 'application/json');
        req.write(JSON.stringify(body));
      }
    }
    req.end();
  });
}

// =========================================================================
// Scenario 1: AdminDbService Exception CRUD & Data Integrity
// =========================================================================
test('Exception Management - DB Service CRUD, leading zero preservation, and search', async () => {
  const db = new AdminDbService();

  // 1. Create with leading zeros and multiline message
  const studentNum = '0098765432';
  const customMessage = 'Results on hold.\nPlease meet Dean Academics.\nRoom 204.';

  const created = await db.createException({
    student_number: studentNum,
    custom_message: customMessage
  });

  assert.ok(created.id, 'Must generate an ID');
  assert.equal(created.student_number, '0098765432', 'Leading zeros must be strictly preserved');
  assert.equal(created.custom_message, customMessage, 'Multiline message must be preserved exactly');
  assert.ok(created.created_at, 'Must have created_at timestamp');
  assert.ok(created.updated_at, 'Must have updated_at timestamp');

  // 2. Lookup by student number
  const fetchedByNum = await db.getExceptionByStudentNumber('0098765432');
  assert.ok(fetchedByNum, 'Must find exception by student number');
  assert.equal(fetchedByNum.id, created.id);
  assert.equal(fetchedByNum.custom_message, customMessage);

  // 3. Lookup by ID
  const fetchedById = await db.getExceptionById(created.id);
  assert.ok(fetchedById, 'Must find exception by primary key ID');
  assert.equal(fetchedById.student_number, '0098765432');

  // 4. Duplicate prevention
  await assert.rejects(
    async () => {
      await db.createException({
        student_number: '0098765432',
        custom_message: 'Duplicate attempt'
      });
    },
    (err) => {
      assert.equal(err.code, 'DUPLICATE_EXCEPTION');
      return true;
    },
    'Must throw DUPLICATE_EXCEPTION when creating with existing student number'
  );

  // 5. Update exception message
  const updatedMessage = 'Updated notice: Contact Exam Cell urgently.';
  const updated = await db.updateException(created.id, {
    custom_message: updatedMessage
  });
  assert.ok(updated);
  assert.equal(updated.custom_message, updatedMessage);
  assert.equal(updated.student_number, '0098765432');

  // 6. List and search
  const list1 = await db.listExceptions({ search: 'Exam Cell' });
  assert.equal(list1.total, 1);
  assert.equal(list1.exceptions[0].student_number, '0098765432');

  const list2 = await db.listExceptions({ search: '009876' });
  assert.equal(list2.total, 1);

  // 7. Delete exception
  const deleteRes = await db.deleteException(created.id);
  assert.equal(deleteRes.success, true);
  assert.equal(deleteRes.deleted, true);

  const afterDelete = await db.getExceptionByStudentNumber('0098765432');
  assert.equal(afterDelete, null, 'Must be null after deletion');
});

// =========================================================================
// Scenario 2: Admin HTTP API Endpoints with Auth & Validation
// =========================================================================
test('Exception Management - Admin API Endpoints with Auth, 409 Duplicate, and Validation', async () => {
  const { server, url } = await startTestServer();

  try {
    // 1. Unauthenticated requests must be rejected
    const unauthGet = await requestJson(`${url}/api/admin/exceptions`);
    assert.equal(unauthGet.statusCode, 401, 'Unauthenticated GET must be 401');

    const unauthPost = await requestJson(`${url}/api/admin/exceptions`, { method: 'POST' }, {
      student_number: '9123456789',
      custom_message: 'Test'
    });
    assert.equal(unauthPost.statusCode, 401, 'Unauthenticated POST must be 401');

    // 2. Authenticate admin
    const loginRes = await requestJson(`${url}/api/admin/login`, { method: 'POST' }, {
      username: 'inexpert_trifler',
      password: process.env.ADMIN_PASSWORD || 'om sai 0987654321'
    });
    assert.equal(loginRes.statusCode, 200);
    const adminToken = loginRes.data.token;
    assert.ok(adminToken, 'Must receive admin session token');

    const authHeaders = {
      'Authorization': `Bearer ${adminToken}`,
      'x-admin-token': adminToken
    };

    // 3. Create exception via API
    const postRes1 = await requestJson(`${url}/api/admin/exceptions`, {
      method: 'POST',
      headers: authHeaders
    }, {
      student_number: '0011223344',
      custom_message: 'Your registration is temporarily suspended.\nPlease contact administrative desk.'
    });
    assert.equal(postRes1.statusCode, 201, 'Must return 201 Created');
    assert.equal(postRes1.data.success, true);
    assert.equal(postRes1.data.data.student_number, '0011223344');
    const createdId = postRes1.data.data.id;

    // 4. Duplicate entry must return 409 Conflict
    const postResDup = await requestJson(`${url}/api/admin/exceptions`, {
      method: 'POST',
      headers: authHeaders
    }, {
      student_number: '0011223344',
      custom_message: 'Another message'
    });
    assert.equal(postResDup.statusCode, 409, 'Duplicate student number must return 409 Conflict');
    assert.equal(postResDup.data.error.code, 'DUPLICATE_EXCEPTION');

    // 5. Get list
    const getListRes = await requestJson(`${url}/api/admin/exceptions`, {
      method: 'GET',
      headers: authHeaders
    });
    assert.equal(getListRes.statusCode, 200);
    assert.ok(Array.isArray(getListRes.data.exceptions));
    const found = getListRes.data.exceptions.find(e => e.student_number === '0011223344');
    assert.ok(found, 'Created exception must be in list');

    // 6. Get single
    const getSingleRes = await requestJson(`${url}/api/admin/exceptions/${createdId}`, {
      method: 'GET',
      headers: authHeaders
    });
    assert.equal(getSingleRes.statusCode, 200);
    assert.equal(getSingleRes.data.exception.student_number, '0011223344');

    // 7. Update via PUT
    const putRes = await requestJson(`${url}/api/admin/exceptions/${createdId}`, {
      method: 'PUT',
      headers: authHeaders
    }, {
      custom_message: 'Updated message: Resolved, but please report to Room 101.'
    });
    assert.equal(putRes.statusCode, 200);
    assert.equal(putRes.data.exception.custom_message, 'Updated message: Resolved, but please report to Room 101.');

    // 8. Delete via DELETE
    const delRes = await requestJson(`${url}/api/admin/exceptions/${createdId}`, {
      method: 'DELETE',
      headers: authHeaders
    });
    assert.equal(delRes.statusCode, 200);
    assert.equal(delRes.data.success, true);

    // 9. Verify gone
    const verifyGet = await requestJson(`${url}/api/admin/exceptions/${createdId}`, {
      method: 'GET',
      headers: authHeaders
    });
    assert.equal(verifyGet.statusCode, 404);
  } finally {
    server.close();
  }
});

// =========================================================================
// Scenario 3: Public Result Search Early Intercept (No API / Portal Call)
// =========================================================================
test('Exception Management - Public Result Search blocks portal call, returns custom message safely', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager({ maxSessions: 50 });

  let credentialLookupCalled = false;
  let portalAuthCalled = false;

  const mockCredentialService = {
    lookupCredentials: async () => {
      credentialLookupCalled = true;
      return { username: 'test_user', password: 'test_password' };
    }
  };

  const autoService = new AutomationService({
    adminDbService: adminDb,
    sessionManager,
    credentialService: mockCredentialService,
    portalAuthHandler: async () => {
      portalAuthCalled = true;
      return { id: '12345', mobile: '9988776655' };
    }
  });

  // Pre-seed an exception for student 9988776655
  const customMessage = 'Result withheld: Document verification required at Registrar Office.';
  await adminDb.createException({
    student_number: '9988776655',
    custom_message: customMessage
  });

  // Also pre-seed student with saved credentials in database to ensure they are NOT used
  await adminDb.upsertStudent({
    name: 'Blocked Student',
    admission_number: 'ADM9988',
    phone_number: '9988776655',
    username: 'pre_saved_user',
    password: 'pre_saved_password'
  });

  // Execute workflow
  const session = sessionManager.createSession('9988776655');
  await autoService.executeWorkflow(session.sessionId, session.sessionToken, '9988776655');

  // Verify assertions:
  // A. Credential API was NOT called
  assert.equal(credentialLookupCalled, false, 'Credential lookup API must NOT be called for exception student');

  // B. Student portal was NOT called
  assert.equal(portalAuthCalled, false, 'Student portal login must NOT be attempted for exception student');

  // C. Session status is exception and message matches
  assert.equal(session.status, 'exception');
  assert.equal(session.isException, true);
  assert.equal(session.customMessage, customMessage);

  // D. Public state includes custom message
  const publicState = sessionManager.toPublicState(session);
  assert.equal(publicState.status, 'exception');
  assert.equal(publicState.isException, true);
  assert.equal(publicState.customMessage, customMessage);
  assert.equal(publicState.hasRenderedView, false, 'No exam marksheet should be rendered');

  // E. Search logs recorded the exception
  const logs = await adminDb.listSearchLogs({ search: '9988776655' });
  assert.ok(logs.logs.length > 0);
  assert.equal(logs.logs[0].result, 'EXCEPTION');
});

// =========================================================================
// Scenario 4: Non-Exception Students Proceed Normally
// =========================================================================
test('Exception Management - Non-exception student numbers proceed normally', async () => {
  const adminDb = new AdminDbService();
  const sessionManager = new SessionManager({ maxSessions: 50 });

  let portalAuthCalled = false;

  const autoService = new AutomationService({
    adminDbService: adminDb,
    sessionManager,
    mockMode: true,
    portalAuthHandler: async (user, pass, num) => {
      portalAuthCalled = true;
      return { id: '8888', mobile: num, firstName: 'Valid', lastName: 'Student' };
    }
  });

  // Pre-seed normal student with saved credentials
  await adminDb.upsertStudent({
    name: 'Normal Student',
    admission_number: 'ADM8888',
    phone_number: '9888888888',
    username: 'normal_user',
    password: 'normal_password'
  });

  const session = sessionManager.createSession('9888888888');
  await autoService.executeWorkflow(session.sessionId, session.sessionToken, '9888888888');

  // Non-exception student must NOT have status 'exception'
  assert.notEqual(session.status, 'exception');
  assert.notEqual(session.isException, true);
  assert.equal(portalAuthCalled, true, 'Portal auth should have been called for non-exception student');
});

// =========================================================================
// Scenario 5: Public Search API Endpoint (/api/automation/start) Exception Response
// =========================================================================
test('Exception Management - POST /api/automation/start returns exception status immediately', async () => {
  const { server, url } = await startTestServer();

  try {
    const studentNum = '9191919191';
    const customMessage = 'Notice: Fee dues pending.\nPlease contact Accounts Department.\nHelpline: 0120-123456';

    // Seed exception in defaultAdminDbService
    await defaultAdminDbService.createException({
      student_number: studentNum,
      custom_message: customMessage
    });

    const startRes = await requestJson(`${url}/api/automation/start`, { method: 'POST' }, {
      studentNumber: studentNum
    });

    assert.equal(startRes.statusCode, 200, 'Exception search should return 200 with notice');
    assert.equal(startRes.data.status, 'exception');
    assert.equal(startRes.data.isException, true);
    assert.equal(startRes.data.customMessage, customMessage);
    assert.equal(startRes.data.message, customMessage);

    // Verify polling status endpoint also returns exception
    const statusRes = await requestJson(`${url}/api/automation/status/${startRes.data.sessionId}`, {
      headers: { 'x-session-token': startRes.data.sessionToken }
    });
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.data.data.status, 'exception');
    assert.equal(statusRes.data.data.isException, true);
    assert.equal(statusRes.data.data.customMessage, customMessage);
  } finally {
    server.close();
  }
});

// =========================================================================
// Scenario 6: UI & Client Integrity Checks
// =========================================================================
test('Exception Management - UI Components & Scripts Integrity', () => {
  const adminIndexHtml = fs.readFileSync(path.resolve(__dirname, '../public/admin/index.html'), 'utf8');
  const adminJs = fs.readFileSync(path.resolve(__dirname, '../public/admin/admin.js'), 'utf8');
  const rootAdminJs = fs.readFileSync(path.resolve(__dirname, '../public/admin.js'), 'utf8');
  const publicAppJs = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');

  // 1. Sidebar Nav
  assert.ok(adminIndexHtml.includes('id="nav-tab-exceptions"'), 'Must have nav item for Exception Management');
  assert.ok(adminIndexHtml.includes('Exception Management'), 'Must have nav label Exception Management');

  // 2. View Container
  assert.ok(adminIndexHtml.includes('id="view-exceptions"'), 'Must have view container #view-exceptions');
  assert.ok(adminIndexHtml.includes('id="btn-open-add-exception"'), 'Must have Add Exception button');
  assert.ok(adminIndexHtml.includes('id="exceptions-table"'), 'Must have exceptions data table');
  assert.ok(adminIndexHtml.includes('Student Number') && adminIndexHtml.includes('Custom Message'), 'Must have required table column headers');

  // 3. Modals
  assert.ok(adminIndexHtml.includes('id="modal-add-exception"'), 'Must have Add Exception modal');
  assert.ok(adminIndexHtml.includes('id="modal-edit-exception"'), 'Must have Edit Exception modal');
  assert.ok(adminIndexHtml.includes('id="modal-delete-exception"'), 'Must have Delete Exception modal');

  // 4. Admin JS features
  assert.ok(adminJs.includes('loadExceptions'), 'admin.js must implement loadExceptions');
  assert.ok(adminJs.includes('renderExceptionsTable'), 'admin.js must implement renderExceptionsTable');
  assert.ok(adminJs.includes('/api/admin/exceptions'), 'admin.js must query /api/admin/exceptions');

  // 5. Syntax validation for admin.js
  assert.doesNotThrow(() => {
    new vm.Script(adminJs);
  }, 'public/admin/admin.js must have valid JavaScript syntax');

  // 6. Sync check between public/admin/admin.js and public/admin.js
  assert.equal(adminJs, rootAdminJs, 'public/admin/admin.js and public/admin.js must be in exact sync');

  // 7. Public search app.js displays exception notice safely
  assert.ok(publicAppJs.includes('showExceptionNotice'), 'public/app.js must implement showExceptionNotice');
  assert.ok(publicAppJs.includes('pre-wrap'), 'public/app.js must preserve line breaks');
});
