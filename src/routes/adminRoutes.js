'use strict';

const express = require('express');
const path = require('path');
const multer = require('multer');
const { defaultAdminAuthService, requireAdminAuth } = require('../services/adminAuthService');
const { defaultAdminDbService } = require('../services/adminDbService');
const { defaultExcelImportService } = require('../services/excelImportService');
const { defaultAdminSearchService } = require('../services/adminSearchService');
const { generateStudentsExportWorkbook, getExportFilename } = require('../services/excelExportService');

const router = express.Router();


const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, 
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowedExts = new Set(['.xlsx', '.xlxs', '.xls', '.xlsm', '.xlsb', '.csv']);
    const mime = (file.mimetype || '').toLowerCase();
    const isExcelMime =
      mime.includes('spreadsheet') ||
      mime.includes('excel') ||
      mime.includes('csv') ||
      mime === 'application/octet-stream';

    if (allowedExts.has(ext) || isExcelMime) {
      return cb(null, true);
    }
    return cb(new Error('Invalid file format. Please upload an Excel workbook (.xlsx, .xlxs, .xls).'));
  }
});

 
function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false,
            error: {
              message: 'File size exceeds the 10MB maximum limit',
              code: 'FILE_TOO_LARGE'
            }
          });
        }
        return res.status(400).json({
          success: false,
          error: {
            message: `Upload error: ${err.message}`,
            code: 'UPLOAD_ERROR'
          }
        });
      }
      return res.status(400).json({
        success: false,
        error: {
          message: err.message,
          code: 'INVALID_FILE_TYPE'
        }
      });
    }
    next();
  });
}


const loginAttempts = new Map();
const accountLockouts = new Map();

 
function cleanExpiredRateLimits() {
  const now = Date.now();
  for (const [key, record] of loginAttempts.entries()) {
    if (record.resetTime && now > record.resetTime) {
      loginAttempts.delete(key);
    }
  }
  for (const [key, record] of accountLockouts.entries()) {
    if (record.lockoutUntil && now > record.lockoutUntil) {
      accountLockouts.delete(key);
    }
  }
}


const rateLimitPruneInterval = setInterval(cleanExpiredRateLimits, 60 * 1000);
if (rateLimitPruneInterval.unref) rateLimitPruneInterval.unref();

function loginRateLimiter(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxAttempts = 10;

  
  const record = loginAttempts.get(ip);
  if (record && now > record.resetTime) {
    loginAttempts.delete(ip);
  }

  
  const rawUsername = req.body?.username;
  if (typeof rawUsername === 'string' && rawUsername.trim()) {
    const targetUser = rawUsername.trim().toLowerCase();
    const acctRecord = accountLockouts.get(targetUser);
    if (acctRecord && acctRecord.lockoutUntil && acctRecord.lockoutUntil > now) {
      const retryAfter = Math.ceil((acctRecord.lockoutUntil - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        success: false,
        error: {
          message: 'Too many failed login attempts for this account. Please try again after 15 minutes.',
          code: 'RATE_LIMITED'
        }
      });
    }
  }

  const activeRecord = loginAttempts.get(ip);
  if (!activeRecord) {
    loginAttempts.set(ip, { count: 1, resetTime: now + windowMs });
    return next();
  }

  if (activeRecord.count >= maxAttempts) {
    const retryAfter = Math.ceil((activeRecord.resetTime - now) / 1000);
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({
      success: false,
      error: {
        message: 'Too many login attempts. Please try again after 1 minute.',
        code: 'RATE_LIMITED'
      }
    });
  }

  activeRecord.count++;
  return next();
}

 
router.post('/login', loginRateLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Both username and password are required',
          code: 'VALIDATION_ERROR'
        }
      });
    }

    const normalizedUser = String(username).trim().toLowerCase();
    const isValid = await defaultAdminAuthService.verifyCredentialsAsync(username, password);
    if (!isValid) {
      
      const now = Date.now();
      const acct = accountLockouts.get(normalizedUser) || { failedCount: 0, lockoutUntil: 0 };
      acct.failedCount = (acct.failedCount || 0) + 1;
      if (acct.failedCount >= 5) {
        acct.lockoutUntil = now + (15 * 60 * 1000);
      }
      accountLockouts.set(normalizedUser, acct);

      return res.status(401).json({
        success: false,
        error: {
          message: 'Invalid admin credentials',
          code: 'UNAUTHORIZED'
        }
      });
    }

    
    accountLockouts.delete(normalizedUser);

    const token = await defaultAdminAuthService.createSession(username);

    
    res.cookie('admin_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 2 * 60 * 60 * 1000,
      path: '/'
    });

    const responsePayload = {
      success: true,
      user: {
        username
      }
    };

    
    
    
    const isBrowser = req.headers['sec-fetch-mode'] || req.headers['sec-fetch-dest'] || req.headers['user-agent']?.includes('Mozilla');
    if (process.env.NODE_ENV !== 'production' && !isBrowser) {
      responsePayload.token = token;
    }

    return res.json(responsePayload);
  } catch (err) {
    return next(err);
  }
});

 
router.post('/logout', async (req, res, next) => {
  try {
    let token = null;
    if (req.cookies && req.cookies.admin_token) {
      token = req.cookies.admin_token;
    } else if (req.headers && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.slice(7).trim();
    } else if (req.headers && req.headers['x-admin-token']) {
      token = req.headers['x-admin-token'];
    } else if (req.body && req.body.token) {
      token = req.body.token;
    }

    if (token) {
      await defaultAdminAuthService.destroySession(token);
    }

    res.clearCookie('admin_token', { path: '/' });
    return res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (err) {
    return next(err);
  }
});

 
router.get('/me', requireAdminAuth, (req, res) => {
  return res.json({
    success: true,
    user: req.adminUser
  });
});

 
router.get('/stats', requireAdminAuth, async (req, res, next) => {
  try {
    const stats = await defaultAdminDbService.getDashboardStats();
    return res.json({
      success: true,
      stats
    });
  } catch (err) {
    return next(err);
  }
});

 
router.post('/search', requireAdminAuth, async (req, res, next) => {
  try {
    const { query, searchType } = req.body || {};
    const result = await defaultAdminSearchService.executeSearch({
      query,
      searchType
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

 
router.get('/search-logs', requireAdminAuth, async (req, res, next) => {
  try {
    const { page, limit, search, result, searchType, date } = req.query;
    const logsData = await defaultAdminDbService.listSearchLogs({
      page,
      limit,
      search,
      result,
      searchType,
      date
    });
    return res.json({
      success: true,
      ...logsData
    });
  } catch (err) {
    return next(err);
  }
});

 
router.get('/search-logs/stats', requireAdminAuth, async (req, res, next) => {
  try {
    const stats = await defaultAdminDbService.getSearchLogStats();
    return res.json({
      success: true,
      stats
    });
  } catch (err) {
    return next(err);
  }
});

 
router.delete('/search-logs', requireAdminAuth, async (req, res, next) => {
  try {
    await defaultAdminDbService.clearSearchLogs();
    return res.json({
      success: true,
      message: 'Search logs cleared successfully.'
    });
  } catch (err) {
    return next(err);
  }
});

 
router.get('/students', requireAdminAuth, async (req, res, next) => {
  try {
    const { page, limit, search, section, credential, sortBy, sortOrder, sort, filter } = req.query;

    let effSortBy = sortBy;
    let effSortOrder = sortOrder;

    if (sort) {
      if (sort === 'name_asc') { effSortBy = 'name'; effSortOrder = 'ASC'; }
      else if (sort === 'name_desc') { effSortBy = 'name'; effSortOrder = 'DESC'; }
      else if (sort === 'adm_asc') { effSortBy = 'admission_number'; effSortOrder = 'ASC'; }
      else if (sort === 'updated_desc') { effSortBy = 'updated_at'; effSortOrder = 'DESC'; }
    }

    const effCredential = credential || filter;

    const result = await defaultAdminDbService.listStudents({
      page,
      limit,
      search,
      section,
      credential: effCredential,
      sortBy: effSortBy,
      sortOrder: effSortOrder
    });

    return res.json({
      success: true,
      ...result
    });
  } catch (err) {
    return next(err);
  }
});

 
router.get('/students/export', requireAdminAuth, async (req, res, next) => {
  try {
    const { search, section, credential, sortBy, sortOrder, sort, filter, exportFilter } = req.query;

    let effSortBy = sortBy || 'name';
    let effSortOrder = sortOrder || 'ASC';

    if (sort) {
      if (sort === 'name_asc') { effSortBy = 'name'; effSortOrder = 'ASC'; }
      else if (sort === 'name_desc') { effSortBy = 'name'; effSortOrder = 'DESC'; }
      else if (sort === 'adm_asc') { effSortBy = 'admission_number'; effSortOrder = 'ASC'; }
      else if (sort === 'updated_desc') { effSortBy = 'updated_at'; effSortOrder = 'DESC'; }
    }

    
    const chosenExportFilter = String(exportFilter || credential || filter || 'all').toLowerCase().trim();
    let effCredential = '';
    if (chosenExportFilter === 'with_credentials' || chosenExportFilter === 'complete') {
      effCredential = 'with_credentials';
    } else if (chosenExportFilter === 'without_credentials' || chosenExportFilter === 'missing') {
      effCredential = 'without_credentials';
    }

    const students = await defaultAdminDbService.getStudentsForExport({
      search,
      section,
      credential: effCredential,
      sortBy: effSortBy,
      sortOrder: effSortOrder
    });

    const buffer = generateStudentsExportWorkbook(students);
    const filename = getExportFilename(chosenExportFilter);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    return res.send(buffer);
  } catch (err) {
    return next(err);
  }
});

 
router.get('/students/:id', requireAdminAuth, async (req, res, next) => {
  try {
    const student = await defaultAdminDbService.getStudentById(req.params.id);
    if (!student) {
      return res.status(404).json({
        success: false,
        error: {
          message: 'Student record not found',
          code: 'NOT_FOUND'
        }
      });
    }

    return res.json({
      success: true,
      student
    });
  } catch (err) {
    return next(err);
  }
});

 
router.post('/students', requireAdminAuth, async (req, res, next) => {
  try {
    const { name, student_name, admission_number, phone_number, username, portal_username, password, portal_password, section } = req.body || {};
    const effectiveName = student_name || name;
    const effectiveUser = portal_username !== undefined ? portal_username : username;
    const effectivePass = portal_password !== undefined ? portal_password : password;

    if (!effectiveName || !admission_number) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Both student name and admission number are required',
          code: 'VALIDATION_ERROR'
        }
      });
    }

    const result = await defaultAdminDbService.upsertStudent({
      student_name: effectiveName,
      name: effectiveName,
      admission_number,
      phone_number,
      portal_username: effectiveUser,
      username: effectiveUser,
      portal_password: effectivePass,
      password: effectivePass,
      section
    });

    return res.status(result.isUpdate ? 200 : 201).json({
      success: true,
      student: result.student,
      isUpdate: result.isUpdate
    });
  } catch (err) {
    return next(err);
  }
});

 
router.put('/students/:id', requireAdminAuth, async (req, res, next) => {
  try {
    const student = await defaultAdminDbService.updateStudent(req.params.id, req.body || {});
    if (!student) {
      return res.status(404).json({
        success: false,
        error: {
          message: 'Student record not found',
          code: 'NOT_FOUND'
        }
      });
    }

    return res.json({
      success: true,
      student
    });
  } catch (err) {
    if (err.code === 'ADMISSION_NUMBER_EXISTS') {
      return res.status(409).json({
        success: false,
        error: {
          message: err.message,
          code: 'ADMISSION_NUMBER_EXISTS'
        }
      });
    }
    return next(err);
  }
});

 
router.delete('/students/:id', requireAdminAuth, async (req, res, next) => {
  try {
    const success = await defaultAdminDbService.deleteStudent(req.params.id);
    if (!success) {
      return res.status(404).json({
        success: false,
        error: {
          message: 'Student record not found',
          code: 'NOT_FOUND'
        }
      });
    }

    return res.json({
      success: true,
      message: 'Student record deleted successfully'
    });
  } catch (err) {
    return next(err);
  }
});

 
router.post('/upload-preview', requireAdminAuth, handleUpload, async (req, res, next) => {
  try {
    let buffer = null;
    let originalname = 'upload.xlsx';

    
    if (req.file && req.file.buffer) {
      buffer = req.file.buffer;
      originalname = req.file.originalname || 'upload.xlsx';
    } else if (req.body && req.body.fileBase64) {
      
      originalname = req.body.filename || req.body.fileName || 'upload.xlsx';
      let b64 = req.body.fileBase64;
      if (typeof b64 === 'string' && b64.startsWith('data:')) {
        b64 = b64.slice(b64.indexOf(',') + 1);
      }
      buffer = Buffer.from(b64, 'base64');
    } else if (req.body && Array.isArray(req.body.records) && req.body.records.length > 0) {
      
      const records = req.body.records;
      const filename = req.body.filename || req.body.fileName || 'client_parsed.xlsx';
      const sectionsSet = new Set();
      for (const r of records) {
        if (r.section) sectionsSet.add(r.section);
      }
      const previewToken = defaultExcelImportService.storePreview({
        filename,
        sectionsFound: Array.from(sectionsSet),
        totalRecords: records.length,
        validRecords: records,
        missingAdmissionRecords: [],
        duplicateWithinFile: [],
        warnings: [],
        sample: records.slice(0, 25)
      });
      return res.json({
        success: true,
        previewToken,
        summary: {
          filename,
          sectionsFound: Array.from(sectionsSet),
          totalRecords: records.length,
          validRecordsCount: records.length,
          missingAdmissionCount: 0,
          duplicateWithinFileCount: 0,
          warnings: []
        },
        sample: records.slice(0, 25),
        missingAdmissionRecords: [],
        duplicatesWithinFile: []
      });
    }

    if (!buffer) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'No Excel file provided for upload',
          code: 'NO_FILE'
        }
      });
    }

    const parsedResult = defaultExcelImportService.parseExcelBuffer(
      buffer,
      originalname
    );

    const previewToken = defaultExcelImportService.storePreview(parsedResult);

    return res.json({
      success: true,
      previewToken,
      summary: {
        filename: parsedResult.filename,
        sectionsFound: parsedResult.sectionsFound,
        totalRecords: parsedResult.totalRecords,
        validRecordsCount: parsedResult.validRecords.length,
        missingAdmissionCount: parsedResult.missingAdmissionRecords.length,
        duplicateWithinFileCount: parsedResult.duplicateWithinFile.length,
        warnings: parsedResult.warnings
      },
      sample: parsedResult.sample,
      missingAdmissionRecords: parsedResult.missingAdmissionRecords.slice(0, 20),
      duplicatesWithinFile: parsedResult.duplicateWithinFile.slice(0, 20)
    });
  } catch (err) {
    return next(err);
  }
});

 
router.post('/upload-confirm', requireAdminAuth, async (req, res, next) => {
  try {
    const { previewToken, records } = req.body || {};

    let recordsToImport = null;

    
    if (previewToken) {
      const preview = defaultExcelImportService.getPreview(previewToken);
      if (preview && Array.isArray(preview.validRecords)) {
        recordsToImport = preview.validRecords;
        defaultExcelImportService.clearPreview(previewToken);
      }
    }

    
    if (!recordsToImport && Array.isArray(records) && records.length > 0) {
      recordsToImport = records;
    }

    if (!recordsToImport || recordsToImport.length === 0) {
      return res.status(410).json({
        success: false,
        error: {
          message: 'Preview session expired or invalid. Please re-upload your Excel file.',
          code: 'PREVIEW_EXPIRED'
        }
      });
    }

    const importResult = await defaultAdminDbService.batchUpsertStudents(recordsToImport);

    return res.json({
      success: true,
      message: `Successfully processed ${importResult.total} student records (${importResult.added} added, ${importResult.updated} updated).`,
      result: importResult
    });
  } catch (err) {
    return next(err);
  }
});





 
router.get('/exceptions', requireAdminAuth, async (req, res, next) => {
  try {
    const { page = 1, limit = 50, search = '' } = req.query;
    const result = await defaultAdminDbService.listExceptions({
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 50,
      search: String(search || '')
    });
    return res.json({
      success: true,
      data: result.exceptions,
      exceptions: result.exceptions,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages
    });
  } catch (err) {
    return next(err);
  }
});

 
router.get('/exceptions/:id', requireAdminAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const exception = await defaultAdminDbService.getExceptionById(id);
    if (!exception) {
      return res.status(404).json({
        success: false,
        error: {
          message: 'Exception record not found.',
          code: 'EXCEPTION_NOT_FOUND'
        }
      });
    }
    return res.json({
      success: true,
      data: exception,
      exception
    });
  } catch (err) {
    return next(err);
  }
});

 
router.post('/exceptions', requireAdminAuth, async (req, res, next) => {
  try {
    const studentNumber = String(req.body?.student_number || req.body?.studentNumber || '').trim();
    const customMessage = String(req.body?.custom_message || req.body?.customMessage || '').trim();

    if (!studentNumber) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Student number is required.',
          code: 'MISSING_STUDENT_NUMBER'
        }
      });
    }

    if (!customMessage) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Custom message is required.',
          code: 'MISSING_CUSTOM_MESSAGE'
        }
      });
    }

    try {
      const created = await defaultAdminDbService.createException({
        student_number: studentNumber,
        custom_message: customMessage
      });
      return res.status(201).json({
        success: true,
        message: 'Exception rule created successfully.',
        data: created,
        exception: created
      });
    } catch (createErr) {
      if (createErr.code === 'DUPLICATE_EXCEPTION' || createErr.message?.includes('already exists') || createErr.code === '23505') {
        return res.status(409).json({
          success: false,
          error: {
            message: 'An exception for this student number already exists. Please edit the existing exception instead.',
            code: 'DUPLICATE_EXCEPTION'
          }
        });
      }
      throw createErr;
    }
  } catch (err) {
    return next(err);
  }
});

 
router.put('/exceptions/:id', requireAdminAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const studentNumber = (req.body?.student_number !== undefined || req.body?.studentNumber !== undefined)
      ? String(req.body?.student_number || req.body?.studentNumber || '').trim()
      : undefined;
    const customMessage = (req.body?.custom_message !== undefined || req.body?.customMessage !== undefined)
      ? String(req.body?.custom_message || req.body?.customMessage || '').trim()
      : undefined;

    if (studentNumber === '') {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Student number cannot be empty.',
          code: 'INVALID_STUDENT_NUMBER'
        }
      });
    }

    if (customMessage === '') {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Custom message cannot be empty.',
          code: 'INVALID_CUSTOM_MESSAGE'
        }
      });
    }

    try {
      const updated = await defaultAdminDbService.updateException(id, {
        student_number: studentNumber,
        custom_message: customMessage
      });

      if (!updated) {
        return res.status(404).json({
          success: false,
          error: {
            message: 'Exception record not found.',
            code: 'EXCEPTION_NOT_FOUND'
          }
        });
      }

      return res.json({
        success: true,
        message: 'Exception rule updated successfully.',
        data: updated,
        exception: updated
      });
    } catch (updErr) {
      if (updErr.code === 'DUPLICATE_EXCEPTION' || updErr.message?.includes('already exists') || updErr.code === '23505') {
        return res.status(409).json({
          success: false,
          error: {
            message: 'Another exception rule already exists for this student number.',
            code: 'DUPLICATE_EXCEPTION'
          }
        });
      }
      throw updErr;
    }
  } catch (err) {
    return next(err);
  }
});

 
router.delete('/exceptions/:id', requireAdminAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await defaultAdminDbService.deleteException(id);
    if (!result || !result.deleted) {
      return res.status(404).json({
        success: false,
        error: {
          message: 'Exception record not found.',
          code: 'EXCEPTION_NOT_FOUND'
        }
      });
    }
    return res.json({
      success: true,
      message: 'Exception rule removed successfully.'
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
