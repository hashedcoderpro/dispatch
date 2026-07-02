const fetch = require('node-fetch');

// GSM 7-bit default alphabet (basic set). If the message contains any
// character outside this set, we must use Unicode (dataCoding = 8) or the
// carrier will mangle/reject the text.
const GSM7_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

function isGsm7(text) {
  for (const ch of text) {
    if (!GSM7_BASIC.includes(ch)) return false;
  }
  return true;
}

/**
 * Decide dataCoding + compute segment count (message parts) for billing/preview.
 * dataCoding: 0 = GSM7 default, 8 = Unicode UCS2 (per Vacotel docs)
 */
function analyzeMessage(text) {
  const gsm7 = isGsm7(text);
  const dataCoding = gsm7 ? 0 : 8;
  const singleLimit = gsm7 ? 160 : 70;
  const multiLimit = gsm7 ? 153 : 67; // per-segment limit once concatenated
  let parts;
  if (text.length <= singleLimit) parts = 1;
  else parts = Math.ceil(text.length / multiLimit);
  return { dataCoding, parts, length: text.length, gsm7 };
}

function normalizeDestination(phone) {
  // Vacotel does not support a leading '+'
  return String(phone).trim().replace(/^\+/, '').replace(/[\s\-()]/g, '');
}

/**
 * Send a single SMS via the Vacotel HTTP(s) POST API.
 * Returns { ok, errorCode, errorDescription, vendorId, messageCount, messageParts, raw }
 */
async function sendSms({ baseUrl, username, password, destination, source, text, dataCoding, testMode }) {
  const dest = normalizeDestination(destination);

  if (testMode) {
    // Simulated response so the app is fully testable before going live.
    await new Promise(r => setTimeout(r, 50));
    return {
      ok: true,
      errorCode: 0,
      errorDescription: 'Ok (test mode - not actually sent)',
      vendorId: 'test-' + Math.random().toString(36).slice(2, 10),
      messageCount: 1,
      messageParts: analyzeMessage(text).parts,
      raw: null
    };
  }

  const url = `${baseUrl.replace(/\/$/, '')}/HTTP/api/Client/SendSMS`;
  const body = { destination: dest, source, text, dataCoding };

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Username': username,
        'Password': password
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return {
      ok: false,
      errorCode: -10,
      errorDescription: `Network error: ${e.message}`,
      vendorId: null,
      messageCount: 0,
      messageParts: analyzeMessage(text).parts,
      raw: null
    };
  }

  let json;
  try {
    json = await resp.json();
  } catch (e) {
    return { ok: false, errorCode: -10, errorDescription: 'UnknownError (bad response body)', raw: null };
  }

  const sms = (json.SMS && json.SMS[0]) || {};
  const errorCode = sms.ErrorCode !== undefined ? sms.ErrorCode : json.ErrorCode;

  return {
    ok: errorCode === 0,
    errorCode,
    errorDescription: json.ErrorDescription,
    vendorId: sms.Id,
    messageCount: json.MessageCount,
    messageParts: json.MessageParts,
    raw: json
  };
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

module.exports = { sendSms, analyzeMessage, normalizeDestination, ERROR_CODES, DLR_STATUS };
