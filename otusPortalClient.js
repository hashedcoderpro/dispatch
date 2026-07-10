const fetch = require('node-fetch');

const OTUS_BASE_URL = 'https://otusprivategw.com';

const SENDER_ID_REGEX = /^(?=.*[a-zA-Z0-9|\-.,&' ])([a-zA-Z0-9?|\-._,&' ]{1,15})$/;

function mergeCookies(jar, headers) {
  const raw = headers.raw && headers.raw()['set-cookie'];
  if (!raw) return;
  for (const line of raw) {
    const part = line.split(';')[0];
    const eq = part.indexOf('=');
    if (eq > 0) jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
}

function cookieHeader(jar) {
  return Object.entries(jar || {}).map(([k, v]) => `${k}=${v}`).join('; ');
}

function validateSenderId(sender) {
  const s = String(sender || '').trim();
  if (!s) return { ok: false, error: 'Sender ID is required' };
  if (s.length > 15) return { ok: false, error: 'Sender ID cannot be longer than 15 characters' };
  if (!SENDER_ID_REGEX.test(s)) return { ok: false, error: 'Sender ID format is not valid for Otus' };
  return { ok: true, value: s };
}

async function portalLogin(username, password) {
  const jar = {};
  const getResp = await fetch(`${OTUS_BASE_URL}/`, {
    headers: { 'User-Agent': 'Dispatch/1.0' }
  });
  mergeCookies(jar, getResp.headers);
  const html = await getResp.text();
  const tokenMatch = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i);
  const token = tokenMatch ? tokenMatch[1] : '';

  const loginResp = await fetch(`${OTUS_BASE_URL}/Account/Login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': cookieHeader(jar),
      'User-Agent': 'Dispatch/1.0'
    },
    body: JSON.stringify({
      __RequestVerificationToken: token,
      user: { username, password },
      returnUrl: ''
    })
  });
  mergeCookies(jar, loginResp.headers);

  let data = {};
  const text = await loginResp.text();
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 300) }; }

  if (!jar['vacotel-Cookie']) {
    const msg = data.message || data.description || data.error
      || (data.tfaEnabled ? 'Two-factor authentication is enabled — sign in at otusprivategw.com' : null)
      || 'Portal login failed — check username and password';
    return { ok: false, error: msg };
  }

  return { ok: true, cookies: jar };
}

async function portalFetch(jar, path, { method = 'GET', body } = {}) {
  const headers = {
    'User-Agent': 'Dispatch/1.0',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `${OTUS_BASE_URL}/Settings/ManageSenderIds`,
    'Cookie': cookieHeader(jar)
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
  }
  const resp = await fetch(`${OTUS_BASE_URL}${path}`, { method, headers, body });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: resp.status, json, text };
}

async function requestSenderId(jar, sender) {
  const check = validateSenderId(sender);
  if (!check.ok) return { ok: false, error: check.error };

  const { status, json, text } = await portalFetch(jar, '/Settings/RequestSenderId', {
    method: 'POST',
    body: new URLSearchParams({ Sender: check.value }).toString()
  });

  if (!json) {
    return { ok: false, error: text.slice(0, 200) || `Request failed (${status})` };
  }
  if (!json.success) {
    return { ok: false, error: json.description || 'Sender ID request rejected', raw: json };
  }
  return {
    ok: true,
    sender: check.value,
    senderId: json.senderId,
    description: json.description || '',
    raw: json
  };
}

async function listSenderIds(jar) {
  const { status, json, text } = await portalFetch(jar, '/Settings/SenderIdList', {
    method: 'POST',
    body: ''
  });
  if (!Array.isArray(json)) {
    return { ok: false, status, error: text.slice(0, 200) || `List failed (${status})`, items: [] };
  }
  return { ok: true, items: json };
}

function parseStoredCookies(raw) {
  if (!raw) return null;
  try {
    const jar = JSON.parse(raw);
    return jar && jar['vacotel-Cookie'] ? jar : null;
  } catch {
    return null;
  }
}

module.exports = {
  OTUS_BASE_URL,
  validateSenderId,
  portalLogin,
  requestSenderId,
  listSenderIds,
  parseStoredCookies
};
