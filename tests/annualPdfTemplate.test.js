'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('Annual PDF Template - renders official layout matching genuine portal specifications', () => {
  const appJsCode = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');

  // Set up mock DOM environment
  const mockContainer = {
    innerHTML: '',
    style: {}
  };

  const sandbox = {
    document: {
      getElementById: (id) => {
        if (id === 'officialReportCardPrintTemplate') return mockContainer;
        return { addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [], style: {}, classList: { add: () => {}, remove: () => {} } };
      },
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    window: {
      addEventListener: () => {}
    },
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  };

  vm.createContext(sandbox);

  // Extract buildReportCardPdfTemplate function definition from appJsCode
  const match = appJsCode.match(/function buildReportCardPdfTemplate\(result\) \{([\s\S]*?)\n  \}/);
  assert.ok(match, 'buildReportCardPdfTemplate must be found in app.js');

  const escapeHtmlMatch = appJsCode.match(/function escapeHtml\(str\) \{([\s\S]*?)\n  \}/);
  assert.ok(escapeHtmlMatch, 'escapeHtml must be found in app.js');

  const testRunnerScript = `
    ${escapeHtmlMatch[0]}
    let officialReportCardPrintTemplate = document.getElementById('officialReportCardPrintTemplate');
    ${match[0]}
    
    // Sample test data
    const mockData = {
      student: {
        fullName: 'ANSH SINGH',
        seatNo: '2503201000228',
        rollNo: '2503201000228',
        className: 'FY-B.Tech CSE (14)',
        academicYear: '2025',
        publishedOn: '15/06/2025',
        session: '2025-26 (REGULAR)',
        abcId: 'ABC-123456',
        semesters: '1, 2',
        status: 'PWG',
        ygpa: '7.18',
        creditsEarned: 46,
        marks: '1811/2400',
        cop: 'None'
      },
      semesters: [
        {
          semesterNumber: 1,
          title: 'Semester I',
          sgpa: '7.48',
          earnedMarks: 899,
          totalMarks: 1200,
          creditsEarned: 23,
          totalCredits: 23,
          status: 'PASS',
          subjects: [
            {
              code: '25AS101',
              name: 'APPLIED PHYSICS',
              type: 'THEORY',
              midTerm1: { obt: 8 },
              midTerm2: { obt: 11 },
              endTerm: { obt: 20 },
              external: { obt: 39 },
              internal: { obt: 26 },
              total: { obt: 65 },
              grade: 'B'
            },
            {
              code: '25AS151',
              name: 'PHYSICS LAB',
              type: 'LAB',
              external: { obt: 42 },
              internal: { obt: 45 },
              total: { obt: 87 },
              grade: 'A'
            }
          ]
        },
        {
          semesterNumber: 2,
          title: 'Semester II',
          sgpa: '6.87',
          earnedMarks: 912,
          totalMarks: 1200,
          creditsEarned: 23,
          totalCredits: 23,
          status: 'PWG',
          subjects: [
            {
              code: '25AS201',
              name: 'ENGINEERING CHEMISTRY',
              type: 'THEORY',
              midTerm1: { obt: 9 },
              midTerm2: { obt: 10 },
              endTerm: { obt: 18 },
              external: { obt: 37 },
              internal: { obt: 25 },
              total: { obt: 62 },
              grade: 'B'
            }
          ]
        }
      ]
    };

    buildReportCardPdfTemplate(mockData);
  `;

  vm.runInContext(testRunnerScript, sandbox);

  const html = mockContainer.innerHTML;
  assert.ok(html.length > 0, 'Rendered HTML must not be empty');

  // 1. Root structure and classes
  assert.ok(html.includes('class="annual-result-print-section"'), 'Must have annual-result-print-section');
  assert.ok(html.includes('class="annual-pdf-watermark"'), 'Must have annual-pdf-watermark');
  assert.ok(html.includes('src="/assets/images/ABES.png"'), 'Must contain ABES.png watermark');
  assert.ok(html.includes('class="annual-pdf-watermark-img"'), 'Must have annual-pdf-watermark-img class');
  assert.ok(html.includes('class="annual-result-content"'), 'Must have annual-result-content');
  assert.ok(html.includes('class="result-pdf-header-banner"'), 'Must have result-pdf-header-banner');
  assert.ok(html.includes('src="/assets/images/reportCardHeader_BG_1.jpeg"'), 'Must contain header banner image');

  // 2. Student information card
  assert.ok(html.includes('class="student-result-info-card"'), 'Must have student-result-info-card');
  assert.ok(html.includes('class="annual-info-grid-top"'), 'Must have annual-info-grid-top');
  assert.ok(html.includes('ANSH SINGH'), 'Must have student name');
  assert.ok(html.includes('2503201000228'), 'Must have seat number');
  assert.ok(html.includes('FY-B.Tech CSE (14)'), 'Must have class name');
  assert.ok(html.includes('2025'), 'Must have academic year');
  assert.ok(html.includes('15/06/2025'), 'Must have published on date');

  assert.ok(html.includes('class="annual-info-grid-bottom"'), 'Must have annual-info-grid-bottom');
  assert.ok(html.includes('2025-26 (REGULAR)'), 'Must have session');
  assert.ok(html.includes('ABC-123456'), 'Must have ABC ID');
  assert.ok(html.includes('1, 2'), 'Must have semesters');
  assert.ok(html.includes('PWG'), 'Must have status');
  assert.ok(html.includes('7.18'), 'Must have YGPA');
  assert.ok(html.includes('46'), 'Must have credits earned');
  assert.ok(html.includes('1811/2400'), 'Must have marks');
  assert.ok(html.includes('None'), 'Must have COP');

  // 3. Dual-semester grid
  assert.ok(html.includes('class="annual-semesters-grid"'), 'Must have annual-semesters-grid');
  assert.ok(html.includes('class="annual-sem-block"'), 'Must have annual-sem-block');
  assert.ok(html.includes('class="annual-sem-heading"'), 'Must have annual-sem-heading');
  assert.ok(html.includes('SEMESTER I'), 'Must have SEMESTER I heading');
  assert.ok(html.includes('SEMESTER II'), 'Must have SEMESTER II heading');

  // 4 Metric cards
  assert.ok(html.includes('class="annual-sem-summary-grid"'), 'Must have annual-sem-summary-grid');
  assert.ok(html.includes('pi pi-pencil'), 'Must have pi-pencil for SGPA');
  assert.ok(html.includes('pi pi-chart-bar'), 'Must have pi-chart-bar for Marks');
  assert.ok(html.includes('pi pi-verified'), 'Must have pi-verified for Credits');
  assert.ok(html.includes('pi pi-check-circle'), 'Must have pi-check-circle for Status');

  // Table
  assert.ok(html.includes('class="annual-sem-table-wrap"'), 'Must have annual-sem-table-wrap');
  assert.ok(html.includes('class="annual-sem-table"'), 'Must have annual-sem-table');
  assert.ok(html.includes('class="pdf-subject-stack"'), 'Must have pdf-subject-stack');
  assert.ok(html.includes('class="pdf-subject-name"'), 'Must have pdf-subject-name');
  assert.ok(html.includes('class="pdf-subject-meta"'), 'Must have pdf-subject-meta');
  assert.ok(html.includes('class="pdf-subject-code"'), 'Must have pdf-subject-code');
  assert.ok(html.includes('class="pdf-subject-chip theory"'), 'Must have pdf-subject-chip theory');
  assert.ok(html.includes('class="pdf-subject-chip lab"'), 'Must have pdf-subject-chip lab');

  // Padding rows
  assert.ok(html.includes('class="annual-sem-table-pad-row"'), 'Must have padding rows for equal height');

  // Summary row
  assert.ok(html.includes('class="annual-sem-table-summary-row"'), 'Must have annual-sem-table-summary-row');
  assert.ok(html.includes('Sem 1 Summary'), 'Must have Sem 1 Summary');
  assert.ok(html.includes('Sem 2 Summary'), 'Must have Sem 2 Summary');

  // 4. Disclaimer block
  assert.ok(html.includes('class="result-pdf-disclaimer-block"'), 'Must have result-pdf-disclaimer-block');
  assert.ok(html.includes('SGPA – Semester Grade Point Average, GP – Grade Points, CG – Credit × Grade Points, PCP – Promoted with Carry Paper(s), Grade Scale printed on ledger'), 'Must have abbreviations');
  assert.ok(html.includes('The College shall not be held responsible for any inadvertent errors or omissions in this statement.'), 'Must have disclaimer text');
});

test('Annual PDF Download Handler - configuration matches requirements', () => {
  const appJsCode = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');

  // Check 794px width
  assert.ok(appJsCode.includes("templateEl.style.width = '794px';"), 'Must set template width to 794px');

  // Check html2pdf options
  assert.ok(appJsCode.includes("filename: `${student.fullName || 'Student'} - Annual Result.pdf`") ||
            appJsCode.includes("filename: `${student.fullName || student.name || 'Student'} - Annual Result.pdf`"),
            'Must use correct filename format');
  assert.ok(appJsCode.includes("margin: [4, 4, 4, 4]"), 'Must use [4, 4, 4, 4] margin');
  assert.ok(appJsCode.includes("scale: 1.5"), 'Must use scale 1.5 in html2canvas options');
  assert.ok(appJsCode.includes("useCORS: true"), 'Must use useCORS true');
  assert.ok(appJsCode.includes("allowTaint: true"), 'Must use allowTaint true');
  assert.ok(appJsCode.includes("backgroundColor: '#ffffff'"), 'Must use backgroundColor #ffffff');
  assert.ok(appJsCode.includes("unit: 'mm', format: 'a4', orientation: 'portrait', compress: true"), 'Must configure jsPDF for a4 portrait with compress');
});
