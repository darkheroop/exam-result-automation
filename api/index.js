'use strict';

// Vercel Serverless Function entry point
const app = require('../src/app');

module.exports = (req, res) => {
  // If Vercel rewrote the path and stripped the '/api' prefix, restore it
  // so Express routes matching '/api/...' continue to match reliably.
  if (req.url && !req.url.startsWith('/api')) {
    req.url = `/api${req.url.startsWith('/') ? '' : '/'}${req.url}`;
  }
  return app(req, res);
};
