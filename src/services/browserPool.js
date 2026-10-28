'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright-core');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

// Module-level singleton lock for serverless Brotli extraction
let serverlessExtractionPromise = null;

async function extractChromiumSafely(sparticuzChromium) {
  if (serverlessExtractionPromise) {
    return serverlessExtractionPromise;
  }

  serverlessExtractionPromise = (async () => {
    const finalBinary = path.join(os.tmpdir(), 'chromium');

    // If the binary already exists and is completely inflated (>180MB), reuse it directly
    if (fs.existsSync(finalBinary)) {
      try {
        const stat = fs.statSync(finalBinary);
        if (stat.size > 180 * 1024 * 1024) {
          return finalBinary;
        }
        // Incomplete / corrupt file from previous aborted write: clean up
        console.warn(`[BrowserPool] Cleaning up incomplete /tmp/chromium (${stat.size} bytes)...`);
        fs.unlinkSync(finalBinary);
      } catch (_) {}
    }

    const candidateBinPaths = [
      path.resolve(process.cwd(), 'node_modules/@sparticuz/chromium/bin'),
      path.resolve(__dirname, '../node_modules/@sparticuz/chromium/bin'),
      path.resolve(__dirname, '../../node_modules/@sparticuz/chromium/bin'),
      '/var/task/node_modules/@sparticuz/chromium/bin',
      '/var/task/bin',
    ];
    const binPath = candidateBinPaths.find(p => fs.existsSync(p));

    const execPath = binPath
      ? await sparticuzChromium.executablePath(binPath)
      : await sparticuzChromium.executablePath();

    if (execPath && fs.existsSync(execPath)) {
      try {
        fs.chmodSync(execPath, 0o755);
      } catch (_) {}
    }

    // Brief stabilization pause to ensure OS finishes flushing write handles
    await new Promise(r => setTimeout(r, 200));
    return execPath;
  })();

  try {
    return await serverlessExtractionPromise;
  } catch (err) {
    serverlessExtractionPromise = null;
    throw err;
  }
}

/**
 * Pre-Warmed, Managed Browser Pool with Auto-Healing, Context Isolation, and Bounded Concurrency.
 */
class BrowserPool {
  constructor(options = {}) {
    this.minBrowsers = options.minBrowsers || config.browserPoolMinBrowsers || 1;
    this.maxBrowsers = options.maxBrowsers || config.browserPoolMaxBrowsers || 2;
    this.maxContextsPerBrowser = options.maxContextsPerBrowser || config.browserPoolMaxContextsPerBrowser || 4;
    this.maxActiveJobs = this.maxBrowsers * this.maxContextsPerBrowser;
    this.idleTimeoutMs = options.idleTimeoutMs || config.browserPoolIdleTimeoutMs || 180000;

    // Array of { id, browser, activeContexts, totalContextsServed, createdAt, lastUsedAt, isWarming }
    this.pool = [];
    this.waitQueue = [];
    this.isDraining = false;
    this.launchLock = null;

    // Telemetry & Metrics
    this.metrics = {
      totalLaunched: 0,
      totalClosed: 0,
      totalCrashed: 0,
      totalContextsAcquired: 0,
      totalContextsReleased: 0,
      peakConcurrentContexts: 0
    };

    // Idle cleanup timer
    this.cleanupTimer = setInterval(() => this.reapIdleBrowsers(), 45000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /**
   * Pre-warms the minimum configured healthy browser instances ahead of requests.
   */
  async preWarm() {
    if (this.isDraining) return;
    const currentHealthy = this.pool.filter(e => e.browser && e.browser.isConnected()).length;
    const needed = Math.max(0, this.minBrowsers - currentHealthy);

    if (needed > 0) {
      console.log(`[BrowserPool] Pre-warming ${needed} browser instance(s)...`);
      const warmPromises = [];
      for (let i = 0; i < needed; i++) {
        warmPromises.push(this.launchNewBrowserInstance().catch(err => {
          console.warn('[BrowserPool] Pre-warm failed:', err.message);
        }));
      }
      await Promise.all(warmPromises);
    }
  }

  /**
   * Internal browser launcher with Sparticuz / System Chrome detection and ETXTBSY retry backoff.
   */
  async launchNewBrowserInstance() {
    if (this.launchLock) {
      return this.launchLock;
    }

    this.launchLock = (async () => {
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
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-component-update',
          '--disable-domain-reliability',
          '--disable-sync',
          '--mute-audio'
        ]
      };

      if (isServerless) {
        try {
          const sparticuzPkg = await import('@sparticuz/chromium');
          const sparticuzChromium = sparticuzPkg.default || sparticuzPkg;

          if (sparticuzChromium.setGraphicsMode !== undefined) {
            sparticuzChromium.setGraphicsMode = false;
          }

          const execPath = await extractChromiumSafely(sparticuzChromium);

          if (execPath) {
            const execDir = path.dirname(execPath);
            const al2023Lib = path.join(execDir, 'al2023', 'lib');
            process.env.LD_LIBRARY_PATH = `${execDir}:${al2023Lib}:${process.env.LD_LIBRARY_PATH || ''}`;
          }

          const rawArgs = sparticuzChromium.args || [];
          const cleanArgs = rawArgs
            .filter(arg => !arg.startsWith('--headless'))
            .concat([
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-gpu',
              '--disable-blink-features=AutomationControlled'
            ]);
          const uniqueArgs = Array.from(new Set(cleanArgs));

          launchOptions = {
            args: uniqueArgs,
            executablePath: execPath,
            headless: true
          };
        } catch (serverlessErr) {
          console.error('[BrowserPool] Serverless Chromium init error:', serverlessErr.message);
          if (config.chromePath) {
            launchOptions.executablePath = config.chromePath;
          } else {
            throw serverlessErr;
          }
        }
      } else {
        if (config.chromePath) {
          launchOptions.executablePath = config.chromePath;
        } else {
          launchOptions.channel = 'chrome';
        }
      }

      let browser = null;
      const maxLaunchAttempts = 5;
      for (let attempt = 1; attempt <= maxLaunchAttempts; attempt++) {
        try {
          browser = await chromium.launch(launchOptions);
          break;
        } catch (launchErr) {
          const isBusy = (launchErr.message && launchErr.message.includes('ETXTBSY')) || launchErr.code === 'ETXTBSY';
          if (isBusy && attempt < maxLaunchAttempts) {
            const backoffMs = 500 * Math.pow(2, attempt - 1);
            console.warn(`[BrowserPool] Chromium binary busy (ETXTBSY attempt ${attempt}/${maxLaunchAttempts}). Retrying in ${backoffMs}ms...`);
            await new Promise(r => setTimeout(r, backoffMs));
            continue;
          }
          throw launchErr;
        }
      }

      const browserEntry = {
        id: uuidv4().slice(0, 8),
        browser,
        activeContexts: 0,
        totalContextsServed: 0,
        createdAt: Date.now(),
        lastUsedAt: Date.now()
      };

      browser.on('disconnected', () => {
        console.warn(`[BrowserPool] Browser instance ${browserEntry.id} disconnected. Removing from pool.`);
        this.metrics.totalCrashed++;
        this.removeBrowser(browserEntry.id);
      });

      this.pool.push(browserEntry);
      this.metrics.totalLaunched++;
      console.log(`[BrowserPool] Successfully launched and added browser ${browserEntry.id} to pool (pool size: ${this.pool.length}).`);
      return browserEntry;
    })();

    try {
      return await this.launchLock;
    } finally {
      this.launchLock = null;
    }
  }

  /**
   * Acquires an isolated browser context and page from a healthy pooled browser.
   * If all browsers are at context capacity, scales up to maxBrowsers or queues the lease.
   */
  async acquireContext(timeoutMs = 45000) {
    if (this.isDraining) {
      throw new Error('BrowserPool is currently draining and cannot accept new jobs.');
    }

    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      // 1. Purge disconnected instances
      this.pool = this.pool.filter(e => e.browser && e.browser.isConnected());

      // 2. Find healthy browser with available context capacity
      let candidate = this.pool.find(e => e.browser && e.browser.isConnected() && e.activeContexts < this.maxContextsPerBrowser);

      // 3. If no candidate with capacity and under maxBrowsers, launch new browser
      if (!candidate && this.pool.length < this.maxBrowsers) {
        try {
          candidate = await this.launchNewBrowserInstance();
        } catch (launchErr) {
          console.warn('[BrowserPool] Failed to launch replacement browser:', launchErr.message);
        }
      }

      // 4. If we have a healthy candidate, allocate context
      if (candidate && candidate.browser && candidate.browser.isConnected()) {
        try {
          candidate.activeContexts++;
          candidate.totalContextsServed++;
          candidate.lastUsedAt = Date.now();

          const context = await candidate.browser.newContext({
            acceptDownloads: true,
            viewport: { width: 1366, height: 900 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
          });

          await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          });

          // Block tracking, analytics, and media to cut network latency and CPU usage
          await context.route('**/*', (route) => {
            const req = route.request();
            const type = req.resourceType();
            const url = req.url();

            if (
              url.includes('google-analytics') ||
              url.includes('googletagmanager') ||
              url.includes('translate.google') ||
              url.includes('doubleclick') ||
              url.includes('facebook') ||
              type === 'media'
            ) {
              return route.abort();
            }

            return route.continue();
          });

          const page = await context.newPage();

          this.metrics.totalContextsAcquired++;
          const currentTotalContexts = this.pool.reduce((sum, b) => sum + b.activeContexts, 0);
          if (currentTotalContexts > this.metrics.peakConcurrentContexts) {
            this.metrics.peakConcurrentContexts = currentTotalContexts;
          }

          const leaseId = uuidv4();
          let isReleased = false;

          const lease = {
            leaseId,
            browserId: candidate.id,
            browser: candidate.browser,
            context,
            page,
            release: async () => {
              if (isReleased) return;
              isReleased = true;
              await this.releaseContext(leaseId, candidate.id, context, page);
            }
          };

          return lease;
        } catch (allocErr) {
          candidate.activeContexts = Math.max(0, candidate.activeContexts - 1);
          console.warn(`[BrowserPool] Failed to create context on browser ${candidate.id}:`, allocErr.message);
        }
      }

      // 5. Wait briefly for a context to be released
      await new Promise(r => setTimeout(r, 200));
    }

    throw new Error(`BrowserPool context acquisition timed out after ${timeoutMs}ms.`);
  }

  /**
   * Safely releases a leased context and page back to the pool.
   */
  async releaseContext(leaseId, browserId, context, page) {
    this.metrics.totalContextsReleased++;
    try {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
    } catch (_) {}

    const entry = this.pool.find(e => e.id === browserId);
    if (entry) {
      entry.activeContexts = Math.max(0, entry.activeContexts - 1);
      entry.lastUsedAt = Date.now();
      console.log(`[BrowserPool] Released context ${leaseId} on browser ${browserId} (active: ${entry.activeContexts}/${this.maxContextsPerBrowser}).`);
    }
  }

  /**
   * Closes and removes a specific browser from the pool.
   */
  async removeBrowser(browserId) {
    const idx = this.pool.findIndex(e => e.id === browserId);
    if (idx !== -1) {
      const entry = this.pool.splice(idx, 1)[0];
      try {
        if (entry.browser) await entry.browser.close().catch(() => {});
      } catch (_) {}
      this.metrics.totalClosed++;
      console.log(`[BrowserPool] Removed browser ${browserId} from pool.`);
    }
  }

  /**
   * Closes idle browsers when surplus instances exceed minBrowsers.
   */
  async reapIdleBrowsers() {
    if (this.pool.length <= this.minBrowsers) return;
    const now = Date.now();

    for (let i = this.pool.length - 1; i >= 0; i--) {
      const entry = this.pool[i];
      if (this.pool.length > this.minBrowsers && entry.activeContexts === 0 && (now - entry.lastUsedAt > this.idleTimeoutMs)) {
        console.log(`[BrowserPool] Reaping idle browser ${entry.id} (idle for ${Math.round((now - entry.lastUsedAt) / 1000)}s)...`);
        await this.removeBrowser(entry.id);
      }
    }
  }

  /**
   * Drains and shuts down all browsers in the pool.
   */
  async closeAll() {
    this.isDraining = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);

    console.log(`[BrowserPool] Draining and closing all ${this.pool.length} browser instance(s)...`);
    const closePromises = this.pool.map(async entry => {
      try {
        if (entry.browser) await entry.browser.close().catch(() => {});
      } catch (_) {}
    });

    await Promise.all(closePromises);
    this.pool = [];
    this.metrics.totalClosed += closePromises.length;
    this.isDraining = false;
  }

  /**
   * Returns current pool diagnostics and health metrics.
   */
  getStats() {
    const activeContexts = this.pool.reduce((sum, b) => sum + b.activeContexts, 0);
    return {
      poolSize: this.pool.length,
      minBrowsers: this.minBrowsers,
      maxBrowsers: this.maxBrowsers,
      maxActiveJobs: this.maxActiveJobs,
      activeContexts,
      availableCapacity: Math.max(0, this.maxActiveJobs - activeContexts),
      browsers: this.pool.map(b => ({
        id: b.id,
        connected: b.browser?.isConnected() || false,
        activeContexts: b.activeContexts,
        totalContextsServed: b.totalContextsServed,
        uptimeSeconds: Math.round((Date.now() - b.createdAt) / 1000)
      })),
      metrics: { ...this.metrics }
    };
  }
}

const defaultBrowserPool = new BrowserPool();

module.exports = {
  BrowserPool,
  defaultBrowserPool
};
