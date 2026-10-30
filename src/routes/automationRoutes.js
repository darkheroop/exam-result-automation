'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const config = require('../config');
const { validateStudentNumber } = require('../services/credentialService');
const { defaultSessionManager } = require('../services/sessionManager');
const { defaultAutomationService } = require('../services/automationService');

const router = express.Router();

// Keep-alive agents for proxying to persistent worker
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
 * Starts the examination result retrieval workflow via direct portal API
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

    // Start workflow asynchronously
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

    // Direct API calls finish fast (typically 1-3s). Wait up to waitWindowMs so the response can return completed if ready.
    const isServerless = Boolean(
      process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_VERSION ||
      process.env.LAMBDA_TASK_ROOT
    );
    const waitWindowMs = isServerless ? (config.overallRequestTimeoutMs || 25000) : 3000;

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
 * Returns the current workflow progress and result data for a specific session
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
 * Serves the rendered examination result view
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

    if (!session.resultData && !session.renderedHtml) {
      return res.status(409).send('<h3>Examination results interface is still preparing. Please wait...</h3>');
    }

    let innerContent = session.renderedHtml || '';
    if (!innerContent && session.resultData) {
      const student = session.resultData.student || {};
      const semHtml = (session.resultData.semesters || []).map(sem => `
        <div style="margin-bottom: 2rem;">
          <h2 style="font-size: 1.25rem; font-weight: 700; color: #1e3a8a; border-bottom: 2px solid #e2e8f0; padding-bottom: 0.5rem;">${sem.title || sem.name} (SGPA: ${sem.sgpa || '—'}, Credits: ${sem.creditsEarned || '—'})</h2>
          <table style="width: 100%; border-collapse: collapse; margin-top: 0.75rem; font-size: 0.875rem;">
            <thead>
              <tr style="background: #f1f5f9; text-align: left;">
                <th style="padding: 8px; border: 1px solid #cbd5e1;">Code</th>
                <th style="padding: 8px; border: 1px solid #cbd5e1;">Subject Name</th>
                <th style="padding: 8px; border: 1px solid #cbd5e1;">Type</th>
                <th style="padding: 8px; border: 1px solid #cbd5e1; text-align: right;">Credits</th>
                <th style="padding: 8px; border: 1px solid #cbd5e1; text-align: right;">Marks</th>
                <th style="padding: 8px; border: 1px solid #cbd5e1; text-align: center;">Grade</th>
                <th style="padding: 8px; border: 1px solid #cbd5e1; text-align: center;">Result</th>
              </tr>
            </thead>
            <tbody>
              ${(sem.subjects || []).map(sub => `
                <tr>
                  <td style="padding: 8px; border: 1px solid #cbd5e1; font-weight: 600;">${sub.acadSubjectCode || sub.code || ''}</td>
                  <td style="padding: 8px; border: 1px solid #cbd5e1;">${sub.acadSubjectLngTitle || sub.name || ''}</td>
                  <td style="padding: 8px; border: 1px solid #cbd5e1;">${sub.subjectType || sub.type || ''}</td>
                  <td style="padding: 8px; border: 1px solid #cbd5e1; text-align: right;">${sub.creditEarnedToPrint !== undefined ? sub.creditEarnedToPrint : sub.credits}</td>
                  <td style="padding: 8px; border: 1px solid #cbd5e1; text-align: right;">${sub.obtResolutionGracesMarksToPrint !== undefined ? sub.obtResolutionGracesMarksToPrint : sub.total?.obt}/${sub.maxPointsToPrint !== undefined ? sub.maxPointsToPrint : sub.total?.max}</td>
                  <td style="padding: 8px; border: 1px solid #cbd5e1; text-align: center; font-weight: bold;">${sub.gradeLetterToPrint || sub.grade || ''}</td>
                  <td style="padding: 8px; border: 1px solid #cbd5e1; text-align: center; color: ${sub.result === 'FAIL' ? '#dc2626' : '#16a34a'}; font-weight: bold;">${sub.result || 'PASS'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `).join('');

      innerContent = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; color: #1e293b;">
          <div style="text-align: center; margin-bottom: 2rem; border-bottom: 2px solid #3b82f6; padding-bottom: 1rem;">
            <h1 style="font-size: 1.5rem; font-weight: 800; color: #0f172a; margin: 0;">ABES ENGINEERING COLLEGE</h1>
            <p style="margin: 0.25rem 0; font-size: 0.95rem; color: #64748b;">Annual Examination Result (Year 1)</p>
          </div>
          <div style="background: #f8fafc; border-radius: 8px; padding: 1.25rem; margin-bottom: 2rem; display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; font-size: 0.9rem;">
            <div><strong>Student Name:</strong> ${student.name || '—'}</div>
            <div><strong>Student ID / Roll No:</strong> ${student.studentNumber || student.rollNo || '—'}</div>
            <div><strong>Registration No:</strong> ${student.regnNo || student.seatNo || '—'}</div>
            <div><strong>Class / Branch:</strong> ${student.className || '—'}</div>
            <div><strong>Academic Year:</strong> ${student.academicYear || '—'}</div>
            <div><strong>Overall Status:</strong> <span style="font-weight: bold; color: ${student.status === 'FAIL' ? '#dc2626' : '#16a34a'};">${student.status || 'PASS'}</span></div>
            <div><strong>Overall YGPA:</strong> <span style="font-weight: bold; font-size: 1.05rem; color: #1d4ed8;">${student.ygpa || session.resultData.overallYgpa || '—'}</span></div>
            <div><strong>Total Credits Earned:</strong> ${student.creditsEarned || session.resultData.overallCreditsEarned || '—'}</div>
          </div>
          ${semHtml}
        </div>
      `;
    }

    const viewHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Examination Result</title>
  <style>
    html, body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #ffffff;
      color: #1e293b;
      margin: 0;
      padding: 1rem;
    }
  </style>
</head>
<body>
  <div class="result-embed-container">
    ${innerContent}
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
 * POST /api/automation/:sessionId/close
 * Cleans up session records
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
