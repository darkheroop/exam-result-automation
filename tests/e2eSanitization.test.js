'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const adminDir = path.join(publicDir, 'admin');

const indexHtmlPath = path.join(publicDir, 'index.html');
const stylesCssPath = path.join(publicDir, 'styles.css');
const appJsPath = path.join(publicDir, 'app.js');
const loginHtmlPath = path.join(adminDir, 'login.html');
const adminIndexHtmlPath = path.join(adminDir, 'index.html');
const adminCssPath = path.join(adminDir, 'admin.css');
const adminJsPath = path.join(adminDir, 'admin.js');
const rootAdminCssPath = path.join(publicDir, 'admin.css');
const rootAdminJsPath = path.join(publicDir, 'admin.js');

const KNOWN_EXAMPLE_NUMBERS = [
  '8887416471',
  '9599099932',
  '9876543210',
  '0012345678',
  '1122334455',
  '1000000001'
];

const KNOWN_SAMPLE_IDENTIFIERS = [
  'Aryan Sharma',
  '2023CS042',
  'Ansh Singh',
  'Anuj Kumar'
];

const KNOWN_TEST_USERNAMES = [
  'ansh14',
  'aryan42'
];

function extractPlaceholders(htmlContent) {
  const matches = [];
  const regex = /placeholder\s*=\s*["']([^"']*)["']/gi;
  let m;
  while ((m = regex.exec(htmlContent)) !== null) {
    matches.push(m[1]);
  }
  return matches;
}

test('Sanitization [Tier 1] - HTML files exist in public and admin directories', () => {
  assert.ok(fs.existsSync(indexHtmlPath), 'public/index.html must exist');
  assert.ok(fs.existsSync(loginHtmlPath), 'public/admin/login.html must exist');
  assert.ok(fs.existsSync(adminIndexHtmlPath), 'public/admin/index.html must exist');
});

test('Sanitization [Tier 1] - Placeholders contain no example phone numbers across all HTML files', () => {
  const htmlFiles = [
    { name: 'public/index.html', content: fs.readFileSync(indexHtmlPath, 'utf8') },
    { name: 'public/admin/login.html', content: fs.readFileSync(loginHtmlPath, 'utf8') },
    { name: 'public/admin/index.html', content: fs.readFileSync(adminIndexHtmlPath, 'utf8') }
  ];

  for (const { name, content } of htmlFiles) {
    const placeholders = extractPlaceholders(content);
    for (const ph of placeholders) {
      for (const num of KNOWN_EXAMPLE_NUMBERS) {
        assert.ok(
          !ph.includes(num),
          `Placeholder "${ph}" in ${name} must not contain hardcoded example number "${num}"`
        );
      }
    }
  }
});

test('Sanitization [Tier 1] - Placeholders contain no sample student names or admission IDs', () => {
  const adminHtml = fs.readFileSync(adminIndexHtmlPath, 'utf8');
  const placeholders = extractPlaceholders(adminHtml);

  for (const ph of placeholders) {
    for (const sample of KNOWN_SAMPLE_IDENTIFIERS) {
      assert.ok(
        !ph.includes(sample),
        `Placeholder "${ph}" in public/admin/index.html must not contain sample identifier "${sample}"`
      );
    }
    for (const user of KNOWN_TEST_USERNAMES) {
      assert.ok(
        !ph.includes(user),
        `Placeholder "${ph}" in public/admin/index.html must not contain test username "${user}"`
      );
    }
  }
});

test('Sanitization [Tier 1] - Admin login username placeholder does not leak default superadmin name', () => {
  const loginHtml = fs.readFileSync(loginHtmlPath, 'utf8');
  const placeholders = extractPlaceholders(loginHtml);

  for (const ph of placeholders) {
    assert.ok(
      !ph.includes('inexpert_trifler'),
      `Login placeholder "${ph}" must not leak default admin username "inexpert_trifler"`
    );
  }
});

test('Sanitization [Tier 1] - Placeholders do not contain "e.g." or "example" guidance prompts', () => {
  const htmlFiles = [
    { name: 'public/index.html', content: fs.readFileSync(indexHtmlPath, 'utf8') },
    { name: 'public/admin/login.html', content: fs.readFileSync(loginHtmlPath, 'utf8') },
    { name: 'public/admin/index.html', content: fs.readFileSync(adminIndexHtmlPath, 'utf8') }
  ];

  for (const { name, content } of htmlFiles) {
    const placeholders = extractPlaceholders(content);
    for (const ph of placeholders) {
      assert.ok(
        !/\b(e\.g\.|example)\b/i.test(ph),
        `Placeholder "${ph}" in ${name} should not contain "e.g." or "example" phrasing`
      );
    }
  }
});

test('Sanitization [Tier 1] - Form hints and helper guidance removed from public search form', () => {
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

  assert.ok(
    !indexHtml.includes('class="form-hint"'),
    'public/index.html must not contain explanatory .form-hint element'
  );
  assert.ok(
    !indexHtml.includes('Leading zeros will be strictly preserved'),
    'public/index.html must not expose internal formatting rules in helper text'
  );
  assert.ok(
    !indexHtml.includes('results-hint-text'),
    'public/index.html must not contain results-hint-text helper guidance'
  );
});

test('Sanitization [Tier 1] - Privacy & Security Architecture notice card removed from public UI', () => {
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

  assert.ok(
    !indexHtml.includes('class="privacy-notice"'),
    'public/index.html must not contain .privacy-notice component'
  );
  assert.ok(
    !indexHtml.includes('Security & Privacy Architecture'),
    'public/index.html must not display "Security & Privacy Architecture" notice heading'
  );
  assert.ok(
    !indexHtml.includes('ephemeral, isolated server-side browser contexts'),
    'public/index.html must not disclose internal architecture mechanics'
  );
});

test('Sanitization [Tier 1] - Technology stack and Playwright mentions removed from footer', () => {
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

  assert.ok(
    !indexHtml.includes('Playwright'),
    'public/index.html footer must not mention "Playwright" automation engine'
  );
  assert.ok(
    !indexHtml.includes('Zero client-side credential storage'),
    'public/index.html footer must not expose credential storage architecture'
  );
});

test('Sanitization [Tier 2] - Progress card replaced by minimal loader without 7-step tracker', () => {
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

  // #progressCard must exist as anchor for app.js
  assert.ok(
    indexHtml.includes('id="progressCard"'),
    '#progressCard wrapper must be preserved for safe script execution'
  );

  // Must not expose multi-step elements
  assert.ok(
    !indexHtml.includes('class="workflow-steps"'),
    'public/index.html must not contain .workflow-steps multi-step container'
  );
  assert.ok(
    !indexHtml.includes('class="step-item'),
    'public/index.html must not contain .step-item elements'
  );
  assert.ok(
    !indexHtml.includes('data-step='),
    'public/index.html must not contain data-step attributes'
  );
  assert.ok(
    !indexHtml.includes('id="progressPercentBadge"'),
    'public/index.html must not expose progressPercentBadge step percentage indicator'
  );

  // Must not contain granular operational step labels
  const forbiddenStepLabels = [
    'Validating input',
    'Retrieving credentials',
    'Connecting to portal',
    'Authenticating',
    'Opening results',
    'Preparing marksheet',
    'Marksheet ready'
  ];
  for (const label of forbiddenStepLabels) {
    assert.ok(
      !indexHtml.includes(label),
      `public/index.html must not expose step message "${label}"`
    );
  }
});

test('Sanitization [Tier 3] - Admin styles and scripts remain 100% byte-for-byte identical with root mirrors', () => {
  const adminJs = fs.readFileSync(adminJsPath, 'utf8');
  const rootAdminJs = fs.readFileSync(rootAdminJsPath, 'utf8');
  assert.strictEqual(
    adminJs,
    rootAdminJs,
    'public/admin/admin.js and public/admin.js must remain 100% byte-for-byte identical'
  );

  const adminCss = fs.readFileSync(adminCssPath, 'utf8');
  const rootAdminCss = fs.readFileSync(rootAdminCssPath, 'utf8');
  assert.strictEqual(
    adminCss,
    rootAdminCss,
    'public/admin/admin.css and public/admin.css must remain 100% byte-for-byte identical'
  );
});

test('Sanitization [Tier 4] - Code comment stripping across frontend HTML, CSS, and JS files', () => {
  const htmlAndJsFiles = [indexHtmlPath, loginHtmlPath, adminIndexHtmlPath, appJsPath, adminJsPath, rootAdminJsPath];
  for (const f of htmlAndJsFiles) {
    const content = fs.readFileSync(f, 'utf8');
    const commentMatch = content.match(/<!--[\s\S]*?-->/g);
    assert.strictEqual(
      commentMatch,
      null,
      `File ${path.relative(rootDir, f)} must not contain HTML comments (found ${commentMatch ? commentMatch.length : 0})`
    );
  }

  const cssFiles = [stylesCssPath, adminCssPath];
  for (const f of cssFiles) {
    const content = fs.readFileSync(f, 'utf8');
    const cssCommentMatch = content.match(/\/\*[\s\S]*?\*\//g);
    assert.strictEqual(
      cssCommentMatch,
      null,
      `CSS file ${path.relative(rootDir, f)} must not contain block comments (found ${cssCommentMatch ? cssCommentMatch.length : 0})`
    );
  }
});

test('Sanitization [Tier 4] - Backend example data and secrets sanitized across core services', () => {
  const credServicePath = path.join(rootDir, 'src/services/credentialService.js');
  if (fs.existsSync(credServicePath)) {
    const credContent = fs.readFileSync(credServicePath, 'utf8');
    assert.ok(
      !credContent.includes("'8887416471':"),
      'src/services/credentialService.js must not contain hardcoded student number 8887416471 fallback'
    );
    assert.ok(
      !credContent.includes("'9919741137':"),
      'src/services/credentialService.js must not contain hardcoded student number 9919741137 fallback'
    );
  }

  const adminDbPath = path.join(rootDir, 'src/services/adminDbService.js');
  if (fs.existsSync(adminDbPath)) {
    const dbContent = fs.readFileSync(adminDbPath, 'utf8');
    assert.ok(
      !dbContent.includes('_seedMemoryStudents()'),
      'src/services/adminDbService.js must not invoke hardcoded seed method _seedMemoryStudents'
    );
  }
});
