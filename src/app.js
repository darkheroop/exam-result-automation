'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
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

// Health Check
app.get('/api/health', (req, res) => {
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

// Serve Frontend Static Assets
app.use(express.static(path.resolve(__dirname, '../public')));

// Fallback to index.html for SPA client navigation
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

// Centralized Error Handler
app.use(errorHandler);

module.exports = app;
