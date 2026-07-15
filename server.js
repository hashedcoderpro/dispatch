require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const path = require('path');
const db = require('./db');
const {
  getUserCredentials,
  upsertUserCredentials,
  updateUserPortalCookies,
  hasUserCredentials,
  migrateLegacyUserCredentials
} = require('./credentials');
const {
  VACOTEL_GATEWAY_URL,
  sendSms,
  analyzeMessage,
  normalizeDestination,
  probeVacotelApi,
  validateVacotelCredentials,
  ERROR_CODES
} = require('./vacotelClient');
const {
  parseLines, parsePhones, buildInterleavedQueue, buildCartesianQueue, buildRouteMatrixQueue,
  assignTemplates, estimateCost
} = require('./sendHelpers');
const {
  portalLogin,
  requestSenderId,
  listSenderIds,
  deleteSenderIds,
  readTraffic,
  getAccountBalance,
  parseStoredCookies,
  validateSenderId,
  verifyAdminAccess,
  getAdminBalance,
  listAdminAccounts,
  addBalanceToAccount,
  changeAccountRoute,
  listAdminSenderIds,
  updateSenderIdStatus,
  VENDOR_ROUTES
} = require('./otusPortalClient');

const SMS_RATE_EUR = 0.05;
const CET_TZ = 'Europe/Paris';
const ROUTE_MATRIX_ROUTE_COUNT = 5;
const ROUTE_MATRIX_SETTLE_MS = 1500;

/** adminUsername → { username, accountId, loggedInAt } */
const routeMatrixSessions = new Map();
/** Single matrix run lock + progress */
let routeMatrixRun = null;

function formatParisLocal(ms) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: CET_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(new Date(ms));
}

function cetTodayYmd(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CET_TZ }).format(date);
}

function utcMsForParisLocal(ymd, h, mi, s) {
  const target = `${ymd} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  const [y, mo, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, 12, 0, 0);
  for (let ms = guess - 14 * 3600000; ms <= guess + 14 * 3600000; ms += 1000) {
    if (formatParisLocal(ms) === target) return ms;
  }
  return guess;
}

function cetDaySqlRange(date = new Date()) {
  const today = cetTodayYmd(date);
  const tomorrow = cetTodayYmd(new Date(date.getTime() + 86400000));
  const toSql = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  return {
    start: toSql(utcMsForParisLocal(today, 0, 0, 0)),
    end: toSql(utcMsForParisLocal(tomorrow, 0, 0, 0)),
    label: today
  };
}

const app = express();
// Cloudflare + Caddy = two proxy hops; trust that many so rate limits see the real client IP.
if (process.env.TRUST_PROXY === '1') {
  const hops = Math.max(1, parseInt(process.env.TRUST_PROXY_HOPS || '2', 10) || 2);
  app.set('trust proxy', hops);
}
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE_SECURE = process.env.TRUST_PROXY === '1' ? '; Secure' : '';
const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/status']);
const PUBLIC_ADMIN_API = new Set(['/api/admin/auth/login', '/api/admin/auth/status']);

const userLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — try again in 15 minutes' }
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — try again in 15 minutes' }
});

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getSessionSecret() {
  let secret = getSetting('session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting('session_secret', secret);
  }
  return secret;
}

function signSession(username, role) {
  const payload = JSON.stringify({ username, role: role || 'user', exp: Date.now() + SESSION_MAX_AGE_MS });
  const body = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySessionToken(token, expectedRole) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', getSessionSecret()).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!data.username || !data.exp || data.exp < Date.now()) return null;
    if (expectedRole === 'admin') {
      if (data.role !== 'admin') return null;
    } else if (expectedRole === 'user') {
      if (data.role && data.role !== 'user') return null;
    }
    return data.username;
  } catch {
    return null;
  }
}

function verifySession(req) {
  return verifySessionToken(parseCookies(req).dispatch_session, 'user');
}

function verifyAdminSession(req) {
  return verifySessionToken(parseCookies(req).dispatch_admin_session, 'admin');
}

function setSessionCookie(res, username) {
  res.setHeader('Set-Cookie', `dispatch_session=${signSession(username, 'user')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}${COOKIE_SECURE}`);
}

function setAdminSessionCookie(res, username) {
  res.setHeader('Set-Cookie', `dispatch_admin_session=${signSession(username, 'admin')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}${COOKIE_SECURE}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `dispatch_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${COOKIE_SECURE}`);
}

function clearAdminSessionCookie(res) {
  res.setHeader('Set-Cookie', `dispatch_admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${COOKIE_SECURE}`);
}

function getAdminEnvCredentials() {
  const username = process.env.ADMIN_USERNAME || '';
  const password = process.env.ADMIN_PASSWORD || '';
  return { username, password };
}

function requireAuth(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();

  if (req.path.startsWith('/api/admin/')) {
    if (PUBLIC_ADMIN_API.has(req.path)) return next();
    const username = verifyAdminSession(req);
    if (!username) return res.status(401).json({ error: 'Not authenticated' });
    req.adminUsername = username;
    return next();
  }

  if (PUBLIC_API.has(req.path)) return next();
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  if (!hasUserCredentials(username)) {
    return res.status(401).json({ error: 'Vacotel credentials not configured — sign in again' });
  }
  req.sessionUsername = username;
  next();
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requireAuth);
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function purgeLegacyAdminSettings() {
  const { username, password } = getAdminEnvCredentials();
  if (!username || !password) return;
  for (const key of ['admin_password', 'admin_username']) {
    if (getSetting(key)) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      console.log(`Removed legacy ${key} from database — using ADMIN_* from .env`);
    }
  }
}

async function refreshPortalSession(username) {
  const creds = getUserCredentials(username);
  if (!creds) return { ok: false, error: 'Portal credentials not configured' };
  const login = await portalLogin(username, creds.password);
  if (!login.ok) {
    updateUserPortalCookies(username, null);
    return login;
  }
  updateUserPortalCookies(username, login.cookies);
  return { ok: true, cookies: login.cookies };
}

async function getPortalCookies(username, { forceRefresh } = {}) {
  if (!forceRefresh) {
    const creds = getUserCredentials(username);
    const jar = creds?.portalCookies;
    if (jar && (jar['vacotel-Cookie'] || jar['.AspNetCore.Session'])) {
      return { ok: true, cookies: jar };
    }
  }
  return refreshPortalSession(username);
}

async function withPortalSession(username, fn) {
  let session = await getPortalCookies(username);
  if (!session.ok) return session;
  let result = await fn(session.cookies);
  if (result.needsRefresh) {
    session = await getPortalCookies(username, { forceRefresh: true });
    if (!session.ok) return session;
    result = await fn(session.cookies);
  }
  if (!result.needsRefresh && session.cookies) {
    updateUserPortalCookies(username, session.cookies);
  }
  return result;
}

async function refreshAdminPortalSession() {
  const { username, password } = getAdminEnvCredentials();
  if (!username || !password) return { ok: false, error: 'Admin credentials not configured in environment' };
  const login = await portalLogin(username, password);
  if (!login.ok) {
    setSetting('otus_admin_portal_cookies', '');
    return login;
  }
  const check = await verifyAdminAccess(login.cookies);
  if (!check.ok) {
    setSetting('otus_admin_portal_cookies', '');
    return check;
  }
  setSetting('otus_admin_portal_cookies', JSON.stringify(login.cookies));
  return { ok: true, cookies: login.cookies };
}

async function getAdminPortalCookies({ forceRefresh } = {}) {
  if (!forceRefresh) {
    const jar = parseStoredCookies(getSetting('otus_admin_portal_cookies'));
    if (jar) return { ok: true, cookies: jar };
  }
  return refreshAdminPortalSession();
}

async function withAdminPortalSession(fn) {
  let session = await getAdminPortalCookies();
  if (!session.ok) return session;
  let result = await fn(session.cookies);
  if (result.needsRefresh) {
    session = await getAdminPortalCookies({ forceRefresh: true });
    if (!session.ok) return session;
    result = await fn(session.cookies);
  }
  if (!result.needsRefresh && session.cookies) {
    setSetting('otus_admin_portal_cookies', JSON.stringify(session.cookies));
  }
  return result;
}

function portalSessionExpired(status, text) {
  return status === 401 || status === 403 || /login|unauthorized|session/i.test(text || '');
}

async function fetchOtusBalance(username) {
  const result = await withPortalSession(username, async (cookies) => {
    const out = await getAccountBalance(cookies);
    if (!out.ok && portalSessionExpired(out.status, out.error)) return { needsRefresh: true };
    return out;
  });
  if (result.needsRefresh) {
    return { ok: false, error: 'Portal session expired — sign in again', needsRefresh: true };
  }
  return result;
}

async function checkBalanceForCost(username, estimatedCostEur) {
  const bal = await fetchOtusBalance(username);
  if (!bal.ok) return bal;
  if (estimatedCostEur > bal.balance) {
    return {
      ok: false,
      error: `Estimated cost (€${estimatedCostEur.toFixed(2)}) exceeds account balance (€${bal.balance.toFixed(2)})`,
      balance: bal.balance
    };
  }
  return { ok: true, balance: bal.balance };
}
function currentBalance() {
  const row = db.prepare('SELECT COALESCE(SUM(amount), 0) as bal FROM balance_transactions').get();
  return row.bal;
}
function fillTemplate(tpl, lead) {
  return tpl
    .replace(/\{name\}/gi, lead.name || '')
    .replace(/\{phone\}/gi, lead.phone || '')
    .replace(/\{number\}/gi, lead.phone || '')
    .replace(/\{custom1\}/gi, lead.custom1 || '')
    .replace(/\{custom2\}/gi, lead.custom2 || '');
}

function getSegmentTemplates(purpose) {
  const rows = db.prepare(`
    SELECT segment, text FROM segment_templates
    WHERE purpose = ? ORDER BY segment, sort_order, id
  `).all(purpose);
  const out = { m: [], p: [] };
  for (const row of rows) {
    const seg = row.segment === 'p' ? 'p' : 'm';
    const text = String(row.text).trim();
    if (text) out[seg].push(text);
  }
  return out;
}

function saveSegmentTemplates(purpose, buckets) {
  const del = db.prepare('DELETE FROM segment_templates WHERE purpose = ?');
  const ins = db.prepare(`
    INSERT INTO segment_templates (segment, purpose, text, sort_order, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  const tx = db.transaction(() => {
    del.run(purpose);
    for (const segment of ['m', 'p']) {
      const lines = Array.isArray(buckets[segment]) ? buckets[segment] : [];
      let order = 0;
      for (const line of lines) {
        const text = String(line).trim();
        if (!text) continue;
        ins.run(segment, purpose, text, order++);
      }
    }
  });
  tx();
}

function resolveSegmentMessages(purpose, segment) {
  const seg = segment === 'p' ? 'p' : 'm';
  const templates = getSegmentTemplates(purpose)[seg];
  return templates.length ? templates : null;
}

function getCampaignSegments(campaignId) {
  let segments = db.prepare(`
    SELECT cs.*, ll.name as list_name
    FROM campaign_segments cs
    JOIN lead_lists ll ON ll.id = cs.list_id
    WHERE cs.campaign_id = ?
    ORDER BY cs.sort_order, cs.id
  `).all(campaignId);

  if (!segments.length) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (campaign) {
      segments = [{
        id: null,
        campaign_id: campaignId,
        list_id: campaign.list_id,
        source: campaign.source,
        label: null,
        sort_order: 0,
        list_name: db.prepare('SELECT name FROM lead_lists WHERE id = ?').get(campaign.list_id)?.name
      }];
    }
  }
  return segments;
}

function loadSegmentLeads(segment) {
  return db.prepare('SELECT * FROM leads WHERE list_id = ? AND opted_out = 0 ORDER BY id').all(segment.list_id);
}

function ownedCampaignOr404(req, res) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND created_by = ?')
    .get(req.params.id, req.sessionUsername);
  if (!campaign) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  return campaign;
}

function ownedLeadListOrNull(listId, username) {
  const row = db.prepare('SELECT id FROM lead_lists WHERE id = ? AND created_by = ?').get(listId, username);
  return row || null;
}

function createRosterFromMessages(name, messages, username) {
  const insertRoster = db.prepare('INSERT INTO message_rosters (name, created_by) VALUES (?, ?)');
  const insertTpl = db.prepare('INSERT INTO message_templates (roster_id, text) VALUES (?, ?)');
  const info = insertRoster.run(name, username);
  const rosterId = info.lastInsertRowid;
  let count = 0;
  for (const m of messages) {
    const text = String(m).trim();
    if (!text) continue;
    insertTpl.run(rosterId, text);
    count++;
  }
  return { rosterId, count };
}

function createListFromPhones(name, phones, username) {
  const insertList = db.prepare('INSERT INTO lead_lists (name, created_by) VALUES (?, ?)');
  const insertLead = db.prepare('INSERT INTO leads (list_id, phone) VALUES (?, ?)');
  const info = insertList.run(name, username);
  const listId = info.lastInsertRowid;
  for (const phone of phones) insertLead.run(listId, phone);
  return { listId, count: phones.length };
}

async function processSendQueue({ username, queue, campaignId, ratePerSms, throttleMs, getText, getPhone, getSource, getLeadId, getTemplateId, notePrefix }) {
  const creds = getUserCredentials(username);
  if (!creds) throw new Error('User credentials not found');
  const apiId = creds.apiId;

  const insertSend = db.prepare(`
    INSERT INTO sends (campaign_id, lead_id, template_id, phone, message_text, data_coding,
      vendor_message_id, send_error_code, send_status, message_count, message_parts, cost, source, segment_label, sent_at, sent_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `);

  for (const item of queue) {
    const text = getText(item);
    const phone = getPhone(item);
    const source = getSource(item);
    const { dataCoding, parts } = analyzeMessage(text);

    let result;
    try {
      result = await sendSms({
        baseUrl: VACOTEL_GATEWAY_URL,
        username: creds.username,
        apiId,
        destination: phone,
        source,
        text,
        dataCoding
      });
    } catch (e) {
      result = { ok: false, errorCode: -10, errorDescription: 'Network/request error: ' + e.message };
    }

    const cost = result.ok ? (result.messageParts || parts) * ratePerSms : 0;
    insertSend.run(
      campaignId,
      getLeadId(item),
      getTemplateId(item),
      phone,
      text,
      dataCoding,
      result.vendorId || null,
      result.errorCode,
      result.ok ? 'sent' : 'failed',
      result.messageCount || 1,
      result.messageParts || parts,
      cost,
      source,
      item.segmentLabel || null,
      username
    );
    if (throttleMs) await new Promise(r => setTimeout(r, throttleMs));
  }
}

// ---------- auth ----------
app.get('/api/auth/status', (req, res) => {
  const username = verifySession(req);
  const creds = username ? getUserCredentials(username) : null;
  res.json({
    authenticated: !!username,
    username: username || null,
    portal_connected: !!(creds?.portalCookies)
  });
});

app.post('/api/auth/login', userLoginLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const apiId = String(req.body.apiId || '').trim();
  if (!username || !password || !apiId) {
    return res.status(400).json({ error: 'Username, password, and API token are all required' });
  }

  const probe = await probeVacotelApi({
    baseUrl: VACOTEL_GATEWAY_URL,
    username,
    apiId
  });
  const check = validateVacotelCredentials(probe);
  if (!check.ok) {
    return res.status(401).json({ error: `API token check failed: ${check.error}` });
  }

  const portal = await portalLogin(username, password);
  if (!portal.ok) {
    console.error('Portal login failed:', portal.error, portal.raw ? JSON.stringify(portal.raw).slice(0, 200) : '');
    return res.status(401).json({ error: `Portal login failed: ${portal.error}` });
  }

  const existing = getUserCredentials(username);
  upsertUserCredentials(username, {
    password,
    apiId,
    portalCookies: portal.cookies
  });
  setSetting('vacotel_base_url', VACOTEL_GATEWAY_URL);
  setSessionCookie(res, username);
  res.json({ ok: true, username, portal_connected: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------- admin auth ----------
app.get('/api/admin/auth/status', (req, res) => {
  const username = verifyAdminSession(req);
  const envAdmin = getAdminEnvCredentials();
  res.json({
    authenticated: !!username,
    username: username || envAdmin.username || null,
    portal_connected: !!parseStoredCookies(getSetting('otus_admin_portal_cookies'))
  });
});

app.post('/api/admin/auth/login', adminLoginLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const envAdmin = getAdminEnvCredentials();
  if (!envAdmin.username || !envAdmin.password) {
    return res.status(503).json({ error: 'Admin credentials not configured on server — set ADMIN_USERNAME and ADMIN_PASSWORD in .env' });
  }
  if (username !== envAdmin.username || password !== envAdmin.password) {
    return res.status(401).json({ error: 'Invalid admin credentials' });
  }

  const portal = await portalLogin(envAdmin.username, envAdmin.password);
  if (!portal.ok) {
    return res.status(401).json({ error: `Portal login failed: ${portal.error}` });
  }
  const check = await verifyAdminAccess(portal.cookies);
  if (!check.ok) {
    return res.status(401).json({ error: check.error || 'This account does not have admin access' });
  }

  setSetting('otus_admin_portal_cookies', JSON.stringify(portal.cookies));
  setAdminSessionCookie(res, username);
  restartSidAutoPoller();
  res.json({ ok: true, username, portal_connected: true });
});

app.post('/api/admin/auth/logout', (req, res) => {
  const adminUser = verifyAdminSession(req);
  if (adminUser) routeMatrixSessions.delete(adminUser);
  clearAdminSessionCookie(res);
  res.json({ ok: true });
});

// ---------- segment templates (user read) ----------
app.get('/api/templates', (req, res) => {
  const purpose = req.query.purpose === 'campaign' ? 'campaign' : 'test';
  res.json(getSegmentTemplates(purpose));
});

// ---------- admin: balance, accounts, templates, SIDs ----------
app.get('/api/admin/balance', async (req, res) => {
  try {
    const result = await withAdminPortalSession(cookies => getAdminBalance(cookies));
    if (result.needsRefresh) return res.status(401).json({ error: result.error });
    if (!result.ok) return res.status(502).json({ error: result.error || 'Could not fetch admin balance' });
    res.json({ balance: result.balance, currency: result.currency, raw: result.raw });
  } catch (e) {
    console.error('Admin balance error:', e);
    res.status(500).json({ error: e.message || 'Failed to fetch admin balance' });
  }
});

app.get('/api/admin/accounts', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  try {
    const result = await withAdminPortalSession(cookies => listAdminAccounts(cookies));
    if (result.needsRefresh) return res.status(401).json({ error: result.error });
    if (!result.ok) return res.status(502).json({ error: result.error || 'Could not load accounts' });
    let accounts = result.accounts || [];
    if (q) {
      accounts = accounts.filter(a =>
        String(a.Name || '').toLowerCase().includes(q) ||
        String(a.EmailAddress || '').toLowerCase().includes(q) ||
        String(a.MobileNum || '').includes(q)
      );
    }
    res.json({ accounts, recordsTotal: result.recordsTotal });
  } catch (e) {
    console.error('Admin accounts error:', e);
    res.status(500).json({ error: e.message || 'Failed to load accounts' });
  }
});

app.post('/api/admin/accounts/:id/balance', async (req, res) => {
  const accountId = Number(req.params.id);
  const amount = Number(req.body.amount);
  if (!accountId || !Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: 'Valid account id and non-zero amount required' });
  }
  try {
    const result = await withAdminPortalSession(cookies => addBalanceToAccount(cookies, accountId, amount));
    if (result.needsRefresh) return res.status(401).json({ error: result.error });
    if (!result.ok) return res.status(400).json({ error: result.error || 'Balance update failed' });
    res.json({ ok: true, message: result.message });
  } catch (e) {
    console.error('Admin balance transfer error:', e);
    res.status(500).json({ error: e.message || 'Balance update failed' });
  }
});

app.post('/api/admin/accounts/:id/route', async (req, res) => {
  const accountId = Number(req.params.id);
  const route = Number(req.body.route);
  if (!accountId || !Number.isInteger(route) || route < 0 || route > 4) {
    return res.status(400).json({ error: 'Valid account id and route 0–4 required' });
  }
  try {
    const result = await withAdminPortalSession(cookies => changeAccountRoute(cookies, accountId, route));
    if (result.needsRefresh) return res.status(401).json({ error: result.error });
    if (!result.ok) return res.status(400).json({ error: result.error || 'Route change failed' });
    res.json({ ok: true, route, vendor_id: VENDOR_ROUTES[route] });
  } catch (e) {
    console.error('Admin route change error:', e);
    res.status(500).json({ error: e.message || 'Route change failed' });
  }
});

// ---------- admin: route matrix (test portal) ----------
function getRouteMatrixSession(adminUsername) {
  return routeMatrixSessions.get(adminUsername) || null;
}

function requireRouteMatrixSession(req, res) {
  const session = getRouteMatrixSession(req.adminUsername);
  if (!session) {
    res.status(401).json({ error: 'Sign into the test account first' });
    return null;
  }
  if (!hasUserCredentials(session.username)) {
    routeMatrixSessions.delete(req.adminUsername);
    res.status(401).json({ error: 'Test account credentials missing — sign in again' });
    return null;
  }
  return session;
}

function parseMatrixStringList(input, { label, min, max, validateItem }) {
  let items;
  if (Array.isArray(input)) {
    items = input.map(s => String(s || '').trim()).filter(Boolean);
  } else if (typeof input === 'string') {
    items = parseLines(input);
  } else {
    items = [];
  }
  if (items.length < min) return { ok: false, error: `At least ${min} ${label} required` };
  if (items.length > max) return { ok: false, error: `At most ${max} ${label} allowed` };
  if (validateItem) {
    for (const item of items) {
      const check = validateItem(item);
      if (!check.ok) return check;
    }
    items = items.map(item => validateItem(item).value || item);
  }
  return { ok: true, items };
}

function parseMatrixPayload(body) {
  const phonesRaw = body.phones ?? body.numbers ?? '';
  const phoneText = Array.isArray(phonesRaw) ? phonesRaw.join('\n') : String(phonesRaw || '');
  const phoneLines = parseLines(phoneText);
  if (phoneLines.length > 3) return { ok: false, error: 'At most 3 phone numbers allowed' };
  const phones = parsePhones(phoneText);
  if (!phones.length) return { ok: false, error: 'At least one valid phone number required' };
  if (phones.length > 3) return { ok: false, error: 'At most 3 phone numbers allowed' };

  const sids = parseMatrixStringList(body.sids, {
    label: 'SID(s)',
    min: 1,
    max: 3,
    validateItem: validateSenderId
  });
  if (!sids.ok) return sids;

  const contents = parseMatrixStringList(body.contents, {
    label: 'content message(s)',
    min: 1,
    max: 3
  });
  if (!contents.ok) return contents;

  const perRoute = phones.length * sids.items.length * contents.items.length;
  const totalSms = perRoute * ROUTE_MATRIX_ROUTE_COUNT;
  return {
    ok: true,
    phones,
    sids: sids.items,
    contents: contents.items,
    per_route: perRoute,
    total_sms: totalSms
  };
}

async function findAccountIdByUsername(username) {
  const result = await withAdminPortalSession(cookies => listAdminAccounts(cookies));
  if (!result.ok) return result;
  const needle = String(username || '').trim().toLowerCase();
  const acct = (result.accounts || []).find(a =>
    String(a.Name || '').trim().toLowerCase() === needle ||
    String(a.Username || '').trim().toLowerCase() === needle
  );
  if (!acct) {
    return { ok: false, error: `No Otus admin account found named "${username}" — check Accounts list` };
  }
  return { ok: true, accountId: Number(acct.AccountId), account: acct };
}

app.post('/api/admin/route-matrix/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const apiId = String(req.body.apiId || req.body.api_id || '').trim();
  if (!username || !password || !apiId) {
    return res.status(400).json({ error: 'Username, password, and API token are all required' });
  }

  try {
    const probe = await probeVacotelApi({
      baseUrl: VACOTEL_GATEWAY_URL,
      username,
      apiId
    });
    const check = validateVacotelCredentials(probe);
    if (!check.ok) {
      return res.status(401).json({ error: `API token check failed: ${check.error}` });
    }

    const portal = await portalLogin(username, password);
    if (!portal.ok) {
      return res.status(401).json({ error: `Portal login failed: ${portal.error}` });
    }

    const accountLookup = await findAccountIdByUsername(username);
    if (accountLookup.needsRefresh) return res.status(401).json({ error: accountLookup.error });
    if (!accountLookup.ok) return res.status(400).json({ error: accountLookup.error });

    upsertUserCredentials(username, {
      password,
      apiId,
      portalCookies: portal.cookies
    });

    routeMatrixSessions.set(req.adminUsername, {
      username,
      accountId: accountLookup.accountId,
      loggedInAt: Date.now()
    });

    res.json({
      ok: true,
      username,
      account_id: accountLookup.accountId,
      balance: accountLookup.account?.Balance
    });
  } catch (e) {
    console.error('Route matrix login error:', e);
    res.status(500).json({ error: e.message || 'Test account login failed' });
  }
});

app.post('/api/admin/route-matrix/logout', (req, res) => {
  routeMatrixSessions.delete(req.adminUsername);
  res.json({ ok: true });
});

app.get('/api/admin/route-matrix/session', (req, res) => {
  const session = getRouteMatrixSession(req.adminUsername);
  if (!session) return res.json({ authenticated: false });
  res.json({
    authenticated: true,
    username: session.username,
    account_id: session.accountId,
    logged_in_at: session.loggedInAt
  });
});

app.get('/api/admin/route-matrix/sender-ids', async (req, res) => {
  const session = requireRouteMatrixSession(req, res);
  if (!session) return;
  try {
    const result = await withPortalSession(session.username, async (cookies) => {
      const list = await listSenderIds(cookies);
      if (!list.ok && portalSessionExpired(list.status, list.error)) {
        return { needsRefresh: true };
      }
      return list;
    });
    if (result.needsRefresh) {
      return res.status(401).json({ error: 'Test account portal session expired — sign in again' });
    }
    if (!result.ok) {
      return res.status(502).json({ error: result.error || 'Could not load sender IDs' });
    }
    res.json({
      otus: result.items.map(item => ({
        otus_sender_id: item.SenderId,
        source: item.Sender,
        status: item.Status,
        active: item.Active,
        created_date: item.CreatedDate
      }))
    });
  } catch (e) {
    console.error('Route matrix SIDs error:', e);
    res.status(500).json({ error: e.message || 'Failed to load sender IDs' });
  }
});

app.post('/api/admin/route-matrix/sender-ids/request', async (req, res) => {
  const session = requireRouteMatrixSession(req, res);
  if (!session) return;
  const source = String(req.body.source || '').trim();
  const check = validateSenderId(source);
  if (!check.ok) return res.status(400).json({ error: check.error });

  try {
    const result = await withPortalSession(session.username, async (cookies) => {
      const out = await requestSenderId(cookies, source);
      if (!out.ok && /login|session|unauthorized/i.test(out.error || '')) {
        return { needsRefresh: true };
      }
      return out;
    });
    if (result.needsRefresh) {
      return res.status(401).json({ error: 'Test account portal session expired — sign in again' });
    }
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'SID request failed' });
    }

    db.prepare(`
      INSERT INTO sender_id_requests (requested_by, source, otus_sender_id, status, description, updated_at)
      VALUES (?, ?, ?, 'pending', ?, datetime('now'))
    `).run(session.username, check.value, result.senderId || null, result.description || 'Submitted to Vacotel for approval');

    res.json({ ok: true, source: check.value, sender_id: result.senderId, description: result.description });
  } catch (e) {
    console.error('Route matrix SID request error:', e);
    res.status(500).json({ error: e.message || 'SID request failed' });
  }
});

app.post('/api/admin/route-matrix/preview', (req, res) => {
  const session = requireRouteMatrixSession(req, res);
  if (!session) return;
  const parsed = parseMatrixPayload(req.body || {});
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const queue = buildRouteMatrixQueue(parsed.phones, parsed.sids, parsed.contents);
  const rate = SMS_RATE_EUR;
  const preview = [];
  for (let route = 0; route < ROUTE_MATRIX_ROUTE_COUNT && preview.length < 20; route++) {
    for (const item of queue) {
      if (preview.length >= 20) break;
      const analysis = analyzeMessage(item.text);
      preview.push({
        route,
        sid: item.source,
        phone: item.phone,
        text: item.text,
        parts: analysis.parts
      });
    }
  }
  const estCost = estimateCost(
    Array.from({ length: ROUTE_MATRIX_ROUTE_COUNT }, () => queue).flat(),
    rate,
    null
  );

  res.json({
    username: session.username,
    account_id: session.accountId,
    phone_count: parsed.phones.length,
    sid_count: parsed.sids.length,
    content_count: parsed.contents.length,
    routes: ROUTE_MATRIX_ROUTE_COUNT,
    per_route: parsed.per_route,
    total_sms: parsed.total_sms,
    estimated_cost: estCost,
    rate_per_sms: rate,
    preview
  });
});

app.get('/api/admin/route-matrix/status', (req, res) => {
  if (!routeMatrixRun) {
    return res.json({ running: false, run: null });
  }
  res.json({
    running: routeMatrixRun.status === 'running',
    run: {
      campaign_id: routeMatrixRun.campaignId,
      status: routeMatrixRun.status,
      username: routeMatrixRun.username,
      current_route: routeMatrixRun.currentRoute,
      sent: routeMatrixRun.sent,
      total_sms: routeMatrixRun.totalSms,
      error: routeMatrixRun.error || null,
      started_at: routeMatrixRun.startedAt,
      finished_at: routeMatrixRun.finishedAt || null
    }
  });
});

app.get('/api/admin/route-matrix/results/:campaignId', (req, res) => {
  const campaignId = Number(req.params.campaignId);
  if (!campaignId) return res.status(400).json({ error: 'Valid campaign id required' });
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const sends = db.prepare(`
    SELECT id, phone, message_text, source, segment_label, send_status, send_error_code, cost, sent_at
    FROM sends WHERE campaign_id = ? ORDER BY id ASC
  `).all(campaignId);
  const stats = {
    total: sends.length,
    sent: sends.filter(s => s.send_status === 'sent').length,
    failed: sends.filter(s => s.send_status === 'failed').length
  };
  res.json({ campaign, sends, stats });
});

app.post('/api/admin/route-matrix/run', async (req, res) => {
  const session = requireRouteMatrixSession(req, res);
  if (!session) return;
  if (routeMatrixRun && routeMatrixRun.status === 'running') {
    return res.status(409).json({ error: 'A route matrix run is already in progress' });
  }

  const parsed = parseMatrixPayload(req.body || {});
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const throttleMs = parseInt(req.body.throttle_ms) || 300;
  const rate = SMS_RATE_EUR;
  const queuePerRoute = buildRouteMatrixQueue(parsed.phones, parsed.sids, parsed.contents);
  const totalSms = parsed.total_sms;
  const estCost = estimateCost(
    Array.from({ length: ROUTE_MATRIX_ROUTE_COUNT }, () => queuePerRoute).flat(),
    rate,
    null
  );

  const balCheck = await checkBalanceForCost(session.username, estCost);
  if (!balCheck.ok) {
    const status = balCheck.needsRefresh ? 401 : 400;
    return res.status(status).json({
      error: balCheck.error,
      estimated_cost: estCost,
      balance: balCheck.balance
    });
  }

  const { listId } = createListFromPhones(
    `Route Matrix ${session.username} ${new Date().toISOString().slice(0, 16)}`,
    parsed.phones,
    session.username
  );
  const leadRows = db.prepare('SELECT id, phone FROM leads WHERE list_id = ?').all(listId);
  const phoneToLeadId = Object.fromEntries(leadRows.map(l => [l.phone, l.id]));
  const info = db.prepare(`
    INSERT INTO campaigns (name, list_id, roster_id, source, rotation_mode, status, rate_per_sms, throttle_ms, started_at, created_by)
    VALUES (?, ?, 0, ?, 'sequential', 'sending', ?, ?, datetime('now'), ?)
  `).run(
    `Route Matrix ${session.username} ${new Date().toLocaleString()}`,
    listId,
    parsed.sids.join(','),
    rate,
    throttleMs,
    session.username
  );
  const campaignId = info.lastInsertRowid;

  routeMatrixRun = {
    campaignId,
    status: 'running',
    username: session.username,
    accountId: session.accountId,
    adminUsername: req.adminUsername,
    currentRoute: 0,
    sent: 0,
    totalSms,
    error: null,
    startedAt: Date.now(),
    finishedAt: null
  };

  res.json({ ok: true, campaign_id: campaignId, total_sms: totalSms, estimated_cost: estCost });

  (async () => {
    try {
      for (let route = 0; route < ROUTE_MATRIX_ROUTE_COUNT; route++) {
        routeMatrixRun.currentRoute = route;
        const routeResult = await withAdminPortalSession(cookies =>
          changeAccountRoute(cookies, session.accountId, route)
        );
        if (routeResult.needsRefresh || !routeResult.ok) {
          throw new Error(routeResult.error || `Failed to set route ${route}`);
        }
        await new Promise(r => setTimeout(r, ROUTE_MATRIX_SETTLE_MS));

        const batch = queuePerRoute.map(item => ({
          ...item,
          segmentLabel: `route:${route}`
        }));
        await processSendQueue({
          username: session.username,
          queue: batch,
          campaignId,
          ratePerSms: rate,
          throttleMs,
          getText: item => item.text,
          getPhone: item => item.phone,
          getSource: item => item.source,
          getLeadId: item => phoneToLeadId[item.phone] ?? leadRows[0]?.id,
          getTemplateId: () => null,
          notePrefix: `Route matrix #${campaignId} route:${route}`
        });
        routeMatrixRun.sent += batch.length;
      }
      db.prepare("UPDATE campaigns SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(campaignId);
      routeMatrixRun.status = 'completed';
      routeMatrixRun.finishedAt = Date.now();
    } catch (e) {
      console.error('Route matrix run error:', e);
      db.prepare("UPDATE campaigns SET status = 'draft', completed_at = NULL WHERE id = ?").run(campaignId);
      routeMatrixRun.status = 'failed';
      routeMatrixRun.error = e.message || String(e);
      routeMatrixRun.finishedAt = Date.now();
    }
  })();
});

app.get('/api/admin/templates', (req, res) => {
  res.json({
    test: getSegmentTemplates('test'),
    campaign: getSegmentTemplates('campaign')
  });
});

app.put('/api/admin/templates', (req, res) => {
  const { purpose, m, p } = req.body;
  if (purpose !== 'test' && purpose !== 'campaign') {
    return res.status(400).json({ error: 'purpose must be test or campaign' });
  }
  const toLines = v => {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string') return parseLines(v);
    return [];
  };
  saveSegmentTemplates(purpose, { m: toLines(m), p: toLines(p) });
  res.json({ ok: true, ...getSegmentTemplates(purpose) });
});

app.get('/api/admin/sender-ids', async (req, res) => {
  try {
    const result = await withAdminPortalSession(cookies => listAdminSenderIds(cookies));
    if (result.needsRefresh) return res.status(401).json({ error: result.error });
    if (!result.ok) return res.status(502).json({ error: result.error || 'Could not load sender IDs' });
    res.json({ items: result.items });
  } catch (e) {
    console.error('Admin sender IDs error:', e);
    res.status(500).json({ error: e.message || 'Failed to load sender IDs' });
  }
});

app.get('/api/admin/sid-auto', (req, res) => {
  let lastRun = null;
  try {
    lastRun = JSON.parse(getSetting('sid_auto_last_run') || 'null');
  } catch (_) {}
  res.json({
    enabled: getSetting('sid_auto_approve') === '1',
    interval_ms: parseInt(getSetting('sid_auto_interval_ms')) || 180000,
    last_run: lastRun
  });
});

app.put('/api/admin/sid-auto', (req, res) => {
  const { enabled, interval_ms } = req.body;
  if (enabled !== undefined) setSetting('sid_auto_approve', enabled ? '1' : '0');
  if (interval_ms !== undefined) {
    const ms = Math.max(60000, parseInt(interval_ms) || 180000);
    setSetting('sid_auto_interval_ms', String(ms));
  }
  restartSidAutoPoller();
  res.json({
    ok: true,
    enabled: getSetting('sid_auto_approve') === '1',
    interval_ms: parseInt(getSetting('sid_auto_interval_ms')) || 180000
  });
});

// ---------- settings ----------
app.get('/api/settings', (req, res) => {
  res.json({
    vacotel_username: req.sessionUsername,
    default_rate_per_sms: SMS_RATE_EUR
  });
});

// ---------- sender IDs (Otus portal) ----------
app.get('/api/sender-ids', async (req, res) => {
  try {
    const result = await withPortalSession(req.sessionUsername, async (cookies) => {
      const list = await listSenderIds(cookies);
      if (!list.ok && portalSessionExpired(list.status, list.error)) {
        return { needsRefresh: true };
      }
      return list;
    });
    if (result.needsRefresh) {
      return res.status(401).json({ error: 'Portal session expired — sign in again' });
    }
    if (!result.ok) {
      return res.status(502).json({ error: result.error || 'Could not load sender IDs from Otus' });
    }

    const local = db.prepare(`
      SELECT id, source, otus_sender_id, status, description, created_at, updated_at
      FROM sender_id_requests WHERE requested_by = ? ORDER BY id DESC LIMIT 100
    `).all(req.sessionUsername);

    res.json({
      otus: result.items.map(item => ({
        otus_sender_id: item.SenderId,
        source: item.Sender,
        status: item.Status,
        active: item.Active,
        created_date: item.CreatedDate
      })),
      requests: local
    });
  } catch (e) {
    console.error('List sender IDs error:', e);
    res.status(500).json({ error: e.message || 'Failed to list sender IDs' });
  }
});

app.post('/api/sender-ids/request', async (req, res) => {
  const source = String(req.body.source || '').trim();
  const check = validateSenderId(source);
  if (!check.ok) return res.status(400).json({ error: check.error });

  try {
    const result = await withPortalSession(req.sessionUsername, async (cookies) => {
      const out = await requestSenderId(cookies, source);
      if (!out.ok && /login|session|unauthorized/i.test(out.error || '')) {
        return { needsRefresh: true };
      }
      return out;
    });
    if (result.needsRefresh) {
      return res.status(401).json({ error: 'Portal session expired — sign in again' });
    }
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'Sender ID request rejected' });
    }

    const info = db.prepare(`
      INSERT INTO sender_id_requests (requested_by, source, otus_sender_id, status, description, updated_at)
      VALUES (?, ?, ?, 'pending', ?, datetime('now'))
    `).run(req.sessionUsername, result.sender, result.senderId, result.description || 'Submitted to Vacotel for approval');

    res.json({
      ok: true,
      id: info.lastInsertRowid,
      source: result.sender,
      otus_sender_id: result.senderId,
      status: 'pending',
      description: result.description || 'Submitted to Vacotel for approval'
    });
  } catch (e) {
    console.error('Request sender ID error:', e);
    res.status(500).json({ error: e.message || 'Failed to request sender ID' });
  }
});

app.post('/api/sender-ids/delete', async (req, res) => {
  const ids = Array.isArray(req.body.otus_sender_ids) ? req.body.otus_sender_ids : [];
  if (!ids.length) return res.status(400).json({ error: 'otus_sender_ids array required' });

  try {
    const result = await withPortalSession(req.sessionUsername, async (cookies) => {
      const out = await deleteSenderIds(cookies, ids);
      if (!out.ok && /login|session|unauthorized/i.test(out.error || '')) return { needsRefresh: true };
      return out;
    });
    if (result.needsRefresh) {
      return res.status(401).json({ error: 'Portal session expired — sign in again' });
    }
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'Could not delete sender ID(s)' });
    }
    res.json({ ok: true, message: result.message });
  } catch (e) {
    console.error('Delete sender ID error:', e);
    res.status(500).json({ error: e.message || 'Failed to delete sender ID' });
  }
});

// ---------- balance (live from Otus account) ----------
app.get('/api/balance', async (req, res) => {
  try {
    const result = await fetchOtusBalance(req.sessionUsername);
    if (result.needsRefresh) {
      return res.status(401).json({ error: result.error });
    }
    if (!result.ok) {
      return res.status(502).json({ error: result.error || 'Could not fetch account balance' });
    }
    res.json({ balance: result.balance, currency: result.currency, raw: result.raw });
  } catch (e) {
    console.error('Balance fetch error:', e);
    res.status(500).json({ error: e.message || 'Failed to fetch balance' });
  }
});

// ---------- quick send (numbers × messages, single SID) ----------
function resolveQuickSendMessages(body) {
  const segment = body.segment === 'p' ? 'p' : 'm';
  return resolveSegmentMessages('test', segment) || [];
}

app.post('/api/quick-send/preview', upload.none(), (req, res) => {
  const source = String(req.body.source || '').trim();
  const phones = parsePhones(req.body.numbers || '');
  const segment = req.body.segment === 'p' ? 'p' : 'm';
  const messages = resolveQuickSendMessages(req.body);
  if (!source) return res.status(400).json({ error: 'Sender ID (SID) required' });
  if (!phones.length) return res.status(400).json({ error: 'At least one valid phone number required' });
  if (!messages.length) return res.status(400).json({ error: `No test messages configured for segment ${segment.toUpperCase()} — ask admin to add templates` });

  const queue = buildCartesianQueue(phones, messages);
  const rate = SMS_RATE_EUR;
  const preview = queue.slice(0, 20).map(item => {
    const analysis = analyzeMessage(item.text);
    return { phone: item.phone, text: item.text, parts: analysis.parts };
  });
  const estCost = estimateCost(queue, rate, null);

  res.json({
    phone_count: phones.length,
    message_count: messages.length,
    segment,
    total_sms: queue.length,
    estimated_cost: estCost,
    rate_per_sms: rate,
    preview
  });
});

app.post('/api/quick-send', upload.none(), async (req, res) => {
  const source = String(req.body.source || '').trim();
  const phones = parsePhones(req.body.numbers || '');
  const messages = resolveQuickSendMessages(req.body);
  const rate = SMS_RATE_EUR;
  const throttleMs = parseInt(req.body.throttle_ms) || 300;
  const segment = req.body.segment === 'p' ? 'p' : 'm';

  if (!source) return res.status(400).json({ error: 'Sender ID (SID) required' });
  if (!phones.length) return res.status(400).json({ error: 'At least one valid phone number required' });
  if (!messages.length) return res.status(400).json({ error: `No test messages configured for segment ${segment.toUpperCase()}` });

  const queue = buildCartesianQueue(phones, messages);
  const estCost = estimateCost(queue, rate, null);
  const balCheck = await checkBalanceForCost(req.sessionUsername, estCost);
  if (!balCheck.ok) {
    const status = balCheck.needsRefresh ? 401 : 400;
    return res.status(status).json({
      error: balCheck.error,
      estimated_cost: estCost,
      balance: balCheck.balance
    });
  }

  const { listId } = createListFromPhones(`Quick Send ${new Date().toISOString().slice(0, 16)}`, phones, req.sessionUsername);
  const leadRows = db.prepare('SELECT id, phone FROM leads WHERE list_id = ?').all(listId);
  const phoneToLeadId = Object.fromEntries(leadRows.map(l => [l.phone, l.id]));
  const info = db.prepare(`
    INSERT INTO campaigns (name, list_id, roster_id, source, rotation_mode, status, rate_per_sms, throttle_ms, started_at, created_by)
    VALUES (?, ?, 0, ?, 'sequential', 'sending', ?, ?, datetime('now'), ?)
  `).run(`Quick Send ${new Date().toLocaleString()}`, listId, source, rate, throttleMs, req.sessionUsername);
  const campaignId = info.lastInsertRowid;

  res.json({ ok: true, campaign_id: campaignId, total_sms: queue.length });

  try {
    await processSendQueue({
      username: req.sessionUsername,
      queue,
      campaignId,
      ratePerSms: rate,
      throttleMs,
      getText: item => item.text,
      getPhone: item => item.phone,
      getSource: () => source,
      getLeadId: item => phoneToLeadId[item.phone] ?? leadRows[0]?.id,
      getTemplateId: () => null,
      notePrefix: `Quick send #${campaignId}`
    });
    db.prepare("UPDATE campaigns SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(campaignId);
  } catch (e) {
    console.error('Quick send error:', e);
    db.prepare("UPDATE campaigns SET status = 'draft', completed_at = NULL WHERE id = ?").run(campaignId);
  }
});

// ---------- campaigns ----------
app.get('/api/campaigns', (req, res) => {
  const { start, end, label } = cetDaySqlRange();
  const campaigns = db.prepare(`
    SELECT c.*, ll.name as list_name, mr.name as roster_name,
      COALESCE(
        (SELECT SUM((SELECT COUNT(*) FROM leads l WHERE l.list_id = cs.list_id AND l.opted_out = 0))
         FROM campaign_segments cs WHERE cs.campaign_id = c.id),
        (SELECT COUNT(*) FROM leads l WHERE l.list_id = c.list_id AND l.opted_out = 0)
      ) as total_leads,
      (SELECT COUNT(*) FROM sends WHERE campaign_id = c.id) as sent_count,
      (SELECT COUNT(*) FROM sends WHERE campaign_id = c.id AND send_status = 'failed') as failed_count,
      (SELECT COALESCE(SUM(cost), 0) FROM sends WHERE campaign_id = c.id) as total_spend
    FROM campaigns c
    JOIN lead_lists ll ON ll.id = c.list_id AND ll.created_by = c.created_by
    LEFT JOIN message_rosters mr ON mr.id = c.roster_id AND c.roster_id > 0 AND mr.created_by = c.created_by
    WHERE c.created_at >= ? AND c.created_at < ?
      AND c.created_by = ?
    ORDER BY c.id DESC
  `).all(start, end, req.sessionUsername);
  res.json({ day: label, timezone: CET_TZ, campaigns });
});

// Launch campaign: inline uploads for messages + per-user lead lists/SIDs
app.post('/api/campaigns/launch', upload.fields([
  { name: 'segment_files', maxCount: 20 }
]), (req, res) => {
  try {
  let payload;
  try {
    payload = JSON.parse(req.body.payload || '{}');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid payload JSON' });
  }

  const { name, rotation_mode, rate_per_sms, throttle_ms, roster_id, segments, segment } = payload;
  if (!name) return res.status(400).json({ error: 'Campaign name required' });
  if (!Array.isArray(segments) || !segments.length) return res.status(400).json({ error: 'At least one client segment required' });

  let resolvedRosterId = roster_id;
  if (!resolvedRosterId) {
    const seg = segment === 'p' ? 'p' : 'm';
    const msgList = resolveSegmentMessages('campaign', seg);
    if (!msgList || !msgList.length) {
      return res.status(400).json({ error: `No campaign messages configured for segment ${seg.toUpperCase()} — ask admin to add templates` });
    }
    const { rosterId } = createRosterFromMessages(`${name} — ${seg.toUpperCase()}`, msgList, req.sessionUsername);
    resolvedRosterId = rosterId;
  }

  const segmentFiles = req.files?.segment_files || [];
  const resolvedSegments = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const source = String(seg.source || '').trim();
    if (!source) return res.status(400).json({ error: `Segment ${i + 1}: Sender ID required` });

    let listId = seg.list_id;
    if (listId && !ownedLeadListOrNull(listId, req.sessionUsername)) {
      return res.status(403).json({ error: `Segment ${i + 1}: lead list not found` });
    }
    const file = segmentFiles[i];
    if (!listId && file) {
        const text = file.buffer.toString('utf8');
        const filename = file.originalname.toLowerCase();
        let parsed = [];
        if (filename.endsWith('.csv')) {
          let records;
          try {
            records = parse(text, { columns: true, skip_empty_lines: true, trim: true });
          } catch (e) {
            return res.status(400).json({ error: `Segment ${i + 1}: could not parse CSV` });
          }
          const cols = Object.keys(records[0] || {});
          const phoneCol = cols.find(c => /phone|mobile|destination|number/i.test(c)) || cols[0];
          const seen = new Set();
          for (const r of records) {
            const phone = normalizeDestination(r[phoneCol]);
            if (!/^\d{7,15}$/.test(phone) || seen.has(phone)) continue;
            seen.add(phone);
            parsed.push(phone);
          }
        } else {
          parsed = parsePhones(text);
        }
        if (!parsed.length) return res.status(400).json({ error: `Segment ${i + 1}: no valid numbers in file` });
        const created = createListFromPhones(`${name} — ${seg.label || 'segment ' + (i + 1)}`, parsed, req.sessionUsername);
        listId = created.listId;
    } else if (!listId && seg.phones) {
      const phones = parsePhones(seg.phones);
      if (!phones.length) return res.status(400).json({ error: `Segment ${i + 1}: no valid numbers` });
      const created = createListFromPhones(`${name} — ${seg.label || 'segment ' + (i + 1)}`, phones, req.sessionUsername);
      listId = created.listId;
    } else if (!listId) {
      return res.status(400).json({ error: `Segment ${i + 1}: provide numbers, CSV, or list_id` });
    }
    resolvedSegments.push({ list_id: listId, source, label: seg.label || null });
  }

  const rate = SMS_RATE_EUR;
  const info = db.prepare(`
    INSERT INTO campaigns (name, list_id, roster_id, source, rotation_mode, rate_per_sms, throttle_ms, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, resolvedSegments[0].list_id, resolvedRosterId, resolvedSegments[0].source, rotation_mode || 'sequential', rate, throttle_ms || 300, req.sessionUsername);
  const campaignId = info.lastInsertRowid;

  const insertSeg = db.prepare('INSERT INTO campaign_segments (campaign_id, list_id, source, label, sort_order) VALUES (?, ?, ?, ?, ?)');
  resolvedSegments.forEach((s, i) => insertSeg.run(campaignId, s.list_id, s.source, s.label, i));

  res.json({ ok: true, campaign_id: campaignId, roster_id: resolvedRosterId, segments: resolvedSegments.length });
  } catch (e) {
    console.error('Launch campaign error:', e);
    res.status(500).json({ error: e.message || 'Launch failed' });
  }
});

// Preview: shows the first N leads with their assigned message, without sending
app.get('/api/campaigns/:id/preview', (req, res) => {
  const campaign = ownedCampaignOr404(req, res);
  if (!campaign) return;

  const segments = getCampaignSegments(campaign.id).map(seg => ({
    ...seg,
    leads: loadSegmentLeads(seg)
  })).filter(s => s.leads.length);

  const templates = db.prepare('SELECT * FROM message_templates WHERE roster_id = ? ORDER BY id').all(campaign.roster_id);
  if (!templates.length) return res.status(400).json({ error: 'roster has no templates' });
  if (!segments.length) return res.status(400).json({ error: 'no leads in any segment' });

  const interleaved = buildInterleavedQueue(segments);
  const withTemplates = assignTemplates(interleaved, templates, campaign.rotation_mode);
  const preview = withTemplates.slice(0, 15).map(item => {
    const text = fillTemplate(item.template.text, item.lead);
    const analysis = analyzeMessage(text);
    return {
      phone: item.lead.phone,
      name: item.lead.name,
      text,
      source: item.source,
      segment: item.segmentLabel,
      parts: analysis.parts
    };
  });

  const estCost = estimateCost(withTemplates, campaign.rate_per_sms, item => fillTemplate(item.template.text, item.lead));

  res.json({
    preview,
    template_count: templates.length,
    total_leads: interleaved.length,
    segment_count: segments.length,
    estimated_cost: estCost
  });
});

// Send: interleaves segments proportionally, one SMS per lead, rotating templates
app.post('/api/campaigns/:id/send', async (req, res) => {
  const campaign = ownedCampaignOr404(req, res);
  if (!campaign) return;
  if (campaign.status === 'sending' || campaign.status === 'completed') {
    return res.status(400).json({ error: `campaign already ${campaign.status}` });
  }

  const segments = getCampaignSegments(campaign.id).map(seg => ({
    ...seg,
    leads: loadSegmentLeads(seg)
  })).filter(s => s.leads.length);

  const templates = db.prepare('SELECT * FROM message_templates WHERE roster_id = ? ORDER BY id').all(campaign.roster_id);
  if (!templates.length) return res.status(400).json({ error: 'roster has no templates' });
  if (!segments.length) return res.status(400).json({ error: 'no leads in any segment' });

  const interleaved = buildInterleavedQueue(segments);
  const queue = assignTemplates(interleaved, templates, campaign.rotation_mode);

  const estCost = estimateCost(queue, campaign.rate_per_sms, item => fillTemplate(item.template.text, item.lead));
  const balCheck = await checkBalanceForCost(req.sessionUsername, estCost);
  if (!balCheck.ok) {
    const status = balCheck.needsRefresh ? 401 : 400;
    return res.status(status).json({
      error: balCheck.error || `Estimated cost (€${estCost.toFixed(2)}) exceeds available balance`,
      estimated_cost: estCost,
      balance: balCheck.balance
    });
  }

  db.prepare("UPDATE campaigns SET status = 'sending', started_at = datetime('now') WHERE id = ?").run(campaign.id);
  res.json({ ok: true, started: true, lead_count: queue.length, segment_count: segments.length });

  await processSendQueue({
    username: req.sessionUsername,
    queue,
    campaignId: campaign.id,
    ratePerSms: campaign.rate_per_sms,
    throttleMs: campaign.throttle_ms,
    getText: item => fillTemplate(item.template.text, item.lead),
    getPhone: item => item.lead.phone,
    getSource: item => item.source,
    getLeadId: item => item.lead.id,
    getTemplateId: item => item.template.id,
    notePrefix: `Campaign #${campaign.id}`
  });

  db.prepare("UPDATE campaigns SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(campaign.id);
});

app.get('/api/campaigns/:id/sends', (req, res) => {
  if (!ownedCampaignOr404(req, res)) return;
  const sends = db.prepare('SELECT * FROM sends WHERE campaign_id = ? ORDER BY id').all(req.params.id);
  res.json(sends);
});

app.get('/api/campaigns/:id/status', (req, res) => {
  const campaign = ownedCampaignOr404(req, res);
  if (!campaign) return;
  const segments = getCampaignSegments(campaign.id);
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN send_status = 'sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN send_status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(cost) as total_cost
    FROM sends WHERE campaign_id = ?
  `).get(req.params.id);
  res.json({ campaign, segments, stats });
});

// ---------- traffic report (live from Otus portal) ----------
app.get('/api/traffic', async (req, res) => {
  const filters = {
    dateFrom: String(req.query.date_from || '').trim(),
    dateTo: String(req.query.date_to || '').trim(),
    senderId: String(req.query.sender_id || '').trim(),
    address: String(req.query.address || '').trim(),
    status: String(req.query.status || '').trim()
  };
  if (!filters.dateFrom || !filters.dateTo) {
    return res.status(400).json({ error: 'date_from and date_to required (YYYY-MM-DD)' });
  }

  try {
    const result = await withPortalSession(req.sessionUsername, async (cookies) => {
      const out = await readTraffic(cookies, filters);
      if (!out.ok && portalSessionExpired(out.status, out.error)) return { needsRefresh: true };
      return out;
    });
    if (result.needsRefresh) {
      return res.status(401).json({ error: 'Portal session expired — sign in again' });
    }
    if (!result.ok) {
      return res.status(502).json({ error: result.error || 'Could not load traffic report' });
    }
    res.json({
      data: result.data,
      totalTraffic: result.totalTraffic,
      totalParts: result.totalParts,
      totalDelivered: result.totalDelivered,
      totalCost: result.totalCost,
      recordsTotal: result.recordsTotal,
      rowsLimit: result.rowsLimit
    });
  } catch (e) {
    console.error('Traffic fetch error:', e);
    res.status(500).json({ error: e.message || 'Failed to load traffic' });
  }
});

// ---------- reports ----------
app.get('/api/reports/summary', async (req, res) => {
  const { start, end, label } = cetDaySqlRange();
  const username = req.sessionUsername;

  let stats = { total_sends: 0, delivered: 0, failed: 0 };
  try {
    const traffic = await withPortalSession(username, cookies => readTraffic(cookies, {
      dateFrom: label,
      dateTo: label
    }));
    if (traffic.needsRefresh) {
      return res.status(401).json({ error: 'Portal session expired — sign in again' });
    }
    if (traffic.ok) {
      const rows = traffic.data || [];
      const total = traffic.totalTraffic ?? rows.length;
      let delivered = traffic.totalDelivered;
      if (delivered == null || delivered === 0) {
        delivered = rows.filter(r => String(r.StringStatus || '').toLowerCase() === 'delivered').length;
      }
      let failed = rows.filter(r => {
        const s = String(r.StringStatus || '').toLowerCase();
        return s === 'failed' || s === 'rejected' || s === 'undelivered';
      }).length;
      if (!failed && total > delivered) failed = total - delivered;
      stats = { total_sends: total, delivered, failed };
    }
  } catch (e) {
    console.error('Dashboard traffic error:', e);
  }

  const byErrorCode = db.prepare(`
    SELECT send_error_code, COUNT(*) as count FROM sends
    WHERE send_status = 'failed' AND sent_at >= ? AND sent_at < ?
      AND sent_by = ?
    GROUP BY send_error_code
  `).all(start, end, username).map(r => ({ ...r, description: ERROR_CODES[String(r.send_error_code)] || 'Unknown' }));

  let balance = null;
  try {
    const bal = await fetchOtusBalance(username);
    if (bal.ok) balance = bal.balance;
  } catch (e) { /* dashboard still works without balance */ }
  res.json({ stats, byErrorCode, balance, day: label, timezone: CET_TZ });
});

app.get('/api/campaigns/:id/export.csv', (req, res) => {
  if (!ownedCampaignOr404(req, res)) return;
  const sends = db.prepare('SELECT * FROM sends WHERE campaign_id = ? ORDER BY id').all(req.params.id);
  const header = 'phone,source,message,send_status,error_code,vendor_message_id,parts,cost,sent_at\n';
  const rows = sends.map(s => [
    s.phone, s.source || '', `"${(s.message_text || '').replace(/"/g, '""')}"`, s.send_status, s.send_error_code,
    s.vendor_message_id || '', s.message_parts, s.cost, s.sent_at || ''
  ].join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="campaign-${req.params.id}-report.csv"`);
  res.send(header + rows.join('\n'));
});

const PORT = process.env.PORT || 3000;

// ---------- background SID auto-approve ----------
let sidAutoTimer = null;

async function runSidAutoApprove() {
  if (getSetting('sid_auto_approve') !== '1') return;
  const { username, password } = getAdminEnvCredentials();
  if (!username || !password) return;

  const log = { at: new Date().toISOString(), approved: 0, errors: [] };
  try {
    const result = await withAdminPortalSession(async (cookies) => {
      const list = await listAdminSenderIds(cookies);
      if (!list.ok) return list;
      const pending = (list.items || []).filter(s => Number(s.Active) === 2);
      if (!pending.length) return { ok: true, approved: 0 };
      const ids = pending.map(s => s.AllowedSenderId);
      const out = await updateSenderIdStatus(cookies, ids, 1);
      if (!out.ok) return out;
      return { ok: true, approved: ids.length, ids };
    });
    if (result.needsRefresh) {
      log.errors.push(result.error || 'Session expired');
    } else if (!result.ok) {
      log.errors.push(result.error || 'Auto-approve failed');
    } else {
      log.approved = result.approved || 0;
      if (result.ids) log.ids = result.ids;
    }
  } catch (e) {
    log.errors.push(e.message || String(e));
  }
  setSetting('sid_auto_last_run', JSON.stringify(log));
}

function restartSidAutoPoller() {
  if (sidAutoTimer) clearInterval(sidAutoTimer);
  sidAutoTimer = null;
  if (getSetting('sid_auto_approve') !== '1') return;
  const { username, password } = getAdminEnvCredentials();
  if (!username || !password) return;
  const ms = Math.max(60000, parseInt(getSetting('sid_auto_interval_ms')) || 180000);
  sidAutoTimer = setInterval(() => runSidAutoApprove(), ms);
  runSidAutoApprove();
}

// Recover campaigns stuck in 'sending' with no recorded sends (e.g. after a crash)
db.prepare(`
  UPDATE campaigns SET status = 'draft', started_at = NULL
  WHERE status = 'sending'
    AND id NOT IN (SELECT DISTINCT campaign_id FROM sends WHERE campaign_id IS NOT NULL)
`).run();

app.listen(PORT, () => {
  db.migratePerUserOwnership();
  migrateLegacyUserCredentials(getSetting);
  purgeLegacyAdminSettings();
  console.log(`Dispatch SMS Console running at http://localhost:${PORT}`);
  console.log(`Admin console at http://localhost:${PORT}/admin`);
  restartSidAutoPoller();
});
