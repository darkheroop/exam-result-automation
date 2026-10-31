'use strict';

require('../config');

let neonClient = null;
try {
  const { neon } = require('@neondatabase/serverless');
  neonClient = neon;
} catch (err) {
  // @neondatabase/serverless optional load
}

class AdminDbService {
  constructor(options = {}) {
    this.connectionString = options.connectionString || this._resolveConnectionString();
    this.sql = null;
    this.schemaInitialized = false;
    this.schemaPromise = null;
    this.isNeonActive = false;

    // Resilient In-Memory Fallback Stores
    this.memoryStudents = new Map(); // key: admission_number, value: student object
    this.memoryAdminSessions = new Map(); // key: token, value: session object
    this.memorySearchLogs = []; // array of log objects
    this.memoryExceptions = new Map(); // key: student_number (TEXT), value: exception object
    this.nextStudentId = 1;
    this.nextSearchLogId = 1;
    this.nextExceptionId = 1;

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
      (process.env.POSTGRES_HOST && process.env.POSTGRES_USER && process.env.POSTGRES_PASSWORD && process.env.POSTGRES_DATABASE
        ? `postgresql://${encodeURIComponent(process.env.POSTGRES_USER)}:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${process.env.POSTGRES_HOST}/${process.env.POSTGRES_DATABASE}?sslmode=require`
        : null)
    );
  }

  getSql() {
    if (this.sql) return this.sql;
    const connStr = this._resolveConnectionString() || this.connectionString;
    if (connStr && neonClient) {
      try {
        this.connectionString = connStr;
        this.sql = neonClient(connStr);
        this.isNeonActive = true;
        return this.sql;
      } catch (err) {
        console.warn('[Admin DB] Failed to initialize Neon client tag, falling back to memory:', err.message);
        this.sql = null;
        this.isNeonActive = false;
      }
    }
    return null;
  }

  /**
   * Initializes managed_students, admin_sessions, and search_logs schemas in database.
   */
  async ensureSchema() {
    const sql = this.getSql();
    if (!sql || this.schemaInitialized) return true;
    if (this.schemaPromise) return this.schemaPromise;

    this.schemaPromise = (async () => {
      try {
        // 1. Dedicated students table & indexes
        try {
          await sql`
            CREATE TABLE IF NOT EXISTS students (
              id BIGSERIAL PRIMARY KEY,
              student_name TEXT NOT NULL,
              admission_number TEXT UNIQUE NOT NULL,
              phone_number TEXT NOT NULL DEFAULT '',
              username TEXT DEFAULT NULL,
              password TEXT DEFAULT NULL,
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
          `;
          await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_students_admission_number ON students(admission_number);`;
          await sql`CREATE INDEX IF NOT EXISTS idx_students_student_name ON students(student_name);`;
          await sql`CREATE INDEX IF NOT EXISTS idx_students_phone_number ON students(phone_number);`;
          await sql`CREATE INDEX IF NOT EXISTS idx_students_username ON students(username);`;

          // Migration from legacy column names and managed_students table
          try {
            await sql`
              DO $$
              BEGIN
                -- Normalize portal_username -> username
                IF EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'students' AND column_name = 'portal_username') THEN
                  IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'students' AND column_name = 'username') THEN
                    ALTER TABLE students RENAME COLUMN portal_username TO username;
                  ELSE
                    UPDATE students SET username = portal_username WHERE (username IS NULL OR username = '') AND portal_username IS NOT NULL;
                    ALTER TABLE students DROP COLUMN IF EXISTS portal_username;
                  END IF;
                END IF;

                -- Normalize portal_password -> password
                IF EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'students' AND column_name = 'portal_password') THEN
                  IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'students' AND column_name = 'password') THEN
                    ALTER TABLE students RENAME COLUMN portal_password TO password;
                  ELSE
                    UPDATE students SET password = portal_password WHERE (password IS NULL OR password = '') AND portal_password IS NOT NULL;
                    ALTER TABLE students DROP COLUMN IF EXISTS portal_password;
                  END IF;
                END IF;

                -- Ensure exact canonical columns exist
                ALTER TABLE students ADD COLUMN IF NOT EXISTS username TEXT DEFAULT NULL;
                ALTER TABLE students ADD COLUMN IF NOT EXISTS password TEXT DEFAULT NULL;

                -- Drop section column if present to conform strictly with Part 2
                IF EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'students' AND column_name = 'section') THEN
                  ALTER TABLE students DROP COLUMN IF EXISTS section CASCADE;
                END IF;

                -- Migration from legacy managed_students base table
                IF EXISTS (
                  SELECT FROM information_schema.tables 
                  WHERE table_schema = 'public' AND table_name = 'managed_students'
                  AND table_type = 'BASE TABLE'
                ) THEN
                  INSERT INTO students (id, student_name, admission_number, phone_number, username, password, created_at, updated_at)
                  SELECT
                    id,
                    COALESCE(name, ''),
                    admission_number,
                    COALESCE(phone_number, ''),
                    NULLIF(TRIM(username), ''),
                    NULLIF(TRIM(password), ''),
                    created_at,
                    updated_at
                  FROM managed_students
                  ON CONFLICT (admission_number) DO UPDATE SET
                    student_name = EXCLUDED.student_name,
                    phone_number = CASE WHEN EXCLUDED.phone_number <> '' THEN EXCLUDED.phone_number ELSE students.phone_number END,
                    username = CASE WHEN EXCLUDED.username IS NOT NULL THEN EXCLUDED.username ELSE students.username END,
                    password = CASE WHEN EXCLUDED.password IS NOT NULL THEN EXCLUDED.password ELSE students.password END,
                    updated_at = EXCLUDED.updated_at;

                  PERFORM setval(pg_get_serial_sequence('students', 'id'), COALESCE((SELECT MAX(id) FROM students), 1));
                  
                  DROP TABLE IF EXISTS managed_students CASCADE;
                  CREATE OR REPLACE VIEW managed_students AS
                  SELECT id, student_name AS name, student_name, admission_number, phone_number, username, password, created_at, updated_at
                  FROM students;
                END IF;
              END $$;
            `;
          } catch (migErr) {
            console.warn('[Admin DB] Migration check notice:', migErr.message);
          }
        } catch (tableErr) {
          console.warn('[Admin DB] students schema check notice:', tableErr.message);
        }

        // 2. admin_sessions table & indexes
        try {
          await sql`
            CREATE TABLE IF NOT EXISTS admin_sessions (
              token VARCHAR(128) PRIMARY KEY,
              username VARCHAR(128) NOT NULL,
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '2 hours')
            );
          `;
          await sql`CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);`;
        } catch (sessErr) {
          console.warn('[Admin DB] admin_sessions schema check notice:', sessErr.message);
        }

        // 3. search_logs table & indexes (supports admission_number column)
        try {
          await sql`
            CREATE TABLE IF NOT EXISTS search_logs (
              id BIGSERIAL PRIMARY KEY,
              admission_number VARCHAR(64),
              search_query TEXT,
              search_type VARCHAR(64) DEFAULT 'Admission Number',
              result VARCHAR(64) NOT NULL,
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
          `;
          try {
            await sql`ALTER TABLE search_logs ADD COLUMN IF NOT EXISTS admission_number VARCHAR(64);`;
          } catch (_) {}
          await sql`CREATE INDEX IF NOT EXISTS idx_search_logs_created_at ON search_logs(created_at DESC);`;
          await sql`CREATE INDEX IF NOT EXISTS idx_search_logs_result ON search_logs(result);`;
          await sql`CREATE INDEX IF NOT EXISTS idx_search_logs_search_type ON search_logs(search_type);`;
          await sql`CREATE INDEX IF NOT EXISTS idx_search_logs_adm ON search_logs(admission_number);`;
        } catch (logErr) {
          console.warn('[Admin DB] search_logs schema check notice:', logErr.message);
        }

        // 4. student_exceptions table & indexes (and view/alias)
        try {
          await sql`
            CREATE TABLE IF NOT EXISTS student_exceptions (
              id BIGSERIAL PRIMARY KEY,
              student_number TEXT UNIQUE NOT NULL,
              custom_message TEXT NOT NULL,
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
          `;
          await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_student_exceptions_number ON student_exceptions(student_number);`;
          await sql`CREATE INDEX IF NOT EXISTS idx_student_exceptions_created ON student_exceptions(created_at DESC);`;
          try {
            await sql`CREATE OR REPLACE VIEW exceptions AS SELECT * FROM student_exceptions;`;
          } catch (_) {}
        } catch (excErr) {
          console.warn('[Admin DB] student_exceptions schema check notice:', excErr.message);
        }

        this.schemaInitialized = true;
        return true;
      } catch (err) {
        console.warn('[Admin DB] Schema verification notice (operating with memory fallback if DB unavailable):', err.message);
        return false;
      } finally {
        this.schemaPromise = null;
      }
    })();

    return this.schemaPromise;
  }

  /**
   * Lists students with pagination, sorting, and universal search.
   */
  async listStudents({ page = 1, limit = 20, search = '', section = '', credential = '', sortBy = 'id', sortOrder = 'ASC' } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;
    const cleanSearch = String(search || '').trim().toLowerCase();
    const cleanSection = String(section || '').trim();
    const cleanCredential = String(credential || '').trim().toLowerCase();

    const allowedSortFields = ['id', 'student_name', 'name', 'admission_number', 'phone_number', 'portal_username', 'username', 'section', 'created_at', 'updated_at'];
    let sortField = allowedSortFields.includes(sortBy) ? sortBy : 'id';
    if (sortBy === 'name') sortField = 'student_name';
    if (sortBy === 'username') sortField = 'username';
    if (sortBy === 'adm') sortField = 'admission_number';
    if (sortBy === 'updated') sortField = 'updated_at';
    const sortDirection = String(sortOrder).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();

        const conditions = [];
        const params = [];
        let pIndex = 1;

        if (cleanSearch) {
          conditions.push(`(
            student_name ILIKE $${pIndex} OR 
            admission_number ILIKE $${pIndex} OR 
            phone_number ILIKE $${pIndex} OR 
            username ILIKE $${pIndex}
          )`);
          params.push(`%${cleanSearch}%`);
          pIndex++;
        }

        if (cleanSection) {
          conditions.push(`(1=1)`); // Section column removed, no-op for compatibility
        }

        if (cleanCredential === 'complete' || cleanCredential === 'with_credentials') {
          conditions.push(`(username IS NOT NULL AND username <> '' AND password IS NOT NULL AND password <> '')`);
        } else if (cleanCredential === 'without_credentials' || cleanCredential === 'missing') {
          conditions.push(`(username IS NULL OR username = '' OR password IS NULL OR password = '')`);
        } else if (cleanCredential === 'missing_username') {
          conditions.push(`(username IS NULL OR username = '')`);
        } else if (cleanCredential === 'missing_password') {
          conditions.push(`(password IS NULL OR password = '')`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countQuery = `SELECT COUNT(*) AS total FROM students ${whereClause};`;
        const countRows = await sql.query(countQuery, params);
        const total = parseInt(countRows[0]?.total || 0, 10);

        const listQuery = `
          SELECT id, student_name, admission_number, phone_number, username, password, created_at, updated_at
          FROM students
          ${whereClause}
          ORDER BY ${sortField} ${sortDirection}, id ASC
          LIMIT $${pIndex} OFFSET $${pIndex + 1};
        `;
        const students = await sql.query(listQuery, [...params, limitNum, offset]);

        return {
          students: students.map(s => this._formatStudent(s)),
          total,
          page: pageNum,
          totalPages: Math.ceil(total / limitNum) || 1,
          limit: limitNum,
          sections: []
        };
      } catch (err) {
        console.warn('[Admin DB] listStudents query error, falling back to memory:', err.message);
      }
    }

    // Memory fallback
    let all = Array.from(this.memoryStudents.values());

    if (cleanSearch) {
      all = all.filter(s => {
        const sName = (s.student_name || s.name || '').toLowerCase();
        const sAdm = (s.admission_number || '').toLowerCase();
        const sPhone = (s.phone_number || '').toLowerCase();
        const sUser = (s.portal_username || s.username || '').toLowerCase();
        return sName.includes(cleanSearch) || sAdm.includes(cleanSearch) || sPhone.includes(cleanSearch) || sUser.includes(cleanSearch);
      });
    }

    if (cleanSection) {
      all = all.filter(s => s.section && s.section.toLowerCase() === cleanSection.toLowerCase());
    }

    if (cleanCredential === 'complete' || cleanCredential === 'with_credentials') {
      all = all.filter(s => {
        const u = String(s.portal_username || s.username || '').trim();
        const p = String(s.portal_password || s.password || '').trim();
        return u.length > 0 && p.length > 0;
      });
    } else if (cleanCredential === 'without_credentials' || cleanCredential === 'missing') {
      all = all.filter(s => {
        const u = String(s.portal_username || s.username || '').trim();
        const p = String(s.portal_password || s.password || '').trim();
        return u.length === 0 || p.length === 0;
      });
    } else if (cleanCredential === 'missing_username') {
      all = all.filter(s => !(s.portal_username || s.username));
    } else if (cleanCredential === 'missing_password') {
      all = all.filter(s => !(s.portal_password || s.password));
    }

    // Sort
    all.sort((a, b) => {
      let valA = a[sortField];
      let valB = b[sortField];

      if (sortField === 'id') {
        valA = Number(valA);
        valB = Number(valB);
        return sortDirection === 'DESC' ? valB - valA : valA - valB;
      }

      valA = String(valA || '').toLowerCase();
      valB = String(valB || '').toLowerCase();
      if (valA < valB) return sortDirection === 'DESC' ? 1 : -1;
      if (valA > valB) return sortDirection === 'DESC' ? -1 : 1;
      return 0;
    });

    const total = all.length;
    const paginated = all.slice(offset, offset + limitNum).map(s => this._formatStudent(s));
    const memorySections = Array.from(new Set(Array.from(this.memoryStudents.values()).map(s => s.section).filter(Boolean))).sort();

    return {
      students: paginated,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum) || 1,
      limit: limitNum,
      sections: memorySections
    };
  }

  /**
   * Retrieves all students matching search, section, and credential filters,
   * sorted as specified, without pagination limits (for export).
   */
  async getStudentsForExport({ search = '', section = '', credential = '', sortBy = 'student_name', sortOrder = 'ASC' } = {}) {
    const cleanSearch = String(search || '').trim().toLowerCase();
    const cleanSection = String(section || '').trim();
    const cleanCredential = String(credential || '').trim().toLowerCase();

    const allowedSortFields = ['id', 'student_name', 'name', 'admission_number', 'phone_number', 'portal_username', 'username', 'section', 'created_at', 'updated_at'];
    let sortField = allowedSortFields.includes(sortBy) ? sortBy : 'student_name';
    if (sortBy === 'name') sortField = 'student_name';
    if (sortBy === 'username') sortField = 'username';
    if (sortBy === 'adm') sortField = 'admission_number';
    if (sortBy === 'updated') sortField = 'updated_at';
    const sortDirection = String(sortOrder).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();

        const conditions = [];
        const params = [];
        let pIndex = 1;

        if (cleanSearch) {
          conditions.push(`(
            student_name ILIKE $${pIndex} OR 
            admission_number ILIKE $${pIndex} OR 
            phone_number ILIKE $${pIndex} OR 
            username ILIKE $${pIndex}
          )`);
          params.push(`%${cleanSearch}%`);
          pIndex++;
        }

        if (cleanSection) {
          conditions.push(`(1=1)`);
        }

        if (cleanCredential === 'complete' || cleanCredential === 'with_credentials') {
          conditions.push(`(username IS NOT NULL AND username <> '' AND password IS NOT NULL AND password <> '')`);
        } else if (cleanCredential === 'without_credentials' || cleanCredential === 'missing') {
          conditions.push(`(username IS NULL OR username = '' OR password IS NULL OR password = '')`);
        } else if (cleanCredential === 'missing_username') {
          conditions.push(`(username IS NULL OR username = '')`);
        } else if (cleanCredential === 'missing_password') {
          conditions.push(`(password IS NULL OR password = '')`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const listQuery = `
          SELECT id, student_name, admission_number, phone_number, username, password, created_at, updated_at
          FROM students
          ${whereClause}
          ORDER BY ${sortField} ${sortDirection}, id ASC;
        `;
        const students = await sql.query(listQuery, params);

        return students.map(s => this._formatStudent(s));
      } catch (err) {
        console.warn('[Admin DB] getStudentsForExport query error, falling back to memory:', err.message);
      }
    }

    // Memory fallback
    let all = Array.from(this.memoryStudents.values());

    if (cleanSearch) {
      all = all.filter(s => {
        const sName = (s.student_name || s.name || '').toLowerCase();
        const sAdm = (s.admission_number || '').toLowerCase();
        const sPhone = (s.phone_number || '').toLowerCase();
        const sUser = (s.portal_username || s.username || '').toLowerCase();
        return sName.includes(cleanSearch) || sAdm.includes(cleanSearch) || sPhone.includes(cleanSearch) || sUser.includes(cleanSearch);
      });
    }

    if (cleanSection) {
      all = all.filter(s => s.section && s.section.toLowerCase() === cleanSection.toLowerCase());
    }

    if (cleanCredential === 'complete' || cleanCredential === 'with_credentials') {
      all = all.filter(s => {
        const u = String(s.portal_username || s.username || '').trim();
        const p = String(s.portal_password || s.password || '').trim();
        return u.length > 0 && p.length > 0;
      });
    } else if (cleanCredential === 'without_credentials' || cleanCredential === 'missing') {
      all = all.filter(s => {
        const u = String(s.portal_username || s.username || '').trim();
        const p = String(s.portal_password || s.password || '').trim();
        return u.length === 0 || p.length === 0;
      });
    } else if (cleanCredential === 'missing_username') {
      all = all.filter(s => !(s.portal_username || s.username));
    } else if (cleanCredential === 'missing_password') {
      all = all.filter(s => !(s.portal_password || s.password));
    }

    // Sort
    all.sort((a, b) => {
      let valA = a[sortField];
      let valB = b[sortField];

      if (sortField === 'id') {
        valA = Number(valA);
        valB = Number(valB);
        return sortDirection === 'DESC' ? valB - valA : valA - valB;
      }

      valA = String(valA || '').toLowerCase();
      valB = String(valB || '').toLowerCase();
      if (valA < valB) return sortDirection === 'DESC' ? 1 : -1;
      if (valA > valB) return sortDirection === 'DESC' ? -1 : 1;
      return 0;
    });

    return all.map(s => this._formatStudent(s));
  }

  /**
   * Retrieves a student by their ID.
   */
  async getStudentById(id) {
    const studentId = parseInt(id, 10);
    if (!studentId || isNaN(studentId)) return null;

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();
        const rows = await sql`
          SELECT * FROM students WHERE id = ${studentId} LIMIT 1;
        `;
        if (rows && rows.length > 0) {
          return this._formatStudent(rows[0]);
        }
        return null;
      } catch (err) {
        console.warn(`[Admin DB] getStudentById error for ${studentId}:`, err.message);
      }
    }

    for (const student of this.memoryStudents.values()) {
      if (Number(student.id) === studentId) {
        return this._formatStudent(student);
      }
    }
    return null;
  }

  /**
   * Retrieves a student by admission number.
   * Strictly matches admission_number (never student name or phone number).
   */
  async getStudentByAdmissionNumber(admissionNumber) {
    const adm = String(admissionNumber || '').trim();
    if (!adm) return null;

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();
        const rows = await sql`
          SELECT * FROM students 
          WHERE LOWER(TRIM(admission_number)) = LOWER(TRIM(${adm}))
          LIMIT 1;
        `;
        if (rows && rows.length > 0) {
          return this._formatStudent(rows[0]);
        }
        return null;
      } catch (err) {
        console.warn(`[Admin DB] getStudentByAdmissionNumber error for ${adm}:`, err.message);
      }
    }

    const admLower = adm.toLowerCase();
    for (const student of this.memoryStudents.values()) {
      if (student.admission_number && student.admission_number.toLowerCase().trim() === admLower) {
        return this._formatStudent(student);
      }
    }
    return null;
  }

  /**
   * Retrieves a student by phone number.
   * Strictly matches phone_number (never student name or admission number).
   */
  async getStudentByPhoneNumber(phoneNumber) {
    const phone = String(phoneNumber || '').trim();
    if (!phone) return null;

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();
        const rows = await sql`
          SELECT * FROM students 
          WHERE TRIM(phone_number) = TRIM(${phone})
          LIMIT 2;
        `;
        if (rows && rows.length > 0) {
          return this._formatStudent(rows[0]);
        }
        return null;
      } catch (err) {
        console.warn(`[Admin DB] getStudentByPhoneNumber error for ${phone}:`, err.message);
      }
    }

    for (const student of this.memoryStudents.values()) {
      if (student.phone_number && String(student.phone_number).trim() === phone) {
        return this._formatStudent(student);
      }
    }
    return null;
  }

  /**
   * Upserts a single student record.
   * Duplicate protection: on conflict on admission_number:
   * updates name, phone_number, section.
   * NEVER overwrites existing non-empty username/password if incoming is empty/undefined.
   */
  async upsertStudent(params = {}) {
    const cleanName = String(params.student_name || params.name || '').trim();
    const cleanAdm = String(params.admission_number || '').trim();
    const cleanPhone = String(params.phone_number || '').trim();
    const cleanUser = String(
      (params.username !== undefined && params.username !== null && params.username !== '')
        ? params.username
        : ((params.portal_username !== undefined && params.portal_username !== null && params.portal_username !== '') ? params.portal_username : '')
    ).trim();
    const cleanPass = String(
      (params.password !== undefined && params.password !== null && params.password !== '')
        ? params.password
        : ((params.portal_password !== undefined && params.portal_password !== null && params.portal_password !== '') ? params.portal_password : '')
    ).trim();
    const cleanSec = String(params.section || '').trim();

    if (!cleanAdm) {
      throw new Error('Admission number is required for student record');
    }
    if (!cleanName) {
      throw new Error('Student name is required');
    }

    let isUpdate = false;
    let savedStudent = null;

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();
        // Check if student existed before this query
        const existingRows = await sql`
          SELECT id, username, password FROM students WHERE LOWER(TRIM(admission_number)) = LOWER(TRIM(${cleanAdm})) LIMIT 1;
        `;
        isUpdate = existingRows && existingRows.length > 0;

        const rows = await sql`
          INSERT INTO students (
            student_name, admission_number, phone_number, username, password, created_at, updated_at
          ) VALUES (
            ${cleanName}, ${cleanAdm}, ${cleanPhone}, ${cleanUser ? cleanUser : null}, ${cleanPass ? cleanPass : null}, NOW(), NOW()
          )
          ON CONFLICT (admission_number) DO UPDATE SET
            student_name = EXCLUDED.student_name,
            phone_number = EXCLUDED.phone_number,
            username = CASE
              WHEN EXCLUDED.username IS NOT NULL AND EXCLUDED.username <> '' THEN EXCLUDED.username
              ELSE students.username
            END,
            password = CASE
              WHEN EXCLUDED.password IS NOT NULL AND EXCLUDED.password <> '' THEN EXCLUDED.password
              ELSE students.password
            END,
            updated_at = NOW()
          RETURNING *;
        `;

        if (rows && rows.length > 0) {
          savedStudent = this._formatStudent(rows[0]);
          // Sync to memory
          this.memoryStudents.set(cleanAdm, { ...savedStudent });
          return { student: savedStudent, isUpdate };
        }
      } catch (err) {
        console.warn(`[Admin DB] upsertStudent error for ${cleanAdm}, falling back to memory:`, err.message);
      }
    }

    // Memory store
    const existing = this.memoryStudents.get(cleanAdm);
    if (existing) {
      isUpdate = true;
      const currentPortalUser = existing.username !== undefined ? existing.username : (existing.portal_username || null);
      const currentPortalPass = existing.password !== undefined ? existing.password : (existing.portal_password || null);
      savedStudent = {
        ...existing,
        student_name: cleanName || existing.student_name || existing.name,
        name: cleanName || existing.name || existing.student_name,
        phone_number: cleanPhone || existing.phone_number,
        section: cleanSec || existing.section,
        username: cleanUser !== '' ? cleanUser : (currentPortalUser || ''),
        portal_username: cleanUser !== '' ? cleanUser : currentPortalUser,
        password: cleanPass !== '' ? cleanPass : (currentPortalPass || ''),
        portal_password: cleanPass !== '' ? cleanPass : currentPortalPass,
        updated_at: new Date().toISOString()
      };
    } else {
      isUpdate = false;
      savedStudent = {
        id: this.nextStudentId++,
        student_name: cleanName,
        name: cleanName,
        admission_number: cleanAdm,
        phone_number: cleanPhone,
        username: cleanUser !== '' ? cleanUser : null,
        portal_username: cleanUser !== '' ? cleanUser : null,
        password: cleanPass !== '' ? cleanPass : null,
        portal_password: cleanPass !== '' ? cleanPass : null,
        section: cleanSec,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    }

    this.memoryStudents.set(cleanAdm, savedStudent);
    return { student: this._formatStudent(savedStudent), isUpdate };
  }

  /**
   * Updates an existing student record by ID.
   * Validates uniqueness of admission_number and preserves credentials if omitted.
   */
  async updateStudent(id, fields = {}) {
    const studentId = parseInt(id, 10);
    if (!studentId || isNaN(studentId)) {
      throw new Error('Invalid student ID');
    }

    const currentStudent = await this.getStudentById(studentId);
    if (!currentStudent) {
      return null;
    }

    const cleanAdm = fields.admission_number !== undefined ? String(fields.admission_number).trim() : currentStudent.admission_number;
    if (!cleanAdm) {
      throw new Error('Admission number cannot be empty');
    }

    // Check unique admission_number against other students
    const conflictStudent = await this.getStudentByAdmissionNumber(cleanAdm);
    if (conflictStudent && Number(conflictStudent.id) !== studentId) {
      const err = new Error(`Admission number '${cleanAdm}' already belongs to another student`);
      err.code = 'ADMISSION_NUMBER_EXISTS';
      throw err;
    }

    const cleanName = (fields.student_name !== undefined ? fields.student_name : fields.name) !== undefined
      ? String(fields.student_name || fields.name).trim()
      : (currentStudent.student_name || currentStudent.name);
    const cleanPhone = fields.phone_number !== undefined ? String(fields.phone_number).trim() : currentStudent.phone_number;
    const cleanSec = fields.section !== undefined ? String(fields.section).trim() : currentStudent.section;

    // Credentials preservation: if not provided or empty, retain existing!
    let newUsername = currentStudent.username || currentStudent.portal_username;
    if (fields.username !== undefined && fields.username !== null && fields.username !== '') {
      newUsername = String(fields.username).trim();
    } else if (fields.portal_username !== undefined && fields.portal_username !== null && fields.portal_username !== '') {
      newUsername = String(fields.portal_username).trim();
    }

    let newPassword = currentStudent.password || currentStudent.portal_password;
    if (fields.password !== undefined && fields.password !== null && fields.password !== '') {
      newPassword = String(fields.password).trim();
    } else if (fields.portal_password !== undefined && fields.portal_password !== null && fields.portal_password !== '') {
      newPassword = String(fields.portal_password).trim();
    }

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();
        const rows = await sql`
          UPDATE students
          SET
            student_name = ${cleanName},
            admission_number = ${cleanAdm},
            phone_number = ${cleanPhone},
            username = ${newUsername ? newUsername : null},
            password = ${newPassword ? newPassword : null},
            updated_at = NOW()
          WHERE id = ${studentId}
          RETURNING *;
        `;
        if (rows && rows.length > 0) {
          const updated = this._formatStudent(rows[0]);
          // Sync to memory
          if (currentStudent.admission_number !== cleanAdm) {
            this.memoryStudents.delete(currentStudent.admission_number);
          }
          this.memoryStudents.set(cleanAdm, { ...updated });
          return updated;
        }
      } catch (err) {
        console.warn(`[Admin DB] updateStudent error for ID ${studentId}:`, err.message);
      }
    }

    // Memory store
    if (currentStudent.admission_number !== cleanAdm) {
      this.memoryStudents.delete(currentStudent.admission_number);
    }

    const updatedMem = {
      ...currentStudent,
      student_name: cleanName,
      name: cleanName,
      admission_number: cleanAdm,
      phone_number: cleanPhone,
      username: newUsername || '',
      portal_username: newUsername ? newUsername : null,
      password: newPassword || '',
      portal_password: newPassword ? newPassword : null,
      section: cleanSec,
      updated_at: new Date().toISOString()
    };
    this.memoryStudents.set(cleanAdm, updatedMem);
    return this._formatStudent(updatedMem);
  }

  /**
   * Deletes a student by ID.
   */
  async deleteStudent(id) {
    const studentId = parseInt(id, 10);
    if (!studentId || isNaN(studentId)) return false;

    const student = await this.getStudentById(studentId);
    if (!student) return false;

    let deleted = false;
    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();
        const rows = await sql`
          DELETE FROM students WHERE id = ${studentId} RETURNING id;
        `;
        deleted = rows && rows.length > 0;
      } catch (err) {
        console.warn(`[Admin DB] deleteStudent error for ID ${studentId}:`, err.message);
      }
    }

    this.memoryStudents.delete(student.admission_number);
    return true;
  }

  /**
   * Batch upserts a list of student objects.
   * Uses high-performance chunked multi-row queries when Neon is active to prevent timeouts,
   * with automatic fallback.
   * Returns { added, updated, duplicates, skipped, errors, total }.
   */
  async batchUpsertStudents(studentsList = []) {
    const summary = {
      added: 0,
      updated: 0,
      duplicates: 0,
      skipped: 0,
      errors: [],
      total: studentsList.length
    };

    const validItems = [];
    for (let i = 0; i < studentsList.length; i++) {
      const item = studentsList[i];
      if (!item || !item.admission_number || !String(item.admission_number).trim()) {
        summary.skipped++;
        continue;
      }
      const stName = String(item.student_name || item.name || 'STUDENT').trim();
      const rawUser = item.username !== undefined ? item.username : item.portal_username;
      const rawPass = item.password !== undefined ? item.password : item.portal_password;
      validItems.push({
        index: i,
        student_name: stName,
        name: stName,
        admission_number: String(item.admission_number).trim(),
        phone_number: String(item.phone_number || '').trim(),
        section: String(item.section || '').trim(),
        username: rawUser ? String(rawUser).trim() : null,
        portal_username: rawUser ? String(rawUser).trim() : null,
        password: rawPass ? String(rawPass).trim() : null,
        portal_password: rawPass ? String(rawPass).trim() : null
      });
    }

    const sql = this.getSql();
    if (sql && validItems.length > 0) {
      try {
        await this.ensureSchema();

        const CHUNK_SIZE = 100;
        for (let c = 0; c < validItems.length; c += CHUNK_SIZE) {
          const chunk = validItems.slice(c, c + CHUNK_SIZE);
          const valueClauses = [];
          const params = [];
          let pIdx = 1;

          for (const s of chunk) {
            valueClauses.push(`($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, NOW(), NOW())`);
            params.push(s.student_name, s.admission_number, s.phone_number, s.username, s.password);
            pIdx += 5;
          }

          const query = `
            INSERT INTO students (student_name, admission_number, phone_number, username, password, created_at, updated_at)
            VALUES ${valueClauses.join(', ')}
            ON CONFLICT (admission_number) DO UPDATE SET
              student_name = EXCLUDED.student_name,
              phone_number = CASE WHEN EXCLUDED.phone_number <> '' THEN EXCLUDED.phone_number ELSE students.phone_number END,
              username = CASE WHEN EXCLUDED.username IS NOT NULL AND EXCLUDED.username <> '' THEN EXCLUDED.username ELSE students.username END,
              password = CASE WHEN EXCLUDED.password IS NOT NULL AND EXCLUDED.password <> '' THEN EXCLUDED.password ELSE students.password END,
              updated_at = NOW()
            RETURNING (xmax = 0) AS inserted, admission_number;
          `;

          try {
            const returnedRows = await sql.query(query, params);
            for (const r of returnedRows) {
              if (r.inserted) {
                summary.added++;
              } else {
                summary.updated++;
                summary.duplicates++;
              }
            }
          } catch (chunkErr) {
            // Fallback for this chunk item-by-item
            console.warn('[Admin DB] Batch chunk upsert encountered error, falling back to item-by-item:', chunkErr.message);
            for (const s of chunk) {
              try {
                const res = await this.upsertStudent(s);
                if (res.isUpdate) {
                  summary.updated++;
                  summary.duplicates++;
                } else {
                  summary.added++;
                }
              } catch (singleErr) {
                summary.errors.push({
                  row: s.index + 1,
                  admission_number: s.admission_number,
                  message: singleErr.message
                });
              }
            }
          }
        }

        return summary;
      } catch (err) {
        console.warn('[Admin DB] batchUpsertStudents fatal error, using memory fallback:', err.message);
      }
    }

    // Memory Store processing
    for (const item of validItems) {
      try {
        const result = await this.upsertStudent(item);
        if (result.isUpdate) {
          summary.updated++;
          summary.duplicates++;
        } else {
          summary.added++;
        }
      } catch (err) {
        summary.errors.push({
          row: item.index + 1,
          admission_number: item.admission_number,
          message: err.message
        });
      }
    }

    return summary;
  }

  /**
   * Computes comprehensive dashboard statistics.
   */
  async getDashboardStats() {
    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();

        const statsQuery = await sql`
          SELECT
            COUNT(*)::int AS total_students,
            0::int AS total_sections,
            COUNT(*) FILTER (WHERE username IS NOT NULL AND username <> '')::int AS students_with_username,
            COUNT(*) FILTER (WHERE username IS NULL OR username = '')::int AS students_without_username,
            COUNT(*) FILTER (WHERE password IS NOT NULL AND password <> '')::int AS students_with_password,
            COUNT(*) FILTER (WHERE password IS NULL OR password = '')::int AS students_without_password
          FROM students;
        `;

        const recentAdded = await sql`
          SELECT id, student_name, admission_number, phone_number, username, password, created_at
          FROM students
          ORDER BY id DESC
          LIMIT 5;
        `;

        const recentUpdated = await sql`
          SELECT id, student_name, admission_number, phone_number, username, password, updated_at
          FROM students
          ORDER BY updated_at DESC
          LIMIT 5;
        `;

        const sectionRows = [];

        const row = statsQuery[0] || {};
        return {
          totalStudents: row.total_students || 0,
          totalSections: 0,
          studentsWithUsername: row.students_with_username || 0,
          studentsWithoutUsername: row.students_without_username || 0,
          studentsWithPassword: row.students_with_password || 0,
          studentsWithoutPassword: row.students_without_password || 0,
          recentlyAdded: recentAdded.map(s => this._formatStudent(s)),
          recentlyUpdated: recentUpdated.map(s => this._formatStudent(s)),
          sectionBreakdown: []
        };
      } catch (err) {
        console.warn('[Admin DB] getDashboardStats error, falling back to memory stats:', err.message);
      }
    }

    // Memory stats
    const students = Array.from(this.memoryStudents.values());
    const totalStudents = students.length;

    const sectionsSet = new Set();
    const sectionCounts = {};
    let studentsWithUsername = 0;
    let studentsWithoutUsername = 0;
    let studentsWithPassword = 0;
    let studentsWithoutPassword = 0;

    for (const s of students) {
      const sec = s.section ? s.section.trim() : 'Unassigned';
      if (s.section && s.section.trim()) {
        sectionsSet.add(s.section.trim());
      }
      sectionCounts[sec] = (sectionCounts[sec] || 0) + 1;

      const user = s.portal_username || s.username;
      const pass = s.portal_password || s.password;

      if (user && String(user).trim() !== '') {
        studentsWithUsername++;
      } else {
        studentsWithoutUsername++;
      }

      if (pass && String(pass).trim() !== '') {
        studentsWithPassword++;
      } else {
        studentsWithoutPassword++;
      }
    }

    const sectionBreakdown = Object.keys(sectionCounts).map(sec => ({
      section: sec,
      count: sectionCounts[sec]
    })).sort((a, b) => b.count - a.count);

    const recentlyAdded = [...students]
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, 5)
      .map(s => this._formatStudent(s));

    const recentlyUpdated = [...students]
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 5)
      .map(s => this._formatStudent(s));

    return {
      totalStudents,
      totalSections: sectionsSet.size,
      studentsWithUsername,
      studentsWithoutUsername,
      studentsWithPassword,
      studentsWithoutPassword,
      recentlyAdded,
      recentlyUpdated,
      sectionBreakdown
    };
  }

  /**
   * Session Management: Creates an admin session.
   */
  async createAdminSession(token, username, ttlHours = 2) {
    if (!token || !username) return false;

    const expiresAt = Date.now() + (ttlHours * 60 * 60 * 1000);
    this.memoryAdminSessions.set(token, {
      token,
      username,
      createdAt: Date.now(),
      expiresAt
    });

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();
        await sql`
          INSERT INTO admin_sessions (token, username, created_at, expires_at)
          VALUES (${token}, ${username}, NOW(), NOW() + (${ttlHours} || ' hours')::interval)
          ON CONFLICT (token) DO UPDATE SET
            username = EXCLUDED.username,
            expires_at = EXCLUDED.expires_at;
        `;
        return true;
      } catch (err) {
        console.warn('[Admin DB] createAdminSession error, memory active:', err.message);
      }
    }

    return true;
  }

  /**
   * Session Management: Retrieves an admin session if valid and not expired.
   */
  async getAdminSession(token) {
    if (!token) return null;

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();
        const rows = await sql`
          SELECT token, username, created_at, expires_at
          FROM admin_sessions
          WHERE token = ${token}
            AND expires_at > NOW()
          LIMIT 1;
        `;
        if (rows && rows.length > 0) {
          const row = rows[0];
          return {
            token: row.token,
            username: row.username,
            createdAt: new Date(row.created_at).getTime(),
            expiresAt: new Date(row.expires_at).getTime()
          };
        }
        return null;
      } catch (err) {
        console.warn('[Admin DB] getAdminSession error, checking memory:', err.message);
      }
    }

    const memSession = this.memoryAdminSessions.get(token);
    if (memSession && memSession.expiresAt > Date.now()) {
      return memSession;
    }
    return null;
  }

  /**
   * Session Management: Deletes an admin session.
   */
  async deleteAdminSession(token) {
    if (!token) return false;

    this.memoryAdminSessions.delete(token);

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();
        await sql`
          DELETE FROM admin_sessions WHERE token = ${token};
        `;
        return true;
      } catch (err) {
        console.warn('[Admin DB] deleteAdminSession error:', err.message);
      }
    }

    return true;
  }

  /**
   * Cleans up expired admin sessions.
   */
  async cleanExpiredSessions() {
    const now = Date.now();
    for (const [token, session] of this.memoryAdminSessions.entries()) {
      if (session.expiresAt <= now) {
        this.memoryAdminSessions.delete(token);
      }
    }

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();
        await sql`
          DELETE FROM admin_sessions WHERE expires_at <= NOW();
        `;
      } catch (err) {
        // Suppress cleanup warning
      }
    }
  }

  /**
   * Updates only portal credentials for a verified student admission number.
   * Strictly matches admission_number (never student name or phone number).
   * Verifies exactly one record is updated and guards against duplicate corruption.
   */
  async updateStudentCredentials(admissionNumber, credentials = {}) {
    const cleanAdm = String(admissionNumber || '').trim();
    if (!cleanAdm) throw new Error('Admission number is required to update credentials');
    const rawUser = credentials.portal_username !== undefined ? credentials.portal_username : credentials.username;
    const cleanUser = String(rawUser || '').trim();
    const rawPass = credentials.portal_password !== undefined ? credentials.portal_password : credentials.password;
    const cleanPass = String(rawPass || '').trim();

    if (!cleanUser || !cleanPass) {
      throw new Error('Valid, non-empty username and password are required to update credentials');
    }

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();

        // 1. Verify existence, check for duplicates, and read currently saved credentials
        const checkRows = await sql`
          SELECT id, student_name, admission_number, phone_number, username, password, created_at, updated_at FROM students
          WHERE LOWER(TRIM(admission_number)) = LOWER(TRIM(${cleanAdm}));
        `;

        if (!checkRows || checkRows.length === 0) {
          console.warn(`[Admin DB] No student record found matching admission number '${cleanAdm}' to update credentials.`);
          return null;
        }

        if (checkRows.length > 1) {
          const err = new Error(`Data integrity violation: ${checkRows.length} duplicate student records match admission number '${cleanAdm}'. Update aborted.`);
          err.code = 'MULTIPLE_RECORDS_MATCH';
          console.error(`[Admin DB] ${err.message}`);
          throw err;
        }

        const existingRow = checkRows[0];
        const currentSavedUser = String(existingRow.username !== undefined ? existingRow.username : (existingRow.portal_username || '')).trim();
        const currentSavedPass = String(existingRow.password !== undefined ? existingRow.password : (existingRow.portal_password || '')).trim();

        // 2. Compare saved credentials with newly returned credentials
        if (currentSavedUser === cleanUser && currentSavedPass === cleanPass) {
          // Identical credentials: keep existing values without an unnecessary database update
          const formatted = this._formatStudent(existingRow);
          formatted.count = 1;
          formatted.success = true;
          formatted.updated = false;
          return formatted;
        }

        // 3. Perform parameterized update matching ONLY admission_number
        const rows = await sql`
          UPDATE students
          SET username = ${cleanUser},
              password = ${cleanPass},
              updated_at = NOW()
          WHERE LOWER(TRIM(admission_number)) = LOWER(TRIM(${cleanAdm}))
          RETURNING id, student_name, admission_number, phone_number, username, password, created_at, updated_at;
        `;

        if (rows && rows.length === 1) {
          const updated = this._formatStudent(rows[0]);
          updated.count = 1;
          updated.success = true;
          updated.updated = true;
          this.memoryStudents.set(updated.admission_number, { ...updated });
          return updated;
        }

        if (rows && rows.length > 1) {
          const err = new Error(`Data integrity violation: ${rows.length} rows updated for admission number '${cleanAdm}'.`);
          err.code = 'MULTIPLE_RECORDS_MATCH';
          throw err;
        }

        return null;
      } catch (err) {
        console.error(`[Admin DB] updateStudentCredentials SQL error for ${cleanAdm}:`, err.message);
        throw err;
      }
    }

    // Resilient memory store fallback
    const admLower = cleanAdm.toLowerCase();
    const matching = [];
    for (const [key, st] of this.memoryStudents.entries()) {
      if (st.admission_number && st.admission_number.toLowerCase().trim() === admLower) {
        matching.push({ key, st });
      }
    }

    if (matching.length === 0) {
      console.warn(`[Admin DB] Memory store: No student record found matching admission number '${cleanAdm}'.`);
      return null;
    }

    if (matching.length > 1) {
      const err = new Error(`Data integrity violation: ${matching.length} duplicate student records match admission number '${cleanAdm}'. Update aborted.`);
      err.code = 'MULTIPLE_RECORDS_MATCH';
      console.error(`[Admin DB] ${err.message}`);
      throw err;
    }

    const { key, st: existing } = matching[0];
    const currentSavedUser = String(existing.username !== undefined ? existing.username : (existing.portal_username || '')).trim();
    const currentSavedPass = String(existing.password !== undefined ? existing.password : (existing.portal_password || '')).trim();

    if (currentSavedUser === cleanUser && currentSavedPass === cleanPass) {
      // Identical credentials: keep existing values without an unnecessary update
      const formatted = this._formatStudent(existing);
      formatted.count = 1;
      formatted.success = true;
      formatted.updated = false;
      return formatted;
    }

    const updated = {
      ...existing,
      portal_username: cleanUser,
      username: cleanUser,
      portal_password: cleanPass,
      password: cleanPass,
      updated_at: new Date().toISOString()
    };
    this.memoryStudents.set(key, updated);
    const formatted = this._formatStudent(updated);
    formatted.count = 1;
    formatted.success = true;
    formatted.updated = true;
    return formatted;
  }

  /**
   * Updates only portal credentials for a verified student phone number.
   * Strictly matches phone_number (never student name or admission number).
   * Verifies exactly one record is updated and guards against duplicate corruption.
   */
  async updateStudentCredentialsByPhone(phoneNumber, credentials = {}) {
    const cleanPhone = String(phoneNumber || '').trim();
    if (!cleanPhone) throw new Error('Phone number is required to update credentials');
    const rawUser = credentials.portal_username !== undefined ? credentials.portal_username : credentials.username;
    const cleanUser = String(rawUser || '').trim();
    const rawPass = credentials.portal_password !== undefined ? credentials.portal_password : credentials.password;
    const cleanPass = String(rawPass || '').trim();

    if (!cleanUser || !cleanPass) {
      throw new Error('Valid, non-empty username and password are required to update credentials');
    }

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();

        // 1. Verify existence, check for duplicates, and read currently saved credentials
        const checkRows = await sql`
          SELECT id, student_name, admission_number, phone_number, username, password, created_at, updated_at FROM students
          WHERE TRIM(phone_number) = TRIM(${cleanPhone});
        `;

        if (!checkRows || checkRows.length === 0) {
          console.warn(`[Admin DB] No student record found matching phone number '${cleanPhone}' to update credentials.`);
          return null;
        }

        if (checkRows.length > 1) {
          const err = new Error(`Data integrity violation: ${checkRows.length} duplicate student records match phone number '${cleanPhone}'. Update aborted.`);
          err.code = 'MULTIPLE_RECORDS_MATCH';
          console.error(`[Admin DB] ${err.message}`);
          throw err;
        }

        const existingRow = checkRows[0];
        const currentSavedUser = String(existingRow.username !== undefined ? existingRow.username : (existingRow.portal_username || '')).trim();
        const currentSavedPass = String(existingRow.password !== undefined ? existingRow.password : (existingRow.portal_password || '')).trim();

        // 2. Compare saved credentials with newly returned credentials
        if (currentSavedUser === cleanUser && currentSavedPass === cleanPass) {
          // Identical credentials: keep existing values without an unnecessary database update
          const formatted = this._formatStudent(existingRow);
          formatted.count = 1;
          formatted.success = true;
          formatted.updated = false;
          return formatted;
        }

        // 3. Perform parameterized update matching ONLY phone_number
        const rows = await sql`
          UPDATE students
          SET username = ${cleanUser},
              password = ${cleanPass},
              updated_at = NOW()
          WHERE TRIM(phone_number) = TRIM(${cleanPhone})
          RETURNING id, student_name, admission_number, phone_number, username, password, created_at, updated_at;
        `;

        if (rows && rows.length === 1) {
          const updated = this._formatStudent(rows[0]);
          updated.count = 1;
          updated.success = true;
          updated.updated = true;
          this.memoryStudents.set(updated.admission_number, { ...updated });
          return updated;
        }

        if (rows && rows.length > 1) {
          const err = new Error(`Data integrity violation: ${rows.length} rows updated for phone number '${cleanPhone}'.`);
          err.code = 'MULTIPLE_RECORDS_MATCH';
          throw err;
        }

        return null;
      } catch (err) {
        console.error(`[Admin DB] updateStudentCredentialsByPhone SQL error for ${cleanPhone}:`, err.message);
        throw err;
      }
    }

    // Resilient memory store fallback
    const matching = [];
    for (const [key, st] of this.memoryStudents.entries()) {
      if (st.phone_number && String(st.phone_number).trim() === cleanPhone) {
        matching.push({ key, st });
      }
    }

    if (matching.length === 0) {
      console.warn(`[Admin DB] Memory store: No student record found matching phone number '${cleanPhone}'.`);
      return null;
    }

    if (matching.length > 1) {
      const err = new Error(`Data integrity violation: ${matching.length} duplicate student records match phone number '${cleanPhone}'. Update aborted.`);
      err.code = 'MULTIPLE_RECORDS_MATCH';
      console.error(`[Admin DB] ${err.message}`);
      throw err;
    }

    const { key, st: existing } = matching[0];
    const currentSavedUser = String(existing.username !== undefined ? existing.username : (existing.portal_username || '')).trim();
    const currentSavedPass = String(existing.password !== undefined ? existing.password : (existing.portal_password || '')).trim();

    if (currentSavedUser === cleanUser && currentSavedPass === cleanPass) {
      // Identical credentials: keep existing values without an unnecessary update
      const formatted = this._formatStudent(existing);
      formatted.count = 1;
      formatted.success = true;
      formatted.updated = false;
      return formatted;
    }

    const updated = {
      ...existing,
      portal_username: cleanUser,
      username: cleanUser,
      portal_password: cleanPass,
      password: cleanPass,
      updated_at: new Date().toISOString()
    };
    this.memoryStudents.set(key, updated);
    const formatted = this._formatStudent(updated);
    formatted.count = 1;
    formatted.success = true;
    formatted.updated = true;
    return formatted;
  }

  /**
   * Clears only portal credentials for a verified student admission number (sets username = null, password = null, updated_at = NOW()).
   * Strictly matches admission_number (never student name or phone number).
   * Verifies exactly one record is updated and guards against duplicate corruption.
   */
  async clearStudentCredentials(admissionNumber) {
    const cleanAdm = String(admissionNumber || '').trim();
    if (!cleanAdm) throw new Error('Admission number is required to clear credentials');

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();

        const checkRows = await sql`
          SELECT id, student_name, admission_number, phone_number, username, password, created_at, updated_at FROM students
          WHERE LOWER(TRIM(admission_number)) = LOWER(TRIM(${cleanAdm}));
        `;

        if (!checkRows || checkRows.length === 0) {
          console.warn(`[Admin DB] No student record found matching admission number '${cleanAdm}' to clear credentials.`);
          return null;
        }

        if (checkRows.length > 1) {
          const err = new Error(`Data integrity violation: ${checkRows.length} duplicate student records match admission number '${cleanAdm}'. Clear aborted.`);
          err.code = 'MULTIPLE_RECORDS_MATCH';
          console.error(`[Admin DB] ${err.message}`);
          throw err;
        }

        const rows = await sql`
          UPDATE students
          SET username = NULL,
              password = NULL,
              updated_at = NOW()
          WHERE LOWER(TRIM(admission_number)) = LOWER(TRIM(${cleanAdm}))
          RETURNING id, student_name, admission_number, phone_number, username, password, created_at, updated_at;
        `;

        if (rows && rows.length === 1) {
          const updated = this._formatStudent(rows[0]);
          updated.count = 1;
          updated.success = true;
          updated.cleared = true;
          this.memoryStudents.set(updated.admission_number, { ...updated });
          return updated;
        }

        if (rows && rows.length > 1) {
          const err = new Error(`Data integrity violation: ${rows.length} rows updated for admission number '${cleanAdm}'.`);
          err.code = 'MULTIPLE_RECORDS_MATCH';
          throw err;
        }

        return null;
      } catch (err) {
        console.error(`[Admin DB] clearStudentCredentials SQL error for ${cleanAdm}:`, err.message);
        throw err;
      }
    }

    // Memory store fallback
    const admLower = cleanAdm.toLowerCase();
    const matching = [];
    for (const [key, st] of this.memoryStudents.entries()) {
      if (st.admission_number && st.admission_number.toLowerCase().trim() === admLower) {
        matching.push({ key, st });
      }
    }

    if (matching.length === 0) {
      console.warn(`[Admin DB] Memory store: No student record found matching admission number '${cleanAdm}'.`);
      return null;
    }

    if (matching.length > 1) {
      const err = new Error(`Data integrity violation: ${matching.length} duplicate student records match admission number '${cleanAdm}'. Clear aborted.`);
      err.code = 'MULTIPLE_RECORDS_MATCH';
      console.error(`[Admin DB] ${err.message}`);
      throw err;
    }

    const { key, st: existing } = matching[0];
    const updated = {
      ...existing,
      portal_username: null,
      username: '',
      portal_password: null,
      password: '',
      updated_at: new Date().toISOString()
    };
    this.memoryStudents.set(key, updated);
    const formatted = this._formatStudent(updated);
    formatted.count = 1;
    formatted.success = true;
    formatted.cleared = true;
    return formatted;
  }

  /**
   * Clears only portal credentials for a verified student phone number (sets username = null, password = null, updated_at = NOW()).
   * Strictly matches phone_number (never student name or admission number).
   * Verifies exactly one record is updated and guards against duplicate corruption.
   */
  async clearStudentCredentialsByPhone(phoneNumber) {
    const cleanPhone = String(phoneNumber || '').trim();
    if (!cleanPhone) throw new Error('Phone number is required to clear credentials');

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();

        const checkRows = await sql`
          SELECT id, student_name, admission_number, phone_number, username, password, created_at, updated_at FROM students
          WHERE TRIM(phone_number) = TRIM(${cleanPhone});
        `;

        if (!checkRows || checkRows.length === 0) {
          console.warn(`[Admin DB] No student record found matching phone number '${cleanPhone}' to clear credentials.`);
          return null;
        }

        if (checkRows.length > 1) {
          const err = new Error(`Data integrity violation: ${checkRows.length} duplicate student records match phone number '${cleanPhone}'. Clear aborted.`);
          err.code = 'MULTIPLE_RECORDS_MATCH';
          console.error(`[Admin DB] ${err.message}`);
          throw err;
        }

        const rows = await sql`
          UPDATE students
          SET username = NULL,
              password = NULL,
              updated_at = NOW()
          WHERE TRIM(phone_number) = TRIM(${cleanPhone})
          RETURNING id, student_name, admission_number, phone_number, username, password, created_at, updated_at;
        `;

        if (rows && rows.length === 1) {
          const updated = this._formatStudent(rows[0]);
          updated.count = 1;
          updated.success = true;
          updated.cleared = true;
          this.memoryStudents.set(updated.admission_number, { ...updated });
          return updated;
        }

        if (rows && rows.length > 1) {
          const err = new Error(`Data integrity violation: ${rows.length} rows updated for phone number '${cleanPhone}'.`);
          err.code = 'MULTIPLE_RECORDS_MATCH';
          throw err;
        }

        return null;
      } catch (err) {
        console.error(`[Admin DB] clearStudentCredentialsByPhone SQL error for ${cleanPhone}:`, err.message);
        throw err;
      }
    }

    // Memory store fallback
    const matching = [];
    for (const [key, st] of this.memoryStudents.entries()) {
      if (st.phone_number && String(st.phone_number).trim() === cleanPhone) {
        matching.push({ key, st });
      }
    }

    if (matching.length === 0) {
      console.warn(`[Admin DB] Memory store: No student record found matching phone number '${cleanPhone}'.`);
      return null;
    }

    if (matching.length > 1) {
      const err = new Error(`Data integrity violation: ${matching.length} duplicate student records match phone number '${cleanPhone}'. Clear aborted.`);
      err.code = 'MULTIPLE_RECORDS_MATCH';
      console.error(`[Admin DB] ${err.message}`);
      throw err;
    }

    const { key, st: existing } = matching[0];
    const updated = {
      ...existing,
      portal_username: null,
      username: '',
      portal_password: null,
      password: '',
      updated_at: new Date().toISOString()
    };
    this.memoryStudents.set(key, updated);
    const formatted = this._formatStudent(updated);
    formatted.count = 1;
    formatted.success = true;
    formatted.cleared = true;
    return formatted;
  }

  /**
   * Seeds in-memory stores with baseline student records for unit testing and offline execution.
   */
  _seedMemoryStudents() {
    const seedStudents = [
      { student_name: 'Ansh Singh', name: 'Ansh Singh', admission_number: '8887416471', phone_number: '8887416471', section: 'CSE-A', portal_username: null, username: '', portal_password: null, password: '' },
      { student_name: 'Anuj Kumar', name: 'Anuj Kumar', admission_number: '9919741137', phone_number: '9919741137', section: 'CSE-B', portal_username: null, username: '', portal_password: null, password: '' },
      { student_name: 'Demo Student', name: 'Demo Student', admission_number: '0012345678', phone_number: '0012345678', section: 'CSE-A', portal_username: null, username: '', portal_password: null, password: '' }
    ];

    for (let i = 1; i <= 10; i++) {
      const num = String(1000000000 + i);
      seedStudents.push({
        student_name: `Test Student ${num}`,
        name: `Test Student ${num}`,
        admission_number: num,
        phone_number: num,
        section: 'CSE-A',
        portal_username: null,
        username: '',
        portal_password: null,
        password: ''
      });
    }

    for (const s of seedStudents) {
      this.memoryStudents.set(s.admission_number, {
        id: this.nextStudentId++,
        ...s,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }
  }

  /**
   * Records a student search operation into search_logs.
   * Does NOT record student passwords or API keys.
   */
  async logSearch({ admissionNumber, searchQuery, searchType = 'Admission Number', result = 'SYSTEM_ERROR' }) {
    const cleanAdm = String(admissionNumber || searchQuery || '').trim();
    const cleanQuery = cleanAdm;
    const cleanType = String(searchType || 'Admission Number').trim();
    const cleanResult = String(result || 'SYSTEM_ERROR').trim().toUpperCase();

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();
        const rows = await sql`
          INSERT INTO search_logs (admission_number, search_query, search_type, result, created_at)
          VALUES (${cleanAdm}, ${cleanQuery}, ${cleanType}, ${cleanResult}, NOW())
          RETURNING id, COALESCE(admission_number, search_query) AS admission_number, search_query, search_type, result, created_at;
        `;
        if (rows && rows.length > 0) {
          const formatted = this._formatSearchLog(rows[0]);
          this.memorySearchLogs.unshift(formatted);
          return formatted;
        }
      } catch (err) {
        console.warn('[Admin DB] logSearch SQL error, fallback to memory:', err.message);
      }
    }

    const logEntry = {
      id: this.nextSearchLogId++,
      admission_number: cleanAdm,
      search_query: cleanQuery,
      search_type: cleanType,
      result: cleanResult,
      created_at: new Date().toISOString()
    };
    this.memorySearchLogs.unshift(logEntry);
    return this._formatSearchLog(logEntry);
  }

  /**
   * Retrieves paginated search logs with filtering.
   */
  async listSearchLogs({ page = 1, limit = 20, search = '', result = '', searchType = '', date = '' } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;
    const cleanSearch = String(search || '').trim().toLowerCase();
    const cleanResult = String(result || '').trim().toUpperCase();
    const cleanType = String(searchType || '').trim();
    const cleanDate = String(date || '').trim();

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();

        // High-performance direct path for default view (no filters applied)
        if (!cleanSearch && !cleanResult && !cleanType && !cleanDate) {
          const countRes = await sql`SELECT COUNT(*) AS total FROM search_logs;`;
          const total = parseInt(countRes[0]?.total || 0, 10);

          const rows = await sql`
            SELECT id, COALESCE(admission_number, search_query) AS admission_number, search_query, search_type, result, created_at
            FROM search_logs
            ORDER BY created_at DESC, id DESC
            LIMIT ${limitNum} OFFSET ${offset};
          `;

          return {
            logs: rows.map(r => this._formatSearchLog(r)),
            total,
            page: pageNum,
            totalPages: Math.ceil(total / limitNum) || 1,
            limit: limitNum
          };
        }

        const conditions = [];
        const params = [];
        let pIdx = 1;

        if (cleanSearch) {
          conditions.push(`(COALESCE(admission_number, '') ILIKE $${pIdx} OR search_query ILIKE $${pIdx})`);
          params.push(`%${cleanSearch}%`);
          pIdx++;
        }

        if (cleanResult) {
          conditions.push(`result = $${pIdx}`);
          params.push(cleanResult);
          pIdx++;
        }

        if (cleanType) {
          conditions.push(`search_type ILIKE $${pIdx}`);
          params.push(cleanType);
          pIdx++;
        }

        if (cleanDate) {
          conditions.push(`(created_at AT TIME ZONE 'Asia/Kolkata')::date = $${pIdx}::date`);
          params.push(cleanDate);
          pIdx++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countQuery = `SELECT COUNT(*) AS total FROM search_logs ${whereClause};`;
        const countRows = await sql.query(countQuery, params);
        const total = parseInt(countRows[0]?.total || 0, 10);

        const listQuery = `
          SELECT id, COALESCE(admission_number, search_query) AS admission_number, search_query, search_type, result, created_at
          FROM search_logs
          ${whereClause}
          ORDER BY created_at DESC, id DESC
          LIMIT $${pIdx} OFFSET $${pIdx + 1};
        `;
        const rows = await sql.query(listQuery, [...params, limitNum, offset]);

        return {
          logs: rows.map(r => this._formatSearchLog(r)),
          total,
          page: pageNum,
          totalPages: Math.ceil(total / limitNum) || 1,
          limit: limitNum
        };
      } catch (err) {
        console.warn('[Admin DB] listSearchLogs error, fallback to memory:', err.message);
      }
    }

    // Memory fallback
    let all = [...this.memorySearchLogs];

    if (cleanSearch) {
      all = all.filter(l => (l.admission_number || l.search_query || '').toLowerCase().includes(cleanSearch));
    }

    if (cleanResult) {
      all = all.filter(l => (l.result || '').toUpperCase() === cleanResult);
    }

    if (cleanType) {
      all = all.filter(l => (l.search_type || '').toLowerCase() === cleanType.toLowerCase());
    }

    if (cleanDate) {
      all = all.filter(l => {
        if (!l.created_at) return false;
        const d = new Date(l.created_at);
        const istDateStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        return istDateStr === cleanDate;
      });
    }

    all.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const total = all.length;
    const paginated = all.slice(offset, offset + limitNum).map(l => this._formatSearchLog(l));

    return {
      logs: paginated,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum) || 1,
      limit: limitNum
    };
  }

  /**
   * Clears all search activity logs.
   * NEVER deletes student records.
   */
  async clearSearchLogs() {
    this.memorySearchLogs = [];

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();
        await sql`DELETE FROM search_logs;`;
        return true;
      } catch (err) {
        console.warn('[Admin DB] clearSearchLogs error:', err.message);
        throw err;
      }
    }
    return true;
  }

  /**
   * Retrieves summary statistics from the search_logs table.
   */
  async getSearchLogStats() {
    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();
        const rows = await sql`
          SELECT 
            COUNT(*) AS total_searches,
            COUNT(*) FILTER (WHERE result = 'SUCCESS') AS successful_lookups,
            COUNT(*) FILTER (WHERE result IN ('API_ERROR', 'INVALID_RESPONSE', 'TIMEOUT', 'NETWORK_ERROR')) AS api_errors,
            COUNT(*) FILTER (WHERE result = 'NOT_FOUND') AS not_found,
            COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS searches_today
          FROM search_logs;
        `;
        if (rows && rows.length > 0) {
          const r = rows[0];
          const totalSearches = parseInt(r.total_searches || 0, 10);
          const successCount = parseInt(r.successful_lookups || 0, 10);
          return {
            totalSearches,
            successCount,
            successfulLookups: successCount,
            failedCount: Math.max(0, totalSearches - successCount),
            apiErrors: parseInt(r.api_errors || 0, 10),
            studentsNotFound: parseInt(r.not_found || 0, 10),
            searchesToday: parseInt(r.searches_today || 0, 10)
          };
        }
      } catch (err) {
        console.warn('[Admin DB] getSearchLogStats error, fallback to memory:', err.message);
      }
    }

    // Memory stats
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    let totalSearches = this.memorySearchLogs.length;
    let successfulLookups = 0;
    let apiErrors = 0;
    let studentsNotFound = 0;
    let searchesToday = 0;

    for (const log of this.memorySearchLogs) {
      const res = (log.result || '').toUpperCase();
      if (res === 'SUCCESS') successfulLookups++;
      if (['API_ERROR', 'INVALID_RESPONSE', 'TIMEOUT', 'NETWORK_ERROR'].includes(res)) apiErrors++;
      if (res === 'NOT_FOUND') studentsNotFound++;
      if (log.created_at) {
        const dStr = new Date(log.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        if (dStr === todayStr) searchesToday++;
      }
    }

    return {
      totalSearches,
      successCount: successfulLookups,
      successfulLookups,
      failedCount: Math.max(0, totalSearches - successfulLookups),
      apiErrors,
      studentsNotFound,
      searchesToday
    };
  }

  // =========================================================================
  // Exception Management (Blocking & Custom Responses)
  // =========================================================================

  /**
   * Retrieves an exception by student number (e.g. 10-digit phone number or identifier).
   * Exact match, preserves leading zeros as text.
   * @param {string} studentNumber
   * @returns {Promise<Object|null>}
   */
  async getExceptionByStudentNumber(studentNumber) {
    const rawNumber = String(studentNumber || '').trim();
    if (!rawNumber) return null;

    const normalizePhone = (num) => {
      let s = String(num || '').trim().replace(/[\s\-\(\)]/g, '');
      if (s.startsWith('+91')) s = s.slice(3);
      if (s.startsWith('91') && s.length === 12) s = s.slice(2);
      return s;
    };

    const cleanNumber = normalizePhone(rawNumber);

    const sql = this.getSql();
    if (sql && this.isNeonActive) {
      try {
        await this.ensureSchema();
        const rows = await sql`
          SELECT * FROM student_exceptions
          WHERE student_number = ${rawNumber}
             OR student_number = ${cleanNumber}
             OR student_number = ${'+91' + cleanNumber}
             OR student_number = ${'+91 ' + cleanNumber}
          LIMIT 1;
        `;
        if (rows && rows.length > 0) {
          return this._formatException(rows[0]);
        }
        return null;
      } catch (err) {
        console.warn('[Admin DB] Neon getExceptionByStudentNumber fallback to memory:', err.message);
      }
    }

    let exc = this.memoryExceptions.get(rawNumber) || this.memoryExceptions.get(cleanNumber);
    if (!exc) {
      for (const item of this.memoryExceptions.values()) {
        const itemRaw = String(item.student_number || '').trim();
        const itemClean = normalizePhone(itemRaw);
        if (itemRaw === rawNumber || itemClean === cleanNumber) {
          exc = item;
          break;
        }
      }
    }
    return exc ? this._formatException(exc) : null;
  }

  /**
   * Lists all exceptions with optional search and pagination.
   * @param {Object} options
   * @returns {Promise<{exceptions: Array, total: number, page: number, limit: number, totalPages: number}>}
   */
  async listExceptions({ page = 1, limit = 50, search = '' } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;
    const cleanSearch = String(search || '').trim();

    const sql = this.getSql();
    if (sql && this.isNeonActive) {
      try {
        await this.ensureSchema();
        let rows;
        let countRes;
        if (cleanSearch) {
          const searchPattern = `%${cleanSearch}%`;
          rows = await sql`
            SELECT * FROM student_exceptions
            WHERE student_number ILIKE ${searchPattern}
               OR custom_message ILIKE ${searchPattern}
            ORDER BY id DESC
            LIMIT ${limitNum} OFFSET ${offset};
          `;
          countRes = await sql`
            SELECT COUNT(*)::int AS total FROM student_exceptions
            WHERE student_number ILIKE ${searchPattern}
               OR custom_message ILIKE ${searchPattern};
          `;
        } else {
          rows = await sql`
            SELECT * FROM student_exceptions
            ORDER BY id DESC
            LIMIT ${limitNum} OFFSET ${offset};
          `;
          countRes = await sql`
            SELECT COUNT(*)::int AS total FROM student_exceptions;
          `;
        }

        const total = countRes[0]?.total || 0;
        return {
          exceptions: rows.map(r => this._formatException(r)),
          total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.max(1, Math.ceil(total / limitNum))
        };
      } catch (err) {
        console.warn('[Admin DB] Neon listExceptions fallback to memory:', err.message);
      }
    }

    // In-memory fallback
    let all = Array.from(this.memoryExceptions.values());
    if (cleanSearch) {
      const q = cleanSearch.toLowerCase();
      all = all.filter(e =>
        String(e.student_number || '').toLowerCase().includes(q) ||
        String(e.custom_message || '').toLowerCase().includes(q)
      );
    }
    all.sort((a, b) => Number(b.id) - Number(a.id));

    const total = all.length;
    const paged = all.slice(offset, offset + limitNum);

    return {
      exceptions: paged.map(e => this._formatException(e)),
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.max(1, Math.ceil(total / limitNum))
    };
  }

  /**
   * Retrieves an exception record by ID.
   * @param {number|string} id
   * @returns {Promise<Object|null>}
   */
  async getExceptionById(id) {
    const idNum = parseInt(id, 10);
    if (!idNum) return null;

    const sql = this.getSql();
    if (sql && this.isNeonActive) {
      try {
        await this.ensureSchema();
        const rows = await sql`
          SELECT * FROM student_exceptions
          WHERE id = ${idNum}
          LIMIT 1;
        `;
        if (rows && rows.length > 0) {
          return this._formatException(rows[0]);
        }
        return null;
      } catch (err) {
        console.warn('[Admin DB] Neon getExceptionById fallback to memory:', err.message);
      }
    }

    for (const exc of this.memoryExceptions.values()) {
      if (Number(exc.id) === idNum) {
        return this._formatException(exc);
      }
    }
    return null;
  }

  /**
   * Creates a new student exception rule.
   * Prevents duplicates by student_number.
   * @param {Object} data
   * @returns {Promise<Object>}
   */
  async createException({ student_number, custom_message }) {
    const cleanNumber = String(student_number || '').trim();
    const cleanMessage = String(custom_message || '').trim();

    if (!cleanNumber) {
      const err = new Error('Student number is required.');
      err.code = 'MISSING_STUDENT_NUMBER';
      throw err;
    }
    if (!cleanMessage) {
      const err = new Error('Custom message is required.');
      err.code = 'MISSING_CUSTOM_MESSAGE';
      throw err;
    }

    // Check existing
    const existing = await this.getExceptionByStudentNumber(cleanNumber);
    if (existing) {
      const err = new Error('An exception for this student number already exists.');
      err.code = 'DUPLICATE_EXCEPTION';
      throw err;
    }

    const sql = this.getSql();
    if (sql && this.isNeonActive) {
      try {
        await this.ensureSchema();
        const rows = await sql`
          INSERT INTO student_exceptions (student_number, custom_message, created_at, updated_at)
          VALUES (${cleanNumber}, ${cleanMessage}, NOW(), NOW())
          RETURNING *;
        `;
        const formatted = this._formatException(rows[0]);
        this.memoryExceptions.set(cleanNumber, formatted);
        return formatted;
      } catch (err) {
        if (err.code === '23505') {
          const dupErr = new Error('An exception for this student number already exists.');
          dupErr.code = 'DUPLICATE_EXCEPTION';
          throw dupErr;
        }
        console.warn('[Admin DB] Neon createException fallback to memory:', err.message);
      }
    }

    // In-memory fallback
    const id = this.nextExceptionId++;
    const now = new Date().toISOString();
    const newExc = {
      id,
      student_number: cleanNumber,
      custom_message: cleanMessage,
      created_at: now,
      updated_at: now
    };
    this.memoryExceptions.set(cleanNumber, newExc);
    return this._formatException(newExc);
  }

  /**
   * Updates an existing exception rule by ID.
   * @param {number|string} id
   * @param {Object} data
   * @returns {Promise<Object|null>}
   */
  async updateException(id, { student_number, custom_message }) {
    const idNum = parseInt(id, 10);
    if (!idNum) return null;

    const existing = await this.getExceptionById(idNum);
    if (!existing) return null;

    const newNumber = student_number !== undefined ? String(student_number).trim() : existing.student_number;
    const newMessage = custom_message !== undefined ? String(custom_message).trim() : existing.custom_message;

    if (!newNumber) {
      const err = new Error('Student number cannot be empty.');
      err.code = 'INVALID_STUDENT_NUMBER';
      throw err;
    }
    if (!newMessage) {
      const err = new Error('Custom message cannot be empty.');
      err.code = 'INVALID_CUSTOM_MESSAGE';
      throw err;
    }

    // If changing student number, verify uniqueness
    if (newNumber !== existing.student_number) {
      const other = await this.getExceptionByStudentNumber(newNumber);
      if (other && Number(other.id) !== idNum) {
        const err = new Error('Another exception rule already exists for this student number.');
        err.code = 'DUPLICATE_EXCEPTION';
        throw err;
      }
    }

    const sql = this.getSql();
    if (sql && this.isNeonActive) {
      try {
        await this.ensureSchema();
        const rows = await sql`
          UPDATE student_exceptions
          SET student_number = ${newNumber},
              custom_message = ${newMessage},
              updated_at = NOW()
          WHERE id = ${idNum}
          RETURNING *;
        `;
        if (rows && rows.length > 0) {
          const formatted = this._formatException(rows[0]);
          if (existing.student_number !== newNumber) {
            this.memoryExceptions.delete(existing.student_number);
          }
          this.memoryExceptions.set(newNumber, formatted);
          return formatted;
        }
        return null;
      } catch (err) {
        if (err.code === '23505') {
          const dupErr = new Error('Another exception rule already exists for this student number.');
          dupErr.code = 'DUPLICATE_EXCEPTION';
          throw dupErr;
        }
        console.warn('[Admin DB] Neon updateException fallback to memory:', err.message);
      }
    }

    // In-memory fallback
    if (existing.student_number !== newNumber) {
      this.memoryExceptions.delete(existing.student_number);
    }
    const updatedExc = {
      id: idNum,
      student_number: newNumber,
      custom_message: newMessage,
      created_at: existing.created_at,
      updated_at: new Date().toISOString()
    };
    this.memoryExceptions.set(newNumber, updatedExc);
    return this._formatException(updatedExc);
  }

  /**
   * Deletes an exception record by ID.
   * @param {number|string} id
   * @returns {Promise<{success: boolean, deleted: boolean}>}
   */
  async deleteException(id) {
    const idNum = parseInt(id, 10);
    if (!idNum) return { success: false, deleted: false };

    const sql = this.getSql();
    if (sql && this.isNeonActive) {
      try {
        await this.ensureSchema();
        const rows = await sql`
          DELETE FROM student_exceptions
          WHERE id = ${idNum}
          RETURNING *;
        `;
        if (rows && rows.length > 0) {
          const deletedNum = rows[0].student_number;
          this.memoryExceptions.delete(deletedNum);
          return { success: true, deleted: true };
        }
        return { success: false, deleted: false };
      } catch (err) {
        console.warn('[Admin DB] Neon deleteException fallback to memory:', err.message);
      }
    }

    // In-memory fallback
    for (const [key, exc] of this.memoryExceptions.entries()) {
      if (Number(exc.id) === idNum) {
        this.memoryExceptions.delete(key);
        return { success: true, deleted: true };
      }
    }
    return { success: false, deleted: false };
  }

  /**
   * Formats an exception object.
   */
  _formatException(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      student_number: String(row.student_number || '').trim(),
      custom_message: String(row.custom_message || ''),
      created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()
    };
  }

  /**
   * Formats a search log object.
   */
  _formatSearchLog(l) {
    if (!l) return null;
    const adm = l.admission_number || l.search_query || '';
    return {
      id: Number(l.id),
      admission_number: adm,
      search_query: adm,
      search_type: l.search_type || 'Admission Number',
      result: (l.result || 'SYSTEM_ERROR').toUpperCase(),
      created_at: l.created_at ? new Date(l.created_at).toISOString() : new Date().toISOString()
    };
  }

  /**
   * Formats student object for clean API response.
   * Maps both canonical schema fields (student_name, portal_username, portal_password)
   * and backwards-compatible aliases (name, username, password).
   */
  _formatStudent(s) {
    if (!s) return null;
    const studentName = String(s.student_name || s.name || '').trim();
    const rawUser = (s.username !== undefined && s.username !== null && s.username !== '')
      ? String(s.username).trim()
      : ((s.portal_username !== undefined && s.portal_username !== null && s.portal_username !== '') ? String(s.portal_username).trim() : null);
    const rawPass = (s.password !== undefined && s.password !== null && s.password !== '')
      ? String(s.password).trim()
      : ((s.portal_password !== undefined && s.portal_password !== null && s.portal_password !== '') ? String(s.portal_password).trim() : null);

    return {
      id: Number(s.id),
      student_name: studentName,
      name: studentName,
      admission_number: String(s.admission_number || '').trim(),
      phone_number: String(s.phone_number || '').trim(),
      username: rawUser ? rawUser : '',
      portal_username: rawUser ? rawUser : null,
      password: rawPass ? rawPass : '',
      portal_password: rawPass ? rawPass : null,
      section: String(s.section || '').trim(),
      created_at: s.created_at ? new Date(s.created_at).toISOString() : new Date().toISOString(),
      updated_at: s.updated_at ? new Date(s.updated_at).toISOString() : new Date().toISOString()
    };
  }
}

const defaultAdminDbService = new AdminDbService();

module.exports = {
  AdminDbService,
  defaultAdminDbService
};
