'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { rateLimitMiddleware } = require('./middleware/rateLimiter');
const { errorHandler } = require('./middleware/errorHandler');
const automationRoutes = require('./routes/automationRoutes');

const app = express();

// Disable fingerprinting
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-session-token', 'Accept'],
}));

// Body Parser
app.use(express.json({ limit: '500kb' }));

// Health & Root API Check
app.get(['/api', '/api/health'], (req, res) => {
  res.json({
    status: 'ok',
    service: 'exam-result-automation',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Rate Limiter on API routes
app.use('/api', rateLimitMiddleware);

// API Routes
app.use('/api/automation', automationRoutes);

// Direct API Aliases
app.post('/api/result', (req, res, next) => {
  req.url = '/start';
  return automationRoutes(req, res, next);
});

app.post('/api/download-pdf', async (req, res, next) => {
  const { defaultAutomationService } = require('./services/automationService');
  const sessionId = req.body?.sessionId || req.query?.sessionId;
  const token = req.headers['x-session-token'] || req.body?.sessionToken || req.query?.token;
  if (!sessionId) {
    return res.status(400).json({ success: false, error: { message: 'Missing sessionId parameter.', code: 'MISSING_SESSION_ID' } });
  }
  try {
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

// Serve Frontend Static Assets
app.use(express.static(path.resolve(__dirname, '../public')));

// Fallback to index.html for SPA client navigation
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  const indexPath = path.resolve(__dirname, '../public/index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  res.status(200).send('Educational Examination Result Retrieval Platform');
});

// Centralized Error Handler
app.use(errorHandler);

module.exports = app;
