const crypto = require('crypto');
const db = require('./db');

let devKeyWarned = false;

function getCredentialsKey() {
  const key = process.env.CREDENTIALS_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CREDENTIALS_KEY environment variable is required in production');
    }
    if (!devKeyWarned) {
      console.warn('CREDENTIALS_KEY not set — using insecure dev key (not for production)');
      devKeyWarned = true;
    }
    return crypto.createHash('sha256').update('dispatch-dev-insecure-key').digest();
  }
  if (/^[0-9a-f]{64}$/i.test(key)) return Buffer.from(key, 'hex');
  return crypto.createHash('sha256').update(key).digest();
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getCredentialsKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

function decrypt(blob) {
  if (!blob) return null;
  const parts = String(blob).split('.');
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const data = Buffer.from(parts[2], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getCredentialsKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function rowToCredentials(row) {
  if (!row) return null;
  const password = decrypt(row.password_enc);
  const apiId = decrypt(row.api_id_enc);
  if (!password || !apiId) return null;
  let portalCookies = null;
  if (row.portal_cookies_enc) {
    try {
      portalCookies = JSON.parse(decrypt(row.portal_cookies_enc) || 'null');
    } catch {
      portalCookies = null;
    }
  }
  return {
    username: row.username,
    password,
    apiId,
    portalCookies,
    testMode: row.test_mode === '1'
  };
}

function getUserCredentials(username) {
  const row = db.prepare('SELECT * FROM user_credentials WHERE username = ?').get(username);
  return rowToCredentials(row);
}

function upsertUserCredentials(username, { password, apiId, portalCookies, testMode }) {
  const existing = db.prepare('SELECT test_mode FROM user_credentials WHERE username = ?').get(username);
  const testVal = testMode !== undefined ? (testMode ? '1' : '0') : (existing?.test_mode || '1');
  db.prepare(`
    INSERT INTO user_credentials (username, password_enc, api_id_enc, portal_cookies_enc, test_mode, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(username) DO UPDATE SET
      password_enc = excluded.password_enc,
      api_id_enc = excluded.api_id_enc,
      portal_cookies_enc = excluded.portal_cookies_enc,
      test_mode = excluded.test_mode,
      updated_at = datetime('now')
  `).run(
    username,
    encrypt(password),
    encrypt(apiId),
    portalCookies ? encrypt(JSON.stringify(portalCookies)) : null,
    testVal
  );
}

function updateUserPortalCookies(username, portalCookies) {
  db.prepare(`
    UPDATE user_credentials SET portal_cookies_enc = ?, updated_at = datetime('now') WHERE username = ?
  `).run(portalCookies ? encrypt(JSON.stringify(portalCookies)) : null, username);
}

function updateUserTestMode(username, testMode) {
  db.prepare(`
    UPDATE user_credentials SET test_mode = ?, updated_at = datetime('now') WHERE username = ?
  `).run(testMode ? '1' : '0', username);
}

function hasUserCredentials(username) {
  return !!getUserCredentials(username);
}

function migrateLegacyUserCredentials(getSetting) {
  const count = db.prepare('SELECT COUNT(*) as n FROM user_credentials').get().n;
  if (count > 0) return;
  const username = getSetting('vacotel_username');
  const password = getSetting('vacotel_password');
  const apiId = getSetting('vacotel_api_id');
  if (!username || !password || !apiId) return;
  let portalCookies = null;
  try {
    portalCookies = JSON.parse(getSetting('otus_portal_cookies') || 'null');
  } catch {
    portalCookies = null;
  }
  const testMode = getSetting('test_mode') === '1';
  upsertUserCredentials(username, { password, apiId, portalCookies, testMode });
  console.log(`Migrated legacy credentials for user "${username}" to user_credentials table`);
}

module.exports = {
  encrypt,
  decrypt,
  getUserCredentials,
  upsertUserCredentials,
  updateUserPortalCookies,
  updateUserTestMode,
  hasUserCredentials,
  migrateLegacyUserCredentials
};
