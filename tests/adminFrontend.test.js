'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const adminDir = path.resolve(__dirname, '../public/admin');
const loginHtmlPath = path.join(adminDir, 'login.html');
const indexHtmlPath = path.join(adminDir, 'index.html');
const adminCssPath = path.join(adminDir, 'admin.css');
const adminJsPath = path.join(adminDir, 'admin.js');

test('Admin Frontend - All required files exist in public/admin', () => {
  assert.ok(fs.existsSync(loginHtmlPath), 'login.html must exist in public/admin/');
  assert.ok(fs.existsSync(indexHtmlPath), 'index.html must exist in public/admin/');
  assert.ok(fs.existsSync(adminCssPath), 'admin.css must exist in public/admin/');
  assert.ok(fs.existsSync(adminJsPath), 'admin.js must exist in public/admin/');
});

test('Admin Frontend - login.html contains required portal elements and auth handling', () => {
  const content = fs.readFileSync(loginHtmlPath, 'utf8');

  // Title and branding
  assert.ok(content.includes('ABES Examination System'), 'Must contain institutional brand name');
  assert.ok(content.includes('Administrator Portal'), 'Must contain Administrator Portal label');

  // Form controls
  assert.ok(content.includes('id="admin-username"') || content.includes('name="username"'), 'Must have username input');
  assert.ok(content.includes('id="admin-password"') || content.includes('name="password"'), 'Must have password input');
  assert.ok(content.includes('toggle-password-btn') || content.includes('togglePassword'), 'Must have password visibility toggle');

  // Validation, errors, loading state
  assert.ok(content.includes('login-alert') || content.includes('role="alert"'), 'Must have error alert container');
  assert.ok(content.includes('spinner') || content.includes('Authenticating'), 'Must have loading state for submission');

  // Authentication API call & redirect
  assert.ok(content.includes('/api/admin/login'), 'Must call /api/admin/login endpoint');
  assert.ok(content.includes('/admin'), 'Must redirect to /admin on successful authentication');
  assert.ok(content.includes('admin_token'), 'Must store session token in local storage');
});

test('Admin Frontend - index.html contains complete dashboard layout and required views', () => {
  const content = fs.readFileSync(indexHtmlPath, 'utf8');

  // Sidebar navigation links
  assert.ok(content.includes('Dashboard Overview'), 'Must have Dashboard Overview nav item');
  assert.ok(content.includes('Student Management'), 'Must have Student Management nav item');
  assert.ok(content.includes('Excel Upload & Import') || content.includes('Excel Upload'), 'Must have Excel Upload nav item');
  assert.ok(content.includes('Universal Search'), 'Must have Universal Search nav item');
  assert.ok(content.includes('Sign Out') || content.includes('Logout'), 'Must have Logout item');

  // Top header elements
  assert.ok(content.includes('btn-sidebar-toggle'), 'Must have mobile hamburger toggle button');
  assert.ok(content.includes('inexpert_trifler'), 'Must display administrator username inexpert_trifler');
  assert.ok(content.includes('btn-quick-logout') || content.includes('Sign Out'), 'Must have quick logout button');

  // View 1: Dashboard Overview
  assert.ok(content.includes('id="view-overview"'), 'Must have overview view container');
  assert.ok(content.includes('Total Students'), 'Must have Total Students metric card');
  assert.ok(content.includes('Total Sections'), 'Must have Total Sections metric card');
  assert.ok(content.includes('With Usernames') || content.includes('With Passwords'), 'Must have credential metrics');
  assert.ok(content.includes('Enrollment by Section') || content.includes('section-chips'), 'Must have section breakdown component');
  assert.ok(content.includes('Recently Added Students'), 'Must have recently added table');
  assert.ok(content.includes('Recently Updated Students'), 'Must have recently updated table');

  // View 2: Student Management
  assert.ok(content.includes('id="view-students"'), 'Must have student management view');
  assert.ok(content.includes('student-search-input'), 'Must have search input');
  assert.ok(content.includes('student-section-filter'), 'Must have section filter');
  assert.ok(content.includes('students-table'), 'Must have student management table');
  assert.ok(content.includes('Pagination') || content.includes('pagination-bar'), 'Must have pagination controls');
  assert.ok(content.includes('students-empty-state'), 'Must have empty state element');

  // 7 Table Columns check
  assert.ok(content.includes('Name'), 'Must have Name column');
  assert.ok(content.includes('Admission Number'), 'Must have Admission Number column');
  assert.ok(content.includes('Phone Number'), 'Must have Phone Number column');
  assert.ok(content.includes('Username'), 'Must have Username column');
  assert.ok(content.includes('Password'), 'Must have Password column');
  assert.ok(content.includes('Section'), 'Must have Section column');
  assert.ok(content.includes('Actions'), 'Must have Actions column');

  // View 3: Excel Upload & Import
  assert.ok(content.includes('id="view-upload"'), 'Must have excel upload view');
  assert.ok(content.includes('excel-dropzone'), 'Must have drag & drop dropzone');
  assert.ok(content.includes('.xlsx') && content.includes('.xls'), 'Must declare accepted Excel formats');
  assert.ok(content.includes('import-preview-box'), 'Must have import preview box');
  assert.ok(content.includes('btn-confirm-import'), 'Must have confirm import button');
  assert.ok(content.includes('import-result-card'), 'Must have import result summary card');

  // View 4: Universal Search
  assert.ok(content.includes('id="view-search"'), 'Must have universal search view');
  assert.ok(content.includes('universal-search-input'), 'Must have universal search input');
  assert.ok(content.includes('filter-chip-btn') || content.includes('filter-chips'), 'Must have search filter chips');
  assert.ok(content.includes('universal-results-tbody'), 'Must have universal search results table');

  // View 5: Search Logs
  assert.ok(content.includes('id="view-logs"'), 'Must have search logs view');
  assert.ok(content.includes('search-logs-table'), 'Must have search logs table');
  assert.ok(content.includes('log-result-filter'), 'Must have search logs result filter');
  assert.ok(content.includes('log-type-filter'), 'Must have search logs type filter');

  // Modals
  assert.ok(content.includes('modal-edit-student'), 'Must have Edit Student modal');
  assert.ok(content.includes('modal-delete-student'), 'Must have Delete Student modal');
  assert.ok(content.includes('modal-clear-logs'), 'Must have Clear Search Logs modal');

  // Toast Container
  assert.ok(content.includes('toast-container'), 'Must have toast notification container');
});

test('Admin Frontend - admin.css has complete design system and responsive styles', () => {
  const css = fs.readFileSync(adminCssPath, 'utf8');

  // Theme palettes: slate, indigo, emerald
  assert.ok(css.includes('--slate-900') || css.includes('#0f172a'), 'Must have slate color palette');
  assert.ok(css.includes('--indigo-600') || css.includes('#4f46e5'), 'Must have indigo brand palette');
  assert.ok(css.includes('--emerald-500') || css.includes('#10b981'), 'Must have emerald success palette');

  // Component classes
  assert.ok(css.includes('.metric-card'), 'Must style metric cards');
  assert.ok(css.includes('.section-chip'), 'Must style section chips');
  assert.ok(css.includes('.data-table'), 'Must style data tables');
  assert.ok(css.includes('.dropzone'), 'Must style dropzone');
  assert.ok(css.includes('.modal-backdrop'), 'Must style modals');
  assert.ok(css.includes('.toast'), 'Must style toast notifications');
  assert.ok(css.includes('.btn-eye-toggle'), 'Must style password eye toggle');

  // Responsive media queries
  assert.ok(css.includes('@media (max-width: 1024px)'), 'Must have tablet responsive breakpoint');
  assert.ok(css.includes('@media (max-width: 768px)'), 'Must have mobile responsive breakpoint');
});

test('Admin Frontend - admin.js implements complete SPA features and API endpoints', () => {
  const js = fs.readFileSync(adminJsPath, 'utf8');

  // Session guard and logout
  assert.ok(js.includes('/api/admin/me'), 'Must verify session via /api/admin/me');
  assert.ok(js.includes('/api/admin/logout'), 'Must handle logout via /api/admin/logout');
  assert.ok(js.includes('/admin/login'), 'Must redirect unauthenticated sessions to /admin/login');

  // Tab switching with URL hash
  assert.ok(js.includes('switchTab'), 'Must implement tab switching');
  assert.ok(js.includes('hashchange'), 'Must support URL hash navigation');

  // Dashboard stats
  assert.ok(js.includes('/api/admin/stats'), 'Must query /api/admin/stats');
  assert.ok(js.includes('renderDashboardStats'), 'Must render dashboard stats');

  // Student directory & pagination
  assert.ok(js.includes('/api/admin/students'), 'Must query /api/admin/students');
  assert.ok(js.includes('renderStudentsTable'), 'Must render responsive student table');
  assert.ok(js.includes('renderPaginationButtons'), 'Must generate pagination bar');

  // Password toggle
  assert.ok(js.includes('btn-eye-toggle'), 'Must handle password reveal/hide');

  // Modals operations
  assert.ok(js.includes('handleSaveStudentEdit'), 'Must handle student edit saving');
  assert.ok(js.includes('handleConfirmDeleteStudent'), 'Must handle student deletion');

  // Excel batch ingestion
  assert.ok(js.includes('/api/admin/upload-preview'), 'Must send file to upload-preview');
  assert.ok(js.includes('/api/admin/upload-confirm'), 'Must send confirmation to upload-confirm');
  assert.ok(js.includes('renderImportPreview'), 'Must render upload preview');

  // Universal search & toast
  assert.ok(js.includes('executeUniversalSearch'), 'Must implement universal search');
  assert.ok(js.includes('showToast'), 'Must provide toast notification helper');

  // Search Logs & credential retrieval
  assert.ok(js.includes('/api/admin/search-logs'), 'Must query /api/admin/search-logs');
  assert.ok(js.includes('loadSearchLogs'), 'Must implement loadSearchLogs');
  assert.ok(js.includes('/api/admin/search'), 'Must query /api/admin/search');

  // Filter chips support admissionNumber and phoneNumber
  assert.ok(js.includes('admissionNumber') && js.includes('phoneNumber'), 'Universal search must support camelCase filter keys');
});

test('Admin Frontend - admin.js is valid JavaScript without syntax errors', () => {
  const vm = require('vm');
  const js = fs.readFileSync(adminJsPath, 'utf8');
  assert.doesNotThrow(() => {
    new vm.Script(js);
  }, 'public/admin/admin.js must have valid syntax without errors');

  const rootAdminJs = path.resolve(__dirname, '../public/admin.js');
  if (fs.existsSync(rootAdminJs)) {
    const rootJs = fs.readFileSync(rootAdminJs, 'utf8');
    assert.doesNotThrow(() => {
      new vm.Script(rootJs);
    }, 'public/admin.js must have valid syntax without errors');
    assert.equal(rootJs, js, 'public/admin.js and public/admin/admin.js must be in exact sync');
  }
});

test('Admin Frontend - Integrity check: public/index.html and styles.css remain untouched', () => {
  const publicIndexPath = path.resolve(__dirname, '../public/index.html');
  const publicStylesPath = path.resolve(__dirname, '../public/styles.css');

  const indexContent = fs.readFileSync(publicIndexPath, 'utf8');
  const stylesContent = fs.readFileSync(publicStylesPath, 'utf8');

  // Verify student portal elements are intact
  assert.ok(indexContent.includes('studentNumberInput'), 'Student search input must be untouched');
  assert.ok(indexContent.includes('fetchResultBtn'), 'Fetch result button must be untouched');
  assert.ok(indexContent.includes('portal-marksheet-canvas') || indexContent.includes('marksheetCollegeTitle'), 'Marksheet section must be untouched');
  assert.ok(!indexContent.includes('btn-action-edit'), 'Student index.html should not have admin edits');

  // Verify styles.css does not have admin leak
  assert.ok(stylesContent.includes('.portal-marksheet-canvas') || stylesContent.includes('marksheet'), 'Public styles.css must be intact');
});
