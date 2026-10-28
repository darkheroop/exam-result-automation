'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

function findSystemBrowser() {
  const customPath = process.env.CHROME_PATH;
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  // Windows standard paths
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // Linux / Mac paths
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined; // Playwright will fall back to channel if undefined
}

const config = Object.freeze({
  port: parseInt(process.env.PORT, 10) || 5050,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Student Lookup Credential API
  studentLookupApiUrl: process.env.STUDENT_LOOKUP_API_URL || 'https://student-lookup-portal.vercel.app/api/lookup',
  studentLookupApiKey: process.env.STUDENT_LOOKUP_API_KEY || '',
  
  // Educational Portal
  portalLoginUrl: process.env.PORTAL_LOGIN_URL || 'https://ai-edunova.abes.ac.in/#/auth/login',
  portalResultsUrl: process.env.PORTAL_RESULTS_URL || 'https://ai-edunova.abes.ac.in/#/insync/dashboard/exam/semester-examination-result?examMpId=2&resultView=annual',
  
  // Browser Automation
  chromePath: findSystemBrowser(),
  headless: process.env.HEADLESS !== 'false',
  pageTimeoutMs: parseInt(process.env.PAGE_TIMEOUT_MS, 10) || 35000,
  
  // Session & Storage
  sessionTtlMs: parseInt(process.env.SESSION_TTL_MS, 10) || 600000, // 10 minutes
  maxConcurrentSessions: parseInt(process.env.MAX_CONCURRENT_SESSIONS, 10) || 10,
  tempStorageDir: path.resolve(__dirname, '../temp_downloads'),
  
  // Rate Limiting
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 30,
});

module.exports = config;
