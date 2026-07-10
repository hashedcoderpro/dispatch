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
    headers: { 'User-Agent': 'Dispatch/1.0', Accept: 'text/html' }
  });
  mergeCookies(jar, getResp.headers);
  const html = await getResp.text();
  const tokenMatch = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i);
  const token = tokenMatch ? tokenMatch[1] : '';

  // Otus login page uses jQuery $.ajax with form-urlencoded (not JSON).
  const body = new URLSearchParams({
    __RequestVerificationToken: token,
    'user[username]': username,
    'user[password]': password,
    returnUrl: '',
    key: ''
  });

  const loginResp = await fetch(`${OTUS_BASE_URL}/Account/Login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': cookieHeader(jar),
      'User-Agent': 'Dispatch/1.0'
    },
    body: body.toString()
  });
  mergeCookies(jar, loginResp.headers);

  let data = {};
  const text = await loginResp.text();
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 300) }; }

  const success = data.success === 'True' || data.success === true;
  if (success && data.tfaEnabled) {
    return { ok: false, error: 'Two-factor authentication is required on this account — sign in at otusprivategw.com or disable 2FA' };
  }
  if (success) {
    return { ok: true, cookies: jar };
  }

  const msg = data.errorMessage || data.message || data.description || data.error
    || (data.success === 'False' ? 'Invalid portal username or password' : null)
    || (typeof data.raw === 'string' && data.raw.includes('login') ? 'Unexpected login response from Otus portal' : null)
    || 'Portal login failed — check username and password';
  return { ok: false, error: msg, raw: data };
}

async function portalFetch(jar, path, { method = 'GET', body, contentType } = {}) {
  const headers = {
    'User-Agent': 'Dispatch/1.0',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `${OTUS_BASE_URL}/Settings/ManageSenderIds`,
    'Cookie': cookieHeader(jar)
  };
  if (body !== undefined) {
    headers['Content-Type'] = contentType || 'application/x-www-form-urlencoded; charset=UTF-8';
  }
  const resp = await fetch(`${OTUS_BASE_URL}${path}`, { method, headers, body });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: resp.status, json, text };
}

function parseBalanceText(text) {
  const raw = String(text || '').trim();
  const m = raw.match(/^([A-Z]{3})([\d.,]+)$/);
  if (m) return { currency: m[1], balance: parseFloat(m[2].replace(',', '.')) };
  const n = parseFloat(raw);
  if (Number.isFinite(n)) return { currency: 'EUR', balance: n };
  return null;
}

async function getAccountBalance(jar) {
  const { status, text } = await portalFetch(jar, '/Home/GetBalance', { method: 'GET' });
  const parsed = parseBalanceText(text);
  if (!parsed) {
    return { ok: false, status, error: text.slice(0, 100) || `Balance fetch failed (${status})` };
  }
  return { ok: true, ...parsed, raw: text.trim() };
}

async function readTraffic(jar, filters = {}) {
  const params = new URLSearchParams({
    DateFrom: filters.dateFrom || '',
    DateTo: filters.dateTo || '',
    CountryId: filters.countryId || '',
    CampaignId: filters.campaignId || '',
    OperatorId: filters.operatorId || '',
    AccountId: filters.accountId || '',
    Status: filters.status || '',
    Address: filters.address || '',
    SenderId: filters.senderId || ''
  });

  const { status, json, text } = await portalFetch(jar, '/Report/ReadTraffic', {
    method: 'POST',
    body: params.toString()
  });

  if (!json || !Array.isArray(json.data)) {
    return { ok: false, status, error: text.slice(0, 200) || `Traffic fetch failed (${status})` };
  }
  return {
    ok: true,
    data: json.data,
    totalTraffic: json.totalTraffic ?? json.data.length,
    totalParts: json.totalParts ?? json.data.length,
    totalDelivered: json.TotalDelivered ?? 0,
    totalCost: json.totalCost ?? 0,
    recordsTotal: json.recordsTotal ?? json.data.length,
    rowsLimit: json.rowsLimit
  };
}

async function deleteSenderIds(jar, senderIds) {
  const ids = senderIds.map(id => Number(id)).filter(n => n > 0);
  if (!ids.length) return { ok: false, error: 'No sender IDs to delete' };

  const { status, json, text } = await portalFetch(jar, '/Settings/DeleteSenderIds', {
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify(ids)
  });

  if (!json) {
    return { ok: false, error: text.slice(0, 200) || `Delete failed (${status})` };
  }
  if (!json.success) {
    return { ok: false, error: json.message || json.description || 'Delete rejected', raw: json };
  }
  return { ok: true, message: json.message || 'Deleted' };
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
    if (!jar) return null;
    if (jar['vacotel-Cookie'] || jar['.AspNetCore.Session']) return jar;
    return null;
  } catch {
    return null;
  }
}

// SMS route index (0–4) → Otus VendorId
const VENDOR_ROUTES = { 0: 121, 1: 312, 2: 313, 3: 314, 4: 315 };
const VENDOR_ID_TO_ROUTE = Object.fromEntries(
  Object.entries(VENDOR_ROUTES).map(([route, id]) => [id, Number(route)])
);

async function adminPortalFetch(jar, path, { method = 'GET', body, contentType, referer } = {}) {
  const headers = {
    'User-Agent': 'Dispatch/1.0',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: referer || `${OTUS_BASE_URL}/Admin/Accounts/Index`,
    Cookie: cookieHeader(jar)
  };
  if (body !== undefined) {
    headers['Content-Type'] = contentType || 'application/x-www-form-urlencoded; charset=UTF-8';
  }
  const resp = await fetch(`${OTUS_BASE_URL}${path}`, { method, headers, body });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: resp.status, json, text };
}

async function verifyAdminAccess(jar) {
  const { status, json, text } = await adminPortalFetch(jar, '/Admin/Accounts/Read');
  if (json && Array.isArray(json.data)) return { ok: true };
  if (/login/i.test(text)) return { ok: false, error: 'Not an admin account — use Otus admin credentials' };
  return { ok: false, status, error: text.slice(0, 120) || `Admin access check failed (${status})` };
}

async function getAdminBalance(jar) {
  const { status, text } = await adminPortalFetch(jar, '/Admin/Dashboard/GetBalance', {
    method: 'POST',
    body: ''
  });
  if (/login/i.test(text)) return { ok: false, error: 'Admin session expired', needsRefresh: true };
  const parsed = parseBalanceText(text);
  if (!parsed) {
    return { ok: false, status, error: text.slice(0, 100) || `Admin balance fetch failed (${status})` };
  }
  return { ok: true, ...parsed, raw: text.trim() };
}

async function listAdminAccounts(jar) {
  const { status, json, text } = await adminPortalFetch(jar, '/Admin/Accounts/Read');
  if (!json || !Array.isArray(json.data)) {
    if (/login/i.test(text)) return { ok: false, error: 'Admin session expired', needsRefresh: true };
    return { ok: false, status, error: text.slice(0, 200) || `Account list failed (${status})`, accounts: [] };
  }
  return {
    ok: true,
    accounts: json.data,
    recordsTotal: json.recordsTotal ?? json.data.length
  };
}

async function addBalanceToAccount(jar, accountId, amount) {
  const { status, json, text } = await adminPortalFetch(jar, '/Admin/Accounts/AddBalanceToAccount', {
    method: 'POST',
    body: new URLSearchParams({
      balance: String(amount),
      accountId: String(accountId)
    }).toString()
  });
  if (/login/i.test(text)) return { ok: false, error: 'Admin session expired', needsRefresh: true };
  if (json && (json.success === true || json.success === 'True' || json.status === 'Success')) {
    return { ok: true, message: json.message || json.description || 'Balance updated' };
  }
  return {
    ok: false,
    error: (json && (json.message || json.description || json.error)) || text.slice(0, 200) || `Balance update failed (${status})`
  };
}

function htmlInputValue(html, name) {
  const re = new RegExp(`(?:id|name)="${name}"[^>]*value="([^"]*)"`, 'i');
  const m = html.match(re);
  if (m) return m[1];
  const re2 = new RegExp(`name="${name}"[^>]*value="([^"]*)"`, 'i');
  const m2 = html.match(re2);
  return m2 ? m2[1] : '';
}

function htmlSelectedOption(html, selectId) {
  const block = html.match(new RegExp(`id="${selectId}"[\\s\\S]*?</select>`, 'i'));
  if (!block) return '';
  const m = block[0].match(/<option[^>]*selected[^>]*value="([^"]*)"/i);
  if (m) return m[1];
  const m2 = block[0].match(/<option[^>]*value="([^"]*)"[^>]*selected/i);
  return m2 ? m2[1] : '';
}

function htmlCheckboxChecked(html, id) {
  const re = new RegExp(`id="${id}"[^>]*checked`, 'i');
  return re.test(html);
}

function parseEditAccountHtml(html) {
  return {
    accountId: htmlInputValue(html, 'AccountId'),
    title: htmlSelectedOption(html, 'Title') || htmlInputValue(html, 'Title'),
    firstName: htmlInputValue(html, 'FirstName') || htmlInputValue(html, 'txtFirstName'),
    lastName: htmlInputValue(html, 'LastName') || htmlInputValue(html, 'txtLastName'),
    username: htmlInputValue(html, 'Username') || htmlInputValue(html, 'txtUserName'),
    pass: htmlInputValue(html, 'Password') || htmlInputValue(html, 'txtpass'),
    email: htmlInputValue(html, 'Email') || htmlInputValue(html, 'txtEmail'),
    address: htmlInputValue(html, 'Address') || htmlInputValue(html, 'txtAddress'),
    phone: htmlInputValue(html, 'TelephoneNumber') || htmlInputValue(html, 'txtTelephone'),
    mobile: htmlInputValue(html, 'MobileNumber') || htmlInputValue(html, 'txtMobile'),
    vendorId: htmlSelectedOption(html, 'VendorDropDown'),
    isActive: htmlCheckboxChecked(html, 'Active'),
    completedFirstPayment: htmlCheckboxChecked(html, 'CompletedFirstPayment'),
    emailVerified: htmlCheckboxChecked(html, 'EmailVerified'),
    hasDSN: htmlCheckboxChecked(html, 'HasDSN'),
    dsnUrl: htmlInputValue(html, 'DSNURL') || htmlInputValue(html, 'txtDSNURL'),
    dsnAuthHeader: htmlInputValue(html, 'DSNAuthHeader') || htmlInputValue(html, 'txtDSNAuthHeader'),
    isAdmin: htmlCheckboxChecked(html, 'isAdmin'),
    securityGroupId: htmlSelectedOption(html, 'SecurityGroupDropDown') || '16',
    isCountriesDND: htmlCheckboxChecked(html, 'isCountriesDND'),
    accountType: htmlInputValue(html, 'IntAccountType') || '1'
  };
}

async function getEditAccountForm(jar, accountId) {
  const { status, text } = await adminPortalFetch(
    jar,
    `/Admin/Accounts/EditAccount?subAccountId=${encodeURIComponent(accountId)}`
  );
  if (/login/i.test(text)) return { ok: false, error: 'Admin session expired', needsRefresh: true };
  if (!text.includes('AccountId')) {
    return { ok: false, status, error: text.slice(0, 200) || `Could not load account (${status})` };
  }
  return { ok: true, fields: parseEditAccountHtml(text) };
}

async function editAccountUser(jar, fields) {
  const body = new URLSearchParams({
    AccountId: fields.accountId,
    title: fields.title || '',
    firstName: fields.firstName,
    lastName: fields.lastName,
    Username: fields.username,
    pass: fields.pass,
    email: fields.email,
    address: fields.address,
    phone: fields.phone,
    mobile: fields.mobile,
    VendorId: String(fields.vendorId),
    isActive: fields.isActive ? 'true' : 'false',
    completedFirstPayment: fields.completedFirstPayment ? 'true' : 'false',
    EmailVerified: fields.emailVerified ? 'true' : 'false',
    hasDSN: fields.hasDSN ? 'true' : 'false',
    DSNURL: fields.dsnUrl || '',
    DSNAuthHeader: fields.dsnAuthHeader || '',
    isAdmin: fields.isAdmin ? 'true' : 'false',
    SecurityGroupId: fields.securityGroupId || '16',
    isCountriesDND: fields.isCountriesDND ? 'true' : 'false',
    accountType: fields.accountType || '1'
  });
  const { status, json, text } = await adminPortalFetch(jar, '/Admin/Accounts/EditUser', {
    method: 'POST',
    body: body.toString()
  });
  if (/login/i.test(text)) return { ok: false, error: 'Admin session expired', needsRefresh: true };
  if (json && json.status === 'Success') return { ok: true };
  return {
    ok: false,
    error: (json && (json.message || json.error)) || text.slice(0, 200) || `Edit user failed (${status})`
  };
}

async function changeAccountRoute(jar, accountId, routeIndex) {
  const vendorId = VENDOR_ROUTES[routeIndex];
  if (!vendorId) return { ok: false, error: `Invalid route index: ${routeIndex}` };
  const form = await getEditAccountForm(jar, accountId);
  if (!form.ok) return form;
  form.fields.vendorId = vendorId;
  return editAccountUser(jar, form.fields);
}

async function listAdminSenderIds(jar) {
  const { status, json, text } = await adminPortalFetch(
    jar,
    '/Admin/SenderIds/Read',
    { referer: `${OTUS_BASE_URL}/Admin/SenderIds/Index` }
  );
  if (!json || !Array.isArray(json.data)) {
    if (/login/i.test(text)) return { ok: false, error: 'Admin session expired', needsRefresh: true };
    return { ok: false, status, error: text.slice(0, 200) || `Sender ID list failed (${status})`, items: [] };
  }
  return { ok: true, items: json.data };
}

async function updateSenderIdStatus(jar, allowedSenderIds, status) {
  const ids = allowedSenderIds.map(id => Number(id)).filter(n => n > 0);
  if (!ids.length) return { ok: false, error: 'No sender IDs to update' };
  const params = new URLSearchParams();
  for (const id of ids) params.append('ids[]', String(id));
  params.set('status', String(status));
  const { status: httpStatus, json, text } = await adminPortalFetch(
    jar,
    '/Admin/SenderIds/UpdateMultipule',
    {
      method: 'POST',
      body: params.toString(),
      referer: `${OTUS_BASE_URL}/Admin/SenderIds/Index`
    }
  );
  if (/login/i.test(text)) return { ok: false, error: 'Admin session expired', needsRefresh: true };
  if (json && json.result) {
    return { ok: true, message: json.Description || json.description || 'Updated' };
  }
  return {
    ok: false,
    error: (json && (json.Description || json.description)) || text.slice(0, 200) || `Update failed (${httpStatus})`
  };
}

module.exports = {
  OTUS_BASE_URL,
  VENDOR_ROUTES,
  VENDOR_ID_TO_ROUTE,
  validateSenderId,
  portalLogin,
  requestSenderId,
  listSenderIds,
  deleteSenderIds,
  readTraffic,
  getAccountBalance,
  parseBalanceText,
  parseStoredCookies,
  verifyAdminAccess,
  getAdminBalance,
  listAdminAccounts,
  addBalanceToAccount,
  changeAccountRoute,
  listAdminSenderIds,
  updateSenderIdStatus
};
