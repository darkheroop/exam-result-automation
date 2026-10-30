'use strict';

/**
 * Direct API Architecture BrowserPool Stub
 * All result retrievals now use pure HTTP direct portal APIs without Chromium overhead.
 */
class BrowserPool {
  constructor(options = {}) {
    this.pool = [];
  }

  async preWarm() {
    return true;
  }

  async acquireContext() {
    return {
      leaseId: 'direct-api-lease',
      context: null,
      page: null,
      release: async () => {}
    };
  }

  async closeAll() {
    return true;
  }

  getStats() {
    return {
      activeBrowsers: 0,
      activeContexts: 0,
      totalCapacity: 0,
      poolSize: 0,
      isDraining: false
    };
  }
}

const defaultBrowserPool = new BrowserPool();

module.exports = {
  BrowserPool,
  defaultBrowserPool
};
