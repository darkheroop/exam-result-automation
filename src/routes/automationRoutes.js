'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const config = require('../config');
const { validateStudentNumber } = require('../services/credentialService');
const { defaultSessionManager } = require('../services/sessionManager');
const { defaultAutomationService } = require('../services/automationService');
const { defaultBrowserPool } = require('../services/browserPool');

const router = express.Router();

// Keep-alive agent for proxying to persistent worker
const proxyHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const proxyHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

function forwardRequest(urlStr, method, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const transport = isHttps ? https : http;
      const agent = isHttps ? proxyHttpsAgent : proxyHttpAgent;
      const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

      const req = transport.request(u, {
        method,
        agent,
        headers: {
          'Accept': 'application/json',
          ...(payload ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          } : {}),
          ...headers
        }
      }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          let json = null;
          try { if (raw) json = JSON.parse(raw); } catch {}
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: json,
            raw
          });
        });
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Helper to extract session token from header or query param
 */
function getSessionToken(req) {
  return (
    req.headers['x-session-token'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    req.query.token ||
    null
  );
}

/**
 * POST /api/automation/start
 * Starts the examination result retrieval workflow
 */
router.post('/start', async (req, res, next) => {
  try {
    const rawNumber = req.body?.studentNumber || req.body?.number || req.body?.studentIdentifier;
    const validatedNumber = validateStudentNumber(rawNumber);

    // Option A: Forward to persistent worker service if configured
    if (config.workerServiceUrl) {
      const fwdHeaders = { 'Content-Type': 'application/json' };
      if (config.workerApiKey) fwdHeaders['x-worker-key'] = config.workerApiKey;
      const fwdRes = await forwardRequest(
        `${config.workerServiceUrl}/api/automation/start`,
        'POST',
        fwdHeaders,
        { studentNumber: validatedNumber }
      );
      return res.status(fwdRes.statusCode || 202).json(fwdRes.data || { raw: fwdRes.raw });
    }

    // De-duplication: check if student has an existing active or recent session
    const existingSession = defaultSessionManager.findActiveSessionByStudent(validatedNumber);
    if (existingSession && !req.query?.force) {
      return res.status(202).json({
        success: true,
        sessionId: existingSession.sessionId,
        sessionToken: existingSession.sessionToken,
        status: existingSession.status,
        message: existingSession.status === 'ready'
          ? 'Examination result retrieval completed successfully.'
          : (existingSession.stageMessage || 'Examination result retrieval already in progress.'),
        error: existingSession.error ? {
          message: existingSession.error.message,
          code: existingSession.error.code
        } : null,
        data: defaultSessionManager.toPublicState(existingSession)
      });
    }

    // Create a new session
    const session = defaultSessionManager.createSession(validatedNumber);

    // Start workflow within worker pool
    const workflowPromise = defaultAutomationService.runWorkflow(session.sessionId, session.sessionToken, validatedNumber).catch((workflowErr) => {
      console.error(`[Session ${session.sessionId}] Workflow failure:`, workflowErr.message);
    });

    // If session was immediately queued due to capacity, return 202 immediately
    if (session.status === 'queued') {
      return res.status(202).json({
        success: true,
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        status: session.status,
        queuePosition: session.queuePosition || defaultSessionManager.getQueuePosition(session.sessionId),
        message: `Request accepted and queued (position ${session.queuePosition || defaultSessionManager.getQueuePosition(session.sessionId)}).`,
        error: null,
        data: defaultSessionManager.toPublicState(session)
      });
    }

    // In serverless environments (e.g. Vercel), hold connection open long enough for the workflow to complete
    // so the serverless container CPU is not frozen before Playwright finishes.
    const isServerless = Boolean(
      process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_VERSION ||
      process.env.LAMBDA_TASK_ROOT
    );
    const waitWindowMs = isServerless ? 45000 : 3000;

    let timeoutId;
    const initialWaitPromise = new Promise((resolve) => {
      timeoutId = setTimeout(resolve, waitWindowMs);
    });

    await Promise.race([workflowPromise, initialWaitPromise]);
    if (timeoutId) clearTimeout(timeoutId);

    res.status(202).json({
      success: true,
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      status: session.status,
      message: session.status === 'ready'
        ? 'Examination result retrieval completed successfully.'
        : (session.error ? session.error.message : (session.stageMessage || 'Examination result retrieval initialized.')),
      error: session.error ? {
        message: session.error.message,
        code: session.error.code
      } : null,
      data: defaultSessionManager.toPublicState(session)
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/automation/status/:sessionId and GET /api/automation/:sessionId/status
 * Returns the current workflow progress for a specific session
 */
const statusHandler = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const token = getSessionToken(req);

    if (config.workerServiceUrl) {
      const fwdHeaders = {};
      if (config.workerApiKey) fwdHeaders['x-worker-key'] = config.workerApiKey;
      if (token) fwdHeaders['x-session-token'] = token;
      const fwdRes = await forwardRequest(
        `${config.workerServiceUrl}/api/automation/status/${sessionId}`,
        'GET',
        fwdHeaders
      );
      return res.status(fwdRes.statusCode || 200).json(fwdRes.data || { raw: fwdRes.raw });
    }

    const session = defaultSessionManager.getSession(sessionId, token);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: {
          message: 'Session not found or has expired. Please start a new retrieval.',
          code: 'SESSION_NOT_FOUND'
        }
      });
    }

    res.json({
      success: true,
      data: defaultSessionManager.toPublicState(session)
    });
  } catch (err) {
    next(err);
  }
};

router.get('/status/:sessionId', statusHandler);
router.get('/:sessionId/status', statusHandler);

/**
 * GET /api/automation/view/:sessionId
 * Serves the rendered examination result view with the top navigation bar hidden
 */
router.get('/view/:sessionId', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const token = getSessionToken(req);

    if (config.workerServiceUrl) {
      const fwdHeaders = {};
      if (config.workerApiKey) fwdHeaders['x-worker-key'] = config.workerApiKey;
      if (token) fwdHeaders['x-session-token'] = token;
      const fwdRes = await forwardRequest(
        `${config.workerServiceUrl}/api/automation/view/${sessionId}`,
        'GET',
        fwdHeaders
      );
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(fwdRes.statusCode || 200).send(fwdRes.raw);
    }

    const session = defaultSessionManager.getSession(sessionId, token);
    if (!session) {
      return res.status(404).send('<h3>Session expired or not found.</h3>');
    }

    if (!session.renderedHtml) {
      return res.status(409).send('<h3>Examination results interface is still preparing. Please wait...</h3>');
    }

    // Build standalone HTML frame incorporating PrimeNG and portal styles
    const viewHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Examination Result - Insync</title>
  <base href="https://ai-edunova.abes.ac.in/">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.cdnfonts.com/css/lato" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/primeicons/7.0.0/primeicons.min.css">
  <link rel="stylesheet" href="https://ai-edunova.abes.ac.in/styles-2NQPLNDH.css">
  <style>
    top-navbar,
    .top-navbar,
    app-topbar,
    .layout-topbar,
    .layout-menu-button,
    nav.p-breadcrumb,
    .p-breadcrumb,
    app-floating-configurator,
    app-configurator,
    app-sidebar,
    .sidebar-base,
    de-loader,
    [class*="backdrop-blur"],
    div[class*="maskbg"],
    div[class*="animate-fadeIn"],
    div.fixed.inset-0,
    div.skiptranslate,
    iframe[id*="container"],
    .p-toast {
      display: none !important;
    }
    img[alt*="Watermark"],
    .watermark,
    div:has(> img[alt*="Watermark"]),
    div:has(> img[src*="ABES.png"]),
    div:has(> img[src*="abes.png"]) {
      display: none !important;
    }
    .hidden {
      display: none !important;
    }
    .h-screen {
      height: auto !important;
      min-height: 100% !important;
    }
    .overflow-hidden {
      overflow: visible !important;
    }
    html, body {
      font-family: 'Lato', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
      background-color: #ffffff !important;
      color: #1e293b !important;
      margin: 0 !important;
      padding: 0.75rem 1.25rem !important;
      overflow: auto !important;
      height: auto !important;
      min-height: 100% !important;
    }
    .layout-main-container, .layout-content-wrapper, .layout-main {
      padding-top: 0 !important;
      margin: 0 auto !important;
      width: 100% !important;
      max-width: 100% !important;
    }
    .semester-result-print-section {
      background: #ffffff !important;
      padding-top: 0 !important;
      margin-top: 0 !important;
      min-height: auto !important;
    }
    .result-print-page-header {
      margin-top: 0 !important;
      padding-top: 0.25rem !important;
      margin-bottom: 0.85rem !important;
    }
    .result-print-page-header h1 {
      display: flex !important;
      align-items: center !important;
      flex-wrap: wrap !important;
      gap: 0.35rem !important;
    }
    .result-print-page-header h1 span {
      display: inline-block !important;
    }
    .result-print-page-header h1 span:nth-child(2) {
      margin: 0 0.35rem !important;
    }
    .result-print-page-header button {
      display: none !important;
    }
  </style>
</head>
<body>
  <div class="result-embed-container">
    ${session.renderedHtml}
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.send(viewHtml);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/automation/:sessionId/download
 * Triggers the educational portal's PDF download and verifies the document
 */
router.post('/:sessionId/download', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const token = getSessionToken(req);

    if (config.workerServiceUrl) {
      const fwdHeaders = {};
      if (config.workerApiKey) fwdHeaders['x-worker-key'] = config.workerApiKey;
      if (token) fwdHeaders['x-session-token'] = token;
      const fwdRes = await forwardRequest(
        `${config.workerServiceUrl}/api/automation/${sessionId}/download`,
        'POST',
        fwdHeaders,
        req.body
      );
      return res.status(fwdRes.statusCode || 200).json(fwdRes.data || { raw: fwdRes.raw });
    }

    const result = await defaultAutomationService.triggerPortalDownload(sessionId, token);

    res.json({
      success: true,
      message: 'Examination result PDF downloaded and verified successfully.',
      fileName: result.fileName,
      size: result.size,
      downloadUrl: result.downloadUrl,
      base64: result.base64 || null
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/automation/:sessionId/file
 * Securely delivers the verified downloaded PDF
 */
router.get('/:sessionId/file', (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const token = getSessionToken(req);

    if (config.workerServiceUrl) {
      const redirectUrl = `${config.workerServiceUrl}/api/automation/${sessionId}/file${token ? `?token=${encodeURIComponent(token)}` : ''}`;
      return res.redirect(redirectUrl);
    }

    const session = defaultSessionManager.getSession(sessionId, token);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: { message: 'Session not found or expired.', code: 'SESSION_NOT_FOUND' }
      });
    }

    if (!session.downloadedFile || !session.downloadedFile.ready) {
      return res.status(404).json({
        success: false,
        error: { message: 'PDF document has not yet been downloaded.', code: 'FILE_NOT_READY' }
      });
    }

    const fileName = session.downloadedFile.fileName || 'Examination_Result.pdf';
    const filePath = session.downloadedFile.filePath;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    // Deliver from disk if file is available
    if (filePath && fs.existsSync(filePath)) {
      res.setHeader('Content-Length', session.downloadedFile.size);
      const fileStream = fs.createReadStream(filePath);
      return fileStream.pipe(res);
    }

    // Fall back to in-memory base64 buffer for serverless multi-container resilience
    if (session.downloadedFile.base64) {
      const buf = Buffer.from(session.downloadedFile.base64, 'base64');
      res.setHeader('Content-Length', buf.length);
      return res.end(buf);
    }

    return res.status(404).json({
      success: false,
      error: { message: 'Downloaded file is no longer available.', code: 'FILE_EXPIRED' }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/automation/:sessionId/close
 * Closes the browser context and cleans up temporary files
 */
router.post('/:sessionId/close', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const token = getSessionToken(req);

    if (config.workerServiceUrl) {
      const fwdHeaders = {};
      if (config.workerApiKey) fwdHeaders['x-worker-key'] = config.workerApiKey;
      if (token) fwdHeaders['x-session-token'] = token;
      const fwdRes = await forwardRequest(
        `${config.workerServiceUrl}/api/automation/${sessionId}/close`,
        'POST',
        fwdHeaders,
        req.body
      );
      return res.status(fwdRes.statusCode || 200).json(fwdRes.data || { raw: fwdRes.raw });
    }

    // Verify ownership
    const session = defaultSessionManager.getSession(sessionId, token);
    if (session) {
      await defaultSessionManager.closeSession(sessionId);
    }

    res.json({
      success: true,
      message: 'Session closed and resources cleaned up.'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/automation/metrics
 * Returns operational metrics, queue status, and resource usage
 */
router.get('/metrics', async (req, res, next) => {
  try {
    if (config.workerServiceUrl) {
      const fwdHeaders = {};
      if (config.workerApiKey) fwdHeaders['x-worker-key'] = config.workerApiKey;
      const fwdRes = await forwardRequest(
        `${config.workerServiceUrl}/api/automation/metrics`,
        'GET',
        fwdHeaders
      );
      return res.status(fwdRes.statusCode || 200).json(fwdRes.data || { raw: fwdRes.raw });
    }

    res.json({
      success: true,
      data: defaultAutomationService.getMetrics()
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
