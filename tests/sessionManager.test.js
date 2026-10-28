'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SessionManager } = require('../src/services/sessionManager');

test('SessionManager - Creates unique isolated sessions with secure tokens', () => {
  const testDir = path.join(os.tmpdir(), `test_sm_${Date.now()}`);
  const sm = new SessionManager({ tempDir: testDir, maxSessions: 5, ttlMs: 10000 });

  try {
    const s1 = sm.createSession('9599099932');
    const s2 = sm.createSession('9876543210');

    assert.notEqual(s1.sessionId, s2.sessionId);
    assert.notEqual(s1.sessionToken, s2.sessionToken);
    assert.equal(s1.studentIdentifier, '9599099932');
    assert.equal(s2.studentIdentifier, '9876543210');

    assert.equal(fs.existsSync(s1.tempDir), true);
    assert.equal(fs.existsSync(s2.tempDir), true);
    assert.notEqual(s1.tempDir, s2.tempDir);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('SessionManager - Rejects unauthorized access when session token does not match', () => {
  const testDir = path.join(os.tmpdir(), `test_sm_auth_${Date.now()}`);
  const sm = new SessionManager({ tempDir: testDir });

  try {
    const session = sm.createSession('9599099932');

    // Matching token succeeds
    const retrieved = sm.getSession(session.sessionId, session.sessionToken);
    assert.ok(retrieved);
    assert.equal(retrieved.sessionId, session.sessionId);

    // Mismatched token throws 403
    assert.throws(
      () => sm.getSession(session.sessionId, 'invalid_attacker_token_xyz'),
      {
        statusCode: 403,
        code: 'SESSION_TOKEN_MISMATCH'
      }
    );
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('SessionManager - Cleans up temporary files and session records on closeSession', async () => {
  const testDir = path.join(os.tmpdir(), `test_sm_cleanup_${Date.now()}`);
  const sm = new SessionManager({ tempDir: testDir });

  try {
    const session = sm.createSession('9599099932');
    const sessionTempFile = path.join(session.tempDir, 'test_marksheet.pdf');
    fs.writeFileSync(sessionTempFile, '%PDF-1.4\ntest');

    assert.equal(fs.existsSync(sessionTempFile), true);

    await sm.closeSession(session.sessionId);

    // Temp directory and file are completely deleted
    assert.equal(fs.existsSync(session.tempDir), false);
    assert.equal(sm.getSession(session.sessionId), null);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('SessionManager - toPublicState strips internal details and secrets', () => {
  const testDir = path.join(os.tmpdir(), `test_sm_pub_${Date.now()}`);
  const sm = new SessionManager({ tempDir: testDir });

  try {
    const session = sm.createSession('9599099932');
    session.browserContext = { dummy: true };
    session.page = { dummy: true };
    session.renderedHtml = '<div>marksheet</div>';

    const pub = sm.toPublicState(session);

    assert.equal(pub.sessionId, session.sessionId);
    assert.equal(pub.hasRenderedView, true);
    assert.equal(pub.sessionToken, undefined);
    assert.equal(pub.browserContext, undefined);
    assert.equal(pub.page, undefined);
    assert.equal(pub.tempDir, undefined);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});
