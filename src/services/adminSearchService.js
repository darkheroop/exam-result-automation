'use strict';

const config = require('../config');
const { defaultAdminDbService } = require('./adminDbService');

class AdminSearchService {
  constructor(options = {}) {
    this.dbService = options.dbService || defaultAdminDbService;
    this.apiUrl = options.apiUrl || config.studentLookupApiUrl || 'https://student-lookup-portal.vercel.app/api/lookup';
    this.apiKey = options.apiKey || config.studentLookupApiKey;
    this.timeoutMs = options.timeoutMs || 8000;
    this.mockMode = options.mockMode || false;
    this.mockCredentialHandler = options.mockCredentialHandler || null;
  }

  /**
   * Resolves search type from explicit input or query inspection.
   * Allowed types: 'Admission Number', 'Name', 'Phone Number', 'Username'
   */
  resolveSearchType(query, explicitType) {
    const cleanType = String(explicitType || '').trim().toLowerCase();
    if (cleanType === 'adm' || cleanType === 'admission number' || cleanType === 'admission_number' || cleanType === 'admissionnumber') {
      return 'Admission Number';
    }
    if (cleanType === 'name') {
      return 'Name';
    }
    if (cleanType === 'phone' || cleanType === 'phone number' || cleanType === 'phone_number' || cleanType === 'phonenumber') {
      return 'Phone Number';
    }
    if (cleanType === 'username') {
      return 'Username';
    }

    const q = String(query || '').trim();
    // Alphanumeric admission numbers: e.g. 2023CS001, 2021...
    if (/^20\d{2}[A-Za-z0-9_-]{3,}$/.test(q)) {
      return 'Admission Number';
    }
    // Name with spaces or alphabets
    if (/^[A-Za-z\s.]{3,}$/.test(q) && q.includes(' ')) {
      return 'Name';
    }
    // 10-digit starting with 6-9 is typically a phone number unless matched to student admission
    if (/^[6-9]\d{9}$/.test(q)) {
      return 'Phone Number';
    }
    if (/^\d{10}$/.test(q)) {
      return 'Admission Number';
    }
    return 'Admission Number';
  }

  /**
   * Calls the Student Lookup API to retrieve portal credentials.
   * @param {string} studentNumber
   * @returns {Promise<{ status: string, username?: string, password?: string, error?: string }>}
   */
  async fetchStudentCredentials(studentNumber) {
    if (this.mockMode && typeof this.mockCredentialHandler === 'function') {
      return this.mockCredentialHandler(studentNumber);
    }

    if (!this.apiUrl || !this.apiKey) {
      return { status: 'API_ERROR', error: 'Missing API configuration' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ studentNumber }),
        signal: controller.signal
      });

      clearTimeout(timer);

      let data;
      try {
        data = await response.json();
      } catch (jsonErr) {
        return { status: 'INVALID_RESPONSE', error: 'Malformed JSON response from API' };
      }

      if (!response.ok || !data) {
        return { status: 'API_ERROR', error: data?.error?.message || `HTTP ${response.status}` };
      }

      if (data.success !== true) {
        return { status: 'API_ERROR', error: data.error?.message || data.message || 'Lookup unsuccessful' };
      }

      const username = typeof data.username === 'string' ? data.username.trim() : '';
      const password = typeof data.password === 'string' ? data.password.trim() : '';

      if (!username || !password) {
        return { status: 'INVALID_RESPONSE', error: 'Missing username or password in API response' };
      }

      return {
        status: 'SUCCESS',
        username,
        password
      };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError' || err.message?.includes('timeout') || err.code === 'ETIMEDOUT') {
        return { status: 'TIMEOUT', error: 'Request timed out' };
      }
      return { status: 'NETWORK_ERROR', error: err.message };
    }
  }

  /**
   * Executes a student search operation with automatic credential retrieval
   * and single-occurrence audit logging.
   * 
   * @param {Object} params
   * @param {string} params.query
   * @param {string} [params.searchType]
   * @returns {Promise<{ success: boolean, result: string, students: Array, updated?: boolean, log?: Object }>}
   */
  async executeSearch({ query, searchType = 'all' }) {
    const rawQuery = query;
    if (typeof rawQuery !== 'string' || !rawQuery.trim()) {
      const log = await this.dbService.logSearch({
        searchQuery: String(rawQuery || ''),
        searchType: 'Admission Number',
        result: 'INVALID_INPUT'
      });
      return {
        success: false,
        result: 'INVALID_INPUT',
        students: [],
        log
      };
    }

    const cleanQuery = rawQuery.trim();
    let effectiveType = this.resolveSearchType(cleanQuery, searchType);

    // If searchType was not explicitly pinned to Phone Number, but a student exists locally with this admission_number,
    // ensure effectiveType resolves to 'Admission Number' so automatic credential lookup triggers.
    const cleanSearchType = String(searchType || '').trim().toLowerCase();
    const isExplicitPhone = cleanSearchType === 'phone' || cleanSearchType === 'phone number' || cleanSearchType === 'phone_number' || cleanSearchType === 'phonenumber';
    if (!isExplicitPhone && effectiveType === 'Phone Number') {
      const studentByAdm = await this.dbService.getStudentByAdmissionNumber(cleanQuery);
      if (studentByAdm) {
        effectiveType = 'Admission Number';
      }
    }

    try {
      // -------------------------------------------------------------
      // CASE 1: Admission Number Search (Automatic Credential Lookup)
      // -------------------------------------------------------------
      if (effectiveType === 'Admission Number') {
        const existingStudent = await this.dbService.getStudentByAdmissionNumber(cleanQuery);

        if (!existingStudent) {
          // Rule: If student does NOT exist in local database, log NOT_FOUND and do NOT call credential API.
          const log = await this.dbService.logSearch({
            searchQuery: cleanQuery,
            searchType: 'Admission Number',
            result: 'NOT_FOUND'
          });
          return {
            success: true,
            result: 'NOT_FOUND',
            students: [],
            log
          };
        }

        // Student exists locally -> Call the Credential Lookup API
        // In mock mode (e.g. unit tests), pass cleanQuery directly to handler.
        // In live mode, upstream student-lookup API requires a 10-digit student identifier.
        // If cleanQuery is not 10 digits (e.g. alphanumeric admission number like 2023CS042),
        // fallback to student's 10-digit phone number or 10-digit admission number if available.
        let studentNumberForApi = cleanQuery;
        if (!this.mockMode && !/^\d{10}$/.test(studentNumberForApi)) {
          if (existingStudent.phone_number && /^\d{10}$/.test(existingStudent.phone_number.trim())) {
            studentNumberForApi = existingStudent.phone_number.trim();
          } else if (existingStudent.admission_number && /^\d{10}$/.test(existingStudent.admission_number.trim())) {
            studentNumberForApi = existingStudent.admission_number.trim();
          }
        }

        const apiResult = await this.fetchStudentCredentials(studentNumberForApi);

        if (apiResult.status === 'SUCCESS') {
          try {
            // Update credentials in database without overwriting name, phone, section, created_at
            const updatedStudent = await this.dbService.updateStudentCredentials(existingStudent.admission_number, {
              username: apiResult.username,
              password: apiResult.password
            });

            if (!updatedStudent) {
              const log = await this.dbService.logSearch({
                searchQuery: cleanQuery,
                searchType: 'Admission Number',
                result: 'DATABASE_ERROR'
              });
              return {
                success: false,
                result: 'DATABASE_ERROR',
                students: [existingStudent],
                log
              };
            }

            // Successfully updated credentials in DB -> Log SUCCESS
            const log = await this.dbService.logSearch({
              searchQuery: cleanQuery,
              searchType: 'Admission Number',
              result: 'SUCCESS'
            });

            return {
              success: true,
              result: 'SUCCESS',
              updated: true,
              students: [updatedStudent],
              log
            };
          } catch (dbErr) {
            const log = await this.dbService.logSearch({
              searchQuery: cleanQuery,
              searchType: 'Admission Number',
              result: 'DATABASE_ERROR'
            });
            return {
              success: false,
              result: 'DATABASE_ERROR',
              students: [existingStudent],
              log
            };
          }
        }

        // Credential API returned non-success (API_ERROR, INVALID_RESPONSE, TIMEOUT, NETWORK_ERROR)
        // Existing student credentials MUST be preserved!
        const resultStatus = ['API_ERROR', 'INVALID_RESPONSE', 'TIMEOUT', 'NETWORK_ERROR'].includes(apiResult.status)
          ? apiResult.status
          : 'API_ERROR';

        const log = await this.dbService.logSearch({
          searchQuery: cleanQuery,
          searchType: 'Admission Number',
          result: resultStatus
        });

        return {
          success: true,
          result: resultStatus,
          students: [existingStudent],
          log
        };
      }

      // -------------------------------------------------------------
      // CASE 2: Name, Phone Number, or Username Search (No Credential API)
      // -------------------------------------------------------------
      const listRes = await this.dbService.listStudents({
        search: cleanQuery,
        limit: 50
      });

      const matchedStudents = listRes.students || [];

      if (matchedStudents.length > 0) {
        const log = await this.dbService.logSearch({
          searchQuery: cleanQuery,
          searchType: effectiveType,
          result: 'FOUND'
        });
        return {
          success: true,
          result: 'FOUND',
          students: matchedStudents,
          total: listRes.total,
          log
        };
      }

      const log = await this.dbService.logSearch({
        searchQuery: cleanQuery,
        searchType: effectiveType,
        result: 'NOT_FOUND'
      });

      return {
        success: true,
        result: 'NOT_FOUND',
        students: [],
        total: 0,
        log
      };
    } catch (err) {
      console.error('[Admin Search Service] Unexpected error:', err);
      const log = await this.dbService.logSearch({
        searchQuery: cleanQuery,
        searchType: effectiveType,
        result: 'SYSTEM_ERROR'
      });
      return {
        success: false,
        result: 'SYSTEM_ERROR',
        students: [],
        log
      };
    }
  }
}

const defaultAdminSearchService = new AdminSearchService();

module.exports = {
  AdminSearchService,
  defaultAdminSearchService
};
