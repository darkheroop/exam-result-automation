'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { CredentialService, CredentialError } = require('../src/services/credentialService');

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let parsed = null;
        try { if (body) parsed = JSON.parse(body); } catch {}
        handler(req, res, parsed);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`
      });
    });
  });
}

test('CredentialService - Mock mode returns test credentials without external calls', async () => {
  const service = new CredentialService({ mockMode: true });
  const result = await service.fetchCredentials('9599099932');
  assert.equal(result.username, 'mock_student');
  assert.equal(result.password, 'mock_password_123');
  assert.equal(result.studentNumber, '9599099932');
});

test('CredentialService - Throws 503 if API configuration (URL or key) is missing', async () => {
  const serviceNoUrl = new CredentialService({ apiUrl: '', apiKey: 'some_key' });
  await assert.rejects(
    () => serviceNoUrl.fetchCredentials('9599099932'),
    (err) => {
      assert.equal(err.name, 'CredentialError');
      assert.equal(err.statusCode, 503);
      assert.equal(err.code, 'CREDENTIAL_CONFIG_MISSING');
      return true;
    }
  );

  const serviceNoKey = new CredentialService({ apiUrl: 'https://example.com/api', apiKey: '' });
  await assert.rejects(
    () => serviceNoKey.fetchCredentials('9599099932'),
    (err) => {
      assert.equal(err.name, 'CredentialError');
      assert.equal(err.statusCode, 503);
      assert.equal(err.code, 'CREDENTIAL_CONFIG_MISSING');
      return true;
    }
  );
});

test('CredentialService - Sends single POST request with Bearer token and studentNumber', async () => {
  let requestCount = 0;
  let capturedHeaders = null;
  let capturedBody = null;

  const mockServer = await startMockServer((req, res, body) => {
    requestCount++;
    capturedHeaders = req.headers;
    capturedBody = body;

    assert.equal(req.method, 'POST');
    assert.equal(req.headers['authorization'], 'Bearer test_auth_bearer_token');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(body.studentNumber, '0012345678');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      username: 'student_verified',
      password: 'authorized_password_xyz'
    }));
  });

  try {
    const service = new CredentialService({
      apiUrl: `${mockServer.url}/api/lookup`,
      apiKey: 'test_auth_bearer_token'
    });

    const result = await service.fetchCredentials('0012345678');

    assert.equal(requestCount, 1, 'Only one single HTTP request should be sent');
    assert.equal(result.username, 'student_verified');
    assert.equal(result.password, 'authorized_password_xyz');
    assert.equal(result.studentNumber, '0012345678');
  } finally {
    mockServer.server.close();
  }
});

test('CredentialService - Handles 404 student not found', async () => {
  const mockServer = await startMockServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: { code: 'STUDENT_NOT_FOUND', message: 'No student found' }
    }));
  });

  try {
    const service = new CredentialService({
      apiUrl: mockServer.url,
      apiKey: 'test_key'
    });

    await assert.rejects(
      () => service.fetchCredentials('0000000000'),
      (err) => {
        assert.equal(err.name, 'CredentialError');
        assert.equal(err.statusCode, 404);
        assert.equal(err.code, 'STUDENT_NOT_FOUND');
        return true;
      }
    );
  } finally {
    mockServer.server.close();
  }
});

test('CredentialService - Handles 401/403 authorization error', async () => {
  const mockServer = await startMockServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: { message: 'Invalid or missing Bearer token' }
    }));
  });

  try {
    const service = new CredentialService({
      apiUrl: mockServer.url,
      apiKey: 'invalid_key'
    });

    await assert.rejects(
      () => service.fetchCredentials('9599099932'),
      (err) => {
        assert.equal(err.name, 'CredentialError');
        assert.equal(err.statusCode, 502);
        assert.equal(err.code, 'API_AUTH_ERROR');
        return true;
      }
    );
  } finally {
    mockServer.server.close();
  }
});

test('CredentialService - Rejects response with success: false', async () => {
  const mockServer = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      message: 'Lookup unsuccessful for specified identifier.'
    }));
  });

  try {
    const service = new CredentialService({
      apiUrl: mockServer.url,
      apiKey: 'test_key'
    });

    await assert.rejects(
      () => service.fetchCredentials('9599099932'),
      (err) => {
        assert.equal(err.name, 'CredentialError');
        assert.equal(err.code, 'LOOKUP_FAILED');
        return true;
      }
    );
  } finally {
    mockServer.server.close();
  }
});

test('CredentialService - Rejects incomplete credentials (missing password or username)', async () => {
  const mockServer = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      username: 'student123',
      password: '' // empty password
    }));
  });

  try {
    const service = new CredentialService({
      apiUrl: mockServer.url,
      apiKey: 'test_key'
    });

    await assert.rejects(
      () => service.fetchCredentials('9599099932'),
      (err) => {
        assert.equal(err.name, 'CredentialError');
        assert.equal(err.code, 'INCOMPLETE_CREDENTIAL_DATA');
        return true;
      }
    );
  } finally {
    mockServer.server.close();
  }
});
