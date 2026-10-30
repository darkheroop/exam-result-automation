'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const xlsx = require('xlsx');
const {
  ExcelImportService,
  parseExcelBuffer,
  cleanStringValue
} = require('../src/services/excelImportService');

test('ExcelImport - cleanStringValue preserves leading zeros and cleans numeric floats', () => {
  assert.equal(cleanStringValue('0012345'), '0012345');
  assert.equal(cleanStringValue('09876543210'), '09876543210');
  assert.equal(cleanStringValue('12345.0'), '12345');
  assert.equal(cleanStringValue('  spaced  '), 'spaced');
  assert.equal(cleanStringValue(null), '');
  assert.equal(cleanStringValue(undefined), '');
});

test('ExcelImport - parses multi-sheet workbooks with leading zeros and section attribution', () => {
  const wb = xlsx.utils.book_new();

  // Sheet 1: Section A
  const data1 = [
    ['Candidate Name', 'Enrollment No', 'Mobile No'],
    ['Aryan Sharma', '0001', '09999999991'],
    ['Bhavna Verma', '0002', '09999999992']
  ];
  const ws1 = xlsx.utils.aoa_to_sheet(data1);
  xlsx.utils.book_append_sheet(wb, ws1, 'Section A');

  // Sheet 2: Section B
  const data2 = [
    ['Full Name', 'Admission No', 'Phone'],
    ['Chetan Patel', '0003', '09999999993'],
    ['Deepa Singh', '0004', '09999999994']
  ];
  const ws2 = xlsx.utils.aoa_to_sheet(data2);
  xlsx.utils.book_append_sheet(wb, ws2, 'Section B');

  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const result = parseExcelBuffer(buffer, 'multi_section.xlsx');

  assert.equal(result.sectionsFound.length, 2);
  assert.ok(result.sectionsFound.includes('Section A'));
  assert.ok(result.sectionsFound.includes('Section B'));
  assert.equal(result.validRecords.length, 4);

  // Check leading zeros preserved
  assert.equal(result.validRecords[0].admission_number, '0001');
  assert.equal(result.validRecords[0].phone_number, '09999999991');
  assert.equal(result.validRecords[0].section, 'Section A');

  assert.equal(result.validRecords[2].admission_number, '0003');
  assert.equal(result.validRecords[2].section, 'Section B');
});

test('ExcelImport - handles inline section markers, missing admission numbers, and duplicate detection', () => {
  const wb = xlsx.utils.book_new();

  const sheetData = [
    ['Section: Batch-Alpha'],
    ['Student Name', 'Admission Number', 'Contact Number'],
    ['Student Alpha One', '101', '9111111111'],
    ['Student Alpha Two (Duplicate)', '101', '9222222222'], // duplicate in file
    ['Student Missing Adm', '', '9333333333'], // missing admission number
    ['Section: Batch-Beta'],
    ['Student Name', 'Admission Number', 'Contact Number'],
    ['Student Beta One', '102', '9444444444']
  ];

  const ws = xlsx.utils.aoa_to_sheet(sheetData);
  xlsx.utils.book_append_sheet(wb, ws, 'AllBatches');

  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const result = parseExcelBuffer(buffer, 'inline_sections.xlsx');

  assert.ok(result.sectionsFound.includes('Batch-Alpha'));
  assert.ok(result.sectionsFound.includes('Batch-Beta'));

  // Duplicate detection
  assert.equal(result.duplicateWithinFile.length, 1);
  assert.equal(result.duplicateWithinFile[0].admission_number, '101');

  // Missing admission detection
  assert.equal(result.missingAdmissionRecords.length, 1);
  assert.equal(result.missingAdmissionRecords[0].name, 'Student Missing Adm');

  // Valid records
  assert.equal(result.validRecords.length, 3);
  assert.equal(result.validRecords[0].section, 'Batch-Alpha');
  assert.equal(result.validRecords[2].section, 'Batch-Beta');
});

test('ExcelImport - Preview cache lifecycle with storePreview, getPreview, clearPreview', () => {
  const service = new ExcelImportService();

  const mockParsed = {
    filename: 'test.xlsx',
    validRecords: [{ name: 'Test Student', admission_number: 'ADM999' }],
    sectionsFound: ['Sec-1']
  };

  const previewToken = service.storePreview(mockParsed);
  assert.ok(previewToken);
  assert.equal(typeof previewToken, 'string');

  const retrieved = service.getPreview(previewToken);
  assert.deepEqual(retrieved, mockParsed);

  const cleared = service.clearPreview(previewToken);
  assert.equal(cleared, true);

  const retrievedAfter = service.getPreview(previewToken);
  assert.equal(retrievedAfter, null);
});
