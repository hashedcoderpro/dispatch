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
    'route-matrix': loadRouteMatrix,
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
  stopRmProgressPoll();
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
    const pending = allAdminSenderIds.filter(s => Number(s.Active) === 2);
    if (pending.length) toast(`${pending.length} pending SID(s) — auto-approve will process them`, false);
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

// ---------- Route Matrix ----------
let rmAvailableSids = [];
let rmSidFieldCount = 1;
let rmContentFieldCount = 1;
let rmProgressTimer = null;
let rmActiveCampaignId = null;

function stopRmProgressPoll() {
  if (rmProgressTimer) clearInterval(rmProgressTimer);
  rmProgressTimer = null;
}

function rmShowLogin() {
  document.getElementById('rmLoginCard').style.display = 'block';
  document.getElementById('rmWorkspace').style.display = 'none';
}

function rmShowWorkspace(session) {
  document.getElementById('rmLoginCard').style.display = 'none';
  document.getElementById('rmWorkspace').style.display = 'block';
  document.getElementById('rmSessionUser').textContent = session.username || '—';
  document.getElementById('rmSessionAccount').textContent = session.account_id != null ? session.account_id : '—';
}

async function loadRouteMatrix() {
  try {
    const session = await api('/api/admin/route-matrix/session');
    if (!session.authenticated) {
      rmShowLogin();
      return;
    }
    rmShowWorkspace(session);
    if (!document.getElementById('rmSidFields').children.length) {
      rmSidFieldCount = 1;
      rmContentFieldCount = 1;
      renderRmSidFields();
      renderRmContentFields();
    }
    await rmLoadSids();
  } catch (e) {
    toast(e.message, true);
    rmShowLogin();
  }
}

async function rmLogin() {
  const username = document.getElementById('rmUsername').value.trim();
  const password = document.getElementById('rmPassword').value;
  const apiId = document.getElementById('rmApiId').value.trim();
  const errEl = document.getElementById('rmLoginError');
  const btn = document.getElementById('rmLoginBtn');
  errEl.style.display = 'none';
  if (!username || !password || !apiId) {
    errEl.textContent = 'Username, password, and API token are required';
    errEl.style.display = 'block';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const data = await api('/api/admin/route-matrix/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, apiId })
    });
    document.getElementById('rmPassword').value = '';
    document.getElementById('rmApiId').value = '';
    rmShowWorkspace({ username: data.username, account_id: data.account_id });
    rmSidFieldCount = 1;
    rmContentFieldCount = 1;
    renderRmSidFields();
    renderRmContentFields();
    await rmLoadSids();
    toast(`Signed in as ${data.username}`);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in to test account';
  }
}

async function rmLogout() {
  stopRmProgressPoll();
  try {
    await api('/api/admin/route-matrix/logout', { method: 'POST' });
  } catch (e) { /* ignore */ }
  rmShowLogin();
  toast('Signed out of test account');
}

async function rmLoadSids() {
  try {
    const data = await api('/api/admin/route-matrix/sender-ids');
    rmAvailableSids = (data.otus || []).filter(s => s.source);
    const tbody = document.querySelector('#rmSidTable tbody');
    tbody.innerHTML = rmAvailableSids.length
      ? rmAvailableSids.map(s => `
        <tr>
          <td class="mono">${escapeHtml(s.source)}</td>
          <td><span class="badge ${Number(s.active) === 1 ? 'ok' : (Number(s.active) === 2 ? 'warn' : 'fail')}">${escapeHtml(s.status || s.active || '—')}</span></td>
          <td class="mono">${escapeHtml(String(s.created_date || '').slice(0, 19) || '—')}</td>
        </tr>
      `).join('')
      : '<tr><td colspan="3" class="empty-state">No sender IDs on this account</td></tr>';
    document.querySelectorAll('.rm-sid-select').forEach(sel => {
      const prev = sel.value;
      sel.innerHTML = rmSidSelectOptions(prev);
    });
  } catch (e) {
    toast(e.message, true);
  }
}

function rmSidSelectOptions(selected) {
  const opts = ['<option value="">— select or type below —</option>']
    .concat(rmAvailableSids.map(s =>
      `<option value="${escapeHtml(s.source)}"${s.source === selected ? ' selected' : ''}>${escapeHtml(s.source)}${s.status ? ' (' + escapeHtml(s.status) + ')' : ''}</option>`
    ));
  return opts.join('');
}

async function rmRequestSid() {
  const source = document.getElementById('rmSidRequestInput').value.trim();
  if (!source) return toast('Enter a sender ID', true);
  try {
    const res = await api('/api/admin/route-matrix/sender-ids/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source })
    });
    document.getElementById('rmSidRequestInput').value = '';
    toast(`Requested "${res.source}" — pending approval`);
    await rmLoadSids();
  } catch (e) {
    toast(e.message, true);
  }
}

function renderRmSidFields() {
  const host = document.getElementById('rmSidFields');
  const existing = [...host.querySelectorAll('.rm-sid-row')].map(row => ({
    select: row.querySelector('.rm-sid-select')?.value || '',
    custom: row.querySelector('.rm-sid-custom')?.value || ''
  }));
  host.innerHTML = '';
  for (let i = 0; i < rmSidFieldCount; i++) {
    const prev = existing[i] || { select: '', custom: '' };
    const row = document.createElement('div');
    row.className = 'rm-sid-row';
    row.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end; margin-bottom:8px;';
    row.innerHTML = `
      <div style="flex:1; min-width:140px;">
        <label>SID ${i + 1}</label>
        <select class="rm-sid-select">${rmSidSelectOptions(prev.select)}</select>
      </div>
      <div style="flex:1; min-width:140px;">
        <label>Or type SID</label>
        <input type="text" class="rm-sid-custom" maxlength="11" placeholder="Custom SID" value="${escapeHtml(prev.custom)}">
      </div>
      ${rmSidFieldCount > 1 ? `<button class="btn-secondary" type="button" style="padding:8px 10px;" data-i="${i}" onclick="rmRemoveSidField(${i})">Remove</button>` : ''}
    `;
    host.appendChild(row);
  }
  document.getElementById('rmAddSidBtn').style.display = rmSidFieldCount >= 3 ? 'none' : '';
}

function renderRmContentFields() {
  const host = document.getElementById('rmContentFields');
  const existing = [...host.querySelectorAll('.rm-content-input')].map(el => el.value);
  host.innerHTML = '';
  for (let i = 0; i < rmContentFieldCount; i++) {
    const prev = existing[i] || '';
    const row = document.createElement('div');
    row.className = 'rm-content-row';
    row.style.cssText = 'margin-bottom:8px;';
    row.innerHTML = `
      <div style="display:flex; gap:8px; align-items:flex-start;">
        <div style="flex:1;">
          <label>Content ${i + 1}</label>
          <textarea class="rm-content-input" placeholder="SMS text…" style="min-height:64px;">${escapeHtml(prev)}</textarea>
        </div>
        ${rmContentFieldCount > 1 ? `<button class="btn-secondary" type="button" style="margin-top:22px; padding:8px 10px;" onclick="rmRemoveContentField(${i})">Remove</button>` : ''}
      </div>
    `;
    host.appendChild(row);
  }
  document.getElementById('rmAddContentBtn').style.display = rmContentFieldCount >= 3 ? 'none' : '';
}

function rmAddSidField() {
  if (rmSidFieldCount >= 3) return;
  rmSidFieldCount += 1;
  renderRmSidFields();
}

function rmRemoveSidField(index) {
  if (rmSidFieldCount <= 1) return;
  const values = [...document.querySelectorAll('.rm-sid-row')].map(row => ({
    select: row.querySelector('.rm-sid-select')?.value || '',
    custom: row.querySelector('.rm-sid-custom')?.value || ''
  }));
  values.splice(index, 1);
  const host = document.getElementById('rmSidFields');
  host.innerHTML = '';
  rmSidFieldCount = values.length;
  for (let i = 0; i < values.length; i++) {
    const prev = values[i];
    const row = document.createElement('div');
    row.className = 'rm-sid-row';
    row.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end; margin-bottom:8px;';
    row.innerHTML = `
      <div style="flex:1; min-width:140px;">
        <label>SID ${i + 1}</label>
        <select class="rm-sid-select">${rmSidSelectOptions(prev.select)}</select>
      </div>
      <div style="flex:1; min-width:140px;">
        <label>Or type SID</label>
        <input type="text" class="rm-sid-custom" maxlength="11" placeholder="Custom SID" value="${escapeHtml(prev.custom)}">
      </div>
      ${rmSidFieldCount > 1 ? `<button class="btn-secondary" type="button" style="padding:8px 10px;" onclick="rmRemoveSidField(${i})">Remove</button>` : ''}
    `;
    host.appendChild(row);
  }
  document.getElementById('rmAddSidBtn').style.display = rmSidFieldCount >= 3 ? 'none' : '';
}

function rmAddContentField() {
  if (rmContentFieldCount >= 3) return;
  rmContentFieldCount += 1;
  renderRmContentFields();
}

function rmRemoveContentField(index) {
  if (rmContentFieldCount <= 1) return;
  const values = [...document.querySelectorAll('.rm-content-input')].map(el => el.value);
  values.splice(index, 1);
  const host = document.getElementById('rmContentFields');
  host.innerHTML = '';
  rmContentFieldCount = values.length;
  for (let i = 0; i < values.length; i++) {
    const row = document.createElement('div');
    row.className = 'rm-content-row';
    row.style.cssText = 'margin-bottom:8px;';
    row.innerHTML = `
      <div style="display:flex; gap:8px; align-items:flex-start;">
        <div style="flex:1;">
          <label>Content ${i + 1}</label>
          <textarea class="rm-content-input" placeholder="SMS text…" style="min-height:64px;">${escapeHtml(values[i] || '')}</textarea>
        </div>
        ${rmContentFieldCount > 1 ? `<button class="btn-secondary" type="button" style="margin-top:22px; padding:8px 10px;" onclick="rmRemoveContentField(${i})">Remove</button>` : ''}
      </div>
    `;
    host.appendChild(row);
  }
  document.getElementById('rmAddContentBtn').style.display = rmContentFieldCount >= 3 ? 'none' : '';
}

function collectRmPayload() {
  const phones = document.getElementById('rmPhones').value;
  const sids = [...document.querySelectorAll('.rm-sid-row')].map(row => {
    const custom = row.querySelector('.rm-sid-custom')?.value.trim() || '';
    const selected = row.querySelector('.rm-sid-select')?.value.trim() || '';
    return custom || selected;
  }).filter(Boolean);
  const contents = [...document.querySelectorAll('.rm-content-input')]
    .map(el => el.value.trim())
    .filter(Boolean);
  return { phones, sids, contents };
}

function fmtMoney(n) {
  return '€' + (Number(n) || 0).toFixed(2);
}

async function rmPreview() {
  const payload = collectRmPayload();
  try {
    const data = await api('/api/admin/route-matrix/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    document.getElementById('rmPreviewBox').innerHTML =
      `${data.phone_count} phones × ${data.sid_count} SIDs × ${data.content_count} contents × ${data.routes} routes = ` +
      `<strong>${data.total_sms} SMS</strong> · est. ${fmtMoney(data.estimated_cost)}` +
      (data.preview?.length
        ? `<div class="table-wrap" style="margin-top:10px;"><table>
            <thead><tr><th>Route</th><th>SID</th><th>Phone</th><th>Content</th></tr></thead>
            <tbody>${data.preview.map(p => `<tr>
              <td class="mono">${p.route}</td>
              <td class="mono">${escapeHtml(p.sid)}</td>
              <td class="mono">${escapeHtml(p.phone)}</td>
              <td>${escapeHtml((p.text || '').slice(0, 80))}</td>
            </tr>`).join('')}</tbody>
          </table></div><div class="hint">Showing first ${data.preview.length} of ${data.total_sms}</div>`
        : '');
  } catch (e) {
    toast(e.message, true);
  }
}

async function rmRun() {
  const payload = collectRmPayload();
  let preview;
  try {
    preview = await api('/api/admin/route-matrix/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return toast(e.message, true);
  }

  if (!confirm(
    `Run route matrix?\n\n${preview.total_sms} SMS across routes 0–4\nEstimated cost: ${fmtMoney(preview.estimated_cost)}\n\nAccount will end on route 4.`
  )) return;

  const btn = document.getElementById('rmRunBtn');
  btn.disabled = true;
  try {
    const res = await api('/api/admin/route-matrix/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    rmActiveCampaignId = res.campaign_id;
    document.getElementById('rmProgressCard').style.display = 'block';
    document.getElementById('rmProgressText').textContent =
      `Started campaign #${res.campaign_id} — ${res.total_sms} SMS…`;
    toast(`Route matrix started (${res.total_sms} SMS)`);
    startRmProgressPoll();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function startRmProgressPoll() {
  stopRmProgressPoll();
  rmProgressPoll();
  rmProgressTimer = setInterval(rmProgressPoll, 2000);
}

async function rmProgressPoll() {
  try {
    const status = await api('/api/admin/route-matrix/status');
    const run = status.run;
    if (!run) return;
    const campaignId = run.campaign_id || rmActiveCampaignId;
    document.getElementById('rmProgressCard').style.display = 'block';
    let line = `Status: ${run.status}`;
    if (run.status === 'running') {
      line += ` · route ${run.current_route} · ${run.sent}/${run.total_sms} sent`;
    } else if (run.status === 'completed') {
      line += ` · ${run.sent}/${run.total_sms} done`;
    } else if (run.status === 'failed') {
      line += run.error ? ` — ${run.error}` : '';
    }
    document.getElementById('rmProgressText').textContent = line;

    if (campaignId) {
      const results = await api(`/api/admin/route-matrix/results/${campaignId}`);
      const tbody = document.querySelector('#rmResultsTable tbody');
      const sends = results.sends || [];
      tbody.innerHTML = sends.length
        ? sends.map(s => {
          const route = String(s.segment_label || '').replace(/^route:/, '') || '—';
          return `<tr>
            <td class="mono">${escapeHtml(route)}</td>
            <td class="mono">${escapeHtml(s.source || '')}</td>
            <td class="mono">${escapeHtml(s.phone || '')}</td>
            <td>${escapeHtml((s.message_text || '').slice(0, 60))}</td>
            <td><span class="badge ${s.send_status === 'sent' ? 'ok' : 'fail'}">${escapeHtml(s.send_status || '—')}</span></td>
          </tr>`;
        }).join('')
        : '<tr><td colspan="5" class="empty-state">No sends yet</td></tr>';
    }

    if (run.status === 'completed' || run.status === 'failed') {
      stopRmProgressPoll();
      if (run.status === 'completed') toast('Route matrix completed');
      else toast(run.error || 'Route matrix failed', true);
    }
  } catch (e) {
    /* keep polling unless session died */
  }
}

initApp();
