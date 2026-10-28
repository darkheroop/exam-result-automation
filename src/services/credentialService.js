'use strict';

const http = require('http');
const https = require('https');
const config = require('../config');

class CredentialError extends Error {
  constructor(message, statusCode = 500, code = 'CREDENTIAL_ERROR') {
    super(message);
    this.name = 'CredentialError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Validates the student number format.
 * Preserves leading zeros.
 */
function validateStudentNumber(number) {
  if (typeof number !== 'string') {
    throw new CredentialError('Student identifier must be a string.', 400, 'INVALID_INPUT');
  }
  const trimmed = number.trim();
  if (!trimmed) {
    throw new CredentialError('Student identifier cannot be empty.', 400, 'EMPTY_INPUT');
  }
  if (!/^\d{10}$/.test(trimmed)) {
    throw new CredentialError('Please enter a valid 10-digit student identifier.', 400, 'INVALID_FORMAT');
  }
  return trimmed;
}

/**
 * Perform a JSON POST request with timeout
 */
function postJson(urlStr, headers = {}, body = null, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const transport = isHttps ? https : http;
      const payload = body ? JSON.stringify(body) : null;

      const reqHeaders = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      };

      const req = transport.request(u, {
        method: 'POST',
        headers: reqHeaders,
        timeout: timeoutMs,
      }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            // raw text if not json
          }
          resolve({
            status: res.statusCode || 500,
            ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300),
            data: parsed,
            raw,
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const err = new Error('REQUEST_TIMEOUT');
        err.name = 'TimeoutError';
        reject(err);
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Student Lookup Credential Service Adapter
 * Single-service integration with https://student-lookup-portal.vercel.app/api/lookup
 */
class CredentialService {
  constructor(customConfig = {}) {
    this.apiUrl = customConfig.apiUrl !== undefined ? customConfig.apiUrl : config.studentLookupApiUrl;
    this.apiKey = customConfig.apiKey !== undefined ? customConfig.apiKey : config.studentLookupApiKey;
    this.mockMode = customConfig.mockMode || false;
  }

  /**
   * Resolves a 10-digit student identifier to authorized portal credentials.
   * Sends one HTTP POST request to the Student Lookup API.
   * @param {string} studentNumber
   * @returns {Promise<{ username: string, password: string, studentNumber: string }>}
   */
  async fetchCredentials(studentNumber) {
    const validNumber = validateStudentNumber(studentNumber);

    // Mock mode for local unit testing / offline development
    if (this.mockMode) {
      return {
        username: 'mock_student',
        password: 'mock_password_123',
        studentNumber: validNumber
      };
    }

    if (!this.apiUrl || !this.apiKey) {
      throw new CredentialError(
        'Student Lookup API configuration is incomplete. Missing API URL or Bearer token.',
        503,
        'CREDENTIAL_CONFIG_MISSING'
      );
    }

    // Build request headers with Bearer token authorization
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`
    };

    // Single HTTP POST request to Student Lookup API
    let response;
    try {
      response = await postJson(
        this.apiUrl,
        headers,
        { studentNumber: validNumber },
        15000
      );
    } catch (err) {
      if (err.name === 'TimeoutError') {
        throw new CredentialError('Student Lookup API request timed out.', 504, 'API_TIMEOUT');
      }
      throw new CredentialError('Unable to connect to Student Lookup API.', 502, 'API_UNAVAILABLE');
    }

    // Handle HTTP error statuses
    if (response.status === 401 || response.status === 403) {
      throw new CredentialError(
        'Authentication failed with Student Lookup API. Please verify the configured Bearer token.',
        502,
        'API_AUTH_ERROR'
      );
    }

    if (response.status === 404 || response.data?.error?.code === 'STUDENT_NOT_FOUND') {
      throw new CredentialError(
        `No authorized student record found for identifier ${validNumber}.`,
        404,
        'STUDENT_NOT_FOUND'
      );
    }

    if (!response.ok || !response.data) {
      throw new CredentialError(
        response.data?.error?.message || 'Student Lookup API returned an error response.',
        response.status >= 400 && response.status < 500 ? response.status : 502,
        'LOOKUP_FAILED'
      );
    }

    const body = response.data;

    // Verify success flag
    if (body.success !== true) {
      throw new CredentialError(
        body.error?.message || body.message || 'Student Lookup API indicated unsuccessful lookup.',
        404,
        'LOOKUP_FAILED'
      );
    }

    // Extract and validate credentials
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password.trim() : '';

    if (!username || !password) {
      throw new CredentialError(
        'Student Lookup API returned incomplete credential data (missing username or password).',
        502,
        'INCOMPLETE_CREDENTIAL_DATA'
      );
    }

    return {
      username,
      password,
      studentNumber: validNumber
    };
  }
}

module.exports = {
  CredentialService,
  CredentialError,
  validateStudentNumber,
  defaultCredentialService: new CredentialService(),
};
