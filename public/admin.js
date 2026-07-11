document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelector(`.nav-item[data-page="${name}"]`).classList.add('active');
  const loaders = {
    dashboard: loadDashboard,
    accounts: loadAccounts,
    templates: loadTemplates,
    'sender-ids': loadAdminSenderIds
  };
  loaders[name] && loaders[name]();
}

function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

function toast(msg, isError) {
  const host = document.getElementById('toastHost');
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function api(path, opts) {
  let resp;
  try {
    resp = await fetch(path, opts);
  } catch (e) {
    throw new Error('Could not reach the server.');
  }
  const data = await resp.json().catch(() => ({}));
  if (resp.status === 401 && !path.includes('/auth/')) {
    showLogin();
    throw new Error('Session expired — sign in again');
  }
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

function showLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('appShell').style.display = 'none';
}

function showApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appShell').style.display = 'flex';
}

async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');
  errEl.style.display = 'none';
  if (!username || !password) {
    errEl.textContent = 'Username and password are required';
    errEl.style.display = 'block';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    await api('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    document.getElementById('loginPassword').value = '';
    showApp();
    startBalancePolling();
    loadDashboard();
    toast('Admin session active');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

async function doLogout() {
  try {
    await api('/api/admin/auth/logout', { method: 'POST' });
  } catch (e) { /* ignore */ }
  stopBalancePolling();
  showLogin();
}

document.getElementById('loginPassword').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

function fmtEur(n) { return '€' + (Number(n) || 0).toFixed(2); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let balancePollTimer = null;
let allAccounts = [];
let allAdminSenderIds = [];
let balanceAccountId = null;
let routeAccountId = null;

function stopBalancePolling() {
  if (balancePollTimer) clearInterval(balancePollTimer);
  balancePollTimer = null;
}

function startBalancePolling() {
  if (balancePollTimer) clearInterval(balancePollTimer);
  balancePollTimer = setInterval(refreshBalancePill, 30000);
}

async function refreshBalancePill() {
  try {
    const { balance } = await api('/api/admin/balance');
    document.getElementById('sidebarBalance').textContent = fmtEur(balance);
  } catch (e) {}
}

async function loadDashboard() {
  refreshBalancePill();
  try {
    const bal = await api('/api/admin/balance');
    document.getElementById('dashStats').innerHTML = `
      <div class="card stat-card"><div class="stat-label">Main balance</div><div class="stat-value accent">${fmtEur(bal.balance)}</div></div>
    `;
  } catch (e) {
    document.getElementById('dashStats').innerHTML = `<div class="card"><p class="muted">${escapeHtml(e.message)}</p></div>`;
  }
  try {
    const sid = await api('/api/admin/sid-auto');
    document.getElementById('sidAutoEnabled').checked = !!sid.enabled;
    document.getElementById('sidAutoInterval').value = Math.round((sid.interval_ms || 180000) / 60000);
    const lr = sid.last_run;
    document.getElementById('sidAutoStatus').textContent = lr
      ? `Last run: ${new Date(lr.at).toLocaleString()} — approved ${lr.approved || 0}${lr.errors?.length ? ' · errors: ' + lr.errors.join('; ') : ''}`
      : 'No runs yet.';
  } catch (e) {}
}

async function saveSidAuto() {
  try {
    await api('/api/admin/sid-auto', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: document.getElementById('sidAutoEnabled').checked,
        interval_ms: (parseInt(document.getElementById('sidAutoInterval').value) || 3) * 60000
      })
    });
    toast('SID auto-approve settings saved');
    loadDashboard();
  } catch (e) { toast(e.message, true); }
}

async function loadAccounts() {
  try {
    const data = await api('/api/admin/accounts');
    allAccounts = data.accounts || [];
    filterAccounts();
  } catch (e) { toast(e.message, true); }
}

function filterAccounts() {
  const q = document.getElementById('accountSearch').value.trim().toLowerCase();
  const rows = q
    ? allAccounts.filter(a =>
      String(a.Name || '').toLowerCase().includes(q) ||
      String(a.EmailAddress || '').toLowerCase().includes(q) ||
      String(a.MobileNum || '').includes(q)
    )
    : allAccounts;
  const tbody = document.querySelector('#accountsTable tbody');
  tbody.innerHTML = rows.length ? rows.map(a => `
    <tr>
      <td>${escapeHtml(a.Name || '—')}</td>
      <td>${escapeHtml(a.EmailAddress || '—')}</td>
      <td class="mono">${escapeHtml(a.MobileNum || '—')}</td>
      <td class="mono">${fmtEur(a.Balance)}</td>
      <td class="mono">—</td>
      <td style="white-space:nowrap;">
        <button class="btn-secondary" style="padding:4px 8px;font-size:11px;margin-right:4px;" data-id="${a.AccountId}" data-name="${escapeHtml(a.Name || '')}" onclick="openBalanceModal(this)">Balance</button>
        <button class="btn-secondary" style="padding:4px 8px;font-size:11px;" data-id="${a.AccountId}" data-name="${escapeHtml(a.Name || '')}" onclick="openRouteModal(this)">Route</button>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="empty-state">No accounts found</td></tr>';
}

function openBalanceModal(btn) {
  balanceAccountId = Number(btn.dataset.id);
  document.getElementById('balanceModalAccount').textContent = btn.dataset.name || '';
  document.getElementById('balanceAmount').value = '';
  openModal('modal-balance');
}

async function submitBalance() {
  const amount = parseFloat(document.getElementById('balanceAmount').value);
  if (!Number.isFinite(amount) || amount === 0) return toast('Enter a non-zero amount', true);
  try {
    await api(`/api/admin/accounts/${balanceAccountId}/balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount })
    });
    closeModal('modal-balance');
    toast(`Balance adjusted by ${fmtEur(amount)}`);
    loadAccounts();
  } catch (e) { toast(e.message, true); }
}

function openRouteModal(btn) {
  routeAccountId = Number(btn.dataset.id);
  document.getElementById('routeModalAccount').textContent = btn.dataset.name || '';
  openModal('modal-route');
}

async function submitRoute() {
  const route = parseInt(document.getElementById('routeSelect').value);
  try {
    await api(`/api/admin/accounts/${routeAccountId}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route })
    });
    closeModal('modal-route');
    toast(`Route set to OTUS_${route === 0 ? '0' : route}`);
    loadAccounts();
  } catch (e) { toast(e.message, true); }
}

async function loadTemplates() {
  try {
    const data = await api('/api/admin/templates');
    document.getElementById('tplTestM').value = (data.test?.m || []).join('\n');
    document.getElementById('tplTestP').value = (data.test?.p || []).join('\n');
    document.getElementById('tplCampaignM').value = (data.campaign?.m || []).join('\n');
    document.getElementById('tplCampaignP').value = (data.campaign?.p || []).join('\n');
  } catch (e) { toast(e.message, true); }
}

async function saveTemplates() {
  const saveBucket = async (purpose, mEl, pEl) => {
    await api('/api/admin/templates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        purpose,
        m: mEl.value.split('\n').map(s => s.trim()).filter(Boolean),
        p: pEl.value.split('\n').map(s => s.trim()).filter(Boolean)
      })
    });
  };
  try {
    await saveBucket('test', document.getElementById('tplTestM'), document.getElementById('tplTestP'));
    await saveBucket('campaign', document.getElementById('tplCampaignM'), document.getElementById('tplCampaignP'));
    toast('Templates saved');
  } catch (e) { toast(e.message, true); }
}

async function loadAdminSenderIds() {
  try {
    const { items } = await api('/api/admin/sender-ids');
    allAdminSenderIds = items || [];
    filterAdminSenderIds();
  } catch (e) { toast(e.message, true); }
}

function filterAdminSenderIds() {
  const q = document.getElementById('sidSearch')?.value.trim().toLowerCase() || '';
  const rows = q
    ? allAdminSenderIds.filter(s =>
      String(s.Sender || '').toLowerCase().includes(q) ||
      String(s.Name || s.CompanyName || '').toLowerCase().includes(q) ||
      String(s.ActiveStr || s.Active || '').toLowerCase().includes(q)
    )
    : allAdminSenderIds;
  const tbody = document.querySelector('#adminSidTable tbody');
  const pending = rows.filter(s => Number(s.Active) === 2);
  tbody.innerHTML = rows.length
    ? rows.slice(0, 200).map(s => `
      <tr>
        <td class="mono">${escapeHtml(s.Sender)}</td>
        <td>${escapeHtml(s.Name || s.CompanyName || '—')}</td>
        <td><span class="badge ${Number(s.Active) === 1 ? 'ok' : (Number(s.Active) === 2 ? 'warn' : 'fail')}">${escapeHtml(s.ActiveStr || s.Active)}</span></td>
        <td class="mono">${escapeHtml(String(s.CreatedDate || '').slice(0, 19))}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="4" class="empty-state">No sender IDs found</td></tr>';
  if (pending.length) toast(`${pending.length} pending SID(s) — auto-approve will process them`, false);
}

async function initApp() {
  try {
    const status = await api('/api/admin/auth/status');
    if (status.authenticated) {
      showApp();
      startBalancePolling();
      loadDashboard();
      return;
    }
    showLogin();
  } catch (e) {
    showLogin();
  }
}

initApp();
