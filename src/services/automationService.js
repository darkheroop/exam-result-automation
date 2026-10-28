'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright-core');
const config = require('../config');
const { defaultCredentialService } = require('./credentialService');
const { defaultSessionManager } = require('./sessionManager');
const { normalizeResultData } = require('./resultNormalizer');

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

class AutomationService {
  constructor(options = {}) {
    this.sessionManager = options.sessionManager || defaultSessionManager;
    this.credentialService = options.credentialService || defaultCredentialService;
    this.maxConcurrentWorkers = options.maxConcurrentWorkers || config.maxConcurrentWorkers || 3;
    this.maxQueueSize = options.maxQueueSize || config.maxQueueSize || 200;
    this.queueTimeoutMs = options.queueTimeoutMs || config.queueTimeoutMs || 120000;
    this.jobTimeoutMs = options.jobTimeoutMs || config.jobTimeoutMs || 90000;
    this.mockMode = options.mockMode !== undefined ? options.mockMode : (config.mockMode || false);
    this.mockDelayMs = options.mockDelayMs || 25;

    this.activeWorkers = 0;
    this.jobQueue = [];
    this.browser = null;
    this.browserInitPromise = null;

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
   * Initializes or returns the shared Chromium browser instance.
   * Reuses browser across jobs while keeping contexts strictly isolated.
   */
  async getBrowser() {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    if (this.browserInitPromise) {
      return this.browserInitPromise;
    }

    this.browserInitPromise = (async () => {
      const isServerless = Boolean(
        process.env.VERCEL ||
        process.env.AWS_LAMBDA_FUNCTION_VERSION ||
        process.env.LAMBDA_TASK_ROOT
      );

      // Stable, multi-context flags without single-process mode
      let launchOptions = {
        headless: config.headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--disable-extensions'
        ]
      };

      if (isServerless) {
        try {
          const sparticuzPkg = await import('@sparticuz/chromium');
          const sparticuzChromium = sparticuzPkg.default || sparticuzPkg;

          if (sparticuzChromium.setGraphicsMode !== undefined) {
            sparticuzChromium.setGraphicsMode = false;
          }

          const candidateBinPaths = [
            path.resolve(__dirname, '../../node_modules/@sparticuz/chromium/bin'),
            path.resolve(__dirname, '../node_modules/@sparticuz/chromium/bin'),
            path.resolve(process.cwd(), 'node_modules/@sparticuz/chromium/bin'),
            '/var/task/node_modules/@sparticuz/chromium/bin',
            '/var/task/bin',
          ];
          const binPath = candidateBinPaths.find(p => fs.existsSync(p));

          const execPath = binPath
            ? await sparticuzChromium.executablePath(binPath)
            : await sparticuzChromium.executablePath();

          launchOptions = {
            args: [
              ...(sparticuzChromium.args || []),
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-gpu',
              '--disable-blink-features=AutomationControlled'
            ],
            executablePath: execPath,
            headless: true
          };
        } catch (serverlessErr) {
          console.error('Sparticuz Chromium init error:', serverlessErr);
          if (config.chromePath) {
            launchOptions.executablePath = config.chromePath;
          } else {
            throw new Error(`Headless browser initialization failed on serverless: ${serverlessErr.message}`);
          }
        }
      } else {
        if (config.chromePath) {
          launchOptions.executablePath = config.chromePath;
        } else {
          launchOptions.channel = 'chrome';
        }
      }

      const browser = await chromium.launch(launchOptions);
      browser.on('disconnected', () => {
        console.warn('Browser process disconnected. Resetting browser instance handle.');
        this.browser = null;
        this.browserInitPromise = null;
      });

      this.browser = browser;
      this.browserInitPromise = null;
      return this.browser;
    })();

    return this.browserInitPromise;
  }

  /**
   * Safely closes the browser instance (for shutdown or testing)
   */
  async closeBrowser() {
    if (this.browser) {
      try {
        await this.browser.close().catch(() => {});
      } catch (_) {}
      this.browser = null;
      this.browserInitPromise = null;
    }
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
   * Internal core workflow execution with strict context isolation and operation timeouts.
   */
  async executeWorkflow(sessionId, sessionToken, studentNumber) {
    const session = this.sessionManager.getSession(sessionId, sessionToken);
    if (!session) return;

    session.workflowLogs = [];
    const log = (msg) => {
      const entry = `[${new Date().toISOString()}] ${msg}`;
      console.log(`[Session ${sessionId}] ${msg}`);
      session.workflowLogs.push(entry);
    };

    let page = null;
    let context = null;

    try {
      // Stage 1: Validate input
      this.sessionManager.updateProgress(sessionId, 1, 'Validating student identifier...', 15, { status: 'processing' });
      const validNumber = studentNumber.trim();
      log(`Stage 1: Validated student number: ${validNumber}`);

      // Stage 2: Retrieve authorized credentials from backend APIs with timeout
      this.sessionManager.updateProgress(sessionId, 2, 'Retrieving authorized credentials...', 30);
      const credentials = await withTimeout(
        this.credentialService.fetchCredentials(validNumber),
        config.credentialLookupTimeoutMs,
        'Credential Lookup',
        'TIMEOUT_CREDENTIALS'
      );
      const username = credentials.username;
      const password = credentials.password;
      session.username = username;
      log(`Stage 2: Retrieved credentials for user: ${username}`);

      // Fast mock mode branch for controlled high-concurrency / load testing
      if (this.mockMode) {
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
            marks: '850 / 1000',
            cop: 'NIL'
          },
          annualSummary: { status: 'PASS', ygpa: '8.50', credits: 44 },
          semesters: [
            {
              title: 'Semester I',
              sgpa: '8.40',
              creditsEarned: 22,
              credits: 22,
              obtainedMarks: 420,
              totalMarks: 500,
              status: 'PASS',
              subjects: [
                {
                  code: 'BAS101',
                  name: 'Engineering Physics',
                  type: 'Theory',
                  grade: 'A',
                  credits: 4,
                  creditsEarned: 4,
                  gradePoints: 8,
                  creditGrade: 32,
                  result: 'PASS',
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

        const mockPdfBuffer = Buffer.from('%PDF-1.4\n%Mock PDF for ' + validNumber + '\n%%EOF');
        session.pdfBuffer = mockPdfBuffer;
        session.pdfBase64 = mockPdfBuffer.toString('base64');
        session.downloadFileName = `Annual-Result-${validNumber}.pdf`;
        session.resultData = mockResultData;

        this.sessionManager.updateProgress(sessionId, 7, 'Examination result loaded successfully.', 100, {
          status: 'ready',
          resultData: mockResultData,
          downloadFileName: session.downloadFileName,
          pdfBase64: session.pdfBase64
        });
        return;
      }

      // Stage 3: Connect to the educational portal and launch isolated browser context
      this.sessionManager.updateProgress(sessionId, 3, 'Connecting to the examination portal...', 45);
      log('Stage 3: Launching isolated browser context...');

      const createContextAndPage = async (b) => {
        const ctx = await b.newContext({
          acceptDownloads: true,
          viewport: { width: 1366, height: 900 },
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
        });
        await ctx.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        const p = await ctx.newPage();
        return { ctx, p };
      };

      let browser;
      try {
        browser = await withTimeout(
          this.getBrowser(),
          config.browserLaunchTimeoutMs,
          'Browser Launch',
          'TIMEOUT_BROWSER_LAUNCH'
        );
        const created = await createContextAndPage(browser);
        context = created.ctx;
        page = created.p;
      } catch (browserErr) {
        log(`Initial browser connection failed (${browserErr.message}). Re-initializing fresh browser instance...`);
        this.metrics.retries++;
        await this.closeBrowser();

        browser = await withTimeout(
          this.getBrowser(),
          config.browserLaunchTimeoutMs,
          'Browser Re-launch',
          'TIMEOUT_BROWSER_RELAUNCH'
        );
        const created = await createContextAndPage(browser);
        context = created.ctx;
        page = created.p;
      }

      session.browserContext = context;
      session.page = page;

      // Track responses to capture genuine API payloads
      let annualwiseCardDetailsJson = null;
      let semesterwiseCardDetailsJson = null;
      let assessmentDataJson = null;
      let authErrorMessage = null;

      page.on('response', async (res) => {
        const url = res.url();
        const status = res.status();

        if (url.includes('GetUserAuthenticatedData') && status >= 400) {
          authErrorMessage = 'Portal authentication rejected credentials.';
        }

        if (status === 200) {
          if (url.includes('ManageStudentExamAnnualwiseDashboardCardDetails')) {
            try {
              annualwiseCardDetailsJson = await res.json();
              log('Intercepted ManageStudentExamAnnualwiseDashboardCardDetails');
            } catch (e) {}
          }
          if (url.includes('ManageStudentExamSemesterwiseDashboardCardDetails')) {
            try {
              semesterwiseCardDetailsJson = await res.json();
              log('Intercepted ManageStudentExamSemesterwiseDashboardCardDetails');
            } catch (e) {}
          }
          if (url.includes('ManageExamInfo') && url.includes('getAssessmentDataToShowOnMobileWithAnnual')) {
            try {
              assessmentDataJson = await res.json();
              log('Intercepted ManageExamInfo (getAssessmentDataToShowOnMobileWithAnnual)');
            } catch (e) {}
          }
        }
      });

      // Track native download events
      let capturedDownload = null;
      page.on('download', async (download) => {
        log(`Download event detected: ${download.suggestedFilename()}`);
        capturedDownload = download;
      });

      // Sanitize portal login URL
      const portalLoginUrl = (config.portalLoginUrl && config.portalLoginUrl.includes('/auth/login'))
        ? config.portalLoginUrl
        : 'https://ai-edunova.abes.ac.in/#/auth/login';

      log(`Navigating to portal login: ${portalLoginUrl}`);
      await withTimeout(
        (async () => {
          try {
            await page.goto(portalLoginUrl, {
              waitUntil: 'commit',
              timeout: config.loginNavigationTimeoutMs
            });
          } catch (commitErr) {
            log(`Notice on commit navigation: ${commitErr.message}. Attempting domcontentloaded...`);
            await page.goto(portalLoginUrl, {
              waitUntil: 'domcontentloaded',
              timeout: config.loginNavigationTimeoutMs
            }).catch((domErr) => {
              log(`Notice on domcontentloaded: ${domErr.message}. Proceeding to element check.`);
            });
          }
        })(),
        config.loginNavigationTimeoutMs + 5000,
        'Portal Login Navigation',
        'TIMEOUT_LOGIN_NAV'
      );

      // Stage 4: Authenticate with the educational portal
      this.sessionManager.updateProgress(sessionId, 4, 'Authenticating session...', 60);

      const isAlreadyDashboard = await page.evaluate(() => window.location.hash.includes('dashboard')).catch(() => false);
      if (isAlreadyDashboard) {
        log('Session is already authenticated at dashboard.');
      } else {
        log('Waiting for login form inputs to mount...');
        await page.waitForFunction(() => {
          return document.querySelectorAll('input').length > 0 || window.location.hash.includes('dashboard');
        }, null, { timeout: config.authCompletionTimeoutMs }).catch(() => {});

        const atDashboardNow = await page.evaluate(() => window.location.hash.includes('dashboard')).catch(() => false);
        if (!atDashboardNow) {
          const userInput = page.locator('input[placeholder*="username" i], input[type="text"]').first();
          const passInput = page.locator('input[type="password"]').first();
          const loginButton = page.locator('button:has-text("Login")').first();

          await userInput.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
          await userInput.fill(username);
          await passInput.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          await passInput.fill(password);

          // Submit login credentials
          log('Submitting login credentials...');
          await loginButton.click().catch(() => {});
          await passInput.press('Enter').catch(() => {});

          // Wait for authentication response or redirect away from login page
          let authenticated = false;
          for (let i = 0; i < 20; i++) {
            await page.waitForTimeout(500);
            const currentHash = await page.evaluate(() => window.location.hash).catch(() => '');
            if (currentHash.includes('dashboard') || (!currentHash.includes('/auth/login') && currentHash.length > 2)) {
              authenticated = true;
              break;
            }
          }

          if (!authenticated) {
            const errorText = await page.evaluate(() => {
              const toast = document.querySelector('.p-toast-message-content, .p-toast-detail, .p-message');
              return toast ? toast.innerText.trim() : null;
            }).catch(() => null);

            if (errorText) {
              const authErr = new Error(`Authentication failed: ${errorText}`);
              authErr.code = 'AUTH_REJECTED';
              throw authErr;
            }
            if (authErrorMessage) {
              const authErr = new Error(`Authentication failed: ${authErrorMessage}`);
              authErr.code = 'AUTH_REJECTED';
              throw authErr;
            }
            const authErr = new Error('Authentication timed out. Portal did not confirm authenticated session.');
            authErr.code = 'AUTH_TIMEOUT';
            throw authErr;
          }
        }
      }

      log('Portal authentication confirmed!');

      // Stage 5: Navigate to results page via official exam dashboard
      this.sessionManager.updateProgress(sessionId, 5, 'Opening examination results...', 75);

      const openAnnualResultViaDashboard = async () => {
        log('Navigating to semester dashboard: https://ai-edunova.abes.ac.in/#/insync/dashboard/exam/semester-dashboard');
        await page.goto('https://ai-edunova.abes.ac.in/#/insync/dashboard/exam/semester-dashboard', {
          waitUntil: 'commit',
          timeout: config.dashboardNavTimeoutMs
        }).catch(async () => {
          await page.waitForTimeout(1000);
        });

        // Make loaders non-blocking so backdrop pointer events cannot intercept automation clicks
        await page.addStyleTag({
          content: 'de-loader, [class*="backdrop-blur"], div.fixed.inset-0 { pointer-events: none !important; }'
        }).catch(() => {});

        // Wait for any initial loader overlay to clear
        await page.waitForSelector('de-loader', { state: 'detached', timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(500);

        // Switch to "Annual" dashboard view
        log('Switching to Annual dashboard tab...');
        const annualToggle = page.locator('p-togglebutton').filter({ hasText: 'Annual' }).first();
        if (await annualToggle.isVisible({ timeout: 5000 }).catch(() => false)) {
          await annualToggle.click({ force: true });
        } else {
          await page.evaluate(() => {
            const el = Array.from(document.querySelectorAll('p-togglebutton, button, span')).find(e => (e.innerText || '').trim() === 'Annual');
            if (el) el.click();
          }).catch(() => {});
        }

        await page.waitForTimeout(600);

        // Click Fetch button if present to populate annual cards
        const fetchBtn = page.locator('button').filter({ hasText: 'Fetch' }).first();
        if (await fetchBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
          await fetchBtn.click({ force: true }).catch(() => {});
        }

        // Wait for loader to disappear if triggered by tab switch or fetch
        await page.waitForSelector('de-loader', { state: 'detached', timeout: 12000 }).catch(() => {});
        await page.waitForTimeout(600);

        // Strictly target Year 1 / Published Annual examination card (avoiding ongoing unpublished Year 2)
        const year1Card = page.locator('section, article, div.rounded-xl, div.border').filter({
          hasText: /Year\s*1/i
        }).first();

        const isYear1Visible = await year1Card.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
        const actionBtn = isYear1Visible
          ? year1Card.locator('button[aria-label*="card actions" i], button[aria-label="Annual card actions"]').first()
          : page.locator('button[aria-label="Annual card actions"], button[aria-label*="card actions" i]').first();

        const isActionVisible = await actionBtn.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
        if (!isActionVisible) {
          throw new Error('Annual card action button not visible on dashboard');
        }

        log('Annual card action button visible. Clicking...');
        await actionBtn.click({ force: true });
        await page.waitForTimeout(600);

        const viewResultItem = page.locator('.p-popover li, li').filter({ hasText: 'View Exam Result' }).first();
        const isViewVisible = await viewResultItem.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
        if (!isViewVisible) {
          throw new Error('View Exam Result action item not visible in popover menu');
        }

        log('Clicking View Exam Result...');
        await viewResultItem.click({ force: true });
        await page.waitForFunction(() => window.location.hash.includes('semester-examination-result'), null, { timeout: 15000 });
        log('Navigated to Annual Result page via official workflow!');
        return true;
      };

      let navigatedViaCard = false;
      try {
        navigatedViaCard = await openAnnualResultViaDashboard();
      } catch (cardNavErr) {
        log(`Card navigation notice: ${cardNavErr.message}. Retrying once...`);
        this.metrics.retries++;
        try {
          await page.waitForTimeout(1000);
          navigatedViaCard = await openAnnualResultViaDashboard();
        } catch (retryErr) {
          log(`Retry card navigation failed: ${retryErr.message}. Falling back to direct URL.`);
        }
      }

      const portalResultsUrl = (config.portalResultsUrl && config.portalResultsUrl.includes('semester-examination-result'))
        ? config.portalResultsUrl
        : 'https://ai-edunova.abes.ac.in/#/insync/dashboard/exam/semester-examination-result?examMpId=2&resultView=annual';

      if (!navigatedViaCard && !page.url().includes('semester-examination-result')) {
        log(`Navigating directly to portalResultsUrl: ${portalResultsUrl}`);
        await page.goto(portalResultsUrl, { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
      }

      // Stage 6: Retrieve and prepare genuine result data
      this.sessionManager.updateProgress(sessionId, 6, 'Retrieving genuine examination marksheet...', 85);

      // Wait for assessment data response or rendered tables
      const waitForAssessment = async (timeoutMs = 6000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (assessmentDataJson) return true;
          await page.waitForTimeout(200);
        }
        return Boolean(assessmentDataJson);
      };

      await waitForAssessment(6000);

      // Also wait for DOM marksheet elements to render
      await page.waitForFunction(() => {
        const text = document.body.innerText || '';
        const hasTable = Boolean(document.querySelector('.annual-sem-table, table, .annual-sem-summary-card, #annual-result-print-section'));
        const hasStudentInfo = Boolean(document.querySelector('.student-result-info-card, [class*="student-info"]'));
        const isNotLoading = !document.querySelector('de-loader');
        return (hasTable && hasStudentInfo && isNotLoading) ||
          text.includes('Result is Not Published Yet') ||
          text.includes('PENDING VERIFICATION');
      }, { timeout: config.resultLoadingTimeoutMs }).catch(() => {});

      // Safe recovery: if the portal ever shows "Result is Not Published Yet", recover via dashboard Year 1 card
      const checkUnpublished = await page.evaluate(() => {
        return (document.body.innerText || '').includes('Result is Not Published Yet');
      }).catch(() => false);

      if (checkUnpublished) {
        log('Detected "Result is Not Published Yet" state. Initiating automatic recovery via dashboard Year 1 card...');
        this.metrics.retries++;
        try {
          await openAnnualResultViaDashboard();
          await waitForAssessment(6000);
          await page.waitForTimeout(2000);
        } catch (recErr) {
          log(`Recovery navigation failed: ${recErr.message}`);
        }
      }

      // Extract high-fidelity rendered HTML from the portal
      const renderedHtml = await page.evaluate(() => {
        const examEl = document.querySelector('app-semester-examination-result');
        const printSec = document.querySelector('#annual-result-print-section');
        const layoutEl = printSec || examEl || document.querySelector('app-layout') || document.body;
        return examEl ? examEl.outerHTML : layoutEl.innerHTML;
      }).catch(() => null);

      session.renderedHtml = renderedHtml;

      // Normalize genuine result data
      if (assessmentDataJson || annualwiseCardDetailsJson) {
        try {
          const normalized = normalizeResultData({
            annualwiseCardDetails: annualwiseCardDetailsJson,
            manageExamInfoDetails: assessmentDataJson,
            semesterwiseCardDetails: semesterwiseCardDetailsJson
          });

          if (normalized) {
            session.resultData = normalized;
            log(`Successfully normalized genuine result data for ${normalized.student.name} (Year: ${normalized.student.academicYear}, YGPA: ${normalized.student.ygpa})`);
          }
        } catch (normErr) {
          log(`Normalization warning: ${normErr.message}`);
        }
      }

      // Stage 7: Preparing verified marksheet PDF document
      this.sessionManager.updateProgress(sessionId, 7, 'Preparing examination result PDF...', 95);

      let pdfBuffer = null;
      let pdfFilename = `${session.resultData?.student?.name || 'Annual-Examination-Result'}-${validNumber}.pdf`;

      // Check if portal native Annual PDF button is active and ready
      const downloadButton = page.locator('button:has-text("Annual PDF"), button[label*="Annual PDF"], button:has-text("Download PDF")').first();
      const isNativeReady = await downloadButton.isVisible().catch(() => false) && !(await downloadButton.isDisabled().catch(() => true));

      if (isNativeReady) {
        try {
          log('Portal native Annual PDF button active. Initiating official client-side PDF generation...');
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 15000 }),
            downloadButton.click({ force: true })
          ]);

          const dlName = download.suggestedFilename() || pdfFilename;
          const sanitizedFilename = dlName.replace(/[^a-zA-Z0-9_\-\. ]/g, '_');
          const dlPath = path.join(session.tempDir, sanitizedFilename);
          await download.saveAs(dlPath);

          if (fs.existsSync(dlPath)) {
            const stat = fs.statSync(dlPath);
            if (stat.size > 0) {
              const fileBuf = fs.readFileSync(dlPath);
              if (fileBuf.slice(0, 4).toString('utf8') === '%PDF') {
                pdfBuffer = fileBuf;
                pdfFilename = sanitizedFilename;
                log(`Captured genuine native portal PDF: ${sanitizedFilename} (${stat.size} bytes)`);
              }
            }
          }
        } catch (dlErr) {
          log(`Native download notice: ${dlErr.message}`);
        }
      }

      // High-fidelity fallback: generate marksheet PDF via Chrome print engine
      if (!pdfBuffer) {
        try {
          log('Generating marksheet PDF via browser print engine...');
          pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' }
          });
        } catch (printErr) {
          log(`Browser PDF generation fallback notice: ${printErr.message}`);
        }
      }

      // Validate & save verified PDF buffer in session
      if (pdfBuffer && pdfBuffer.length > 0 && pdfBuffer.slice(0, 4).toString('utf8') === '%PDF') {
        const sanitizedFilename = pdfFilename.replace(/[^a-zA-Z0-9_\-\. ]/g, '_');
        const pdfFilePath = path.join(session.tempDir, sanitizedFilename);
        try {
          fs.writeFileSync(pdfFilePath, pdfBuffer);
        } catch (writeErr) {}

        session.downloadedFile = {
          ready: true,
          filePath: pdfFilePath,
          fileName: sanitizedFilename,
          size: pdfBuffer.length,
          mimeType: 'application/pdf',
          downloadedAt: Date.now(),
          base64: pdfBuffer.toString('base64')
        };
        log(`Verified marksheet PDF ready (${pdfBuffer.length} bytes, file: ${sanitizedFilename})`);
      }

      session.examSummary = {
        title: session.resultData?.institution?.headerTitle || 'ABES Engineering College : Annual Result',
        isPending: session.resultData ? session.resultData.annualSummary.status === 'PENDING' : false,
        isPdfButtonDisabled: !session.downloadedFile?.ready,
        hasTable: Boolean(session.resultData?.semesters?.length),
        portalUrl: config.portalResultsUrl
      };

      // Stage 7: Complete and ready
      this.sessionManager.updateProgress(sessionId, 7, 'Ready to download examination result.', 100, {
        status: 'ready'
      });
      log('Workflow completed successfully.');

    } catch (err) {
      log(`Workflow error: ${err.message}`);
      session.status = 'error';
      session.error = {
        message: err.message || 'An unexpected error occurred during portal automation.',
        code: err.code || 'AUTOMATION_FAILED'
      };
      this.sessionManager.updateProgress(sessionId, session.stage || 1, `Failed: ${err.message}`, session.progressPercent || 10);
      throw err;
    } finally {
      if (context) {
        try {
          await context.close().catch(() => {});
        } catch (e) {}
        session.browserContext = null;
        session.page = null;
      }
    }
  }

  /**
   * Triggers the educational portal's PDF download and captures the resulting PDF
   * @param {string} sessionId
   * @param {string} sessionToken
   */
  async triggerPortalDownload(sessionId, sessionToken) {
    const session = this.sessionManager.getSession(sessionId, sessionToken);
    if (!session) {
      const err = new Error('Automation session not found or has expired. Please fetch results again.');
      err.statusCode = 404;
      err.code = 'SESSION_NOT_FOUND';
      throw err;
    }

    // Fast-path: if verified marksheet PDF is already ready in session, return immediately
    if (session.downloadedFile && session.downloadedFile.ready) {
      return {
        success: true,
        fileName: session.downloadedFile.fileName,
        size: session.downloadedFile.size,
        downloadUrl: `/api/automation/${sessionId}/file?token=${sessionToken}`,
        base64: session.downloadedFile.base64
      };
    }

    if (session.status !== 'ready' && session.status !== 'download_ready') {
      const err = new Error(`Examination results page is not ready for download (current status: ${session.status}).`);
      err.statusCode = 400;
      err.code = 'NOT_READY';
      throw err;
    }

    const page = session.page;
    if (!page || page.isClosed()) {
      const err = new Error('Browser session for this request is no longer active. Please fetch results again.');
      err.statusCode = 410;
      err.code = 'SESSION_EXPIRED';
      throw err;
    }

    this.sessionManager.updateProgress(sessionId, 7, 'Generating and downloading marksheet PDF...', 95, {
      status: 'downloading'
    });

    try {
      const downloadButton = page.locator('button:has-text("Annual PDF"), button[label*="Annual PDF"], button:has-text("Download PDF")').first();
      const count = await downloadButton.count();

      if (count === 0) {
        throw new Error('Could not locate the Annual PDF download control on the examination portal.');
      }

      const isDisabled = await downloadButton.isDisabled();
      if (isDisabled) {
        throw new Error('The portal download control is currently disabled. The examination result may be incomplete or pending approval.');
      }

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 35000 }),
        downloadButton.click()
      ]);

      const originalFilename = download.suggestedFilename() || `${session.resultData?.student?.name || 'Annual-Result'}.pdf`;
      const sanitizedFilename = originalFilename.replace(/[^a-zA-Z0-9_\-\. ]/g, '_');
      const targetFilePath = path.join(session.tempDir, sanitizedFilename);

      await download.saveAs(targetFilePath);

      if (!fs.existsSync(targetFilePath)) {
        throw new Error('Downloaded file could not be verified on the server.');
      }

      const stats = fs.statSync(targetFilePath);
      if (stats.size === 0) {
        fs.unlinkSync(targetFilePath);
        throw new Error('Retrieved PDF file was empty.');
      }

      const buffer = fs.readFileSync(targetFilePath);
      if (!buffer.slice(0, 4).toString('utf8').startsWith('%PDF')) {
        fs.unlinkSync(targetFilePath);
        throw new Error('Retrieved file is not a valid PDF document.');
      }

      session.downloadedFile = {
        ready: true,
        filePath: targetFilePath,
        fileName: sanitizedFilename,
        size: stats.size,
        mimeType: 'application/pdf',
        downloadedAt: Date.now(),
        base64: buffer.toString('base64')
      };

      this.sessionManager.updateProgress(sessionId, 7, 'PDF marksheet downloaded and verified successfully.', 100, {
        status: 'download_ready'
      });

      return {
        success: true,
        fileName: sanitizedFilename,
        size: stats.size,
        downloadUrl: `/api/automation/${sessionId}/file?token=${sessionToken}`,
        base64: session.downloadedFile.base64
      };

    } catch (err) {
      session.status = 'ready';
      throw new Error(`Portal PDF download failed: ${err.message}`);
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
      uptimeSec: Math.floor(process.uptime())
    };
  }
}

module.exports = {
  AutomationService,
  defaultAutomationService: new AutomationService(),
};
