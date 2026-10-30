'use strict';

const app = require('./src/app');
const { defaultSessionManager } = require('./src/services/sessionManager');

const port = parseInt(process.env.WORKER_PORT, 10) || parseInt(process.env.PORT, 10) || 5055;

console.log('================================================================');
console.log('Starting Persistent Result Automation Worker Service...');
console.log(`Port: ${port}`);
console.log('Engine: Direct Portal API Integration');
console.log('================================================================');

const server = app.listen(port, () => {
  console.log(`Persistent Worker listening on http://127.0.0.1:${port}`);
  console.log('Ready for forwarded requests from Vercel or direct client searches.');
});

// Graceful Shutdown
async function gracefulShutdown(signal) {
  console.log(`\n[Worker] Received ${signal}. Shutting down worker gracefully...`);
  server.close(async () => {
    console.log('[Worker] HTTP server closed. Cleaning up sessions...');
    await defaultSessionManager.cleanupExpired().catch(() => {});
    console.log('[Worker] Cleanup completed. Exiting.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
