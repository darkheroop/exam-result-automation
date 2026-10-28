'use strict';

const app = require('./src/app');
const config = require('./src/config');
const { defaultSessionManager } = require('./src/services/sessionManager');
const { defaultBrowserPool } = require('./src/services/browserPool');

const port = parseInt(process.env.WORKER_PORT, 10) || parseInt(process.env.PORT, 10) || 5055;

console.log('================================================================');
console.log('Starting Persistent Browser Automation Worker Service...');
console.log(`Port: ${port}`);
console.log(`Min Browsers: ${config.browserPoolMinBrowsers}, Max: ${config.browserPoolMaxBrowsers}`);
console.log('================================================================');

// Pre-warm the configured browser pool on worker startup
defaultBrowserPool.preWarm().then(() => {
  console.log('[Worker] Browser pool pre-warming completed. Ready to process searches.');
}).catch((err) => {
  console.warn('[Worker] Initial browser pre-warm notice:', err.message);
});

const server = app.listen(port, () => {
  console.log(`Persistent Worker listening on http://127.0.0.1:${port}`);
  console.log('Ready for forwarded requests from Vercel or direct client searches.');
});

// Graceful Shutdown
async function gracefulShutdown(signal) {
  console.log(`\n[Worker] Received ${signal}. Shutting down worker gracefully...`);
  server.close(async () => {
    console.log('[Worker] HTTP server closed. Draining browser pool...');
    await defaultBrowserPool.closeAll().catch(() => {});
    await defaultSessionManager.cleanupExpired().catch(() => {});
    console.log('[Worker] Cleanup completed. Exiting.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
