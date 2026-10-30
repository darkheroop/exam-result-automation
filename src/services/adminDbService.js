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
    this.nextStudentId = 1;
    this.nextSearchLogId = 1;

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
        // 1. managed_students table & indexes
        try {
          await sql`
            CREATE TABLE IF NOT EXISTS managed_students (
              id BIGSERIAL PRIMARY KEY,
              name VARCHAR(255) NOT NULL,
              admission_number VARCHAR(64) UNIQUE NOT NULL,
              phone_number VARCHAR(32),
              username VARCHAR(128) DEFAULT '',
              password VARCHAR(255) DEFAULT '',
              section VARCHAR(64) DEFAULT '',
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
          `;
          try {
            await sql`ALTER TABLE managed_students ADD COLUMN IF NOT EXISTS username VARCHAR(128) DEFAULT '';`;
            await sql`ALTER TABLE managed_students ADD COLUMN IF NOT EXISTS password VARCHAR(255) DEFAULT '';`;
            await sql`ALTER TABLE managed_students ADD COLUMN IF NOT EXISTS section VARCHAR(64) DEFAULT '';`;
          } catch (_) {}
          await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_students_adm ON managed_students(admission_number);`;
          await sql`CREATE INDEX IF NOT EXISTS idx_managed_students_name ON managed_students(name);`;
          await sql`CREATE INDEX IF NOT EXISTS idx_managed_students_phone ON managed_students(phone_number);`;
          await sql`CREATE INDEX IF NOT EXISTS idx_managed_students_user ON managed_students(username);`;
          await sql`CREATE INDEX IF NOT EXISTS idx_managed_students_sec ON managed_students(section);`;
        } catch (tableErr) {
          console.warn('[Admin DB] managed_students schema check notice:', tableErr.message);
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

    const allowedSortFields = ['id', 'name', 'admission_number', 'phone_number', 'username', 'section', 'created_at', 'updated_at'];
    let sortField = allowedSortFields.includes(sortBy) ? sortBy : 'id';
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
            name ILIKE $${pIndex} OR 
            admission_number ILIKE $${pIndex} OR 
            phone_number ILIKE $${pIndex} OR 
            username ILIKE $${pIndex}
          )`);
          params.push(`%${cleanSearch}%`);
          pIndex++;
        }

        if (cleanSection) {
          conditions.push(`section ILIKE $${pIndex}`);
          params.push(cleanSection);
          pIndex++;
        }

        if (cleanCredential === 'complete') {
          conditions.push(`(username IS NOT NULL AND username <> '' AND password IS NOT NULL AND password <> '')`);
        } else if (cleanCredential === 'missing_username') {
          conditions.push(`(username IS NULL OR username = '')`);
        } else if (cleanCredential === 'missing_password') {
          conditions.push(`(password IS NULL OR password = '')`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countQuery = `SELECT COUNT(*) AS total FROM managed_students ${whereClause};`;
        const countRows = await sql.query(countQuery, params);
        const total = parseInt(countRows[0]?.total || 0, 10);

        const listQuery = `
          SELECT id, name, admission_number, phone_number, username, password, section, created_at, updated_at
          FROM managed_students
          ${whereClause}
          ORDER BY ${sortField} ${sortDirection}, id DESC
          LIMIT $${pIndex} OFFSET $${pIndex + 1};
        `;
        const students = await sql.query(listQuery, [...params, limitNum, offset]);

        let sections = [];
        try {
          const secRows = await sql`
            SELECT DISTINCT section FROM managed_students 
            WHERE section IS NOT NULL AND section <> '' 
            ORDER BY section ASC;
          `;
          sections = secRows.map(r => r.section);
        } catch (_) {}

        return {
          students: students.map(s => this._formatStudent(s)),
          total,
          page: pageNum,
          totalPages: Math.ceil(total / limitNum) || 1,
          limit: limitNum,
          sections
        };
      } catch (err) {
        console.warn('[Admin DB] listStudents query error, falling back to memory:', err.message);
      }
    }

    // Memory fallback
    let all = Array.from(this.memoryStudents.values());

    if (cleanSearch) {
      all = all.filter(s =>
        (s.name && s.name.toLowerCase().includes(cleanSearch)) ||
        (s.admission_number && s.admission_number.toLowerCase().includes(cleanSearch)) ||
        (s.phone_number && s.phone_number.toLowerCase().includes(cleanSearch)) ||
        (s.username && s.username.toLowerCase().includes(cleanSearch))
      );
    }

    if (cleanSection) {
      all = all.filter(s => s.section && s.section.toLowerCase() === cleanSection.toLowerCase());
    }

    if (cleanCredential === 'complete') {
      all = all.filter(s => s.username && s.password);
    } else if (cleanCredential === 'missing_username') {
      all = all.filter(s => !s.username);
    } else if (cleanCredential === 'missing_password') {
      all = all.filter(s => !s.password);
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
          SELECT * FROM managed_students WHERE id = ${studentId} LIMIT 1;
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
          SELECT * FROM managed_students 
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
   * Upserts a single student record.
   * Duplicate protection: on conflict on admission_number:
   * updates name, phone_number, section.
   * NEVER overwrites existing non-empty username/password if incoming is empty/undefined.
   */
  async upsertStudent({ name, admission_number, phone_number = '', username = '', password = '', section = '' }) {
    const cleanName = String(name || '').trim();
    const cleanAdm = String(admission_number || '').trim();
    const cleanPhone = String(phone_number || '').trim();
    const cleanUser = String(username || '').trim();
    const cleanPass = String(password || '').trim();
    const cleanSec = String(section || '').trim();

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
          SELECT id, username, password FROM managed_students WHERE LOWER(TRIM(admission_number)) = LOWER(TRIM(${cleanAdm})) LIMIT 1;
        `;
        isUpdate = existingRows && existingRows.length > 0;

        const rows = await sql`
          INSERT INTO managed_students (
            name, admission_number, phone_number, username, password, section, created_at, updated_at
          ) VALUES (
            ${cleanName}, ${cleanAdm}, ${cleanPhone}, ${cleanUser}, ${cleanPass}, ${cleanSec}, NOW(), NOW()
          )
          ON CONFLICT (admission_number) DO UPDATE SET
            name = EXCLUDED.name,
            phone_number = EXCLUDED.phone_number,
            section = EXCLUDED.section,
            username = CASE
              WHEN EXCLUDED.username IS NOT NULL AND EXCLUDED.username <> '' THEN EXCLUDED.username
              ELSE managed_students.username
            END,
            password = CASE
              WHEN EXCLUDED.password IS NOT NULL AND EXCLUDED.password <> '' THEN EXCLUDED.password
              ELSE managed_students.password
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
      savedStudent = {
        ...existing,
        name: cleanName || existing.name,
        phone_number: cleanPhone || existing.phone_number,
        section: cleanSec || existing.section,
        username: cleanUser !== '' ? cleanUser : existing.username,
        password: cleanPass !== '' ? cleanPass : existing.password,
        updated_at: new Date().toISOString()
      };
    } else {
      isUpdate = false;
      savedStudent = {
        id: this.nextStudentId++,
        name: cleanName,
        admission_number: cleanAdm,
        phone_number: cleanPhone,
        username: cleanUser,
        password: cleanPass,
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

    const cleanName = fields.name !== undefined ? String(fields.name).trim() : currentStudent.name;
    const cleanPhone = fields.phone_number !== undefined ? String(fields.phone_number).trim() : currentStudent.phone_number;
    const cleanSec = fields.section !== undefined ? String(fields.section).trim() : currentStudent.section;

    // Credentials preservation: if not provided or empty, retain existing!
    let newUsername = currentStudent.username;
    if (fields.username !== undefined && fields.username !== null && fields.username !== '') {
      newUsername = String(fields.username).trim();
    }

    let newPassword = currentStudent.password;
    if (fields.password !== undefined && fields.password !== null && fields.password !== '') {
      newPassword = String(fields.password).trim();
    }

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();
        const rows = await sql`
          UPDATE managed_students
          SET
            name = ${cleanName},
            admission_number = ${cleanAdm},
            phone_number = ${cleanPhone},
            username = ${newUsername},
            password = ${newPassword},
            section = ${cleanSec},
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
      name: cleanName,
      admission_number: cleanAdm,
      phone_number: cleanPhone,
      username: newUsername,
      password: newPassword,
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
          DELETE FROM managed_students WHERE id = ${studentId} RETURNING id;
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
      validItems.push({
        index: i,
        name: String(item.name || 'STUDENT').trim(),
        admission_number: String(item.admission_number).trim(),
        phone_number: String(item.phone_number || '').trim(),
        section: String(item.section || '').trim(),
        username: String(item.username || '').trim(),
        password: String(item.password || '').trim()
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
            valueClauses.push(`($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}, NOW())`);
            params.push(s.name, s.admission_number, s.phone_number, s.section, s.username, s.password);
            pIdx += 6;
          }

          const query = `
            INSERT INTO managed_students (name, admission_number, phone_number, section, username, password, updated_at)
            VALUES ${valueClauses.join(', ')}
            ON CONFLICT (admission_number) DO UPDATE SET
              name = EXCLUDED.name,
              phone_number = CASE WHEN EXCLUDED.phone_number <> '' THEN EXCLUDED.phone_number ELSE managed_students.phone_number END,
              section = CASE WHEN EXCLUDED.section <> '' THEN EXCLUDED.section ELSE managed_students.section END,
              username = CASE WHEN EXCLUDED.username <> '' THEN EXCLUDED.username ELSE managed_students.username END,
              password = CASE WHEN EXCLUDED.password <> '' THEN EXCLUDED.password ELSE managed_students.password END,
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
            COUNT(DISTINCT section) FILTER (WHERE section IS NOT NULL AND section <> '')::int AS total_sections,
            COUNT(*) FILTER (WHERE username IS NOT NULL AND username <> '')::int AS students_with_username,
            COUNT(*) FILTER (WHERE username IS NULL OR username = '')::int AS students_without_username,
            COUNT(*) FILTER (WHERE password IS NOT NULL AND password <> '')::int AS students_with_password,
            COUNT(*) FILTER (WHERE password IS NULL OR password = '')::int AS students_without_password
          FROM managed_students;
        `;

        const recentAdded = await sql`
          SELECT id, name, admission_number, phone_number, section, created_at
          FROM managed_students
          ORDER BY id DESC
          LIMIT 5;
        `;

        const recentUpdated = await sql`
          SELECT id, name, admission_number, phone_number, section, updated_at
          FROM managed_students
          ORDER BY updated_at DESC
          LIMIT 5;
        `;

        const sectionRows = await sql`
          SELECT
            CASE WHEN section IS NULL OR section = '' THEN 'Unassigned' ELSE section END AS section,
            COUNT(*)::int AS count
          FROM managed_students
          GROUP BY section
          ORDER BY count DESC;
        `;

        const row = statsQuery[0] || {};
        return {
          totalStudents: row.total_students || 0,
          totalSections: row.total_sections || 0,
          studentsWithUsername: row.students_with_username || 0,
          studentsWithoutUsername: row.students_without_username || 0,
          studentsWithPassword: row.students_with_password || 0,
          studentsWithoutPassword: row.students_without_password || 0,
          recentlyAdded: recentAdded.map(s => this._formatStudent(s)),
          recentlyUpdated: recentUpdated.map(s => this._formatStudent(s)),
          sectionBreakdown: sectionRows.map(r => ({ section: r.section, count: Number(r.count) }))
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

      if (s.username && s.username.trim() !== '') {
        studentsWithUsername++;
      } else {
        studentsWithoutUsername++;
      }

      if (s.password && s.password.trim() !== '') {
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
   * Updates only username and password for a verified student admission number.
   * Strictly matches admission_number (never student name or phone number).
   * Verifies exactly one record is updated and guards against duplicate corruption.
   */
  async updateStudentCredentials(admissionNumber, { username = '', password = '' }) {
    const cleanAdm = String(admissionNumber || '').trim();
    if (!cleanAdm) throw new Error('Admission number is required to update credentials');
    const cleanUser = String(username || '').trim();
    const cleanPass = String(password || '').trim();

    if (!cleanUser || !cleanPass) {
      throw new Error('Valid, non-empty username and password are required to update credentials');
    }

    const sql = this.getSql();
    if (sql) {
      try {
        await this.ensureSchema();

        // 1. Verify existence and check for duplicates to ensure data integrity
        const checkRows = await sql`
          SELECT id, admission_number FROM managed_students
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

        // 2. Perform parameterized update matching ONLY admission_number
        const rows = await sql`
          UPDATE managed_students
          SET username = ${cleanUser},
              password = ${cleanPass},
              updated_at = NOW()
          WHERE LOWER(TRIM(admission_number)) = LOWER(TRIM(${cleanAdm}))
          RETURNING id, name, admission_number, phone_number, username, password, section, created_at, updated_at;
        `;

        if (rows && rows.length === 1) {
          const updated = this._formatStudent(rows[0]);
          updated.count = 1;
          updated.success = true;
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
    const updated = {
      ...existing,
      username: cleanUser,
      password: cleanPass,
      updated_at: new Date().toISOString()
    };
    this.memoryStudents.set(key, updated);
    const formatted = this._formatStudent(updated);
    formatted.count = 1;
    formatted.success = true;
    return formatted;
  }

  /**
   * Seeds in-memory stores with baseline student records for unit testing and offline execution.
   */
  _seedMemoryStudents() {
    const seedStudents = [
      { name: 'Ansh Singh', admission_number: '8887416471', phone_number: '8887416471', section: 'CSE-A', username: 'ansh14', password: 'gaqhf' },
      { name: 'Anuj Kumar', admission_number: '9919741137', phone_number: '9919741137', section: 'CSE-B', username: 'anuj2', password: 'ldkdl' },
      { name: 'Demo Student', admission_number: '0012345678', phone_number: '0012345678', section: 'CSE-A', username: '', password: '' }
    ];

    for (let i = 1; i <= 10; i++) {
      const num = String(1000000000 + i);
      seedStudents.push({
        name: `Test Student ${num}`,
        admission_number: num,
        phone_number: num,
        section: 'CSE-A',
        username: 'mock_student',
        password: 'mock_password_123'
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
   */
  _formatStudent(s) {
    if (!s) return null;
    return {
      id: Number(s.id),
      name: s.name || '',
      admission_number: s.admission_number || '',
      phone_number: s.phone_number || '',
      username: s.username || '',
      password: s.password || '',
      section: s.section || '',
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
