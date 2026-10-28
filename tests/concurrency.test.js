'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { defaultAutomationService } = require('../src/services/automationService');
const { defaultCredentialService } = require('../src/services/credentialService');
const { defaultSessionManager } = require('../src/services/sessionManager');

// Helper to make HTTP JSON requests with connection pooling
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 150 });

function postJson(urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = JSON.stringify(body);
    const req = http.request(u, {
      method: 'POST',
      agent: httpAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Accept': 'application/json',
        ...headers
      }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        let json = null;
        try { if (raw) json = JSON.parse(raw); } catch {}
        resolve({ statusCode: res.statusCode, headers: res.headers, data: json, raw });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getJson(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request(u, {
      method: 'GET',
      agent: httpAgent,
      headers: {
        'Accept': 'application/json',
        ...headers
      }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        let json = null;
        try { if (raw) json = JSON.parse(raw); } catch {}
        resolve({ statusCode: res.statusCode, headers: res.headers, data: json, raw });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function calculatePercentiles(latencies) {
  if (latencies.length === 0) return { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
  const p50 = sorted[Math.floor(sorted.length * 0.50)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || max;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || max;
  return { min, max, mean, p50, p95, p99 };
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function runConcurrencyScenario(serverUrl, concurrencyLevel, startIdOffset) {
  console.log(`\n======================================================================`);
  console.log(`>>> STARTING LOAD TEST: ${concurrencyLevel} SIMULTANEOUS STUDENT SUBMISSIONS`);
  console.log(`======================================================================`);

  const initialCpu = process.cpuUsage();
  const initialMem = process.memoryUsage();
  let peakRss = initialMem.rss;
  let peakHeap = initialMem.heapUsed;

  const memTracker = setInterval(() => {
    const m = process.memoryUsage();
    if (m.rss > peakRss) peakRss = m.rss;
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
  }, 25);

  const students = [];
  for (let i = 0; i < concurrencyLevel; i++) {
    const num = String(startIdOffset + i).padStart(10, '0');
    students.push(num);
  }

  const startTime = Date.now();
  const acceptLatencies = [];
  const fullResolutionLatencies = [];

  // Step 1: Submit all N requests concurrently
  console.log(`Submitting ${concurrencyLevel} search requests in parallel...`);
  const submissionPromises = students.map(async (studentId) => {
    const reqStart = Date.now();
    const res = await postJson(`${serverUrl}/api/automation/start`, { studentNumber: studentId });
    const acceptTime = Date.now() - reqStart;
    acceptLatencies.push(acceptTime);

    assert.equal(res.statusCode, 202, `Expected 202 Accepted for student ${studentId}, got ${res.statusCode}: ${JSON.stringify(res.data || res.raw)}`);
    assert.ok(res.data?.success, `Response not successful: ${JSON.stringify(res.data)}`);
    assert.ok(res.data?.sessionId, `Missing sessionId for ${studentId}`);
    assert.ok(res.data?.sessionToken, `Missing sessionToken for ${studentId}`);

    return {
      studentId,
      sessionId: res.data.sessionId,
      sessionToken: res.data.sessionToken,
      initialStatus: res.data.status,
      queuePosition: res.data.queuePosition || 0,
      submittedAt: reqStart
    };
  });

  const sessionHandles = await Promise.all(submissionPromises);
  console.log(`All ${concurrencyLevel} requests accepted (HTTP 202) within ${Date.now() - startTime}ms.`);

  // Step 2: Concurrently poll all sessions until completion
  console.log(`Polling status of all ${concurrencyLevel} sessions concurrently...`);
  const resolutionPromises = sessionHandles.map(async (handle) => {
    const pollStart = Date.now();
    let completed = false;
    let finalData = null;
    let pollAttempts = 0;

    while (!completed && pollAttempts < 120) {
      pollAttempts++;
      const res = await getJson(`${serverUrl}/api/automation/status/${handle.sessionId}`, {
        'x-session-token': handle.sessionToken
      });

      assert.equal(res.statusCode, 200, `Expected 200 for status check of ${handle.sessionId}`);
      const st = res.data?.data;

      if (st && (st.status === 'ready' || st.status === 'download_ready' || st.status === 'error')) {
        completed = true;
        finalData = st;
        break;
      }
      await new Promise(r => setTimeout(r, 60));
    }

    assert.ok(completed, `Session ${handle.sessionId} for student ${handle.studentId} timed out waiting for status`);
    assert.equal(finalData.status, 'ready', `Session ${handle.sessionId} failed with status: ${finalData.status}`);
    
    // Step 3: Strict Data Isolation Check
    assert.equal(finalData.studentNumber, handle.studentId, `DATA LEAKAGE: Session requested student ${handle.studentId} but contains ${finalData.studentNumber}`);
    assert.ok(finalData.resultData, `Missing resultData for session ${handle.sessionId}`);
    assert.equal(finalData.resultData.student.studentNumber, handle.studentId, `DATA LEAKAGE: Marksheet studentNumber does not match`);
    assert.equal(finalData.resultData.student.name, `Test Student ${handle.studentId}`, `DATA LEAKAGE: Marksheet student name does not match`);

    const totalDuration = Date.now() - handle.submittedAt;
    fullResolutionLatencies.push(totalDuration);

    return {
      studentId: handle.studentId,
      sessionId: handle.sessionId,
      totalDuration,
      pollAttempts
    };
  });

  const completedSessions = await Promise.all(resolutionPromises);
  clearInterval(memTracker);

  const totalWallTime = Date.now() - startTime;
  const cpuDiff = process.cpuUsage(initialCpu);
  const finalMem = process.memoryUsage();

  const acceptStats = calculatePercentiles(acceptLatencies);
  const resolveStats = calculatePercentiles(fullResolutionLatencies);

  // Verification of Unique Sessions and Zero Overlap
  const uniqueSessionIds = new Set(completedSessions.map(s => s.sessionId));
  const uniqueStudentIds = new Set(completedSessions.map(s => s.studentId));
  assert.equal(uniqueSessionIds.size, concurrencyLevel, 'Session ID collision detected');
  assert.equal(uniqueStudentIds.size, concurrencyLevel, 'Student ID collision detected');

  const report = {
    concurrencyLevel,
    totalRequests: concurrencyLevel,
    successfulRequests: completedSessions.length,
    failedRequests: concurrencyLevel - completedSessions.length,
    successRate: `${((completedSessions.length / concurrencyLevel) * 100).toFixed(1)}%`,
    totalWallTimeMs: totalWallTime,
    throughputReqSec: ((concurrencyLevel / totalWallTime) * 1000).toFixed(2),
    acceptStats,
    resolveStats,
    cpuUserMs: Math.round(cpuDiff.user / 1000),
    cpuSystemMs: Math.round(cpuDiff.system / 1000),
    initialRss: formatBytes(initialMem.rss),
    peakRss: formatBytes(peakRss),
    initialHeap: formatBytes(initialMem.heapUsed),
    peakHeap: formatBytes(peakHeap),
    zeroLeakageVerified: true
  };

  console.log(`\n--- RESULTS FOR ${concurrencyLevel} CONCURRENT USERS ---`);
  console.log(`Success Rate:            ${report.successRate} (${report.successfulRequests}/${report.totalRequests})`);
  console.log(`Total Wall Clock Time:   ${report.totalWallTimeMs} ms`);
  console.log(`Throughput:              ${report.throughputReqSec} req/sec`);
  console.log(`API Accept Time (p50):   ${report.acceptStats.p50} ms`);
  console.log(`API Accept Time (p95):   ${report.acceptStats.p95} ms`);
  console.log(`Full Resolve Time (mean):${report.resolveStats.mean} ms`);
  console.log(`Full Resolve Time (p50): ${report.resolveStats.p50} ms`);
  console.log(`Full Resolve Time (p95): ${report.resolveStats.p95} ms`);
  console.log(`Full Resolve Time (max): ${report.resolveStats.max} ms`);
  console.log(`Peak RSS Memory:         ${report.peakRss}`);
  console.log(`Peak Heap Memory:        ${report.peakHeap}`);
  console.log(`CPU Time (User/Sys):     ${report.cpuUserMs}ms / ${report.cpuSystemMs}ms`);
  console.log(`Data Isolation:          PASS (Zero cross-session data leakage across ${uniqueSessionIds.size} sessions)`);

  return report;
}

async function runAllConcurrencyTests() {
  console.log('Starting local HTTP server for concurrency load testing...');
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  const serverUrl = `http://127.0.0.1:${port}`;
  console.log(`Server listening on ${serverUrl}`);

  // Enable mockMode on defaultAutomationService and defaultCredentialService for capacity testing
  defaultAutomationService.mockMode = true;
  defaultAutomationService.mockDelayMs = 20; // 20ms per stage, total ~100ms per simulated student workflow
  defaultCredentialService.mockMode = true;

  const results = [];

  try {
    // Scenario 1: 10 concurrent requests
    results.push(await runConcurrencyScenario(serverUrl, 10, 1000000001));

    // Scenario 2: 25 concurrent requests
    results.push(await runConcurrencyScenario(serverUrl, 25, 2000000001));

    // Scenario 3: 50 concurrent requests
    results.push(await runConcurrencyScenario(serverUrl, 50, 3000000001));

    // Scenario 4: 100 concurrent requests
    results.push(await runConcurrencyScenario(serverUrl, 100, 4000000001));

    console.log(`\n======================================================================`);
    console.log(`>>> COMPREHENSIVE CONCURRENCY TEST SUMMARY TABLE (10, 25, 50, 100 USERS)`);
    console.log(`======================================================================`);
    console.log(`| Level | Sent | Success | Success % | Wall Time | Throughput | Accept p95 | Resolve p50 | Resolve p95 | Peak RSS | Peak Heap | Leakage |`);
    console.log(`|-------|------|---------|-----------|-----------|------------|------------|-------------|-------------|----------|-----------|---------|`);
    for (const r of results) {
      console.log(`| ${String(r.concurrencyLevel).padEnd(5)} | ${String(r.totalRequests).padEnd(4)} | ${String(r.successfulRequests).padEnd(7)} | ${r.successRate.padEnd(9)} | ${(r.totalWallTimeMs + 'ms').padEnd(9)} | ${(r.throughputReqSec + ' r/s').padEnd(10)} | ${(r.acceptStats.p95 + 'ms').padEnd(10)} | ${(r.resolveStats.p50 + 'ms').padEnd(11)} | ${(r.resolveStats.p95 + 'ms').padEnd(11)} | ${r.peakRss.padEnd(8)} | ${r.peakHeap.padEnd(9)} | ZERO    |`);
    }
    console.log(`======================================================================\n`);

  } finally {
    // Reset service state
    defaultAutomationService.mockMode = false;
    defaultCredentialService.mockMode = false;
    server.close();
  }

  return results;
}

if (require.main === module) {
  runAllConcurrencyTests()
    .then(() => {
      console.log('All concurrency load testing scenarios PASSED successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Concurrency load test failed:', err);
      process.exit(1);
    });
}

module.exports = { runConcurrencyScenario, runAllConcurrencyTests };
