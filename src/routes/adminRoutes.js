'use strict';

const express = require('express');
const path = require('path');
const multer = require('multer');
const { defaultAdminAuthService, requireAdminAuth } = require('../services/adminAuthService');
const { defaultAdminDbService } = require('../services/adminDbService');
const { defaultExcelImportService } = require('../services/excelImportService');

const router = express.Router();

// Multer memory storage configuration (15MB limit, .xlsx, .xlxs, .xls, .xlsm, .csv)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
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

/**
 * Middleware handling multer upload errors gracefully.
 */
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

// In-memory rate limiting for login attempts (max 10 attempts per minute)
const loginAttempts = new Map();
function loginRateLimiter(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxAttempts = 10;

  const record = loginAttempts.get(ip);
  if (!record || now > record.resetTime) {
    loginAttempts.set(ip, { count: 1, resetTime: now + windowMs });
    return next();
  }

  if (record.count >= maxAttempts) {
    const retryAfter = Math.ceil((record.resetTime - now) / 1000);
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({
      success: false,
      error: {
        message: 'Too many login attempts. Please try again after 1 minute.',
        code: 'RATE_LIMITED'
      }
    });
  }

  record.count++;
  return next();
}

/**
 * POST /api/admin/login
 * Validates admin credentials, issues session token, sets HTTP-only cookie.
 */
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

    const isValid = defaultAdminAuthService.verifyCredentials(username, password);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        error: {
          message: 'Invalid admin credentials',
          code: 'UNAUTHORIZED'
        }
      });
    }

    const token = await defaultAdminAuthService.createSession(username);

    // Set HTTP-only secure cookie
    res.cookie('admin_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 2 * 60 * 60 * 1000,
      path: '/'
    });

    return res.json({
      success: true,
      token,
      user: {
        username
      }
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/admin/logout
 * Clears cookie and invalidates the session.
 */
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

/**
 * GET /api/admin/me
 * Retrieves current admin identity.
 */
router.get('/me', requireAdminAuth, (req, res) => {
  return res.json({
    success: true,
    user: req.adminUser
  });
});

/**
 * GET /api/admin/stats
 * Retrieves real dashboard metrics and analytics.
 */
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

/**
 * GET /api/admin/students
 * Paginated, sorted, and searchable student directory.
 */
router.get('/students', requireAdminAuth, async (req, res, next) => {
  try {
    const { page, limit, search, section, sortBy, sortOrder } = req.query;
    const result = await defaultAdminDbService.listStudents({
      page,
      limit,
      search,
      section,
      sortBy,
      sortOrder
    });

    return res.json({
      success: true,
      ...result
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/admin/students/:id
 * Retrieves single student by ID.
 */
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

/**
 * POST /api/admin/students
 * Creates or upserts a student manually.
 */
router.post('/students', requireAdminAuth, async (req, res, next) => {
  try {
    const { name, admission_number, phone_number, username, password, section } = req.body || {};

    if (!name || !admission_number) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Both student name and admission number are required',
          code: 'VALIDATION_ERROR'
        }
      });
    }

    const result = await defaultAdminDbService.upsertStudent({
      name,
      admission_number,
      phone_number,
      username,
      password,
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

/**
 * PUT /api/admin/students/:id
 * Updates an existing student record with credential protection.
 */
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

/**
 * DELETE /api/admin/students/:id
 * Deletes a student record.
 */
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

/**
 * POST /api/admin/upload-preview
 * Parses uploaded Excel workbook without committing, creates a previewToken.
 */
router.post('/upload-preview', requireAdminAuth, handleUpload, async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'No Excel file provided for upload',
          code: 'NO_FILE'
        }
      });
    }

    const parsedResult = defaultExcelImportService.parseExcelBuffer(
      req.file.buffer,
      req.file.originalname || 'upload.xlsx'
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

/**
 * POST /api/admin/upload-confirm
 * Commits the parsed records from previewToken into the database.
 */
router.post('/upload-confirm', requireAdminAuth, async (req, res, next) => {
  try {
    const { previewToken } = req.body || {};
    if (!previewToken) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'previewToken is required to confirm import',
          code: 'MISSING_PARAM'
        }
      });
    }

    const preview = defaultExcelImportService.getPreview(previewToken);
    if (!preview) {
      return res.status(410).json({
        success: false,
        error: {
          message: 'Preview session expired or invalid. Please re-upload your Excel file.',
          code: 'PREVIEW_EXPIRED'
        }
      });
    }

    const importResult = await defaultAdminDbService.batchUpsertStudents(preview.validRecords);
    defaultExcelImportService.clearPreview(previewToken);

    return res.json({
      success: true,
      message: `Successfully processed ${importResult.total} student records (${importResult.added} added, ${importResult.updated} updated).`,
      result: importResult
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
