'use strict';

const app = require('./src/app');
const config = require('./src/config');
const { defaultSessionManager } = require('./src/services/sessionManager');

const server = app.listen(config.port, () => {
  console.log(`================================================================`);
  console.log(`Examination Result Retrieval & PDF Automation Platform`);
  console.log(`Server running on: http://127.0.0.1:${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Portal Login URL: ${config.portalLoginUrl}`);
  console.log(`Browser: ${config.chromePath ? 'System Chrome/Edge' : 'Playwright bundled'}`);
  console.log(`================================================================`);
});

// Graceful Shutdown
function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  server.close(async () => {
    console.log('HTTP server closed. Cleaning up automation sessions...');
    await defaultSessionManager.cleanupExpired();
    console.log('Cleanup completed. Exiting.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
