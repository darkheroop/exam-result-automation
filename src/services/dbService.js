'use strict';

require('../config');

let neonClient = null;
try {
  const { neon } = require('@neondatabase/serverless');
  neonClient = neon;
} catch (err) {
  // @neondatabase/serverless optional load
}

class DbService {
  constructor(options = {}) {
    this.connectionString = options.connectionString || this._resolveConnectionString();
    this.sql = null;
    this.schemaInitialized = false;
    this.schemaPromise = null;
    this.isNeonActive = false;

    // Resilient In-Memory Fallback Cache & Stores
    this.memoryCache = new Map();
    this.memorySessions = new Map();
    this.memoryLogs = [];

    this.getSql();
  }

  _resolveConnectionString() {
    return (
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.POSTGRES_PRISMA_URL ||
      process.env.POSTGRES_URL_NON_POOLING ||
      process.env.POSTGRES_URL_NO_SSL ||
      process.env.NEON_DATABASE_URL ||
      null
    );
  }

  getSql() {
    if (this.sql) return this.sql;
    const connStr = this.connectionString || this._resolveConnectionString();
    if (connStr && neonClient) {
      try {
        this.connectionString = connStr;
        this.sql = neonClient(connStr);
        this.isNeonActive = true;
        return this.sql;
      } catch (err) {
        console.warn('[Neon DB] Failed to initialize Neon client tag, falling back to memory:', err.message);
        this.sql = null;
        this.isNeonActive = false;
      }
    }
    return null;
  }

  /**
   * Automatically initializes the required Neon database schema.
   */
  async ensureSchema() {
    if (!this.sql || this.schemaInitialized) return true;
    if (this.schemaPromise) return this.schemaPromise;

    this.schemaPromise = (async () => {
      try {
        await this.sql`
          CREATE TABLE IF NOT EXISTS cached_student_results (
            student_number VARCHAR(16) PRIMARY KEY,
            student_name VARCHAR(128),
            roll_no VARCHAR(64),
            seat_no VARCHAR(64),
            class_name VARCHAR(64),
            academic_year VARCHAR(32),
            session VARCHAR(64),
            ygpa VARCHAR(16),
            status VARCHAR(32),
            total_marks VARCHAR(32),
            credits_earned VARCHAR(32),
            normalized_data JSONB NOT NULL,
            published_on VARCHAR(64),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '7 days')
          );
        `;

        await this.sql`
          CREATE TABLE IF NOT EXISTS durable_sessions (
            session_id VARCHAR(64) PRIMARY KEY,
            session_token VARCHAR(64) NOT NULL,
            student_number VARCHAR(16) NOT NULL,
            status VARCHAR(32) NOT NULL,
            stage INTEGER DEFAULT 1,
            progress_percent INTEGER DEFAULT 0,
            stage_message TEXT,
            result_data JSONB,
            error_message TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '1 hour')
          );
        `;

        await this.sql`
          CREATE TABLE IF NOT EXISTS search_audit_logs (
            id BIGSERIAL PRIMARY KEY,
            student_number VARCHAR(16) NOT NULL,
            cache_hit BOOLEAN DEFAULT FALSE,
            response_time_ms INTEGER NOT NULL,
            status VARCHAR(32) NOT NULL,
            error_code VARCHAR(64),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );
        `;

        await this.sql`
          CREATE INDEX IF NOT EXISTS idx_cached_results_expires ON cached_student_results(expires_at);
        `;

        await this.sql`
          CREATE INDEX IF NOT EXISTS idx_durable_sessions_token ON durable_sessions(session_token);
        `;

        this.schemaInitialized = true;
        return true;
      } catch (err) {
        console.warn('[Neon DB] Schema verification notice (operating with available tables):', err.message);
        return false;
      } finally {
        this.schemaPromise = null;
      }
    })();

    return this.schemaPromise;
  }

  /**
   * Retrieves cached student marksheet result.
   * Returns normalized result if found and not expired.
   */
  async getCachedResult(studentNumber) {
    const cleanNum = String(studentNumber || '').trim();
    if (!cleanNum) return null;

    if (this.sql) {
      try {
        await this.ensureSchema();
        const rows = await this.sql`
          SELECT normalized_data, expires_at
          FROM cached_student_results
          WHERE student_number = ${cleanNum}
            AND expires_at > NOW()
          LIMIT 1;
        `;
        if (rows && rows.length > 0) {
          const row = rows[0];
          return typeof row.normalized_data === 'string'
            ? JSON.parse(row.normalized_data)
            : row.normalized_data;
        }
      } catch (err) {
        console.warn(`[Neon DB] Cache read error for ${cleanNum}, checking memory fallback:`, err.message);
      }
    }

    // Memory fallback
    const memEntry = this.memoryCache.get(cleanNum);
    if (memEntry && memEntry.expiresAt > Date.now()) {
      return memEntry.data;
    }
    return null;
  }

  /**
   * Stores normalized student examination result in cache.
   */
  async setCachedResult(studentNumber, normalizedResult, ttlDays = 7) {
    const cleanNum = String(studentNumber || '').trim();
    if (!cleanNum || !normalizedResult) return false;

    const student = normalizedResult.student || {};
    const annualSummary = normalizedResult.annualSummary || {};

    const studentName = student.fullName || student.name || 'STUDENT';
    const rollNo = student.rollNo || '';
    const seatNo = student.seatNo || '';
    const className = student.className || '';
    const academicYear = student.academicYear || '';
    const session = student.session || '';
    const ygpa = String(student.ygpa || annualSummary.ygpa || '');
    const status = String(student.status || annualSummary.status || 'PASS');
    const totalMarks = String(student.marks || '');
    const creditsEarned = String(student.creditsEarned || '');
    const publishedOn = String(student.publishedOn || '');

    // Memory cache
    this.memoryCache.set(cleanNum, {
      data: normalizedResult,
      expiresAt: Date.now() + (ttlDays * 24 * 60 * 60 * 1000)
    });

    if (this.sql) {
      try {
        await this.ensureSchema();
        const jsonData = JSON.stringify(normalizedResult);
        await this.sql`
          INSERT INTO cached_student_results (
            student_number, student_name, roll_no, seat_no, class_name,
            academic_year, session, ygpa, status, total_marks, credits_earned,
            normalized_data, published_on, updated_at, expires_at
          ) VALUES (
            ${cleanNum}, ${studentName}, ${rollNo}, ${seatNo}, ${className},
            ${academicYear}, ${session}, ${ygpa}, ${status}, ${totalMarks}, ${creditsEarned},
            ${jsonData}::jsonb, ${publishedOn}, NOW(), NOW() + (${ttlDays} || ' days')::interval
          )
          ON CONFLICT (student_number) DO UPDATE SET
            student_name = EXCLUDED.student_name,
            roll_no = EXCLUDED.roll_no,
            seat_no = EXCLUDED.seat_no,
            class_name = EXCLUDED.class_name,
            academic_year = EXCLUDED.academic_year,
            session = EXCLUDED.session,
            ygpa = EXCLUDED.ygpa,
            status = EXCLUDED.status,
            total_marks = EXCLUDED.total_marks,
            credits_earned = EXCLUDED.credits_earned,
            normalized_data = EXCLUDED.normalized_data,
            published_on = EXCLUDED.published_on,
            updated_at = NOW(),
            expires_at = EXCLUDED.expires_at;
        `;
        return true;
      } catch (err) {
        console.warn(`[Neon DB] Cache write error for ${cleanNum}:`, err.message);
        return false;
      }
    }

    return true;
  }

  /**
   * Persists durable session in Neon database.
   */
  async saveSession(session) {
    if (!session || !session.sessionId) return false;

    // Memory fallback update
    this.memorySessions.set(session.sessionId, { ...session });

    if (this.sql) {
      try {
        await this.ensureSchema();
        const resultJson = session.resultData ? JSON.stringify(session.resultData) : null;
        const errMsg = session.error?.message || null;

        await this.sql`
          INSERT INTO durable_sessions (
            session_id, session_token, student_number, status, stage,
            progress_percent, stage_message, result_data, error_message, updated_at
          ) VALUES (
            ${session.sessionId}, ${session.sessionToken}, ${session.studentIdentifier || ''},
            ${session.status || 'initializing'}, ${session.stage || 1}, ${session.progressPercent || 0},
            ${session.stageMessage || ''}, ${resultJson ? this.sql`${resultJson}::jsonb` : null},
            ${errMsg}, NOW()
          )
          ON CONFLICT (session_id) DO UPDATE SET
            status = EXCLUDED.status,
            stage = EXCLUDED.stage,
            progress_percent = EXCLUDED.progress_percent,
            stage_message = EXCLUDED.stage_message,
            result_data = EXCLUDED.result_data,
            error_message = EXCLUDED.error_message,
            updated_at = NOW();
        `;
        return true;
      } catch (err) {
        console.warn(`[Neon DB] Session save error for ${session.sessionId}:`, err.message);
      }
    }

    return true;
  }

  /**
   * Retrieves durable session from Neon database.
   */
  async getSession(sessionId, sessionToken) {
    if (!sessionId) return null;

    if (this.sql) {
      try {
        await this.ensureSchema();
        const rows = await this.sql`
          SELECT * FROM durable_sessions
          WHERE session_id = ${sessionId}
            AND expires_at > NOW()
          LIMIT 1;
        `;

        if (rows && rows.length > 0) {
          const row = rows[0];
          if (sessionToken && row.session_token !== sessionToken) {
            return null; // Invalid token
          }
          return {
            sessionId: row.session_id,
            sessionToken: row.session_token,
            studentIdentifier: row.student_number,
            status: row.status,
            stage: row.stage,
            progressPercent: row.progress_percent,
            stageMessage: row.stage_message,
            resultData: typeof row.result_data === 'string' ? JSON.parse(row.result_data) : row.result_data,
            error: row.error_message ? { message: row.error_message } : null,
            createdAt: new Date(row.created_at).getTime(),
            updatedAt: new Date(row.updated_at).getTime(),
            expiresAt: new Date(row.expires_at).getTime()
          };
        }
      } catch (err) {
        console.warn(`[Neon DB] Session read error for ${sessionId}:`, err.message);
      }
    }

    // Memory fallback
    const memSession = this.memorySessions.get(sessionId);
    if (memSession) {
      if (sessionToken && memSession.sessionToken !== sessionToken) return null;
      return memSession;
    }

    return null;
  }

  /**
   * Deletes session from database.
   */
  async deleteSession(sessionId) {
    if (!sessionId) return false;
    this.memorySessions.delete(sessionId);

    if (this.sql) {
      try {
        await this.ensureSchema();
        await this.sql`DELETE FROM durable_sessions WHERE session_id = ${sessionId};`;
        return true;
      } catch (err) {
        console.warn(`[Neon DB] Session delete error for ${sessionId}:`, err.message);
      }
    }

    return true;
  }

  /**
   * Logs a student search query for analytics & audit tracking.
   */
  async logSearch({ studentNumber, cacheHit = false, responseTimeMs = 0, status = 'SUCCESS', errorCode = null }) {
    const cleanNum = String(studentNumber || '').trim();
    if (!cleanNum) return;

    this.memoryLogs.push({
      studentNumber: cleanNum,
      cacheHit,
      responseTimeMs,
      status,
      errorCode,
      timestamp: Date.now()
    });
    if (this.memoryLogs.length > 500) this.memoryLogs.shift();

    if (this.sql) {
      try {
        await this.ensureSchema();
        await this.sql`
          INSERT INTO search_audit_logs (
            student_number, cache_hit, response_time_ms, status, error_code, created_at
          ) VALUES (
            ${cleanNum}, ${cacheHit}, ${Math.round(responseTimeMs)}, ${status}, ${errorCode}, NOW()
          );
        `;
      } catch (err) {
        // Suppress audit logging error so it never blocks user experience
      }
    }
  }

  /**
   * Reports health & connectivity status of database.
   */
  async getHealth() {
    if (!this.sql) {
      return {
        connected: false,
        driver: 'memory-fallback',
        message: 'Running in resilient in-memory mode (DATABASE_URL not set).'
      };
    }

    const start = Date.now();
    try {
      await this.sql`SELECT 1 as test;`;
      return {
        connected: true,
        driver: 'neon-serverless',
        latencyMs: Date.now() - start,
        message: 'Neon PostgreSQL connected via Serverless HTTP driver.'
      };
    } catch (err) {
      return {
        connected: false,
        driver: 'neon-serverless-error',
        latencyMs: Date.now() - start,
        error: err.message,
        fallback: 'in-memory-active'
      };
    }
  }
}

const defaultDbService = new DbService();

module.exports = {
  DbService,
  defaultDbService
};
