'use strict';

let neonClient = null;
try {
  const { neon } = require('@neondatabase/serverless');
  neonClient = neon;
} catch (err) {
  // @neondatabase/serverless optional load
}

class AdminDbService {
  constructor(options = {}) {
    this.connectionString = options.connectionString ||
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.POSTGRES_PRISMA_URL ||
      null;

    this.sql = null;
    this.schemaInitialized = false;
    this.schemaPromise = null;
    this.isNeonActive = false;

    // Resilient In-Memory Fallback Stores
    this.memoryStudents = new Map(); // key: admission_number, value: student object
    this.memoryAdminSessions = new Map(); // key: token, value: session object
    this.nextStudentId = 1;

    if (this.connectionString && neonClient) {
      try {
        this.sql = neonClient(this.connectionString);
        this.isNeonActive = true;
      } catch (err) {
        console.warn('[Admin DB] Failed to initialize Neon client tag, falling back to memory:', err.message);
        this.sql = null;
        this.isNeonActive = false;
      }
    }
  }

  /**
   * Initializes managed_students and admin_sessions schemas in database.
   */
  async ensureSchema() {
    if (!this.sql || this.schemaInitialized) return true;
    if (this.schemaPromise) return this.schemaPromise;

    this.schemaPromise = (async () => {
      try {
        await this.sql`
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

        await this.sql`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_students_adm ON managed_students(admission_number);
        `;
        await this.sql`
          CREATE INDEX IF NOT EXISTS idx_managed_students_name ON managed_students(name);
        `;
        await this.sql`
          CREATE INDEX IF NOT EXISTS idx_managed_students_phone ON managed_students(phone_number);
        `;
        await this.sql`
          CREATE INDEX IF NOT EXISTS idx_managed_students_user ON managed_students(username);
        `;
        await this.sql`
          CREATE INDEX IF NOT EXISTS idx_managed_students_sec ON managed_students(section);
        `;

        await this.sql`
          CREATE TABLE IF NOT EXISTS admin_sessions (
            token VARCHAR(128) PRIMARY KEY,
            username VARCHAR(128) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '2 hours')
          );
        `;

        await this.sql`
          CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);
        `;

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
  async listStudents({ page = 1, limit = 20, search = '', section = '', sortBy = 'id', sortOrder = 'ASC' } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;
    const cleanSearch = String(search || '').trim().toLowerCase();
    const cleanSection = String(section || '').trim();

    const allowedSortFields = ['id', 'name', 'admission_number', 'phone_number', 'username', 'section', 'created_at', 'updated_at'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'id';
    const sortDirection = String(sortOrder).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    if (this.sql) {
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

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countQuery = `SELECT COUNT(*) AS total FROM managed_students ${whereClause};`;
        const countRows = await this.sql.query(countQuery, params);
        const total = parseInt(countRows[0]?.total || 0, 10);

        const listQuery = `
          SELECT id, name, admission_number, phone_number, username, password, section, created_at, updated_at
          FROM managed_students
          ${whereClause}
          ORDER BY ${sortField} ${sortDirection}
          LIMIT $${pIndex} OFFSET $${pIndex + 1};
        `;
        const students = await this.sql.query(listQuery, [...params, limitNum, offset]);

        return {
          students: students.map(s => this._formatStudent(s)),
          total,
          page: pageNum,
          totalPages: Math.ceil(total / limitNum) || 1,
          limit: limitNum
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

    return {
      students: paginated,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum) || 1,
      limit: limitNum
    };
  }

  /**
   * Retrieves a student by their ID.
   */
  async getStudentById(id) {
    const studentId = parseInt(id, 10);
    if (!studentId || isNaN(studentId)) return null;

    if (this.sql) {
      try {
        await this.ensureSchema();
        const rows = await this.sql`
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
   */
  async getStudentByAdmissionNumber(admissionNumber) {
    const adm = String(admissionNumber || '').trim();
    if (!adm) return null;

    if (this.sql) {
      try {
        await this.ensureSchema();
        const rows = await this.sql`
          SELECT * FROM managed_students WHERE admission_number = ${adm} LIMIT 1;
        `;
        if (rows && rows.length > 0) {
          return this._formatStudent(rows[0]);
        }
        return null;
      } catch (err) {
        console.warn(`[Admin DB] getStudentByAdmissionNumber error for ${adm}:`, err.message);
      }
    }

    const mem = this.memoryStudents.get(adm);
    return mem ? this._formatStudent(mem) : null;
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

    if (this.sql) {
      try {
        await this.ensureSchema();
        // Check if student existed before this query
        const existingRows = await this.sql`
          SELECT id, username, password FROM managed_students WHERE admission_number = ${cleanAdm} LIMIT 1;
        `;
        isUpdate = existingRows && existingRows.length > 0;

        const rows = await this.sql`
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

    if (this.sql) {
      try {
        await this.ensureSchema();
        const rows = await this.sql`
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
    if (this.sql) {
      try {
        await this.ensureSchema();
        const rows = await this.sql`
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

    for (let i = 0; i < studentsList.length; i++) {
      const item = studentsList[i];
      if (!item || !item.admission_number || !String(item.admission_number).trim()) {
        summary.skipped++;
        continue;
      }

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
          row: i + 1,
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
    if (this.sql) {
      try {
        await this.ensureSchema();

        const statsQuery = await this.sql`
          SELECT
            COUNT(*)::int AS total_students,
            COUNT(DISTINCT section) FILTER (WHERE section IS NOT NULL AND section <> '')::int AS total_sections,
            COUNT(*) FILTER (WHERE username IS NOT NULL AND username <> '')::int AS students_with_username,
            COUNT(*) FILTER (WHERE username IS NULL OR username = '')::int AS students_without_username,
            COUNT(*) FILTER (WHERE password IS NOT NULL AND password <> '')::int AS students_with_password,
            COUNT(*) FILTER (WHERE password IS NULL OR password = '')::int AS students_without_password
          FROM managed_students;
        `;

        const recentAdded = await this.sql`
          SELECT id, name, admission_number, phone_number, section, created_at
          FROM managed_students
          ORDER BY id DESC
          LIMIT 5;
        `;

        const recentUpdated = await this.sql`
          SELECT id, name, admission_number, phone_number, section, updated_at
          FROM managed_students
          ORDER BY updated_at DESC
          LIMIT 5;
        `;

        const sectionRows = await this.sql`
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

    if (this.sql) {
      try {
        await this.ensureSchema();
        await this.sql`
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

    if (this.sql) {
      try {
        await this.ensureSchema();
        const rows = await this.sql`
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

    if (this.sql) {
      try {
        await this.ensureSchema();
        await this.sql`
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

    if (this.sql) {
      try {
        await this.ensureSchema();
        await this.sql`
          DELETE FROM admin_sessions WHERE expires_at <= NOW();
        `;
      } catch (err) {
        // Suppress cleanup warning
      }
    }
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
