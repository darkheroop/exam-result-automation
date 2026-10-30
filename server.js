'use strict';

const app = require('./src/app');
const config = require('./src/config');
const { defaultSessionManager } = require('./src/services/sessionManager');

const server = app.listen(config.port, () => {
  console.log(`================================================================`);
  console.log(`Examination Result Retrieval Platform`);
  console.log(`Server running on: http://127.0.0.1:${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Engine: High-Performance Direct Portal API Client`);
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
