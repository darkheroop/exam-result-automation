'use strict';

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { rateLimitMiddleware } = require('./middleware/rateLimiter');
const { errorHandler } = require('./middleware/errorHandler');
const automationRoutes = require('./routes/automationRoutes');
const adminRoutes = require('./routes/adminRoutes');
const { defaultDbService } = require('./services/dbService');

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
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-session-token', 'x-admin-token', 'Accept'],
}));

// Body Parsers (High capacity for Base64 Excel imports and JSON transfers)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// Health & Root API Check
app.get(['/api', '/api/health'], async (req, res) => {
  const dbHealth = await defaultDbService.getHealth();
  res.json({
    status: 'ok',
    service: 'exam-result-automation',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: dbHealth
  });
});

// Rate Limiter on API routes
app.use('/api', rateLimitMiddleware);

// API Routes
app.use('/api/automation', automationRoutes);
app.use('/api/admin', adminRoutes);

// Direct API Aliases
app.post('/api/result', (req, res, next) => {
  req.url = '/start';
  return automationRoutes(req, res, next);
});

// Dedicated Public Universal Student Search Aliases
app.get(['/api/students/search', '/api/public/students/search'], (req, res, next) => {
  req.url = '/students/search';
  return automationRoutes(req, res, next);
});

// Serve Frontend Static Assets
app.use(express.static(path.resolve(__dirname, '../public')));
app.use('/admin', express.static(path.resolve(__dirname, '../public/admin')));

// Admin Dashboard UI Routes
app.get('/admin/login', (req, res) => {
  const loginPath = path.resolve(__dirname, '../public/admin/login.html');
  if (fs.existsSync(loginPath)) {
    return res.sendFile(loginPath);
  }
  return res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

app.get(['/admin', '/admin/*'], (req, res) => {
  const adminIndexPath = path.resolve(__dirname, '../public/admin/index.html');
  if (fs.existsSync(adminIndexPath)) {
    return res.sendFile(adminIndexPath);
  }
  return res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

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
