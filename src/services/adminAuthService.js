'use strict';

const crypto = require('crypto');
const { defaultAdminDbService } = require('./adminDbService');

const DEFAULT_SALT = '62fe5a291dc3abf4e61e8b1ddc2c71ee';
const DEFAULT_HASH = '3f6aa76f85f1dfbde3975efd7dc8b6f180ab2ebc3f56ffb1d99606cdc33d62045a5ce4e29d33f4e73b066f3e1fa5179c413b3117b46f819da1aaf67dea9ae4f7';
const ITERATIONS = 10000;
const KEY_LEN = 64;
const DIGEST = 'sha512';

class AdminAuthService {
  constructor(dbService = defaultAdminDbService) {
    this.dbService = dbService;
  }

  /**
   * Verifies admin username and password.
   * Compares password against PBKDF2 hash or process.env.ADMIN_PASSWORD.
   * Uses crypto.timingSafeEqual for constant-time comparison.
   */
  verifyCredentials(username, password) {
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return false;
    }

    const expectedUsername = (process.env.ADMIN_USERNAME || 'inexpert_trifler').trim();
    const inputUsername = username.trim();

    // Constant-time username comparison
    const userBuf = Buffer.from(inputUsername);
    const expUserBuf = Buffer.from(expectedUsername);
    if (userBuf.length !== expUserBuf.length || !crypto.timingSafeEqual(userBuf, expUserBuf)) {
      return false;
    }

    // Direct password override
    if (process.env.ADMIN_PASSWORD) {
      const pwdBuf = Buffer.from(password);
      const envPwdBuf = Buffer.from(process.env.ADMIN_PASSWORD);
      if (pwdBuf.length === envPwdBuf.length && crypto.timingSafeEqual(pwdBuf, envPwdBuf)) {
        return true;
      }
    }

    // PBKDF2 Hash Verification
    const salt = process.env.ADMIN_PASSWORD_SALT || DEFAULT_SALT;
    const expectedHash = process.env.ADMIN_PASSWORD_HASH || DEFAULT_HASH;

    try {
      const computedHashBuf = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, DIGEST);
      const expectedHashBuf = Buffer.from(expectedHash, 'hex');

      if (computedHashBuf.length !== expectedHashBuf.length) {
        return false;
      }

      return crypto.timingSafeEqual(computedHashBuf, expectedHashBuf);
    } catch (err) {
      return false;
    }
  }

  /**
   * Generates a cryptographically secure admin session token with 2-hour TTL.
   */
  async createSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    await this.dbService.createAdminSession(token, username, 2);
    return token;
  }

  /**
   * Verifies if an admin session token is valid and active.
   * Returns { username } or null.
   */
  async verifySession(token) {
    if (!token || typeof token !== 'string') return null;
    const session = await this.dbService.getAdminSession(token);
    if (!session) return null;
    return { username: session.username };
  }

  /**
   * Destroys an active admin session.
   */
  async destroySession(token) {
    if (!token) return false;
    return await this.dbService.deleteAdminSession(token);
  }

  /**
   * Express middleware enforcing admin authentication.
   * Inspects cookie admin_token, Authorization: Bearer, or x-admin-token.
   */
  getMiddleware() {
    return async (req, res, next) => {
      try {
        let token = null;

        if (req.cookies && req.cookies.admin_token) {
          token = req.cookies.admin_token;
        } else if (req.headers && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
          token = req.headers.authorization.slice(7).trim();
        } else if (req.headers && req.headers['x-admin-token']) {
          token = req.headers['x-admin-token'];
        }

        if (token) {
          const user = await this.verifySession(token);
          if (user) {
            req.adminUser = user;
            return next();
          }
        }

        // Authentication failure
        const reqPath = req.originalUrl || req.url || req.path || '';
        if (reqPath.startsWith('/api')) {
          return res.status(401).json({
            success: false,
            error: {
              message: 'Unauthorized admin access',
              code: 'UNAUTHORIZED'
            }
          });
        }

        return res.redirect('/admin/login');
      } catch (err) {
        return next(err);
      }
    };
  }
}

const defaultAdminAuthService = new AdminAuthService();

const requireAdminAuth = defaultAdminAuthService.getMiddleware();

module.exports = {
  AdminAuthService,
  defaultAdminAuthService,
  requireAdminAuth
};
