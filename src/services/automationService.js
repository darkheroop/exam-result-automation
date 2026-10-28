'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const config = require('../config');
const { defaultCredentialService } = require('./credentialService');
const { defaultSessionManager } = require('./sessionManager');
const { normalizeResultData } = require('./resultNormalizer');

class AutomationService {
  constructor(options = {}) {
    this.sessionManager = options.sessionManager || defaultSessionManager;
    this.credentialService = options.credentialService || defaultCredentialService;
    this.browser = null;
    this.browserInitPromise = null;
  }

  /**
   * Initializes the Chromium browser instance if not already running
   */
  async getBrowser() {
    const isServerless = Boolean(
      process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_VERSION ||
      process.env.LAMBDA_TASK_ROOT
    );

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
          '--single-process',
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
              '--single-process',
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

      this.browser = await chromium.launch(launchOptions);
      this.browser.on('disconnected', () => {
        this.browser = null;
        this.browserInitPromise = null;
      });
      return this.browser;
    })();

    return this.browserInitPromise;
  }

  /**
   * Starts and executes the complete examination result retrieval workflow
   * @param {string} sessionId
   * @param {string} sessionToken
   * @param {string} studentNumber
   */
  async runWorkflow(sessionId, sessionToken, studentNumber) {
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

      // Stage 2: Retrieve authorized credentials from backend APIs
      this.sessionManager.updateProgress(sessionId, 2, 'Retrieving authorized credentials...', 30);
      const credentials = await this.credentialService.fetchCredentials(validNumber);
      const username = credentials.username;
      const password = credentials.password;
      session.username = username;
      log(`Stage 2: Retrieved credentials for user: ${username}`);

      // Stage 3: Connect to the educational portal
      this.sessionManager.updateProgress(sessionId, 3, 'Connecting to the examination portal...', 45);
      log('Stage 3: Launching browser...');

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
        browser = await this.getBrowser();
        const created = await createContextAndPage(browser);
        context = created.ctx;
        page = created.p;
      } catch (browserErr) {
        log(`Initial browser connection failed (${browserErr.message}). Re-initializing fresh browser instance...`);
        try {
          if (this.browser) {
            await this.browser.close().catch(() => {});
          }
        } catch (_) {}
        this.browser = null;
        this.browserInitPromise = null;

        browser = await this.getBrowser();
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

      log(`Navigating to portal login: ${config.portalLoginUrl}`);
      await page.goto(config.portalLoginUrl, { waitUntil: 'commit', timeout: config.pageTimeoutMs });

      // Stage 4: Authenticate with the educational portal
      this.sessionManager.updateProgress(sessionId, 4, 'Authenticating session...', 60);

      // Wait for login UI elements (inputs or tabs) to render
      await page.waitForFunction(() => {
        const text = document.body ? document.body.innerText : '';
        const hasInputs = document.querySelectorAll('input').length > 0;
        const hasTabs = text.includes('With Password') || text.includes('Login');
        return hasInputs || hasTabs;
      }, { timeout: 15000 }).catch(() => {});

      // Switch to "With Password" tab if present
      const withPasswordTab = page.locator('text="With Password"').first();
      if (await withPasswordTab.isVisible({ timeout: 5000 }).catch(() => false)) {
        await withPasswordTab.click();
        await page.waitForTimeout(500);
      }

      // Fill username & password
      const userInput = page.locator('input[placeholder*="username" i], input[type="text"]').first();
      const passInput = page.locator('input[type="password"]').first();
      const loginButton = page.locator('button:has-text("Login")').first();

      await userInput.waitFor({ state: 'visible', timeout: 15000 });
      await userInput.fill(username);
      await passInput.waitFor({ state: 'visible', timeout: 10000 });
      await passInput.fill(password);

      // Submit login
      await loginButton.click();

      // Wait for authentication response or redirect away from login page
      try {
        await page.waitForFunction(
          () => !window.location.hash.includes('/auth/login'),
          { timeout: 15000 }
        );
      } catch (timeoutErr) {
        const errorText = await page.evaluate(() => {
          const toast = document.querySelector('.p-toast-message-content, .p-toast-detail, .p-message');
          return toast ? toast.innerText.trim() : null;
        }).catch(() => null);

        if (errorText) {
          throw new Error(`Authentication failed: ${errorText}`);
        }
        if (authErrorMessage) {
          throw new Error(`Authentication failed: ${authErrorMessage}`);
        }
        throw new Error('Authentication timed out. Portal did not confirm authenticated session.');
      }

      log('Portal authentication confirmed!');

      // Stage 5: Navigate to results page via official exam dashboard
      this.sessionManager.updateProgress(sessionId, 5, 'Opening examination results...', 75);
      log('Navigating to semester dashboard: https://ai-edunova.abes.ac.in/#/insync/dashboard/exam/semester-dashboard');

      await page.goto('https://ai-edunova.abes.ac.in/#/insync/dashboard/exam/semester-dashboard', {
        waitUntil: 'networkidle',
        timeout: 20000
      }).catch(async () => {
        await page.waitForTimeout(2000);
      });

      // Suppress any lingering loader masks or backdrops on dashboard
      await page.evaluate(() => {
        document.querySelectorAll('de-loader, [class*="backdrop-blur"], div.fixed.inset-0').forEach(el => el.remove());
      }).catch(() => {});

      let navigatedViaCard = false;
      try {
        // Switch to "Annual" dashboard view
        log('Switching to Annual dashboard tab...');
        await page.waitForFunction(() => {
          const els = Array.from(document.querySelectorAll('button, span, div, p-togglebutton'));
          return els.some(el => (el.innerText || '').trim() === 'Annual');
        }, { timeout: 10000 }).catch(() => {});

        const clicked = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, span, div, p-togglebutton')).filter(el => {
            return (el.innerText || '').trim() === 'Annual';
          });
          if (buttons.length > 0) {
            buttons[0].click();
            return true;
          }
          return false;
        }).catch(() => false);

        if (!clicked) {
          const annualToggle = page.locator('p-togglebutton:has-text("Annual"), button:has-text("Annual"), span:has-text("Annual")').first();
          await annualToggle.click({ timeout: 5000 }).catch(() => {});
        }
        log('Clicked Annual dashboard toggle.');
        await page.waitForTimeout(1000);

        // Wait for annual card action button to appear
        log('Waiting for annual card action button...');
        const actionBtn = page.locator('button[aria-label="Annual card actions"]').first();
        await actionBtn.waitFor({ state: 'visible', timeout: 8000 });
        log('Annual card action button visible. Clicking...');
        await actionBtn.click();
        await page.waitForTimeout(800);

        const viewResultItem = page.locator('text="View Exam Result"').first();
        await viewResultItem.waitFor({ state: 'visible', timeout: 6000 });
        log('Clicking View Exam Result...');
        await viewResultItem.click();

        await page.waitForFunction(() => window.location.hash.includes('semester-examination-result'), { timeout: 10000 });
        log('Navigated to Annual Result page via official workflow!');
        navigatedViaCard = true;
      } catch (cardNavErr) {
        log(`Card navigation notice: ${cardNavErr.message}. Falling back to direct URL.`);
      }

      if (!navigatedViaCard && !page.url().includes('semester-examination-result')) {
        log(`Navigating directly to portalResultsUrl: ${config.portalResultsUrl}`);
        await page.goto(config.portalResultsUrl, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
      }

      // Stage 6: Retrieve and prepare genuine result data
      this.sessionManager.updateProgress(sessionId, 6, 'Retrieving genuine examination marksheet...', 85);

      // Wait for assessment data response or rendered tables
      const waitForAssessment = async (timeoutMs = 15000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (assessmentDataJson) return true;
          await page.waitForTimeout(300);
        }
        return Boolean(assessmentDataJson);
      };

      await waitForAssessment(15000);

      // Also wait for DOM marksheet elements to render
      await page.waitForFunction(() => {
        const text = document.body.innerText || '';
        const hasTable = Boolean(document.querySelector('.annual-sem-table, table, .annual-sem-summary-card, #annual-result-print-section'));
        const hasStudentInfo = Boolean(document.querySelector('.student-result-info-card, [class*="student-info"]'));
        const isNotLoading = !document.querySelector('de-loader');
        return (hasTable && hasStudentInfo && isNotLoading) ||
          text.includes('Result is Not Published Yet') ||
          text.includes('PENDING VERIFICATION');
      }, { timeout: 12000 }).catch(() => {});

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

      // Wait up to 10s for the portal's native Annual PDF button to become enabled
      await page.waitForFunction(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          (b.innerText || '').includes('Annual PDF') || (b.getAttribute('label') || '').includes('Annual PDF')
        );
        return btn && !btn.disabled && !btn.hasAttribute('disabled');
      }, { timeout: 10000 }).catch(() => {});

      const downloadButton = page.locator('button:has-text("Annual PDF"), button[label*="Annual PDF"], button:has-text("Download PDF")').first();
      const hasDownloadBtn = (await downloadButton.count()) > 0;
      const isPortalDownloadDisabled = hasDownloadBtn ? await downloadButton.isDisabled().catch(() => true) : true;

      if (hasDownloadBtn && !isPortalDownloadDisabled) {
        try {
          log('Portal native Annual PDF button active. Initiating official client-side PDF generation...');
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 25000 }),
            downloadButton.click()
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
          log(`Native download event timed out or failed: ${dlErr.message}`);
        }
      }

      // Fallback: If portal native download was unavailable or pending
      if (!pdfBuffer) {
        try {
          log('Generating marksheet PDF via browser print engine fallback...');
          pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' }
          });
        } catch (printErr) {
          log(`Browser PDF generation fallback warning: ${printErr.message}`);
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
    } finally {
      if (context) {
        try {
          await context.close().catch(() => {});
        } catch (e) {}
        session.browserContext = null;
        session.page = null;
      }

      const isServerless = Boolean(
        process.env.VERCEL ||
        process.env.AWS_LAMBDA_FUNCTION_VERSION ||
        process.env.LAMBDA_TASK_ROOT
      );
      if (isServerless && this.browser) {
        try {
          await this.browser.close().catch(() => {});
        } catch (e) {}
        this.browser = null;
        this.browserInitPromise = null;
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
}

module.exports = {
  AutomationService,
  defaultAutomationService: new AutomationService(),
};
