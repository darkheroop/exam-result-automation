'use strict';

const xlsx = require('xlsx');
const { v4: uuidv4 } = require('uuid');

const NAME_REGEX = /^(student\s*name|candidate\s*name|full\s*name|student|candidate|name)$/i;
const ADMISSION_REGEX = /^(admission\s*(no\.?|num\.?|number)?|adm\.?\s*no\.?|roll\s*(no\.?|num\.?|number)?|reg\s*(no\.?|num\.?|number)?|registration\s*(no\.?|num\.?|number)?|student\s*id|enrollment\s*(no\.?|num\.?|number)?|adm_no|roll_no|reg_no)$/i;
const PHONE_REGEX = /^(phone\s*(no\.?|num\.?|number)?|mobile\s*(no\.?|num\.?|number)?|contact\s*(no\.?|num\.?|number)?|phone_number|mobile_number|contact_number|cell(\s*no\.?)?|whatsapp)$/i;
const SECTION_REGEX = /^(section|sec|class|batch|branch)$/i;
const USERNAME_REGEX = /^(user\s*name|username|login\s*id|user\s*id|user)$/i;
const PASSWORD_REGEX = /^(password|pwd|pass)$/i;

const INLINE_SECTION_REGEX = /^\s*(?:section|sec|class|batch)\s*[:\-]?\s*([a-z0-9\-_ ]+)/i;

/**
 * Cleans string and numeric values from Excel cells, retaining leading zeros
 * and avoiding scientific notation or floating point trailing '.0'.
 */
function cleanStringValue(val) {
  if (val === null || val === undefined) return '';
  let str = String(val).trim();
  if (!str) return '';

  // Handle scientific notation e.g. 1.23456789e9
  if (/^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(str)) {
    try {
      const num = Number(str);
      if (!isNaN(num) && Number.isSafeInteger(num)) {
        str = BigInt(Math.round(num)).toString();
      }
    } catch (e) {
      // Ignore conversion fallback to original
    }
  }

  // Remove trailing .0 from Excel integer representations
  if (/^\d+\.0+$/.test(str)) {
    str = str.replace(/\.0+$/, '');
  }

  return str;
}

/**
 * Parses an Excel file buffer into structured student records.
 */
function parseExcelBuffer(buffer, filename = 'upload.xlsx') {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('Invalid Excel file buffer provided');
  }

  const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true, raw: false });
  const sheetNames = workbook.SheetNames || [];

  if (sheetNames.length === 0) {
    throw new Error('Excel workbook contains no sheets');
  }

  const validRecords = [];
  const missingAdmissionRecords = [];
  const duplicateWithinFile = [];
  const warnings = [];
  const sectionsFoundSet = new Set();
  const seenAdmissionNumbers = new Map(); // adm -> { row, sheet, name }

  let totalRawRowsCount = 0;

  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    // Convert sheet to array of arrays
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!rows || rows.length === 0) continue;

    // Detect if sheet name itself indicates a section
    let sheetDefaultSection = '';
    const cleanSheetName = sheetName.trim();
    if (sheetNames.length > 1 || /^(?:section|sec|batch|class|[a-z0-9]+-[0-9]+|[a-z0-9]+-[a-z])/i.test(cleanSheetName)) {
      sheetDefaultSection = cleanSheetName;
      sectionsFoundSet.add(sheetDefaultSection);
    }

    let currentSection = sheetDefaultSection;
    let colMap = null;

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx];
      if (!Array.isArray(row)) continue;

      // Filter non-empty cells
      const nonEmpties = row.map(cell => cleanStringValue(cell)).filter(Boolean);
      if (nonEmpties.length === 0) continue; // Skip blank rows

      totalRawRowsCount++;

      // Check for inline section markers (e.g. cell containing "Section: A" or "Section - CSE-1")
      if (nonEmpties.length <= 3) {
        const firstCell = nonEmpties[0];
        const match = firstCell.match(INLINE_SECTION_REGEX);
        if (match && match[1]) {
          currentSection = match[1].trim();
          sectionsFoundSet.add(currentSection);
          // Reset colMap for new section table if needed
          colMap = null;
          continue;
        }
      }

      // Check if this row is a header row
      let detectedAdmCol = -1;
      let detectedNameCol = -1;
      let detectedPhoneCol = -1;
      let detectedSecCol = -1;
      let detectedUserCol = -1;
      let detectedPassCol = -1;

      for (let c = 0; c < row.length; c++) {
        const cell = cleanStringValue(row[c]).toLowerCase();
        if (!cell) continue;

        if (detectedAdmCol === -1 && ADMISSION_REGEX.test(cell)) detectedAdmCol = c;
        else if (detectedNameCol === -1 && NAME_REGEX.test(cell)) detectedNameCol = c;
        else if (detectedPhoneCol === -1 && PHONE_REGEX.test(cell)) detectedPhoneCol = c;
        else if (detectedSecCol === -1 && SECTION_REGEX.test(cell)) detectedSecCol = c;
        else if (detectedUserCol === -1 && USERNAME_REGEX.test(cell)) detectedUserCol = c;
        else if (detectedPassCol === -1 && PASSWORD_REGEX.test(cell)) detectedPassCol = c;
      }

      if (detectedAdmCol !== -1 || (detectedNameCol !== -1 && detectedPhoneCol !== -1)) {
        colMap = {
          adm: detectedAdmCol,
          name: detectedNameCol,
          phone: detectedPhoneCol,
          section: detectedSecCol,
          username: detectedUserCol,
          password: detectedPassCol
        };
        continue; // Header row consumed
      }

      // If no header found yet, skip decorative banner or title rows
      if (!colMap) {
        continue;
      }

      // Process student data row
      const rawAdm = colMap.adm >= 0 ? row[colMap.adm] : '';
      const rawName = colMap.name >= 0 ? row[colMap.name] : '';
      const rawPhone = colMap.phone >= 0 ? row[colMap.phone] : '';
      const rawSec = colMap.section >= 0 ? row[colMap.section] : '';
      const rawUser = colMap.username >= 0 ? row[colMap.username] : '';
      const rawPass = colMap.password >= 0 ? row[colMap.password] : '';

      const admStr = cleanStringValue(rawAdm);
      const nameStr = cleanStringValue(rawName);
      const phoneStr = cleanStringValue(rawPhone);
      const userStr = cleanStringValue(rawUser);
      const passStr = cleanStringValue(rawPass);

      // Determine section for this row
      let recordSection = cleanStringValue(rawSec) || currentSection || sheetDefaultSection || 'Default';
      sectionsFoundSet.add(recordSection);

      // Skip repeated header rows in data
      if (NAME_REGEX.test(nameStr.toLowerCase()) && ADMISSION_REGEX.test(admStr.toLowerCase())) {
        continue;
      }

      // Flag records missing admission number
      if (!admStr) {
        if (nameStr || phoneStr) {
          missingAdmissionRecords.push({
            sheet: sheetName,
            row: rIdx + 1,
            name: nameStr,
            phone_number: phoneStr,
            section: recordSection,
            reason: 'Missing admission number'
          });
          warnings.push(`Row ${rIdx + 1} in sheet '${sheetName}' skipped: student '${nameStr || 'Unknown'}' is missing an admission number.`);
        }
        continue;
      }

      // Check duplicates within the file
      if (seenAdmissionNumbers.has(admStr)) {
        const previous = seenAdmissionNumbers.get(admStr);
        duplicateWithinFile.push({
          admission_number: admStr,
          name: nameStr,
          section: recordSection,
          sheet: sheetName,
          row: rIdx + 1,
          previousSheet: previous.sheet,
          previousRow: previous.row
        });
        warnings.push(`Duplicate admission number '${admStr}' detected in file at sheet '${sheetName}', row ${rIdx + 1} (first seen on row ${previous.row}).`);
      } else {
        seenAdmissionNumbers.set(admStr, {
          row: rIdx + 1,
          sheet: sheetName,
          name: nameStr
        });
      }

      validRecords.push({
        name: nameStr || 'STUDENT',
        admission_number: admStr,
        phone_number: phoneStr,
        section: recordSection,
        username: userStr,
        password: passStr
      });
    }
  }

  const sectionsFound = Array.from(sectionsFoundSet).filter(Boolean);

  return {
    filename,
    sectionsFound,
    totalRecords: totalRawRowsCount,
    validRecords,
    missingAdmissionRecords,
    duplicateWithinFile,
    warnings,
    sample: validRecords.slice(0, 20)
  };
}

class ExcelImportService {
  constructor() {
    // In-memory preview cache: token -> { data, expiresAt }
    this.previewCache = new Map();
    this.previewTtlMs = 15 * 60 * 1000; // 15 minutes TTL
  }

  /**
   * Parses an Excel buffer.
   */
  parseExcelBuffer(buffer, filename) {
    return parseExcelBuffer(buffer, filename);
  }

  /**
   * Stores parsed preview data in cache and returns a previewToken.
   */
  storePreview(parsedData) {
    this._cleanExpiredPreviews();
    const token = uuidv4();
    this.previewCache.set(token, {
      data: parsedData,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.previewTtlMs
    });
    return token;
  }

  /**
   * Retrieves parsed preview data by token.
   */
  getPreview(token) {
    if (!token) return null;
    this._cleanExpiredPreviews();
    const entry = this.previewCache.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.previewCache.delete(token);
      return null;
    }
    return entry.data;
  }

  /**
   * Clears a preview session from cache.
   */
  clearPreview(token) {
    if (!token) return false;
    return this.previewCache.delete(token);
  }

  /**
   * Internal cleaner for expired preview sessions.
   */
  _cleanExpiredPreviews() {
    const now = Date.now();
    for (const [token, entry] of this.previewCache.entries()) {
      if (entry.expiresAt <= now) {
        this.previewCache.delete(token);
      }
    }
  }
}

const defaultExcelImportService = new ExcelImportService();

module.exports = {
  ExcelImportService,
  defaultExcelImportService,
  parseExcelBuffer,
  cleanStringValue
};
