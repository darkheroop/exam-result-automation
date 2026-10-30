'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Client PDF Removal - index.html has no PDF download button or template', () => {
  const htmlPath = path.resolve(__dirname, '../public/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  // Must not have PDF download button
  assert.equal(html.includes('id="downloadAnnualPdfBtn"'), false, 'index.html must not contain downloadAnnualPdfBtn');
  assert.equal(html.includes('btn-annual-pdf'), false, 'index.html must not contain btn-annual-pdf');
  assert.equal(html.includes('Annual PDF'), false, 'index.html must not contain Annual PDF button text');

  // Must not have hidden print template or html2pdf bundle
  assert.equal(html.includes('officialReportCardPrintTemplate'), false, 'index.html must not contain officialReportCardPrintTemplate');
  assert.equal(html.includes('html2pdf'), false, 'index.html must not load html2pdf library');

  // Must have official examination record badge
  assert.ok(html.includes('OFFICIAL EXAMINATION RECORD'), 'index.html must contain OFFICIAL EXAMINATION RECORD badge');
});

test('Client PDF Removal - app.js has no PDF download button handlers or template builder', () => {
  const appJsPath = path.resolve(__dirname, '../public/app.js');
  const code = fs.readFileSync(appJsPath, 'utf8');

  assert.equal(code.includes('downloadAnnualPdfBtn'), false, 'app.js must not contain downloadAnnualPdfBtn');
  assert.equal(code.includes('buildReportCardPdfTemplate'), false, 'app.js must not contain buildReportCardPdfTemplate');
  assert.equal(code.includes('officialReportCardPrintTemplate'), false, 'app.js must not contain officialReportCardPrintTemplate');
  assert.equal(code.includes('html2pdf'), false, 'app.js must not contain html2pdf calls');
});
