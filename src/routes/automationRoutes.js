'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { validateStudentNumber } = require('../services/credentialService');
const { defaultSessionManager } = require('../services/sessionManager');
const { defaultAutomationService } = require('../services/automationService');

const router = express.Router();

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
    const rawNumber = req.body?.studentNumber || req.body?.number;
    const validatedNumber = validateStudentNumber(rawNumber);

    // Create a new session
    const session = defaultSessionManager.createSession(validatedNumber);

    // Asynchronously trigger the automation workflow
    setImmediate(() => {
      defaultAutomationService.runWorkflow(session.sessionId, session.sessionToken, validatedNumber)
        .catch(err => {
          console.error(`[Session ${session.sessionId}] Workflow failure:`, err.message);
        });
    });

    res.status(202).json({
      success: true,
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      status: 'started',
      message: 'Examination result retrieval workflow initialized.'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/automation/status/:sessionId
 * Returns the current workflow progress for a specific session
 */
router.get('/status/:sessionId', (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const token = getSessionToken(req);

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
});

/**
 * GET /api/automation/view/:sessionId
 * Serves the rendered examination result view with the top navigation bar hidden
 */
router.get('/view/:sessionId', (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const token = getSessionToken(req);

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
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.cdnfonts.com/css/lato" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
  <link rel="stylesheet" href="https://ai-edunova.abes.ac.in/styles-2NQPLNDH.css">
  <style>
    body {
      font-family: Lato, sans-serif;
      background-color: #f8fafc;
      color: #1e293b;
      margin: 0;
      padding: 1.5rem;
    }
    app-topbar, .layout-topbar, .layout-menu-button, nav.p-breadcrumb, .p-breadcrumb, app-floating-configurator, app-configurator {
      display: none !important;
    }
    .layout-main-container, .layout-content-wrapper, .layout-main {
      padding-top: 0 !important;
      margin-top: 0 !important;
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

    const result = await defaultAutomationService.triggerPortalDownload(sessionId, token);

    res.json({
      success: true,
      message: 'Examination result PDF downloaded and verified successfully.',
      fileName: result.fileName,
      size: result.size,
      downloadUrl: result.downloadUrl
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

    const filePath = session.downloadedFile.filePath;
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        error: { message: 'Downloaded file is no longer available.', code: 'FILE_EXPIRED' }
      });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${session.downloadedFile.fileName}"`);
    res.setHeader('Content-Length', session.downloadedFile.size);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
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

module.exports = router;
