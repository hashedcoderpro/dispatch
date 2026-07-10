const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const path = require('path');
const db = require('./db');
const {
  VACOTEL_GATEWAY_URL,
  sendSms,
  analyzeMessage,
  normalizeDestination,
  probeVacotelApi,
  validateVacotelCredentials,
  ERROR_CODES,
  DLR_STATUS
} = require('./vacotelClient');
const {
  parseLines, parsePhones, buildInterleavedQueue, buildCartesianQueue, assignTemplates, estimateCost
} = require('./sendHelpers');
const {
  portalLogin,
  requestSenderId,
  listSenderIds,
  deleteSenderIds,
  readTraffic,
  getAccountBalance,
  parseStoredCookies,
  validateSenderId
} = require('./otusPortalClient');

const SMS_RATE_EUR = 0.05;

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/status']);

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

function signSession(username) {
  const payload = JSON.stringify({ username, exp: Date.now() + SESSION_MAX_AGE_MS });
  const body = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(req) {
  const token = parseCookies(req).dispatch_session;
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
    return data.username;
  } catch {
    return null;
  }
}

function setSessionCookie(res, username) {
  res.setHeader('Set-Cookie', `dispatch_session=${signSession(username)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'dispatch_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function requireAuth(req, res, next) {
  if (!req.path.startsWith('/api/') || req.path === '/api/dlr' || PUBLIC_API.has(req.path)) return next();
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  if (!getSetting('vacotel_username') || !getSetting('vacotel_api_id')) {
    return res.status(401).json({ error: 'Vacotel credentials not configured' });
  }
  req.sessionUsername = username;
  next();
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

async function refreshPortalSession() {
  const username = getSetting('vacotel_username');
  const password = getSetting('vacotel_password');
  if (!username || !password) return { ok: false, error: 'Portal password not configured' };
  const login = await portalLogin(username, password);
  if (!login.ok) {
    setSetting('otus_portal_cookies', '');
    return login;
  }
  setSetting('otus_portal_cookies', JSON.stringify(login.cookies));
  return { ok: true, cookies: login.cookies };
}

async function getPortalCookies({ forceRefresh } = {}) {
  if (!forceRefresh) {
    const jar = parseStoredCookies(getSetting('otus_portal_cookies'));
    if (jar) return { ok: true, cookies: jar };
  }
  return refreshPortalSession();
}

async function withPortalSession(fn) {
  let session = await getPortalCookies();
  if (!session.ok) return session;
  let result = await fn(session.cookies);
  if (result.needsRefresh) {
    session = await getPortalCookies({ forceRefresh: true });
    if (!session.ok) return session;
    result = await fn(session.cookies);
  }
  return result;
}

function portalSessionExpired(status, text) {
  return status === 401 || status === 403 || /login|unauthorized|session/i.test(text || '');
}

async function fetchOtusBalance() {
  const result = await withPortalSession(async (cookies) => {
    const out = await getAccountBalance(cookies);
    if (!out.ok && portalSessionExpired(out.status, out.error)) return { needsRefresh: true };
    return out;
  });
  if (result.needsRefresh) {
    return { ok: false, error: 'Portal session expired — sign in again', needsRefresh: true };
  }
  return result;
}

async function checkBalanceForCost(estimatedCostEur) {
  const bal = await fetchOtusBalance();
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

function createRosterFromMessages(name, messages) {
  const insertRoster = db.prepare('INSERT INTO message_rosters (name) VALUES (?)');
  const insertTpl = db.prepare('INSERT INTO message_templates (roster_id, text) VALUES (?, ?)');
  const info = insertRoster.run(name);
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

function createListFromPhones(name, phones) {
  const insertList = db.prepare('INSERT INTO lead_lists (name) VALUES (?)');
  const insertLead = db.prepare('INSERT INTO leads (list_id, phone) VALUES (?, ?)');
  const info = insertList.run(name);
  const listId = info.lastInsertRowid;
  for (const phone of phones) insertLead.run(listId, phone);
  return { listId, count: phones.length };
}

async function processSendQueue({ queue, campaignId, ratePerSms, throttleMs, getText, getPhone, getSource, getLeadId, getTemplateId, notePrefix }) {
  const username = getSetting('vacotel_username');
  const apiId = getSetting('vacotel_api_id');
  const testMode = getSetting('test_mode') === '1';

  const insertSend = db.prepare(`
    INSERT INTO sends (campaign_id, lead_id, template_id, phone, message_text, data_coding,
      vendor_message_id, send_error_code, send_status, message_count, message_parts, cost, source, segment_label, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
        username,
        apiId,
        destination: phone,
        source,
        text,
        dataCoding,
        testMode
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
      item.segmentLabel || null
    );
    if (throttleMs) await new Promise(r => setTimeout(r, throttleMs));
  }
}

// ---------- auth ----------
app.get('/api/auth/status', (req, res) => {
  const username = verifySession(req);
  res.json({
    authenticated: !!username,
    username: username || getSetting('vacotel_username') || null,
    portal_connected: !!parseStoredCookies(getSetting('otus_portal_cookies'))
  });
});

app.post('/api/auth/login', async (req, res) => {
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

  setSetting('vacotel_username', username);
  setSetting('vacotel_password', password);
  setSetting('vacotel_api_id', apiId);
  setSetting('vacotel_base_url', VACOTEL_GATEWAY_URL);
  setSetting('otus_portal_cookies', JSON.stringify(portal.cookies));
  setSessionCookie(res, username);
  res.json({ ok: true, username, portal_connected: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  setSetting('otus_portal_cookies', '');
  res.json({ ok: true });
});

// ---------- settings ----------
app.get('/api/settings', (req, res) => {
  res.json({
    vacotel_username: getSetting('vacotel_username'),
    test_mode: getSetting('test_mode') === '1',
    default_rate_per_sms: SMS_RATE_EUR
  });
});

app.post('/api/settings', (req, res) => {
  const { test_mode } = req.body;
  if (test_mode !== undefined) setSetting('test_mode', test_mode ? '1' : '0');
  setSetting('default_rate_per_sms', String(SMS_RATE_EUR));
  res.json({ ok: true, test_mode: getSetting('test_mode') === '1' });
});

// ---------- sender IDs (Otus portal) ----------
app.get('/api/sender-ids', async (req, res) => {
  try {
    const result = await withPortalSession(async (cookies) => {
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
      FROM sender_id_requests ORDER BY id DESC LIMIT 100
    `).all();

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
    const result = await withPortalSession(async (cookies) => {
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
    const result = await withPortalSession(async (cookies) => {
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
    const result = await fetchOtusBalance();
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
function resolveQuickSendMessages(body, file) {
  if (file) {
    const text = file.buffer.toString('utf8');
    if (file.originalname.toLowerCase().endsWith('.csv')) {
      const records = parse(text, { columns: false, skip_empty_lines: true, trim: true });
      return records.map(r => String(r[0]).trim()).filter(Boolean);
    }
    return parseLines(text);
  }
  if (Array.isArray(body.messages) && body.messages.length) {
    return body.messages.map(m => String(m).trim()).filter(Boolean);
  }
  if (body.message) {
    return parseLines(body.message);
  }
  return [];
}

app.post('/api/quick-send/preview', upload.single('message_file'), (req, res) => {
  const source = String(req.body.source || '').trim();
  const phones = parsePhones(req.body.numbers || '');
  const messages = resolveQuickSendMessages(req.body, req.file);
  if (!source) return res.status(400).json({ error: 'Sender ID (SID) required' });
  if (!phones.length) return res.status(400).json({ error: 'At least one valid phone number required' });
  if (!messages.length) return res.status(400).json({ error: 'At least one message required (text box or file)' });

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
    total_sms: queue.length,
    estimated_cost: estCost,
    rate_per_sms: rate,
    preview
  });
});

app.post('/api/quick-send', upload.single('message_file'), async (req, res) => {
  const source = String(req.body.source || '').trim();
  const phones = parsePhones(req.body.numbers || '');
  const messages = resolveQuickSendMessages(req.body, req.file);
  const rate = SMS_RATE_EUR;
  const throttleMs = parseInt(req.body.throttle_ms) || 300;

  if (!source) return res.status(400).json({ error: 'Sender ID (SID) required' });
  if (!phones.length) return res.status(400).json({ error: 'At least one valid phone number required' });
  if (!messages.length) return res.status(400).json({ error: 'At least one message required' });

  const queue = buildCartesianQueue(phones, messages);
  const estCost = estimateCost(queue, rate, null);
  if (getSetting('test_mode') !== '1') {
    const balCheck = await checkBalanceForCost(estCost);
    if (!balCheck.ok) {
      const status = balCheck.needsRefresh ? 401 : 400;
      return res.status(status).json({
        error: balCheck.error,
        estimated_cost: estCost,
        balance: balCheck.balance
      });
    }
  }

  const { listId } = createListFromPhones(`Quick Send ${new Date().toISOString().slice(0, 16)}`, phones);
  const leadRows = db.prepare('SELECT id, phone FROM leads WHERE list_id = ?').all(listId);
  const phoneToLeadId = Object.fromEntries(leadRows.map(l => [l.phone, l.id]));
  const info = db.prepare(`
    INSERT INTO campaigns (name, list_id, roster_id, source, rotation_mode, status, rate_per_sms, throttle_ms, started_at)
    VALUES (?, ?, 0, ?, 'sequential', 'sending', ?, ?, datetime('now'))
  `).run(`Quick Send ${new Date().toLocaleString()}`, listId, source, rate, throttleMs);
  const campaignId = info.lastInsertRowid;

  res.json({ ok: true, campaign_id: campaignId, total_sms: queue.length });

  try {
    await processSendQueue({
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

// ---------- lead lists ----------
app.get('/api/lead-lists', (req, res) => {
  const lists = db.prepare(`
    SELECT ll.*, (SELECT COUNT(*) FROM leads WHERE list_id = ll.id) as lead_count
    FROM lead_lists ll ORDER BY id DESC
  `).all();
  res.json(lists);
});

app.post('/api/lead-lists', upload.single('file'), (req, res) => {
  const name = (req.body.name || '').trim() || req.file?.originalname || 'Lead list';

  if (req.file) {
    const filename = req.file.originalname.toLowerCase();
    if (!filename.endsWith('.csv')) {
      const phones = parsePhones(req.file.buffer.toString('utf8'));
      if (!phones.length) return res.status(400).json({ error: 'No valid phone numbers in file' });
      const created = createListFromPhones(name, phones);
      return res.json({ ok: true, list_id: created.listId, inserted: created.count, skipped: 0 });
    }
  } else if (req.body.numbers) {
    const phones = parsePhones(req.body.numbers);
    if (!phones.length) return res.status(400).json({ error: 'No valid phone numbers' });
    const created = createListFromPhones(name, phones);
    return res.json({ ok: true, list_id: created.listId, inserted: created.count, skipped: 0 });
  } else {
    return res.status(400).json({ error: 'Paste numbers or upload a .txt / .csv file' });
  }

  // CSV upload (req.file is present and .csv)
  let records;
  try {
    records = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return res.status(400).json({ error: 'Could not parse CSV: ' + e.message });
  }
  if (!records.length) return res.status(400).json({ error: 'CSV is empty' });

  // find phone column flexibly
  const cols = Object.keys(records[0]);
  const phoneCol = cols.find(c => /phone|mobile|destination|number/i.test(c)) || cols[0];
  const nameCol = cols.find(c => /^name$|first.?name|full.?name/i.test(c));
  const custom1Col = cols.find(c => /custom1|company|note/i.test(c));
  const custom2Col = cols.find(c => /custom2|account|id$/i.test(c));

  const insertList = db.prepare('INSERT INTO lead_lists (name) VALUES (?)');
  const insertLead = db.prepare('INSERT INTO leads (list_id, phone, name, custom1, custom2) VALUES (?, ?, ?, ?, ?)');

  let inserted = 0, skipped = 0;
  const tx = db.transaction(() => {
    const info = insertList.run(name);
    const listId = info.lastInsertRowid;
    const seen = new Set();
    for (const r of records) {
      const rawPhone = r[phoneCol];
      if (!rawPhone) { skipped++; continue; }
      const phone = normalizeDestination(rawPhone);
      if (!/^\d{7,15}$/.test(phone)) { skipped++; continue; }
      if (seen.has(phone)) { skipped++; continue; }
      seen.add(phone);
      insertLead.run(listId, phone, nameCol ? r[nameCol] : null, custom1Col ? r[custom1Col] : null, custom2Col ? r[custom2Col] : null);
      inserted++;
    }
    return listId;
  });

  const listId = tx();
  res.json({ ok: true, list_id: listId, inserted, skipped, detected_columns: { phoneCol, nameCol, custom1Col, custom2Col } });
});

app.get('/api/lead-lists/:id/leads', (req, res) => {
  const leads = db.prepare('SELECT * FROM leads WHERE list_id = ? ORDER BY id').all(req.params.id);
  res.json(leads);
});

app.delete('/api/lead-lists/:id', (req, res) => {
  db.prepare('DELETE FROM leads WHERE list_id = ?').run(req.params.id);
  db.prepare('DELETE FROM lead_lists WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- message rosters ----------
app.get('/api/rosters', (req, res) => {
  const rosters = db.prepare(`
    SELECT mr.*, (SELECT COUNT(*) FROM message_templates WHERE roster_id = mr.id) as template_count
    FROM message_rosters mr ORDER BY id DESC
  `).all();
  res.json(rosters);
});

app.post('/api/rosters', (req, res) => {
  // accepts either { name, messages: [text, ...] } as JSON, used for both
  // pasted-in text and CSV-parsed-on-the-client-then-posted flows
  const { name, messages } = req.body;
  if (!name || !Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'name and messages[] required' });
  }
  const insertRoster = db.prepare('INSERT INTO message_rosters (name) VALUES (?)');
  const insertTpl = db.prepare('INSERT INTO message_templates (roster_id, text) VALUES (?, ?)');
  const tx = db.transaction(() => {
    const info = insertRoster.run(name);
    const rosterId = info.lastInsertRowid;
    let count = 0;
    for (const m of messages) {
      const text = String(m).trim();
      if (!text) continue;
      insertTpl.run(rosterId, text);
      count++;
    }
    return { rosterId, count };
  });
  const result = tx();
  res.json({ ok: true, roster_id: result.rosterId, inserted: result.count });
});

app.post('/api/rosters/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV/TXT file required' });
  const name = req.body.name || req.file.originalname;
  const text = req.file.buffer.toString('utf8');
  let messages;
  if (req.file.originalname.toLowerCase().endsWith('.csv')) {
    const records = parse(text, { columns: false, skip_empty_lines: true, trim: true });
    messages = records.map(r => r[0]);
  } else {
    messages = text.split('\n');
  }
  messages = messages.map(m => m.trim()).filter(Boolean);
  if (!messages.length) return res.status(400).json({ error: 'No messages found in file' });

  const insertRoster = db.prepare('INSERT INTO message_rosters (name) VALUES (?)');
  const insertTpl = db.prepare('INSERT INTO message_templates (roster_id, text) VALUES (?, ?)');
  const tx = db.transaction(() => {
    const info = insertRoster.run(name);
    const rosterId = info.lastInsertRowid;
    for (const m of messages) insertTpl.run(rosterId, m);
    return rosterId;
  });
  const rosterId = tx();
  res.json({ ok: true, roster_id: rosterId, inserted: messages.length });
});

app.get('/api/rosters/:id/templates', (req, res) => {
  const templates = db.prepare('SELECT * FROM message_templates WHERE roster_id = ? ORDER BY id').all(req.params.id);
  res.json(templates);
});

app.delete('/api/rosters/:id', (req, res) => {
  db.prepare('DELETE FROM message_templates WHERE roster_id = ?').run(req.params.id);
  db.prepare('DELETE FROM message_rosters WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- campaigns ----------
app.get('/api/campaigns', (req, res) => {
  const campaigns = db.prepare(`
    SELECT c.*, ll.name as list_name, mr.name as roster_name,
      COALESCE(
        (SELECT SUM((SELECT COUNT(*) FROM leads l WHERE l.list_id = cs.list_id AND l.opted_out = 0))
         FROM campaign_segments cs WHERE cs.campaign_id = c.id),
        (SELECT COUNT(*) FROM leads l WHERE l.list_id = c.list_id AND l.opted_out = 0)
      ) as total_leads,
      (SELECT COUNT(*) FROM sends WHERE campaign_id = c.id) as sent_count,
      (SELECT COUNT(*) FROM sends WHERE campaign_id = c.id AND send_status = 'failed') as failed_count,
      (SELECT COUNT(*) FROM sends WHERE campaign_id = c.id AND dlr_status = 'Delivered') as delivered_count,
      (SELECT COALESCE(SUM(cost), 0) FROM sends WHERE campaign_id = c.id) as total_spend
    FROM campaigns c
    JOIN lead_lists ll ON ll.id = c.list_id
    LEFT JOIN message_rosters mr ON mr.id = c.roster_id AND c.roster_id > 0
    ORDER BY c.id DESC
  `).all();
  res.json(campaigns);
});

app.post('/api/campaigns', (req, res) => {
  const { name, list_id, roster_id, source, rotation_mode, rate_per_sms, throttle_ms, segments } = req.body;
  if (!name || !roster_id) {
    return res.status(400).json({ error: 'name and roster_id required' });
  }

  const segList = Array.isArray(segments) && segments.length ? segments : null;
  if (!segList && (!list_id || !source)) {
    return res.status(400).json({ error: 'list_id and source required (or provide segments[])' });
  }

  const primaryList = segList ? segList[0].list_id : list_id;
  const primarySource = segList ? segList[0].source : source;
  const rate = SMS_RATE_EUR;

  const info = db.prepare(`
    INSERT INTO campaigns (name, list_id, roster_id, source, rotation_mode, rate_per_sms, throttle_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, primaryList, roster_id, primarySource, rotation_mode || 'sequential', rate, throttle_ms || 300);
  const campaignId = info.lastInsertRowid;

  if (segList) {
    const insertSeg = db.prepare('INSERT INTO campaign_segments (campaign_id, list_id, source, label, sort_order) VALUES (?, ?, ?, ?, ?)');
    segList.forEach((s, i) => {
      if (!s.list_id || !s.source) throw new Error('Each segment needs list_id and source (SID)');
      insertSeg.run(campaignId, s.list_id, s.source, s.label || null, i);
    });
  }

  res.json({ ok: true, campaign_id: campaignId });
});

// Launch campaign: inline uploads for messages + per-client lead lists/SIDs
app.post('/api/campaigns/launch', upload.fields([
  { name: 'message_file', maxCount: 1 },
  { name: 'segment_files', maxCount: 20 }
]), (req, res) => {
  try {
  let payload;
  try {
    payload = JSON.parse(req.body.payload || '{}');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid payload JSON' });
  }

  const { name, rotation_mode, rate_per_sms, throttle_ms, roster_id, segments } = payload;
  if (!name) return res.status(400).json({ error: 'Campaign name required' });
  if (!Array.isArray(segments) || !segments.length) return res.status(400).json({ error: 'At least one client segment required' });

  let resolvedRosterId = roster_id;
  const messages = payload.messages || [];
  if (!resolvedRosterId) {
    const msgFile = req.files?.message_file?.[0];
    let msgList = messages.map(m => String(m).trim()).filter(Boolean);
    if (msgFile) {
      const text = msgFile.buffer.toString('utf8');
      if (msgFile.originalname.toLowerCase().endsWith('.csv')) {
        const records = parse(text, { columns: false, skip_empty_lines: true, trim: true });
        msgList = records.map(r => String(r[0]).trim()).filter(Boolean);
      } else {
        msgList = parseLines(text);
      }
    }
    if (!msgList.length) return res.status(400).json({ error: 'Upload or paste at least one message' });
    const { rosterId } = createRosterFromMessages(`${name} messages`, msgList);
    resolvedRosterId = rosterId;
  }

  const segmentFiles = req.files?.segment_files || [];
  const resolvedSegments = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const source = String(seg.source || '').trim();
    if (!source) return res.status(400).json({ error: `Segment ${i + 1}: Sender ID required` });

    let listId = seg.list_id;
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
        const created = createListFromPhones(`${name} — ${seg.label || 'segment ' + (i + 1)}`, parsed);
        listId = created.listId;
    } else if (!listId && seg.phones) {
      const phones = parsePhones(seg.phones);
      if (!phones.length) return res.status(400).json({ error: `Segment ${i + 1}: no valid numbers` });
      const created = createListFromPhones(`${name} — ${seg.label || 'segment ' + (i + 1)}`, phones);
      listId = created.listId;
    } else if (!listId) {
      return res.status(400).json({ error: `Segment ${i + 1}: provide numbers, CSV, or list_id` });
    }
    resolvedSegments.push({ list_id: listId, source, label: seg.label || null });
  }

  const rate = SMS_RATE_EUR;
  const info = db.prepare(`
    INSERT INTO campaigns (name, list_id, roster_id, source, rotation_mode, rate_per_sms, throttle_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, resolvedSegments[0].list_id, resolvedRosterId, resolvedSegments[0].source, rotation_mode || 'sequential', rate, throttle_ms || 300);
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
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'not found' });

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
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'not found' });
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
  if (getSetting('test_mode') !== '1') {
    const balCheck = await checkBalanceForCost(estCost);
    if (!balCheck.ok) {
      const status = balCheck.needsRefresh ? 401 : 400;
      return res.status(status).json({
        error: balCheck.error || `Estimated cost (€${estCost.toFixed(2)}) exceeds available balance`,
        estimated_cost: estCost,
        balance: balCheck.balance
      });
    }
  }

  db.prepare("UPDATE campaigns SET status = 'sending', started_at = datetime('now') WHERE id = ?").run(campaign.id);
  res.json({ ok: true, started: true, lead_count: queue.length, segment_count: segments.length });

  await processSendQueue({
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
  const sends = db.prepare('SELECT * FROM sends WHERE campaign_id = ? ORDER BY id').all(req.params.id);
  res.json(sends);
});

app.get('/api/campaigns/:id/status', (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'not found' });
  const segments = getCampaignSegments(campaign.id);
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN send_status = 'sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN send_status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN dlr_status = 'Delivered' THEN 1 ELSE 0 END) as delivered,
      SUM(CASE WHEN dlr_status IS NOT NULL AND dlr_status != 'Delivered' THEN 1 ELSE 0 END) as dlr_failed,
      SUM(cost) as total_cost
    FROM sends WHERE campaign_id = ?
  `).get(req.params.id);
  res.json({ campaign, segments, stats });
});

// ---------- DLR webhook (point Vacotel's DLR push at /api/dlr) ----------
function handleDlr(req, res) {
  const data = { ...req.query, ...req.body };
  // supports both the flat body and the nested {"CallBackResponse": {...}} shape from the docs
  const payload = data.CallBackResponse || data;
  const messageId = payload.messageId || payload.MessageId || payload.MessageID;
  const statusId = payload.statusId || payload.StatusId;
  const statusText = payload.Status || DLR_STATUS[statusId] || 'Unknown';

  if (!messageId) return res.status(400).json({ error: 'messageId required' });

  const result = db.prepare(`
    UPDATE sends SET dlr_status = ?, dlr_status_id = ?, dlr_received_at = datetime('now')
    WHERE vendor_message_id = ?
  `).run(statusText, String(statusId || ''), messageId);

  res.json({ ok: true, matched: result.changes > 0 });
}
app.get('/api/dlr', handleDlr);
app.post('/api/dlr', handleDlr);

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
    const result = await withPortalSession(async (cookies) => {
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
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_sends,
      SUM(CASE WHEN send_status = 'sent' THEN 1 ELSE 0 END) as accepted_by_api,
      SUM(CASE WHEN send_status = 'failed' THEN 1 ELSE 0 END) as api_failed,
      SUM(CASE WHEN dlr_status = 'Delivered' THEN 1 ELSE 0 END) as delivered,
      SUM(CASE WHEN dlr_status IS NOT NULL AND dlr_status != 'Delivered' THEN 1 ELSE 0 END) as dlr_negative,
      SUM(CASE WHEN dlr_status IS NULL AND send_status = 'sent' THEN 1 ELSE 0 END) as awaiting_dlr,
      SUM(cost) as total_spend
    FROM sends
  `).get();
  const byErrorCode = db.prepare(`
    SELECT send_error_code, COUNT(*) as count FROM sends
    WHERE send_status = 'failed' AND sent_at >= datetime('now', '-7 days')
    GROUP BY send_error_code
  `).all().map(r => ({ ...r, description: ERROR_CODES[String(r.send_error_code)] || 'Unknown' }));
  const legacyFailed = db.prepare(`
    SELECT COUNT(*) as count FROM sends
    WHERE send_status = 'failed' AND (sent_at IS NULL OR sent_at < datetime('now', '-7 days'))
  `).get().count;
  let balance = null;
  try {
    const bal = await fetchOtusBalance();
    if (bal.ok) balance = bal.balance;
  } catch (e) { /* dashboard still works without balance */ }
  res.json({ stats, byErrorCode, legacyFailed, balance });
});

app.get('/api/campaigns/:id/export.csv', (req, res) => {
  const sends = db.prepare('SELECT * FROM sends WHERE campaign_id = ? ORDER BY id').all(req.params.id);
  const header = 'phone,source,message,send_status,error_code,vendor_message_id,parts,cost,dlr_status,sent_at,dlr_received_at\n';
  const rows = sends.map(s => [
    s.phone, s.source || '', `"${(s.message_text || '').replace(/"/g, '""')}"`, s.send_status, s.send_error_code,
    s.vendor_message_id || '', s.message_parts, s.cost, s.dlr_status || '', s.sent_at || '', s.dlr_received_at || ''
  ].join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="campaign-${req.params.id}-report.csv"`);
  res.send(header + rows.join('\n'));
});

const PORT = process.env.PORT || 3000;

// Recover campaigns stuck in 'sending' with no recorded sends (e.g. after a crash)
db.prepare(`
  UPDATE campaigns SET status = 'draft', started_at = NULL
  WHERE status = 'sending'
    AND id NOT IN (SELECT DISTINCT campaign_id FROM sends WHERE campaign_id IS NOT NULL)
`).run();

app.listen(PORT, () => console.log(`Dispatch SMS Console running at http://localhost:${PORT}`));
