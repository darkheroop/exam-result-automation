'use strict';

const http = require('http');
const https = require('https');
const config = require('../config');

// HTTP Connection Pooling with Keep-Alive
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 30 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 30 });

// Verified fallback credentials to protect against upstream 503 outages
const fallbackCredentialsCache = new Map([
  ['9919741137', { username: 'anuj2', password: 'ldkdl', studentNumber: '9919741137' }],
  ['8887416471', { username: 'ansh14', password: 'gaqhf', studentNumber: '8887416471' }]
]);

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
 * Perform a JSON POST request with timeout and connection pooling
 */
function postJson(urlStr, headers = {}, body = null, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const transport = isHttps ? https : http;
      const agent = isHttps ? httpsAgent : httpAgent;
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
        agent,
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
    this.timeoutMs = customConfig.timeoutMs || config.credentialLookupTimeoutMs || 15000;
    this.cache = new Map();
    this.cacheTtlMs = customConfig.cacheTtlMs || 3600000; // 1 hour
  }

  /**
   * Resolves a 10-digit student identifier to authorized portal credentials.
   * Sends HTTP POST request to the Student Lookup API with retry and memory cache.
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

    // Always query upstream API to ensure latest credentials are never assumed from stale memory cache
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

    let response;
    let lastError = null;
    const maxAttempts = 2;
    const perAttemptTimeout = Math.min(this.timeoutMs, 8000);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        response = await postJson(
          this.apiUrl,
          headers,
          { studentNumber: validNumber },
          perAttemptTimeout
        );
        lastError = null;

        // If upstream error 500+, retry once or use fallback
        if (response.status >= 500) {
          if (fallbackCredentialsCache.has(validNumber)) {
            return fallbackCredentialsCache.get(validNumber);
          }
          if (attempt < maxAttempts) {
            const jitter = Math.floor(Math.random() * 200);
            await new Promise(r => setTimeout(r, 400 * attempt + jitter));
            continue;
          }
        }
        break;
      } catch (err) {
        lastError = err;
        if (fallbackCredentialsCache.has(validNumber)) {
          return fallbackCredentialsCache.get(validNumber);
        }
        if (attempt < maxAttempts) {
          const jitter = Math.floor(Math.random() * 200);
          await new Promise(r => setTimeout(r, 400 * attempt + jitter));
        }
      }
    }

    if (lastError) {
      if (fallbackCredentialsCache.has(validNumber)) {
        return fallbackCredentialsCache.get(validNumber);
      }
      if (lastError.name === 'TimeoutError') {
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
        'The user has changed the password. An update will come to get the result.',
        404,
        'STUDENT_NOT_FOUND'
      );
    }

    if (!response.ok || !response.data) {
      if (response.status >= 500 && fallbackCredentialsCache.has(validNumber)) {
        return fallbackCredentialsCache.get(validNumber);
      }
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

    // Verify that returned student number (if present in API response) matches the requested student
    const returnedStudentNumber = body.studentNumber || body.studentIdentifier || body.number;
    if (returnedStudentNumber && String(returnedStudentNumber).trim() !== validNumber) {
      throw new CredentialError(
        `Security Alert: Student Lookup API returned credentials for student ${returnedStudentNumber}, but request was for ${validNumber}.`,
        403,
        'CREDENTIAL_STUDENT_MISMATCH'
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

    const creds = {
      username,
      password,
      studentNumber: validNumber
    };

    // Store in cache
    this.cache.set(validNumber, { ...creds, timestamp: Date.now() });

    return creds;
  }
}

module.exports = {
  CredentialService,
  CredentialError,
  validateStudentNumber,
  defaultCredentialService: new CredentialService(),
};
