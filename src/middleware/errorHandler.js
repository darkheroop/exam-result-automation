'use strict';

function errorHandler(err, req, res, next) {
  
  const statusCode = err.statusCode || (err.status >= 400 && err.status < 600 ? err.status : 500);
  const code = err.code || (statusCode === 400 ? 'INVALID_INPUT' : 'INTERNAL_SERVER_ERROR');

  
  let publicMessage = err.message || 'An unexpected error occurred.';
  if (typeof publicMessage === 'string') {
    if (/^Student not found for identifier/i.test(publicMessage.trim())) {
      publicMessage = 'Given number is not a student number.\nTo get number search it below.';
    } else if (/^No authorized student record found for identifier/i.test(publicMessage.trim())) {
      publicMessage = 'The user has changed the password. An update will come to get the result.';
    }
  }
  if (statusCode === 500 && process.env.NODE_ENV === 'production') {
    publicMessage = 'An internal system error occurred. Please try again later.';
  }

  
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
