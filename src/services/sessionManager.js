'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

class SessionManager {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs || config.sessionTtlMs;
    this.maxSessions = options.maxSessions || config.maxConcurrentSessions;
    this.tempDir = options.tempDir || config.tempStorageDir;
    this.sessions = new Map();

    // Ensure temporary downloads directory exists safely without crashing on read-only file systems
    try {
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }
    } catch (err) {
      try {
        this.tempDir = path.join(os.tmpdir(), 'exam_temp_downloads');
        if (!fs.existsSync(this.tempDir)) {
          fs.mkdirSync(this.tempDir, { recursive: true });
        }
      } catch (fallbackErr) {
        // Safe suppression of startup error
      }
    }

    // Periodic sweep for expired sessions
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 30000);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Creates a new isolated automation session
   */
  createSession(studentIdentifier) {
    if (this.sessions.size >= this.maxSessions) {
      this.cleanupExpired();
      if (this.sessions.size >= this.maxSessions) {
        throw new Error('System is currently at maximum capacity. Please try again shortly.');
      }
    }

    const sessionId = uuidv4();
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const now = Date.now();

    let sessionTempDir = path.join(this.tempDir, sessionId);
    try {
      if (!fs.existsSync(sessionTempDir)) {
        fs.mkdirSync(sessionTempDir, { recursive: true });
      }
    } catch (err) {
      this.tempDir = path.join(os.tmpdir(), 'exam_temp_downloads');
      sessionTempDir = path.join(this.tempDir, sessionId);
      try {
        if (!fs.existsSync(sessionTempDir)) {
          fs.mkdirSync(sessionTempDir, { recursive: true });
        }
      } catch (fallbackErr) {
        // Safe suppression
      }
    }

    const session = {
      sessionId,
      sessionToken,
      studentIdentifier,
      status: 'initializing',
      stage: 1,
      stageMessage: 'Validating student identifier...',
      progressPercent: 10,
      browserContext: null,
      page: null,
      renderedHtml: null,
      examSummary: null,
      resultData: null,
      downloadedFile: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
      tempDir: sessionTempDir
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Retrieves a session by ID and verifies the session token
   */
  getSession(sessionId, sessionToken) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      // Attempt restoration from temp disk
      try {
        const sessionTempDir = path.join(this.tempDir, sessionId);
        const stateFile = path.join(sessionTempDir, 'state.json');
        if (fs.existsSync(stateFile)) {
          const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          session = {
            ...loaded,
            browserContext: null,
            page: null
          };
          this.sessions.set(sessionId, session);
        }
      } catch (err) {
        // Safe suppression
      }
    }

    if (!session) {
      return null;
    }

    if (sessionToken && session.sessionToken !== sessionToken) {
      const err = new Error('Unauthorized session access.');
      err.statusCode = 403;
      err.code = 'SESSION_TOKEN_MISMATCH';
      throw err;
    }

    if (Date.now() > session.expiresAt) {
      this.closeSession(sessionId);
      return null;
    }

    // Touch session on activity
    session.updatedAt = Date.now();
    return session;
  }

  /**
   * Updates session progress
   */
  updateProgress(sessionId, stage, stageMessage, progressPercent, extra = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.stage = stage;
    session.stageMessage = stageMessage;
    session.progressPercent = progressPercent;
    session.updatedAt = Date.now();

    Object.assign(session, extra);

    // Persist session state to disk for multi-container resilience
    try {
      if (session.tempDir) {
        const stateFile = path.join(session.tempDir, 'state.json');
        const publicState = this.toPublicState(session);
        fs.writeFileSync(stateFile, JSON.stringify({
          ...publicState,
          sessionToken: session.sessionToken,
          studentIdentifier: session.studentIdentifier,
          expiresAt: session.expiresAt,
          renderedHtml: session.renderedHtml,
          resultData: session.resultData,
          downloadedFile: session.downloadedFile,
          tempDir: session.tempDir
        }), 'utf8');
      }
    } catch (e) {
      // Safe suppression
    }
  }

  /**
   * Closes a session and cleans up resources
   */
  async closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = 'closed';

    // Close Playwright browser context
    if (session.browserContext) {
      try {
        await session.browserContext.close();
      } catch (err) {
        // Safe suppression of close errors
      }
      session.browserContext = null;
      session.page = null;
    }

    // Clean up temporary files
    if (session.tempDir && fs.existsSync(session.tempDir)) {
      try {
        fs.rmSync(session.tempDir, { recursive: true, force: true });
      } catch (err) {
        // Operational log
      }
    }

    this.sessions.delete(sessionId);
  }

  /**
   * Periodic cleanup of stale sessions
   */
  async cleanupExpired() {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now > session.expiresAt || session.status === 'closed') {
        await this.closeSession(id);
      }
    }
  }

  /**
   * Safe public representation of a session (no secrets, no internal browser handles)
   */
  toPublicState(session) {
    if (!session) return null;

    return {
      sessionId: session.sessionId,
      status: session.status,
      stage: session.stage,
      stageMessage: session.stageMessage,
      progressPercent: session.progressPercent,
      hasRenderedView: Boolean(session.renderedHtml || session.resultData),
      renderedHtml: session.renderedHtml || null,
      resultData: session.resultData || null,
      hasDownloadableFile: Boolean(session.downloadedFile?.ready),
      downloadFileName: session.downloadedFile?.fileName || null,
      downloadUrl: session.downloadedFile?.ready ? `/api/automation/${session.sessionId}/file?token=${session.sessionToken}` : null,
      pdfBase64: session.downloadedFile?.base64 || null,
      examSummary: session.examSummary || null,
      workflowLogs: session.workflowLogs || [],
      error: session.error ? {
        message: session.error.message,
        code: session.error.code || 'AUTOMATION_ERROR'
      } : null
    };
  }
}

module.exports = {
  SessionManager,
  defaultSessionManager: new SessionManager(),
};
