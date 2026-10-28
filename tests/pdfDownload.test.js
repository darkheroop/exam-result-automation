'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
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

test('PDF Download - Validates and securely streams downloaded PDF document', async () => {
  const { server, url } = await startTestServer();
  const session = defaultSessionManager.createSession('9599099932');

  try {
    const testPdfContent = '%PDF-1.4\n1 0 obj\n<< /Title (Semester Examination Result) >>\nendobj\n%%EOF';
    const filePath = path.join(session.tempDir, 'Semester_Result_9599099932.pdf');
    fs.writeFileSync(filePath, testPdfContent);

    session.downloadedFile = {
      ready: true,
      filePath,
      fileName: 'Semester_Result_9599099932.pdf',
      size: Buffer.byteLength(testPdfContent),
      mimeType: 'application/pdf',
      downloadedAt: Date.now()
    };

    // Fetch the file endpoint with session token
    const fileRes = await new Promise((resolve, reject) => {
      http.get(`${url}/api/automation/${session.sessionId}/file?token=${session.sessionToken}`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data
        }));
      }).on('error', reject);
    });

    assert.equal(fileRes.statusCode, 200);
    assert.equal(fileRes.headers['content-type'], 'application/pdf');
    assert.ok(fileRes.headers['content-disposition'].includes('Semester_Result_9599099932.pdf'));
    assert.equal(fileRes.data.startsWith('%PDF'), true);
  } finally {
    await defaultSessionManager.closeSession(session.sessionId);
    server.close();
  }
});

test('PDF Download - Rejects unauthorized request without session token', async () => {
  const { server, url } = await startTestServer();
  const session = defaultSessionManager.createSession('9599099932');

  try {
    const fileRes = await new Promise((resolve, reject) => {
      http.get(`${url}/api/automation/${session.sessionId}/file?token=invalid_token`, (res) => {
        resolve({ statusCode: res.statusCode });
      }).on('error', reject);
    });

    assert.equal(fileRes.statusCode, 403);
  } finally {
    await defaultSessionManager.closeSession(session.sessionId);
    server.close();
  }
});
