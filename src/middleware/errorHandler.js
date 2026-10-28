'use strict';

function errorHandler(err, req, res, next) {
  // Extract status code
  const statusCode = err.statusCode || (err.status >= 400 && err.status < 600 ? err.status : 500);
  const code = err.code || (statusCode === 400 ? 'INVALID_INPUT' : 'INTERNAL_SERVER_ERROR');

  // Operational error sanitization (never leak credentials, internals, or stack traces)
  let publicMessage = err.message || 'An unexpected error occurred.';
  if (statusCode === 500 && process.env.NODE_ENV === 'production') {
    publicMessage = 'An internal system error occurred. Please try again later.';
  }

  // Prevent caching of error responses
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  res.status(statusCode).json({
    success: false,
    error: {
      message: publicMessage,
      code
    }
  });
}

module.exports = {
  errorHandler
};
