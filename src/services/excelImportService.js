'use strict';

const xlsx = require('xlsx');
const { v4: uuidv4 } = require('uuid');

 
function cleanStringValue(val) {
  if (val === null || val === undefined) return '';
  let str = String(val).trim();
  if (!str) return '';

  
  if (/^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(str)) {
    try {
      const num = Number(str);
      if (!isNaN(num) && Number.isSafeInteger(num)) {
        str = BigInt(Math.round(num)).toString();
      }
    } catch (e) {
      
    }
  }

  
  if (/^\d+\.0+$/.test(str)) {
    str = str.replace(/\.0+$/, '');
  }

  return str;
}

 
function matchHeaderColumn(headerCell) {
  if (!headerCell || typeof headerCell !== 'string') return null;
  const h = headerCell
    .toLowerCase()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.:\-_]+$/, '')
    .trim();

  if (!h) return null;

  
  if (/(?:^|\b)(?:admission|adm)(?:\s*(?:no|num|number))?(?:$|\b)/i.test(h) ||
      /^(?:admission_no|adm_no|admission_number|enrollment(?:\s*(?:no|num|number))?)$/i.test(h)) {
    return 'adm';
  }

  
  if (/(?:student\s*name|candidate\s*name|name\s*student|name\s*of\s*student|full\s*name|^name$)/i.test(h)) {
    return 'name';
  }

  
  if (/(?:student\s*mob|student\s*mobile|mob\s*no|mobile\s*no|^mob$|mobile|phone|contact|cell|whatsapp)/i.test(h)) {
    return 'phone';
  }

  
  if (/^(?:sec|sec\.|section|branch|class|batch)$/i.test(h)) {
    return 'section';
  }

  
  if (/(?:roll\s*(?:no|num|number)|student\s*id|registration)/i.test(h) ||
      /^(?:roll_no|reg_no)$/i.test(h)) {
    return 'roll';
  }

  
  if (/^(?:user\s*name|username|login\s*id|user\s*id|user)$/i.test(h)) {
    return 'username';
  }

  
  if (/^(?:password|pwd|pass)$/i.test(h)) {
    return 'password';
  }

  return null;
}

 
function detectSectionFromTitle(cellText) {
  if (!cellText || typeof cellText !== 'string') return null;
  const text = cellText.replace(/\s+/g, ' ').trim();

  
  const branchMatch = text.match(/(?:branch\s*&\s*section|branch|section)\s*[:\-]?\s*(?:b\.?tech\.?)?\s*(?:\([^)]*\))?\s*([a-z0-9\-_ ]+)/i);
  if (branchMatch && branchMatch[1]) {
    let sec = branchMatch[1].trim();
    
    sec = sec.replace(/\s*-\s*/g, '-');
    if (sec.length >= 2 && !/^(name|faculty|date|total|sheet|session|semester)/i.test(sec)) {
      return sec;
    }
  }

  
  const secMatch = text.match(/^\s*(?:section|sec|class|batch)\s*[:\-]?\s*([a-z0-9\-_ ]+)/i);
  if (secMatch && secMatch[1]) {
    let sec = secMatch[1].trim().replace(/\s*-\s*/g, '-');
    if (sec.length >= 1) return sec;
  }

  return null;
}

 
function parseExcelBuffer(buffer, filename = 'upload.xlsx') {
  if (!buffer) {
    throw new Error('No Excel buffer or data provided');
  }

  let rawBuffer = buffer;
  
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
  const seenAdmissionNumbers = new Map(); 

  let totalRawRowsCount = 0;

  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!rows || rows.length === 0) continue;

    
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

      
      const nonEmpties = row.map(cleanStringValue).filter(Boolean);
      if (nonEmpties.length === 0) continue;

      totalRawRowsCount++;

      
      for (const cell of nonEmpties.slice(0, 3)) {
        const detectedSec = detectSectionFromTitle(cell);
        if (detectedSec) {
          currentSection = detectedSec;
          sectionsFoundSet.add(currentSection);
          colMap = null; 
          break;
        }
      }

      
      const tempMap = {};
      for (let c = 0; c < row.length; c++) {
        const role = matchHeaderColumn(cleanStringValue(row[c]));
        if (role && tempMap[role] === undefined) {
          tempMap[role] = c;
        }
      }

      
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
        continue; 
      }

      
      if (!colMap) {
        continue;
      }

      
      let rawAdm = colMap.adm >= 0 ? cleanStringValue(row[colMap.adm]) : '';
      let rawName = colMap.name >= 0 ? cleanStringValue(row[colMap.name]) : '';
      let rawPhone = colMap.phone >= 0 ? cleanStringValue(row[colMap.phone]) : '';
      let rawSec = colMap.section >= 0 ? cleanStringValue(row[colMap.section]) : '';
      let rawUser = colMap.username >= 0 ? cleanStringValue(row[colMap.username]) : '';
      let rawPass = colMap.password >= 0 ? cleanStringValue(row[colMap.password]) : '';

      
      if (matchHeaderColumn(rawName) === 'name' || matchHeaderColumn(rawAdm) === 'adm') {
        continue;
      }

      
      if (/^(total|hod|s\.?\s*no|faculty|subject|regular|lecture|attendance|sign)/i.test(rawName) ||
          /^(total|hod|s\.?\s*no)/i.test(rawAdm)) {
        continue;
      }

      
      
      if (!rawAdm) {
        for (const cell of row) {
          const s = cleanStringValue(cell);
          if (/^202\d[A-Z0-9]{5,}$/i.test(s) || /^(?:201|202|203)\d{7,14}$/.test(s)) {
            rawAdm = s;
            break;
          }
        }
      }

      
      if (!rawPhone) {
        for (const cell of row) {
          const s = cleanStringValue(cell);
          if (/^[6-9]\d{9}$/.test(s)) {
            rawPhone = s;
            break;
          }
        }
      }

      
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

      
      let recordSection = rawSec;
      
      if (!recordSection || /^[a-z]\d+$/i.test(recordSection)) {
        recordSection = currentSection || sheetDefaultSection || 'Default';
      }
      sectionsFoundSet.add(recordSection);

      
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
        student_name: rawName || 'STUDENT',
        name: rawName || 'STUDENT',
        admission_number: rawAdm,
        phone_number: rawPhone,
        section: recordSection,
        username: null,
        password: null
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
    
    this.previewCache = new Map();
    this.previewTtlMs = 15 * 60 * 1000; 
  }

   
  parseExcelBuffer(buffer, filename) {
    return parseExcelBuffer(buffer, filename);
  }

   
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

   
  clearPreview(token) {
    if (!token) return false;
    return this.previewCache.delete(token);
  }

   
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
