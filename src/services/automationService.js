'use strict';

const crypto = require('crypto');
const https = require('https');
const config = require('../config');
const { defaultCredentialService } = require('./credentialService');
const { defaultSessionManager } = require('./sessionManager');
const { defaultDbService } = require('./dbService');
const { normalizeResultData } = require('./resultNormalizer');

// Persistent HTTPS Connection Pooling with Keep-Alive
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

/**
 * Executes a promise with an operation-specific timeout and clean error code.
 */
async function withTimeout(promise, timeoutMs, opName, opCode = 'TIMEOUT') {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Operation '${opName}' timed out after ${timeoutMs}ms.`);
      err.name = 'TimeoutError';
      err.code = opCode;
      reject(err);
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Performs a high-performance direct GET request to the educational portal APIs.
 */
function fetchPortalJson(urlStr, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const req = https.get(u, {
        agent: httpsAgent,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
          ...headers
        },
        timeout: timeoutMs
      }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try {
            if (raw) parsed = JSON.parse(raw);
          } catch {
            // not valid json
          }
          if (res.statusCode >= 400) {
            const err = new Error(`Portal API responded with HTTP status ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.code = 'PORTAL_API_ERROR';
            return reject(err);
          }
          resolve(parsed);
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const err = new Error(`Portal API request timed out after ${timeoutMs}ms.`);
        err.name = 'TimeoutError';
        err.code = 'PORTAL_TIMEOUT';
        reject(err);
      });

      req.on('error', (err) => {
        reject(err);
      });
    } catch (e) {
      reject(e);
    }
  });
}

class AutomationService {
  constructor(options = {}) {
    this.sessionManager = options.sessionManager || defaultSessionManager;
    this.credentialService = options.credentialService || defaultCredentialService;
    this.dbService = options.dbService || defaultDbService;
    this.maxConcurrentWorkers = options.maxConcurrentWorkers || config.maxConcurrentWorkers || 10;
    this.maxQueueSize = options.maxQueueSize || config.maxQueueSize || 200;
    this.queueTimeoutMs = options.queueTimeoutMs || config.queueTimeoutMs || 120000;
    this.jobTimeoutMs = options.jobTimeoutMs || config.jobTimeoutMs || 30000;
    this.mockMode = options.mockMode !== undefined ? options.mockMode : (config.mockMode || process.env.MOCK_AUTOMATION === 'true' || false);
    this.mockDelayMs = options.mockDelayMs || 25;

    this.activeWorkers = 0;
    this.jobQueue = [];

    // Metrics for diagnostics, load testing, and observability
    this.metrics = {
      submittedSearches: 0,
      queuedSearches: 0,
      activeSearches: 0,
      completedSearches: 0,
      failedSearches: 0,
      timeouts: 0,
      retries: 0,
      peakConcurrentWorkers: 0,
      totalExecutionDurationMs: 0
    };
  }

  /**
   * Compatibility methods for graceful shutdown / testing
   */
  async getBrowser() {
    return null;
  }

  async closeBrowser() {
    return null;
  }

  /**
   * Enqueues or starts the workflow within controlled worker limits.
   * Prevents system overload when 50-100 students search simultaneously.
   * @param {string} sessionId
   * @param {string} sessionToken
   * @param {string} studentNumber
   */
  async runWorkflow(sessionId, sessionToken, studentNumber) {
    this.metrics.submittedSearches++;
    const session = this.sessionManager.getSession(sessionId, sessionToken);
    if (!session) return;

    // Check if worker capacity is reached
    if (this.activeWorkers >= this.maxConcurrentWorkers) {
      if (this.jobQueue.length >= this.maxQueueSize) {
        this.metrics.failedSearches++;
        const queueErr = new Error('System is currently experiencing high demand. Please try again shortly.');
        queueErr.statusCode = 503;
        queueErr.code = 'QUEUE_FULL';
        session.status = 'error';
        session.error = { message: queueErr.message, code: queueErr.code };
        this.sessionManager.updateProgress(sessionId, 1, `Failed: ${queueErr.message}`, 10);
        throw queueErr;
      }

      this.metrics.queuedSearches++;
      session.status = 'queued';
      this.sessionManager.updateProgress(sessionId, 1, 'Waiting in queue...', 10, { status: 'queued' });

      return new Promise((resolve, reject) => {
        let timeoutTimer = null;
        if (this.queueTimeoutMs > 0) {
          timeoutTimer = setTimeout(() => {
            const idx = this.jobQueue.findIndex(j => j.sessionId === sessionId);
            if (idx !== -1) {
              this.jobQueue.splice(idx, 1);
              this.metrics.timeouts++;
              this.metrics.failedSearches++;
              const timeoutErr = new Error('Request queue wait deadline exceeded. Please try again.');
              timeoutErr.statusCode = 504;
              timeoutErr.code = 'QUEUE_TIMEOUT';
              session.status = 'error';
              session.error = { message: timeoutErr.message, code: timeoutErr.code };
              this.sessionManager.updateProgress(sessionId, 1, `Failed: ${timeoutErr.message}`, 10);
              reject(timeoutErr);
            }
          }, this.queueTimeoutMs);
          if (timeoutTimer.unref) timeoutTimer.unref();
        }

        this.jobQueue.push({
          sessionId,
          sessionToken,
          studentNumber,
          resolve,
          reject,
          timeoutTimer,
          enqueuedAt: Date.now()
        });
      });
    }

    return this.executeJobWithWorker(sessionId, sessionToken, studentNumber);
  }

  /**
   * Dispatches and tracks a job execution on an active worker slot.
   */
  async executeJobWithWorker(sessionId, sessionToken, studentNumber) {
    this.activeWorkers++;
    this.metrics.activeSearches++;
    if (this.activeWorkers > this.metrics.peakConcurrentWorkers) {
      this.metrics.peakConcurrentWorkers = this.activeWorkers;
    }

    const jobStart = Date.now();
    try {
      await this.executeWorkflow(sessionId, sessionToken, studentNumber);
      this.metrics.completedSearches++;
      this.metrics.totalExecutionDurationMs += (Date.now() - jobStart);
    } catch (err) {
      this.metrics.failedSearches++;
      throw err;
    } finally {
      this.activeWorkers--;
      this.metrics.activeSearches--;
      this.processNextQueuedJob();
    }
  }

  /**
   * Pulls and dispatches the next job waiting in the queue.
   */
  processNextQueuedJob() {
    if (this.activeWorkers < this.maxConcurrentWorkers && this.jobQueue.length > 0) {
      const nextJob = this.jobQueue.shift();
      if (nextJob.timeoutTimer) clearTimeout(nextJob.timeoutTimer);

      this.executeJobWithWorker(nextJob.sessionId, nextJob.sessionToken, nextJob.studentNumber)
        .then(nextJob.resolve)
        .catch(nextJob.reject);
    }
  }

  /**
   * High-Performance Direct Portal API Workflow:
   * 1. Retrieve authorized credentials from backend lookup.
   * 2. Authenticate directly via GetUserAuthenticatedData using MD5 password.
   * 3. Strictly verify student identity (userData.mobile === studentNumber).
   * 4. Extract loggedInUsrId and class parameters.
   * 5. Query ManageExamInfo and ManageStudentExamAnnualwiseDashboardCardDetails.
   * 6. Normalize and store genuine examination marksheet in session.
   */
  async executeWorkflow(sessionId, sessionToken, studentNumber) {
    const startTime = Date.now();
    const validNumber = (studentNumber || '').trim();
    const session = this.sessionManager.getSession(sessionId, sessionToken);
    if (!session) return;

    session.workflowLogs = [];
    const log = (msg) => {
      const entry = `[${new Date().toISOString()}] ${msg}`;
      console.log(`[Session ${sessionId}] ${msg}`);
      session.workflowLogs.push(entry);
    };

    try {
      // Stage 1: Validate input
      this.sessionManager.updateProgress(sessionId, 1, 'Validating student identifier...', 15, { status: 'processing' });
      log(`Stage 1: Validated student number: ${validNumber}`);

      const cached = await this.dbService.getCachedResult(validNumber);
      if (cached) {
        log(`Cache hit: Serving student result from Neon DB cache for ${validNumber}`);
        session.resultData = cached;
        session.examSummary = {
          title: session.resultData?.institution?.headerTitle || 'ABES Engineering College : Annual Result',
          isPending: session.resultData.annualSummary?.status === 'PENDING',
          hasTable: Boolean(session.resultData?.semesters?.length),
          portalUrl: config.portalResultsUrl
        };
        this.sessionManager.updateProgress(sessionId, 7, 'Examination result loaded from cache.', 100, {
          status: 'ready',
          resultData: cached
        });
        this.dbService.logSearch({
          studentNumber: validNumber,
          cacheHit: true,
          responseTimeMs: Date.now() - startTime,
          status: 'SUCCESS'
        }).catch(() => {});
        return;
      }

      // Stage 2: Retrieve authorized credentials from backend APIs with timeout
      this.sessionManager.updateProgress(sessionId, 2, 'Retrieving authorized credentials...', 30);
      const credentials = await withTimeout(
        this.credentialService.fetchCredentials(validNumber),
        config.credentialLookupTimeoutMs || 15000,
        'Credential Lookup',
        'TIMEOUT_CREDENTIALS'
      );

      if (credentials.studentNumber && credentials.studentNumber !== validNumber) {
        const mismatchErr = new Error(`Security mismatch: retrieved credentials belong to ${credentials.studentNumber}, expected ${validNumber}`);
        mismatchErr.code = 'CREDENTIAL_STUDENT_MISMATCH';
        throw mismatchErr;
      }

      const username = credentials.username;
      const password = credentials.password;
      session.username = username;
      log(`Stage 2: Retrieved credentials for user: ${username}`);

      // Fast mock mode branch for load / capacity / unit testing
      if (this.mockMode || process.env.MOCK_AUTOMATION === 'true') {
        log(`Executing in mock mode for load/capacity testing: student ${validNumber}`);
        this.sessionManager.updateProgress(sessionId, 3, 'Connecting to the examination portal...', 45);
        await new Promise(r => setTimeout(r, this.mockDelayMs));

        this.sessionManager.updateProgress(sessionId, 4, 'Authenticating session...', 60);
        await new Promise(r => setTimeout(r, this.mockDelayMs));

        this.sessionManager.updateProgress(sessionId, 5, 'Navigating to Annual Examination results...', 75);
        await new Promise(r => setTimeout(r, this.mockDelayMs));

        this.sessionManager.updateProgress(sessionId, 6, 'Retrieving Year 1 examination marksheet...', 90);
        await new Promise(r => setTimeout(r, this.mockDelayMs));

        const mockResultData = {
          student: {
            name: `Test Student ${validNumber}`,
            studentNumber: validNumber,
            regnNo: validNumber,
            seatNo: `SEAT_${validNumber}`,
            className: 'B.Tech - Computer Science and Engineering',
            academicYear: '2024-2025',
            publishedOn: '15/07/2024',
            session: '2024-25',
            abcId: `ABC${validNumber}`,
            semesters: 'Semester I, Semester II',
            status: 'PASS',
            ygpa: '8.50',
            creditsEarned: 44,
            totalCredits: 44,
            marks: '850 / 1000',
            cop: 'NIL',
            overallYgpa: '8.50',
            overallCreditsEarned: 44,
            overallRemarks: 'PASS'
          },
          annualSummary: {
            status: 'PASS',
            ygpa: '8.50',
            credits: 44,
            overallYgpa: '8.50',
            overallCreditsEarned: 44,
            overallRemarks: 'PASS'
          },
          overallYgpa: '8.50',
          overallCreditsEarned: 44,
          overallRemarks: 'PASS',
          semesters: [
            {
              title: 'Semester I',
              name: 'Semester I',
              sgpa: '8.40',
              creditsEarned: 22,
              credits: 22,
              totalCredits: 22,
              obtainedMarks: 420,
              totalMarks: 500,
              status: 'PASS',
              generalRemark: 'PASS',
              generalRemarks: 'PASS',
              subjects: [
                {
                  acadSubjectCode: 'BAS101',
                  acadSubjectLngTitle: 'Engineering Physics',
                  subjectType: 'Theory',
                  code: 'BAS101',
                  name: 'Engineering Physics',
                  type: 'THEORY',
                  grade: 'A',
                  gradeLetterToPrint: 'A',
                  credits: 4,
                  creditPointsToPrint: 4,
                  creditsEarned: 4,
                  creditEarnedToPrint: 4,
                  gradePoints: 8,
                  gradePointsToPrint: '8',
                  creditGrade: 32,
                  result: 'PASS',
                  maxPointsToPrint: 100,
                  minPointsToPrint: 40,
                  obtResolutionGracesMarksToPrint: 91,
                  allExamAsmtTypeMarksDataArr: [],
                  midTerm1: { obt: 25, min: 12, max: 30 },
                  midTerm2: { obt: 26, min: 12, max: 30 },
                  endTerm: { obt: 40, min: 20, max: 50 },
                  external: { obt: 65, min: 30, max: 70 },
                  internal: { obt: 26, min: 12, max: 30 },
                  total: { obt: 91, min: 40, max: 100 }
                }
              ]
            }
          ]
        };

        session.resultData = mockResultData;
        this.sessionManager.updateProgress(sessionId, 7, 'Examination result loaded successfully.', 100, {
          status: 'ready',
          resultData: mockResultData
        });
        return;
      }

      // Stage 3: Connect to the educational portal
      this.sessionManager.updateProgress(sessionId, 3, 'Connecting to the examination portal...', 45);
      log('Stage 3: Preparing portal direct API client connection...');

      // Stage 4: Authenticate with the educational portal
      this.sessionManager.updateProgress(sessionId, 4, 'Authenticating session...', 60);

      // Compute MD5 hash of the plaintext password
      const md5Password = crypto.createHash('md5').update(password).digest('hex');
      const authPayload = JSON.stringify({
        username,
        password: md5Password,
        authMethod: 'online'
      });

      const portalAuthUrl = `https://edunova.abes.ac.in/sims-services/digitalsims/?r=api/v1/User/GetUserAuthenticatedData&data=${encodeURIComponent(authPayload)}`;
      log(`Stage 4: Authenticating user ${username} via GetUserAuthenticatedData...`);

      const authResponse = await withTimeout(
        fetchPortalJson(portalAuthUrl, { hash: 'trr36pdthb9xbhcppyqkgbpkq' }, config.authCompletionTimeoutMs || 15000),
        (config.authCompletionTimeoutMs || 15000) + 2000,
        'Portal Direct Authentication',
        'TIMEOUT_PORTAL_AUTH'
      );

      const respStatus = authResponse?.collection?.response?.responseStatus;
      const userData = authResponse?.collection?.response?.userData;

      if (respStatus !== 'SUCCESS' || !userData || userData === 'FALSE' || typeof userData !== 'object') {
        const errorMsg = authResponse?.collection?.response?.responseMsg || 'Portal authentication rejected credentials.';
        const authErr = new Error(`Authentication failed: ${errorMsg}`);
        authErr.code = 'AUTH_REJECTED';
        throw authErr;
      }

      // Strict User Identity Verification: verified mobile must match requested studentNumber
      const authenticatedStudentMobile = String(userData.mobile || '').trim();
      if (authenticatedStudentMobile !== validNumber) {
        const identityErr = new Error(`Student identity mismatch: authenticated account (${authenticatedStudentMobile}) does not match requested student (${validNumber}).`);
        identityErr.code = 'STUDENT_IDENTITY_MISMATCH';
        throw identityErr;
      }

      const loggedInUsrId = String(userData.id);
      const studentFullName = `${userData.firstName || ''} ${userData.lastName || ''}`.trim() || username;
      log(`Stage 4: Portal authentication confirmed for ${studentFullName} (User ID: ${loggedInUsrId}, Mobile: ${authenticatedStudentMobile})`);

      // Stage 5: Prepare query parameters from userData.classData or default Year 1 mappings
      this.sessionManager.updateProgress(sessionId, 5, 'Querying examination records...', 75);

      const classList = Array.isArray(userData.classData) ? userData.classData : [];
      const sem2Class = classList.find(c => String(c.mpId) === '2') ||
                        classList.find(c => (c.classShortName && c.classShortName.includes('FY-')) || c.academicYear === '2025');
      const sem1Class = classList.find(c => String(c.mpId) === '1') || sem2Class;

      const examClassId = String(sem2Class?.classId || sem1Class?.classId || '4');
      const examClassTitle = sem2Class?.classShortName || sem1Class?.classShortName || 'FY-B.Tech CSE (14)';
      const academicYear = String(sem2Class?.academicYear || sem1Class?.academicYear || '2025');
      const schoolId = String(sem2Class?.instId || sem1Class?.instId || '1');
      const schoolTitle = sem2Class?.instShortName || sem1Class?.instShortName || 'ABES';
      const asmtGrpId = '3';

      const commonAsmtTypeTitles = [
        { asmtTypeId: 9, asmtTypeName: 'CIA' },
        { asmtTypeId: 6, asmtTypeName: 'End Term' },
        { asmtTypeId: 7, asmtTypeName: 'Internal' },
        { asmtTypeId: 8, asmtTypeName: 'External' },
        { asmtTypeId: 4, asmtTypeName: 'Mid Term 1' },
        { asmtTypeId: 5, asmtTypeName: 'Mid Term 2' }
      ];

      const actionData = [
        {
          asmtGrpId,
          examClassId,
          examClassTitle,
          examClassLngNames: examClassTitle,
          examClassGrpId: '',
          examClassMpCtgryAcademicYears: academicYear,
          examClassMpCtgryId: '11',
          examClassMpCtgryTitle: 'Semester II',
          examScheduledSchoolId: schoolId,
          examScheduledSchoolTitle: schoolTitle,
          examScheduledSyear: academicYear,
          examScheduledMpId: '2',
          examScheduledMpTitle: 'Even Sem (2,4,6,8)',
          examAttemptTypeId: '1',
          examAttemptTypeTitle: 'Regular',
          isRegularExamConducted: 'Y',
          examAsmtCtgryId: '11',
          examAsmtCtgryTitle: 'Semester II',
          examAsmtTypeId: '1,2,3,4,5,6,7,8,9,990',
          examAsmtTypeTitle: commonAsmtTypeTitles,
          examCpMpId: '2',
          loggedInUsrId,
          showResultOnMobile: 'Y'
        },
        {
          asmtGrpId,
          examClassId,
          examClassTitle,
          examClassLngNames: examClassTitle,
          examClassGrpId: '',
          examClassMpCtgryAcademicYears: academicYear,
          examClassMpCtgryId: '1',
          examClassMpCtgryTitle: 'Semester I',
          examScheduledSchoolId: schoolId,
          examScheduledSchoolTitle: schoolTitle,
          examScheduledSyear: academicYear,
          examScheduledMpId: '1',
          examScheduledMpTitle: 'Odd Sem (1,3,5,7)',
          examAttemptTypeId: '1',
          examAttemptTypeTitle: 'Regular',
          isRegularExamConducted: 'Y',
          examAsmtCtgryId: '1',
          examAsmtCtgryTitle: 'Semester I',
          examAsmtTypeId: '1,2,3,4,5,6,7,8,9,990',
          examAsmtTypeTitle: commonAsmtTypeTitles,
          examCpMpId: '1',
          loggedInUsrId,
          showResultOnMobile: 'Y'
        }
      ];

      const examParamsPayload = JSON.stringify({
        examParams: {
          action_type: 'getAssessmentDataToShowOnMobileWithAnnual',
          action_data: actionData
        }
      });

      const annualCardParamsPayload = JSON.stringify({
        examParamDataObj: {
          actionType: 'studentAnnualWiseExamDashboard',
          actionData: {
            usrAsmtGrpId: asmtGrpId,
            usrEnrolledInstId: schoolId,
            usrType: 'STUDENTS',
            usrId: loggedInUsrId,
            loggedInUsrType: 'STUDENTS',
            loggedInUsrId: loggedInUsrId
          }
        }
      });

      const examInfoUrl = `https://edunova.abes.ac.in/sims-services/digitalsims/?r=api/v1/Assessment/ManageExamInfo&data=${encodeURIComponent(examParamsPayload)}`;
      const annualCardUrl = `https://edunova.abes.ac.in/sims-services/digitalsims/?r=api/v1/Exam/ManageStudentExamAnnualwiseDashboardCardDetails&data=${encodeURIComponent(annualCardParamsPayload)}`;

      // Stage 6: Retrieve genuine examination marksheet
      this.sessionManager.updateProgress(sessionId, 6, 'Retrieving genuine examination marksheet...', 90);
      log('Stage 6: Querying ManageExamInfo and annual card details in parallel...');

      const [examInfoJson, annualCardsJson] = await Promise.all([
        withTimeout(
          fetchPortalJson(examInfoUrl, { hash: 'trr36pdthb9xbhcppyqkgbpkq' }, config.resultLoadingTimeoutMs || 20000),
          (config.resultLoadingTimeoutMs || 20000) + 2000,
          'ManageExamInfo Retrieval',
          'TIMEOUT_EXAM_INFO'
        ),
        fetchPortalJson(annualCardUrl, { hash: 'trr36pdthb9xbhcppyqkgbpkq' }, config.resultLoadingTimeoutMs || 20000).catch(() => null)
      ]);

      const pubDetails = examInfoJson?.collection?.response?.examInfo?.publishingDetails;
      if (!pubDetails || !Array.isArray(pubDetails.data) || pubDetails.data.length === 0) {
        const fetchErr = new Error('Examination result could not be retrieved from the portal.');
        fetchErr.code = 'RESULT_EXTRACTION_FAILED';
        throw fetchErr;
      }

      // Stage 7: Normalize clean result JSON
      const normalized = normalizeResultData({
        annualwiseCardDetails: annualCardsJson,
        manageExamInfoDetails: examInfoJson,
        expectedStudentNumber: validNumber,
        authenticatedUserData: userData
      });

      if (!normalized) {
        const normErr = new Error('Failed to normalize examination result data.');
        normErr.code = 'NORMALIZATION_FAILED';
        throw normErr;
      }

      // Final identity verification assertion on normalized object
      if (normalized.student.studentNumber && normalized.student.studentNumber !== validNumber) {
        const mismatchErr = new Error(`Identity mismatch in normalized result: ${normalized.student.studentNumber} !== ${validNumber}`);
        mismatchErr.code = 'STUDENT_IDENTITY_MISMATCH';
        throw mismatchErr;
      }

      this.dbService.setCachedResult(validNumber, normalized).catch(e => console.warn('[Neon DB] Failed to cache result:', e.message));
      this.dbService.logSearch({
        studentNumber: validNumber,
        cacheHit: false,
        responseTimeMs: Date.now() - startTime,
        status: 'SUCCESS'
      }).catch(() => {});

      session.resultData = normalized;
      session.examSummary = {
        title: session.resultData?.institution?.headerTitle || 'ABES Engineering College : Annual Result',
        isPending: session.resultData.annualSummary.status === 'PENDING',
        hasTable: Boolean(session.resultData?.semesters?.length),
        portalUrl: config.portalResultsUrl
      };

      this.sessionManager.updateProgress(sessionId, 7, 'Examination result loaded successfully.', 100, {
        status: 'ready',
        resultData: normalized
      });
      log(`Workflow completed successfully for student: ${normalized.student.name} (YGPA: ${normalized.overallYgpa}, Status: ${normalized.overallRemarks})`);

    } catch (err) {
      log(`Workflow error: ${err.message}`);
      session.status = 'error';
      session.error = {
        message: err.message || 'An unexpected error occurred during portal automation.',
        code: err.code || 'AUTOMATION_FAILED'
      };
      // Explicitly wipe all partial/stale result data to prevent any data leakage
      session.resultData = null;
      session.renderedHtml = null;
      session.downloadedFile = null;
      session.examSummary = null;
      this.sessionManager.updateProgress(sessionId, session.stage || 1, `Failed: ${err.message}`, session.progressPercent || 10);
      this.dbService.logSearch({
        studentNumber: validNumber,
        cacheHit: false,
        responseTimeMs: Date.now() - startTime,
        status: 'ERROR',
        errorCode: err.code || 'AUTOMATION_FAILED'
      }).catch(() => {});
      throw err;
    }
  }

  /**
   * Retrieves operational diagnostics, queue status, and health metrics
   */
  getMetrics() {
    const mem = process.memoryUsage();
    return {
      submittedSearches: this.metrics.submittedSearches,
      queuedSearches: this.jobQueue.length,
      activeSearches: this.activeWorkers,
      completedSearches: this.metrics.completedSearches,
      failedSearches: this.metrics.failedSearches,
      timeouts: this.metrics.timeouts,
      retries: this.metrics.retries,
      peakConcurrentWorkers: this.metrics.peakConcurrentWorkers,
      maxConcurrentWorkers: this.maxConcurrentWorkers,
      maxQueueSize: this.maxQueueSize,
      averageDurationSec: this.metrics.completedSearches > 0
        ? parseFloat((this.metrics.totalExecutionDurationMs / this.metrics.completedSearches / 1000).toFixed(1))
        : 0,
      memoryUsageMb: {
        rss: parseFloat((mem.rss / 1024 / 1024).toFixed(1)),
        heapUsed: parseFloat((mem.heapUsed / 1024 / 1024).toFixed(1)),
        heapTotal: parseFloat((mem.heapTotal / 1024 / 1024).toFixed(1))
      },
      browserPool: null,
      uptimeSec: Math.floor(process.uptime())
    };
  }
}

module.exports = {
  AutomationService,
  defaultAutomationService: new AutomationService(),
};
