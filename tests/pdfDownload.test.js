'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/app');
const { SessionManager } = require('../src/services/sessionManager');
const { AutomationService } = require('../src/services/automationService');
const { CredentialService } = require('../src/services/credentialService');

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

test('PDF Deprecation - POST /api/automation/:sessionId/download returns 404', async () => {
  const { server, url } = await startTestServer();
  try {
    const res = await requestJson(`${url}/api/automation/session-123/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(res.statusCode, 404);
  } finally {
    server.close();
  }
});

test('PDF Deprecation - GET /api/automation/download/:sessionId returns 404', async () => {
  const { server, url } = await startTestServer();
  try {
    const res = await requestJson(`${url}/api/automation/download/session-123`, {
      method: 'GET'
    });
    assert.equal(res.statusCode, 404);
  } finally {
    server.close();
  }
});

test('PDF Deprecation - GET /api/automation/:sessionId/file returns 404', async () => {
  const { server, url } = await startTestServer();
  try {
    const res = await requestJson(`${url}/api/automation/session-123/file`, {
      method: 'GET'
    });
    assert.equal(res.statusCode, 404);
  } finally {
    server.close();
  }
});

test('Direct Result Retrieval - Marksheet data is returned directly without PDF paths or download URLs', async () => {
  const sessionManager = new SessionManager();
  const automationService = new AutomationService({
    sessionManager,
    credentialService: new CredentialService({ mockMode: true }),
    mockMode: true,
    mockDelayMs: 5
  });

  const studentNumber = '9599099932';
  const session = sessionManager.createSession(studentNumber);

  await automationService.runWorkflow(session.sessionId, session.sessionToken, studentNumber);

  const updatedSession = sessionManager.getSession(session.sessionId, session.sessionToken);
  assert.equal(updatedSession.status, 'ready');
  assert.ok(updatedSession.resultData);
  assert.equal(updatedSession.resultData.student.studentNumber, studentNumber);

  const pubState = sessionManager.toPublicState(updatedSession);

  // Assert complete absence of PDF fields
  assert.equal(pubState.downloadFileName, undefined);
  assert.equal(pubState.downloadUrl, undefined);
  assert.equal(pubState.hasDownloadableFile, undefined);
  assert.equal(pubState.pdfBase64, undefined);
  assert.equal(pubState.filePath, undefined);

  // Assert direct structured result availability
  assert.ok(pubState.resultData);
  assert.equal(pubState.resultData.student.studentNumber, studentNumber);
  assert.ok(Array.isArray(pubState.resultData.semesters));
});
