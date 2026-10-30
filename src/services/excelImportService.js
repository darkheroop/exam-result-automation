'use strict';

const xlsx = require('xlsx');
const { v4: uuidv4 } = require('uuid');

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
 * Matches a header cell string against recognized column roles.
 * Priority order:
 *  1. Admission number (explicit admission > enrollment/reg > roll)
 *  2. Name
 *  3. Phone/Mobile
 *  4. Section
 *  5. Roll number (fallback if no admission column)
 *  6. Username
 *  7. Password
 */
function matchHeaderColumn(headerCell) {
  if (!headerCell || typeof headerCell !== 'string') return null;
  const h = headerCell
    .toLowerCase()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.:\-_]+$/, '')
    .trim();

  if (!h) return null;

  // 1. Admission number takes highest priority
  if (/(?:^|\b)(?:admission|adm)(?:\s*(?:no|num|number))?(?:$|\b)/i.test(h) ||
      /^(?:admission_no|adm_no|admission_number|enrollment(?:\s*(?:no|num|number))?)$/i.test(h)) {
    return 'adm';
  }

  // 2. Student Name
  if (/(?:student\s*name|candidate\s*name|name\s*student|name\s*of\s*student|full\s*name|^name$)/i.test(h)) {
    return 'name';
  }

  // 3. Mobile / Phone
  if (/(?:student\s*mob|student\s*mobile|mob\s*no|mobile\s*no|^mob$|mobile|phone|contact|cell|whatsapp)/i.test(h)) {
    return 'phone';
  }

  // 4. Section
  if (/^(?:sec|sec\.|section|branch|class|batch)$/i.test(h)) {
    return 'section';
  }

  // 5. Roll number (lower priority admission identifier)
  if (/(?:roll\s*(?:no|num|number)|student\s*id|registration)/i.test(h) ||
      /^(?:roll_no|reg_no)$/i.test(h)) {
    return 'roll';
  }

  // 6. Username
  if (/^(?:user\s*name|username|login\s*id|user\s*id|user)$/i.test(h)) {
    return 'username';
  }

  // 7. Password
  if (/^(?:password|pwd|pass)$/i.test(h)) {
    return 'password';
  }

  return null;
}

/**
 * Extracts section identifier from table title banners like:
 * "Branch & Section  B.Tech.  (1st Sem) CSE - 11"
 * "Attendance Sheet of Session: ... CSE-12"
 * "Section: Batch-Alpha"
 */
function detectSectionFromTitle(cellText) {
  if (!cellText || typeof cellText !== 'string') return null;
  const text = cellText.replace(/\s+/g, ' ').trim();

  // Pattern: Branch & Section B.Tech. (1st Sem) CSE - 11 or Branch & Section : CSEDS-1
  const branchMatch = text.match(/(?:branch\s*&\s*section|branch|section)\s*[:\-]?\s*(?:b\.?tech\.?)?\s*(?:\([^)]*\))?\s*([a-z0-9\-_ ]+)/i);
  if (branchMatch && branchMatch[1]) {
    let sec = branchMatch[1].trim();
    // Normalize "CSE - 11" to "CSE-11"
    sec = sec.replace(/\s*-\s*/g, '-');
    if (sec.length >= 2 && !/^(name|faculty|date|total|sheet|session|semester)/i.test(sec)) {
      return sec;
    }
  }

  // Pattern: "Section: A" or "Sec - B"
  const secMatch = text.match(/^\s*(?:section|sec|class|batch)\s*[:\-]?\s*([a-z0-9\-_ ]+)/i);
  if (secMatch && secMatch[1]) {
    let sec = secMatch[1].trim().replace(/\s*-\s*/g, '-');
    if (sec.length >= 1) return sec;
  }

  return null;
}

/**
 * Parses an Excel buffer or workbook into structured student records.
 * Supports any workbook layout: multi-section attendance sheets, single consolidated sheets,
 * custom column orderings, inline sections, and missing headers via smart fallback scanning.
 */
function parseExcelBuffer(buffer, filename = 'upload.xlsx') {
  if (!buffer) {
    throw new Error('No Excel buffer or data provided');
  }

  let rawBuffer = buffer;
  // Convert base64 string to buffer if string was supplied
  if (typeof buffer === 'string') {
    if (buffer.startsWith('data:')) {
      const commaIdx = buffer.indexOf(',');
      rawBuffer = Buffer.from(buffer.slice(commaIdx + 1), 'base64');
    } else {
      try {
        rawBuffer = Buffer.from(buffer, 'base64');
      } catch (e) {
        rawBuffer = Buffer.from(buffer, 'utf8');
      }
    }
  }

  const workbook = xlsx.read(rawBuffer, { type: 'buffer', cellDates: true, raw: false });
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

    // Convert sheet to array of rows
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!rows || rows.length === 0) continue;

    // Default section from sheet name if informative
    const cleanSheetName = sheetName.trim();
    let sheetDefaultSection = cleanSheetName;
    if (cleanSheetName && !/^(sheet\d+|total students\s*\d*)$/i.test(cleanSheetName)) {
      sectionsFoundSet.add(cleanSheetName);
    } else {
      sheetDefaultSection = 'Default';
    }

    let currentSection = sheetDefaultSection;
    let colMap = null;

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx];
      if (!Array.isArray(row)) continue;

      // Filter non-empty cell strings
      const nonEmpties = row.map(cleanStringValue).filter(Boolean);
      if (nonEmpties.length === 0) continue;

      totalRawRowsCount++;

      // 1. Check for title section marker in early non-empty cells
      for (const cell of nonEmpties.slice(0, 3)) {
        const detectedSec = detectSectionFromTitle(cell);
        if (detectedSec) {
          currentSection = detectedSec;
          sectionsFoundSet.add(currentSection);
          colMap = null; // reset column map for new section table
          break;
        }
      }

      // 2. Check if this row is a header row
      const tempMap = {};
      for (let c = 0; c < row.length; c++) {
        const role = matchHeaderColumn(cleanStringValue(row[c]));
        if (role && tempMap[role] === undefined) {
          tempMap[role] = c;
        }
      }

      // Prioritize explicit 'adm' column over 'roll' column
      const effectiveAdmCol = tempMap.adm !== undefined ? tempMap.adm : tempMap.roll;

      if (effectiveAdmCol !== undefined && (tempMap.name !== undefined || tempMap.phone !== undefined)) {
        colMap = {
          adm: effectiveAdmCol,
          name: tempMap.name !== undefined ? tempMap.name : -1,
          phone: tempMap.phone !== undefined ? tempMap.phone : -1,
          section: tempMap.section !== undefined ? tempMap.section : -1,
          username: tempMap.username !== undefined ? tempMap.username : -1,
          password: tempMap.password !== undefined ? tempMap.password : -1
        };
        continue; // Header row consumed
      }

      // If no valid column mapping established yet, skip non-data banner rows
      if (!colMap) {
        continue;
      }

      // Extract values according to mapped columns
      let rawAdm = colMap.adm >= 0 ? cleanStringValue(row[colMap.adm]) : '';
      let rawName = colMap.name >= 0 ? cleanStringValue(row[colMap.name]) : '';
      let rawPhone = colMap.phone >= 0 ? cleanStringValue(row[colMap.phone]) : '';
      let rawSec = colMap.section >= 0 ? cleanStringValue(row[colMap.section]) : '';
      let rawUser = colMap.username >= 0 ? cleanStringValue(row[colMap.username]) : '';
      let rawPass = colMap.password >= 0 ? cleanStringValue(row[colMap.password]) : '';

      // Skip repeated header rows
      if (matchHeaderColumn(rawName) === 'name' || matchHeaderColumn(rawAdm) === 'adm') {
        continue;
      }

      // Skip footer or summary rows (e.g. Total, HOD, Signature, Date)
      if (/^(total|hod|s\.?\s*no|faculty|subject|regular|lecture|attendance|sign)/i.test(rawName) ||
          /^(total|hod|s\.?\s*no)/i.test(rawAdm)) {
        continue;
      }

      // 3. Fallback Cell Scanner:
      // If admission number is missing from mapped column, scan the row for admission number patterns
      if (!rawAdm) {
        for (const cell of row) {
          const s = cleanStringValue(cell);
          if (/^202\d[A-Z0-9]{5,}$/i.test(s) || /^(?:201|202|203)\d{7,14}$/.test(s)) {
            rawAdm = s;
            break;
          }
        }
      }

      // If phone number is missing from mapped column, scan row for 10-digit mobile number
      if (!rawPhone) {
        for (const cell of row) {
          const s = cleanStringValue(cell);
          if (/^[6-9]\d{9}$/.test(s)) {
            rawPhone = s;
            break;
          }
        }
      }

      // If student name is missing and admission number exists, scan row for alphabetic name
      if (!rawName && rawAdm) {
        for (const cell of row) {
          const s = cleanStringValue(cell);
          if (s !== rawAdm && s !== rawPhone &&
              /^[a-zA-Z\s.]{3,50}$/.test(s) &&
              !/^(total|hod|s\.?\s*no|branch|sec|regular|group|absent|present)/i.test(s)) {
            rawName = s;
            break;
          }
        }
      }

      // Determine final section
      let recordSection = rawSec;
      // If rawSec is a group identifier like "G1" or "A1", or empty, prefer currentSection/sheetDefaultSection
      if (!recordSection || /^[a-z]\d+$/i.test(recordSection)) {
        recordSection = currentSection || sheetDefaultSection || 'Default';
      }
      sectionsFoundSet.add(recordSection);

      // Handle records completely missing admission numbers
      if (!rawAdm) {
        if (rawName || rawPhone) {
          missingAdmissionRecords.push({
            sheet: sheetName,
            row: rIdx + 1,
            name: rawName,
            phone_number: rawPhone,
            section: recordSection,
            reason: 'Missing admission number'
          });
          if (warnings.length < 50) {
            warnings.push(`Row ${rIdx + 1} in sheet '${sheetName}' skipped: student '${rawName || 'Unknown'}' is missing an admission number.`);
          }
        }
        continue;
      }

      // Duplicate detection within the file
      if (seenAdmissionNumbers.has(rawAdm)) {
        const previous = seenAdmissionNumbers.get(rawAdm);
        duplicateWithinFile.push({
          admission_number: rawAdm,
          name: rawName,
          section: recordSection,
          sheet: sheetName,
          row: rIdx + 1,
          previousSheet: previous.sheet,
          previousRow: previous.row
        });
        if (warnings.length < 50) {
          warnings.push(`Duplicate admission number '${rawAdm}' detected in file at sheet '${sheetName}', row ${rIdx + 1} (first seen on row ${previous.row}).`);
        }
      } else {
        seenAdmissionNumbers.set(rawAdm, {
          row: rIdx + 1,
          sheet: sheetName,
          name: rawName
        });
      }

      validRecords.push({
        name: rawName || 'STUDENT',
        admission_number: rawAdm,
        phone_number: rawPhone,
        section: recordSection,
        username: rawUser,
        password: rawPass
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
    sample: validRecords.slice(0, 25)
  };
}

class ExcelImportService {
  constructor() {
    // In-memory preview cache: token -> { data, expiresAt }
    this.previewCache = new Map();
    this.previewTtlMs = 15 * 60 * 1000; // 15 minutes TTL
  }

  /**
   * Parses an Excel buffer or base64 data.
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
  cleanStringValue,
  matchHeaderColumn,
  detectSectionFromTitle
};
