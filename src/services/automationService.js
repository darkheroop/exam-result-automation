'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const config = require('../config');
const { defaultCredentialService } = require('./credentialService');
const { defaultSessionManager } = require('./sessionManager');

class AutomationService {
  constructor(options = {}) {
    this.sessionManager = options.sessionManager || defaultSessionManager;
    this.credentialService = options.credentialService || defaultCredentialService;
    this.browser = null;
    this.browserInitPromise = null;
  }

  /**
   * Initializes the shared Chromium/Chrome browser instance if not already running
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

          // Disable graphics mode to avoid unpacking swiftshader (~2-3s speedup)
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

    try {
      // Stage 1: Validate input
      this.sessionManager.updateProgress(sessionId, 1, 'Validating student identifier...', 15, { status: 'processing' });
      const validNumber = studentNumber.trim();

      // Stage 2: Retrieve authorized credentials from backend APIs
      this.sessionManager.updateProgress(sessionId, 2, 'Retrieving authorized credentials...', 30);
      const credentials = await this.credentialService.fetchCredentials(validNumber);
      const username = credentials.username;
      const password = credentials.password;
      session.username = username;

      // Stage 3: Connect to the educational portal
      this.sessionManager.updateProgress(sessionId, 3, 'Connecting to the examination portal...', 45);
      console.log(`[Session ${sessionId}] Stage 3: Launching browser...`);
      const browser = await this.getBrowser();
      console.log(`[Session ${sessionId}] Browser ready, creating context...`);
      const context = await browser.newContext({
        acceptDownloads: true,
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      });

      // Avoid headless detection flags
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      session.browserContext = context;
      const page = await context.newPage();
      session.page = page;

      // Monitor portal toast errors and API responses
      let authErrorMessage = null;
      page.on('response', async (res) => {
        const url = res.url();
        if (url.includes('GetUserAuthenticatedData') && res.status() >= 400) {
          authErrorMessage = 'Portal authentication rejected credentials.';
        }
      });

      console.log(`[Session ${sessionId}] Navigating to portal login: ${config.portalLoginUrl}`);
      await page.goto(config.portalLoginUrl, { waitUntil: 'commit', timeout: config.pageTimeoutMs });
      console.log(`[Session ${sessionId}] Login response committed, waiting for login form...`);

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

      try {
        await userInput.waitFor({ state: 'visible', timeout: 15000 });
      } catch (waitErr) {
        const diag = await page.evaluate(() => ({
          title: document.title,
          url: window.location.href,
          text: document.body?.innerText?.slice(0, 300)
        })).catch(() => null);
        console.error(`[Session ${sessionId}] Input not visible. Diag:`, diag);
        throw new Error(`Portal login input not found. (Page: "${diag?.title || ''}", Snippet: "${diag?.text?.replace(/\s+/g, ' ').trim() || ''}")`);
      }

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
        // Check for visible error message on the page
        const errorText = await page.evaluate(() => {
          const toast = document.querySelector('.p-toast-message-content, .p-toast-detail, .p-message');
          return toast ? toast.innerText.trim() : null;
        });

        if (errorText) {
          throw new Error(`Authentication failed: ${errorText}`);
        }
        if (authErrorMessage) {
          throw new Error(`Authentication failed: ${authErrorMessage}`);
        }
        throw new Error('Authentication timed out. Portal did not confirm authenticated session.');
      }

      // Stage 5: Navigate to results page
      this.sessionManager.updateProgress(sessionId, 5, 'Opening examination results...', 75);
      console.log(`[Session ${sessionId}] Navigating to results page: ${config.portalResultsUrl}`);

      await page.goto(config.portalResultsUrl, { waitUntil: 'commit', timeout: config.pageTimeoutMs });

      // Fast reactive wait for destination results page content
      await page.waitForFunction(() => {
        const text = document.body.innerText || '';
        return (
          Boolean(document.querySelector('.annual-sem-table, table, .annual-result-print-section, .result-print-page-header, .student-result-info-card, button[label*="PDF"]')) ||
          text.includes('Result is Not Published Yet') ||
          text.includes('Annual Result') ||
          text.includes('Examination Result') ||
          window.location.hash.includes('semester-examination-result')
        );
      }, { timeout: 15000 }).catch(async () => {});

      // Verify destination results page loaded
      const pageVerification = await page.evaluate(() => {
        const href = window.location.href;
        const hash = window.location.hash;
        const isExamUrl = hash.includes('semester-examination-result') || href.includes('semester-examination-result');
        const hasResultContent = Boolean(
          document.querySelector('.annual-sem-table, table, .annual-result-print-section, .result-print-page-header, .student-result-info-card, button[label*="PDF"]')
        );
        const bodyText = document.body.innerText || '';
        const isUnpublished = bodyText.includes('Result is Not Published Yet') || bodyText.includes('PENDING VERIFICATION') || bodyText.includes('Annual Result');
        return { isExamUrl, hasResultContent, isUnpublished, href, hash };
      });

      console.log(`[Session ${sessionId}] Page verification:`, pageVerification);

      if (!pageVerification.isExamUrl && !pageVerification.hasResultContent && !pageVerification.isUnpublished) {
        throw new Error('Failed to reach examination results page. Session may have expired or access was redirected.');
      }

      // Stage 6: Preparing the result interface (hide top navigation bar)
      this.sessionManager.updateProgress(sessionId, 6, 'Preparing the result interface...', 90);

      // Inject custom CSS to cleanly remove the top navigation bar while keeping the full result interface
      await page.addStyleTag({
        content: `
          top-navbar,
          .top-navbar,
          app-topbar,
          .layout-topbar,
          .layout-menu-button,
          nav.p-breadcrumb,
          .p-breadcrumb,
          app-floating-configurator,
          app-configurator {
            display: none !important;
          }
          .layout-main-container,
          .layout-content-wrapper,
          .layout-main {
            padding-top: 0.5rem !important;
            margin-top: 0 !important;
          }
        `
      });

      // Extract high-fidelity rendered HTML and metadata for the viewing container
      const resultData = await page.evaluate(() => {
        const layoutEl = document.querySelector('app-layout') || document.querySelector('app-root') || document.body;
        const printHeader = document.querySelector('.result-print-page-header');
        const bodyText = document.body.innerText || '';
        const isPending = bodyText.includes('Result is Not Published Yet') || bodyText.includes('PENDING VERIFICATION');
        
        // Find existing download button state using native DOM APIs
        const pdfButton = document.querySelector('button[label*="PDF"]') ||
          Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').includes('PDF') || (b.innerText || '').includes('Download'));
        const isPdfButtonDisabled = pdfButton ? (pdfButton.disabled || pdfButton.hasAttribute('disabled')) : false;

        return {
          headerTitle: printHeader ? printHeader.innerText.split('\n')[0] : 'Semester Examination Result',
          isPending,
          isPdfButtonDisabled,
          hasTable: Boolean(document.querySelector('.annual-sem-table, table')),
          fullHtml: layoutEl.innerHTML
        };
      });

      // Save rendered state in session
      session.renderedHtml = resultData.fullHtml;
      session.examSummary = {
        title: resultData.headerTitle,
        isPending: resultData.isPending,
        isPdfButtonDisabled: resultData.isPdfButtonDisabled,
        hasTable: resultData.hasTable,
        portalUrl: config.portalResultsUrl
      };

      // Stage 7: Ready to download
      this.sessionManager.updateProgress(sessionId, 7, 'Ready to download examination result.', 100, {
        status: 'ready'
      });



    } catch (err) {
      session.status = 'error';
      session.error = {
        message: err.message || 'An unexpected error occurred during portal automation.',
        code: err.code || 'AUTOMATION_FAILED'
      };
      this.sessionManager.updateProgress(sessionId, session.stage, `Failed: ${err.message}`, session.progressPercent);
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
      throw new Error('Automation session not found or has expired.');
    }

    if (session.status !== 'ready' && session.status !== 'download_ready') {
      throw new Error(`Examination results page is not ready for download (current status: ${session.status}).`);
    }

    const page = session.page;
    if (!page || page.isClosed()) {
      throw new Error('Browser session for this request is no longer active. Please fetch results again.');
    }

    // Check if the portal results are currently unpublished
    if (session.examSummary?.isPending) {
      // The portal genuinely has no published marksheet yet
      throw new Error(
        'The examination result for this record is currently under process or pending verification on the educational portal. The portal has disabled PDF generation for unpublished results.'
      );
    }

    this.sessionManager.updateProgress(sessionId, 7, 'Generating and downloading marksheet PDF...', 95, {
      status: 'downloading'
    });

    try {
      // Locate the existing PDF download button on the educational portal
      const downloadButton = page.locator('button:has-text("Download PDF"), button:has-text("Annual PDF"), button[label*="PDF"]').first();
      const count = await downloadButton.count();

      if (count === 0) {
        throw new Error('Could not locate the PDF download control on the examination portal.');
      }

      const isDisabled = await downloadButton.isDisabled();
      if (isDisabled) {
        throw new Error('The portal download control is currently disabled. The examination result may be incomplete or pending approval.');
      }

      // Trigger the download and wait for Playwright download event
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 45000 }),
        downloadButton.click()
      ]);

      const originalFilename = download.suggestedFilename() || `Exam_Result_${session.studentIdentifier || 'Marksheet'}.pdf`;
      const sanitizedFilename = originalFilename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
      const targetFilePath = path.join(session.tempDir, sanitizedFilename);

      // Save downloaded file
      await download.saveAs(targetFilePath);

      // Verify that the file exists and is a valid PDF
      if (!fs.existsSync(targetFilePath)) {
        throw new Error('Downloaded file could not be verified on the server.');
      }

      const stats = fs.statSync(targetFilePath);
      if (stats.size === 0) {
        fs.unlinkSync(targetFilePath);
        throw new Error('Retrieved PDF file was empty.');
      }

      // Validate PDF magic bytes (%PDF)
      const buffer = Buffer.alloc(5);
      const fd = fs.openSync(targetFilePath, 'r');
      fs.readSync(fd, buffer, 0, 5, 0);
      fs.closeSync(fd);

      if (!buffer.toString('utf8').startsWith('%PDF')) {
        fs.unlinkSync(targetFilePath);
        throw new Error('Retrieved file is not a valid PDF document.');
      }

      // Update session with verified file
      session.downloadedFile = {
        ready: true,
        filePath: targetFilePath,
        fileName: sanitizedFilename,
        size: stats.size,
        mimeType: 'application/pdf',
        downloadedAt: Date.now()
      };

      this.sessionManager.updateProgress(sessionId, 7, 'PDF marksheet downloaded and verified successfully.', 100, {
        status: 'download_ready'
      });

      return {
        success: true,
        fileName: sanitizedFilename,
        size: stats.size,
        downloadUrl: `/api/automation/${sessionId}/file?token=${sessionToken}`
      };

    } catch (err) {
      session.status = 'ready'; // Revert back to ready so user can retry
      throw new Error(`Portal PDF download failed: ${err.message}`);
    }
  }
}

module.exports = {
  AutomationService,
  defaultAutomationService: new AutomationService(),
};
