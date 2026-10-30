'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const { defaultDbService } = require('./dbService');

class SessionManager {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs || config.sessionTtlMs;
    this.maxSessions = options.maxSessions || config.maxConcurrentSessions || 300;
    this.tempDir = options.tempDir || config.tempStorageDir;
    this.dbService = options.dbService || defaultDbService;
    this.sessions = new Map();

    // Ensure temporary storage directory exists safely without crashing on read-only file systems
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
   * Finds an existing active or ready session for a student number
   * to prevent duplicate concurrent workflows.
   */
  findActiveSessionByStudent(studentIdentifier) {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.studentIdentifier === studentIdentifier && now < session.expiresAt) {
        if (
          session.status === 'initializing' ||
          session.status === 'queued' ||
          session.status === 'processing' ||
          (session.status === 'ready' && now - session.updatedAt < 60000)
        ) {
          return session;
        }
      }
    }
    return null;
  }

  /**
   * Calculates the queue position of a session if queued
   */
  getQueuePosition(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'queued') return 0;

    let position = 1;
    for (const s of this.sessions.values()) {
      if (s.status === 'queued' && s.createdAt < session.createdAt) {
        position++;
      }
    }
    return position;
  }

  /**
   * Creates a new isolated automation session
   */
  createSession(studentIdentifier, initialExtra = {}) {
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
      status: initialExtra.status || 'initializing',
      stage: initialExtra.stage || 1,
      stageMessage: initialExtra.stageMessage || 'Validating student identifier...',
      progressPercent: initialExtra.progressPercent || 10,
      browserContext: null,
      page: null,
      renderedHtml: null,
      examSummary: null,
      resultData: null,
      downloadedFile: null,
      error: null,
      workflowLogs: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
      tempDir: sessionTempDir,
      ...initialExtra
    };

    this.sessions.set(sessionId, session);
    this.dbService.saveSession(session).catch(() => {});
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
    this.dbService.saveSession(session).catch(() => {});

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
   * Restores a session from durable Neon DB store if not found in memory
   */
  async restoreSessionFromDb(sessionId, sessionToken) {
    if (!sessionId) return null;
    let session = this.sessions.get(sessionId);
    if (session) {
      if (sessionToken && session.sessionToken !== sessionToken) {
        const err = new Error('Unauthorized session access.');
        err.statusCode = 403;
        err.code = 'SESSION_TOKEN_MISMATCH';
        throw err;
      }
      return session;
    }

    try {
      const restored = await this.dbService.getSession(sessionId, sessionToken);
      if (restored) {
        const restoredSession = {
          browserContext: null,
          page: null,
          workflowLogs: [],
          tempDir: path.join(this.tempDir, restored.sessionId),
          ...restored
        };
        this.sessions.set(sessionId, restoredSession);
        return restoredSession;
      }
    } catch (err) {
      if (err.code === 'SESSION_TOKEN_MISMATCH') throw err;
    }
    return null;
  }

  /**
   * Closes a session and cleans up resources
   */
  async closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.dbService.deleteSession(sessionId).catch(() => {});
      return;
    }

    session.status = 'closed';

    if (session.browserContext) {
      try {
        await session.browserContext.close();
      } catch (err) {
        // Safe suppression
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
    this.dbService.deleteSession(sessionId).catch(() => {});
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
   * Safe public representation of a session (no secrets, no internal handles, no PDF tracking)
   */
  toPublicState(session) {
    if (!session) return null;

    const queuePosition = session.status === 'queued' ? this.getQueuePosition(session.sessionId) : 0;

    return {
      sessionId: session.sessionId,
      studentIdentifier: session.studentIdentifier,
      studentNumber: session.studentIdentifier,
      status: session.status,
      stage: session.stage,
      stageMessage: session.status === 'queued'
        ? `Waiting in queue (position ${queuePosition})...`
        : session.stageMessage,
      progressPercent: session.progressPercent,
      queuePosition: queuePosition > 0 ? queuePosition : undefined,
      hasRenderedView: Boolean(session.renderedHtml || session.resultData),
      renderedHtml: session.renderedHtml || null,
      resultData: session.resultData || null,
      overallYgpa: session.resultData?.overallYgpa || session.resultData?.annualSummary?.ygpa || null,
      overallRemarks: session.resultData?.overallRemarks || session.resultData?.annualSummary?.status || null,
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
