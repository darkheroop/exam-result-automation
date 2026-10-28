'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
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
  studentLookupApiKey: process.env.STUDENT_LOOKUP_API_KEY || 'sk_support_3dbd105ccf05e3fb30d38c64151d426e6bd397f8219545a946182e037c3ae0ac',
  
  // Educational Portal
  portalLoginUrl: process.env.PORTAL_LOGIN_URL || 'https://ai-edunova.abes.ac.in/#/auth/login',
  portalResultsUrl: process.env.PORTAL_RESULTS_URL || 'https://ai-edunova.abes.ac.in/#/insync/dashboard/exam/semester-examination-result?examMpId=2&resultView=annual',
  
  // Browser Automation
  chromePath: findSystemBrowser(),
  headless: process.env.HEADLESS !== 'false',
  pageTimeoutMs: parseInt(process.env.PAGE_TIMEOUT_MS, 10) || 15000,
  
  // Session & Storage
  sessionTtlMs: parseInt(process.env.SESSION_TTL_MS, 10) || 600000, // 10 minutes
  maxConcurrentSessions: parseInt(process.env.MAX_CONCURRENT_SESSIONS, 10) || 300,
  maxConcurrentWorkers: parseInt(process.env.MAX_CONCURRENT_WORKERS, 10) || Math.min(Math.max(os.cpus()?.length || 2, 2), 4),
  maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE, 10) || 200,
  queueTimeoutMs: parseInt(process.env.QUEUE_TIMEOUT_MS, 10) || 120000,
  jobTimeoutMs: parseInt(process.env.JOB_TIMEOUT_MS, 10) || 90000,
  tempStorageDir: process.env.TEMP_STORAGE_DIR || (
    (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_VERSION || process.env.LAMBDA_TASK_ROOT)
      ? path.join(os.tmpdir(), 'exam_temp_downloads')
      : path.resolve(__dirname, '../temp_downloads')
  ),

  // Granular Operation-Specific Timeouts
  credentialLookupTimeoutMs: parseInt(process.env.TIMEOUT_CREDENTIAL_LOOKUP_MS, 10) || 15000,
  browserLaunchTimeoutMs: parseInt(process.env.TIMEOUT_BROWSER_LAUNCH_MS, 10) || 20000,
  loginNavigationTimeoutMs: parseInt(process.env.TIMEOUT_LOGIN_NAV_MS, 10) || 15000,
  authCompletionTimeoutMs: parseInt(process.env.TIMEOUT_AUTH_COMPLETION_MS, 10) || 15000,
  dashboardNavTimeoutMs: parseInt(process.env.TIMEOUT_DASHBOARD_NAV_MS, 10) || 18000,
  resultLoadingTimeoutMs: parseInt(process.env.TIMEOUT_RESULT_LOADING_MS, 10) || 15000,
  pdfGenerationTimeoutMs: parseInt(process.env.TIMEOUT_PDF_GEN_MS, 10) || 20000,
  overallRequestTimeoutMs: parseInt(process.env.TIMEOUT_OVERALL_REQUEST_MS, 10) || 45000,
  
  // Rate Limiting
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 600,
});

module.exports = config;
