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
    
    if (/^20\d{2}[A-Za-z0-9_-]{3,}$/.test(q)) {
      return 'Admission Number';
    }
    
    if (/^[A-Za-z\s.]{3,}$/.test(q) && q.includes(' ')) {
      return 'Name';
    }
    
    if (/^[6-9]\d{9}$/.test(q)) {
      return 'Phone Number';
    }
    if (/^\d{10}$/.test(q)) {
      return 'Admission Number';
    }
    return 'Admission Number';
  }

   
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

    
    
    const cleanSearchType = String(searchType || '').trim().toLowerCase();
    const isExplicitPhone = cleanSearchType === 'phone' || cleanSearchType === 'phone number' || cleanSearchType === 'phone_number' || cleanSearchType === 'phonenumber';
    if (!isExplicitPhone && effectiveType === 'Phone Number') {
      const studentByAdm = await this.dbService.getStudentByAdmissionNumber(cleanQuery);
      if (studentByAdm) {
        effectiveType = 'Admission Number';
      } else {
        const studentByPhone = await this.dbService.getStudentByPhoneNumber(cleanQuery);
        if (studentByPhone) {
          effectiveType = 'Admission Number';
        }
      }
    }

    try {
      
      
      
      if (effectiveType === 'Admission Number') {
        let existingStudent = await this.dbService.getStudentByAdmissionNumber(cleanQuery);
        let matchedByPhone = false;
        if (!existingStudent) {
          existingStudent = await this.dbService.getStudentByPhoneNumber(cleanQuery);
          if (existingStudent) matchedByPhone = true;
        }

        if (!existingStudent) {
          
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
            
            let updatedStudent = null;
            if (matchedByPhone && existingStudent.phone_number) {
              updatedStudent = await this.dbService.updateStudentCredentialsByPhone(existingStudent.phone_number, {
                username: apiResult.username,
                password: apiResult.password
              });
            }
            if (!updatedStudent) {
              updatedStudent = await this.dbService.updateStudentCredentials(existingStudent.admission_number, {
                username: apiResult.username,
                password: apiResult.password
              });
            }

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

            
            const log = await this.dbService.logSearch({
              searchQuery: cleanQuery,
              searchType: 'Admission Number',
              result: 'SUCCESS'
            });

            return {
              success: true,
              result: 'SUCCESS',
              updated: Boolean(updatedStudent && updatedStudent.updated !== false),
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
