const fetch = require('node-fetch');

const VACOTEL_GATEWAY_URL = 'https://otusprivategw.com';

const GSM7_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

function isGsm7(text) {
  for (const ch of text) {
    if (!GSM7_BASIC.includes(ch)) return false;
  }
  return true;
}

function analyzeMessage(text) {
  const gsm7 = isGsm7(text);
  const dataCoding = gsm7 ? 0 : 8;
  const singleLimit = gsm7 ? 160 : 70;
  const multiLimit = gsm7 ? 153 : 67;
  let parts;
  if (text.length <= singleLimit) parts = 1;
  else parts = Math.ceil(text.length / multiLimit);
  return { dataCoding, parts, length: text.length, gsm7 };
}

function normalizeDestination(phone) {
  return String(phone).trim().replace(/^\+/, '').replace(/[\s\-()]/g, '');
}

function normalizeBaseUrl(baseUrl) {
  const url = String(baseUrl || '').replace(/\/$/, '');
  if (/^http:\/\/otusprivategw\.com/i.test(url)) return url.replace(/^http:/i, 'https:');
  return url;
}

function sendEndpoint(baseUrl) {
  const host = normalizeBaseUrl(baseUrl);
  if (/\/API\/SendSMS$/i.test(host)) return host;
  return `${host}/API/SendSMS`;
}

function parseApiResponse(bodyText, defaultParts) {
  let json = null;
  try { json = JSON.parse(bodyText); } catch (_) {}

  if (json) {
    const sms = (json.SMS && json.SMS[0]) || {};
    const errorCode = sms.ErrorCode !== undefined ? sms.ErrorCode : json.ErrorCode;
    const ok = errorCode === 0 || json.success === true || json.Status === 'OK';
    return {
      ok,
      errorCode: errorCode ?? (ok ? 0 : -10),
      errorDescription: json.ErrorDescription || json.message || json.Status || bodyText.slice(0, 200),
      vendorId: sms.Id || json.messageId || json.MessageId || null,
      messageCount: json.MessageCount || 1,
      messageParts: json.MessageParts || defaultParts,
      raw: json
    };
  }

  const t = bodyText.trim();
  const failed = /fail|error|invalid|reject/i.test(t);
  const ok = !failed && /ok|sent|success|accepted/i.test(t);
  return {
    ok,
    errorCode: ok ? 0 : -10,
    errorDescription: t || 'Empty response',
    vendorId: null,
    messageCount: ok ? 1 : 0,
    messageParts: defaultParts,
    raw: t
  };
}

/**
 * Send SMS — supports:
 * 1) Private gateway (Otus etc): GET /API/SendSMS?username=&apiId=&json=True&...
 * 2) Legacy Vacotel docs: POST /HTTP/api/Client/SendSMS with Username/Password headers
 */
async function sendSms({ baseUrl, username, password, apiId, destination, source, text, dataCoding, testMode }) {
  const dest = normalizeDestination(destination);
  const parts = analyzeMessage(text).parts;
  const coding = dataCoding ?? analyzeMessage(text).dataCoding;

  if (testMode) {
    await new Promise(r => setTimeout(r, 50));
    return {
      ok: true,
      errorCode: 0,
      errorDescription: 'Ok (test mode - not actually sent)',
      vendorId: 'test-' + Math.random().toString(36).slice(2, 10),
      messageCount: 1,
      messageParts: parts,
      raw: null
    };
  }

  let resp;
  try {
    if (apiId) {
      const params = new URLSearchParams({
        username: username || '',
        apiId,
        json: 'True',
        destination: dest,
        source,
        text
      });
      if (coding !== undefined) params.set('datacoding', String(coding));
      const url = `${sendEndpoint(baseUrl)}?${params}`;
      resp = await fetch(url, { method: 'GET' });
    } else {
      const url = `${baseUrl.replace(/\/$/, '')}/HTTP/api/Client/SendSMS`;
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Username': username,
          'Password': password
        },
        body: JSON.stringify({ destination: dest, source, text, dataCoding: coding })
      });
    }
  } catch (e) {
    return {
      ok: false,
      errorCode: -10,
      errorDescription: `Network error: ${e.message}`,
      vendorId: null,
      messageCount: 0,
      messageParts: parts,
      raw: null
    };
  }

  const bodyText = await resp.text();
  return parseApiResponse(bodyText, parts);
}

async function probeVacotelApi({ baseUrl, username, password, apiId }) {
  const started = Date.now();
  const result = await sendSms({
    baseUrl,
    username,
    password,
    apiId,
    destination: '0',
    source: 'Dispatch',
    text: 'probe',
    dataCoding: 0,
    testMode: false
  });

  const ms = Date.now() - started;
  let summary = result.errorDescription || 'Unknown';
  let reachable = true;
  let auth_ok = result.ok;

  if (result.errorDescription?.includes('Network error')) {
    reachable = false;
    auth_ok = false;
    summary = result.errorDescription;
  } else if (result.errorCode === -5) {
    auth_ok = false;
    summary = 'Invalid credentials';
  } else if (result.errorCode === -8) {
    auth_ok = false;
    summary = 'IP not whitelisted';
  } else if (result.errorCode === -3 || result.errorCode === -4) {
    auth_ok = true;
    summary = 'API reachable (destination rejected — expected for probe)';
  } else if (result.ok) {
    summary = 'API accepted request';
  } else if (/MESSAGE_FAILED/i.test(summary)) {
    summary = 'API reachable — request rejected (check destination/SID/credits)';
    auth_ok = true;
  }

  return {
    base_url: baseUrl,
    mode: apiId ? 'gateway-get-apiId' : 'legacy-post-password',
    get: {
      ms,
      reachable,
      auth_ok,
      summary,
      error_code: result.errorCode,
      body_preview: typeof result.raw === 'string' ? result.raw.slice(0, 800) : JSON.stringify(result.raw || {}).slice(0, 800)
    }
  };
}

function validateVacotelCredentials(probe) {
  const b = probe.get;
  if (!b.reachable) {
    return { ok: false, error: 'Cannot reach Vacotel gateway — try again later' };
  }
  if (b.error_code === -5 || b.auth_ok === false) {
    return { ok: false, error: 'Invalid username or API token' };
  }
  if (b.auth_ok === true || b.error_code === -3 || b.error_code === -4 || b.error_code === 0) {
    return { ok: true };
  }
  if (/invalid.*credential|unauthorized|authentication/i.test(b.summary || '')) {
    return { ok: false, error: 'Invalid username or API token' };
  }
  if (/reachable/i.test(b.summary || '')) {
    return { ok: true };
  }
  return { ok: false, error: b.summary || 'Could not verify credentials' };
}

const ERROR_CODES = {
  0: 'Ok',
  '-1': 'NoMessage',
  '-2': 'NoSource',
  '-3': 'NoDestination',
  '-4': 'UnsupportedDestination',
  '-5': 'InvalidCredentials',
  '-6': 'NoCredit',
  '-7': 'InvalidDataCoding',
  '-8': 'IPnotwhitelisted',
  '-10': 'UnknownError',
  '-11': 'InvalidInstanceConnection'
};

const DLR_STATUS = {
  2: 'Delivered',
  3: 'Expired',
  4: 'Deleted',
  5: 'Undelivered',
  6: 'Accepted',
  7: 'Invalid',
  8: 'Rejected'
};

module.exports = {
  VACOTEL_GATEWAY_URL,
  sendSms,
  analyzeMessage,
  normalizeDestination,
  probeVacotelApi,
  validateVacotelCredentials,
  ERROR_CODES,
  DLR_STATUS
};
