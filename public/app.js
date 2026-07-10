// ---------- navigation ----------
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelector(`.nav-item[data-page="${name}"]`).classList.add('active');
  const loaders = { dashboard: loadDashboard, send: loadSendPage, 'sender-ids': loadSenderIds, leads: loadLeads, messages: loadRosters, campaigns: loadCampaigns, reports: loadReports, settings: loadSettings };
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
    throw new Error('Could not reach the server — try restarting it (npm start).');
  }
  const data = await resp.json().catch(() => ({}));
  if (resp.status === 401 && path !== '/api/auth/status' && path !== '/api/auth/login') {
    showLogin();
    throw new Error('Session expired — sign in again');
  }
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

function showLogin(prefillUsername) {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('appShell').style.display = 'none';
  const userEl = document.getElementById('loginUsername');
  const errEl = document.getElementById('loginError');
  if (prefillUsername) userEl.value = prefillUsername;
  errEl.style.display = 'none';
  errEl.textContent = '';
}

function showApp(username) {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appShell').style.display = 'flex';
  const signedIn = document.getElementById('setSignedInUser');
  if (signedIn && username) signedIn.textContent = username;
}

async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const apiId = document.getElementById('loginApiToken').value.trim();
  const errEl = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');
  errEl.style.display = 'none';
  if (!username || !password || !apiId) {
    errEl.textContent = 'Username, portal password, and API token are all required';
    errEl.style.display = 'block';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const r = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, apiId })
    });
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginApiToken').value = '';
    showApp(r.username);
    await refreshTestModeUI();
    await loadSenderIdOptions();
    startBalancePolling();
    loadDashboard();
    refreshBalancePill();
    toast('Signed in — portal session active');
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
    await api('/api/auth/logout', { method: 'POST' });
  } catch (e) { /* ignore */ }
  stopBalancePolling();
  showLogin();
}

document.getElementById('loginApiToken').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});
document.getElementById('loginPassword').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});
document.getElementById('loginUsername').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('loginApiToken').focus();
});

function fmtEur(n) { return '€' + (Number(n) || 0).toFixed(2); }
function fmtMoney(n) { return fmtEur(n); }
function fmtDate(s) { if (!s) return '—'; return new Date(s.replace(' ', 'T') + 'Z').toLocaleString(); }

let balancePollTimer = null;
const SMS_RATE_EUR = 0.05;
let availableSids = [];

function startBalancePolling() {
  if (balancePollTimer) clearInterval(balancePollTimer);
  balancePollTimer = setInterval(() => refreshBalancePill(), 30000);
}

function stopBalancePolling() {
  if (balancePollTimer) clearInterval(balancePollTimer);
  balancePollTimer = null;
}

async function refreshBalancePill() {
  try {
    const { balance } = await api('/api/balance');
    const text = fmtEur(balance);
    document.getElementById('sidebarBalance').textContent = text;
    const settingsBal = document.getElementById('settingsBalance');
    if (settingsBal) settingsBal.textContent = text;
  } catch (e) {}
}

function sidOptionLabel(s) {
  const status = s.status ? ` (${s.status})` : '';
  return `${s.source}${status}`;
}

function buildSidSelectOptions(sids, selected) {
  if (!sids.length) {
    return '<option value="">— no sender IDs on account —</option>';
  }
  const opts = '<option value="">— select sender ID —</option>' +
    sids.map(s => `<option value="${escapeHtml(s.source)}"${s.source === selected ? ' selected' : ''}>${escapeHtml(sidOptionLabel(s))}</option>`).join('');
  return opts;
}

function fillSidSelect(selectEl, selected) {
  if (!selectEl) return;
  const prev = selected || selectEl.value;
  selectEl.innerHTML = buildSidSelectOptions(availableSids, prev);
}

async function loadSenderIdOptions() {
  try {
    const data = await api('/api/sender-ids');
    availableSids = (data.otus || []).filter(s => s.source);
    fillSidSelect(document.getElementById('qsSource'));
    document.querySelectorAll('.seg-source').forEach(sel => fillSidSelect(sel));
    fillSidSelect(document.getElementById('campSource'));
    return availableSids;
  } catch (e) {
    return availableSids;
  }
}

// ---------- DASHBOARD ----------
async function loadDashboard() {
  const data = await api('/api/reports/summary');
  const s = data.stats;
  const cards = [
    { label: 'Balance', value: data.balance != null ? fmtEur(data.balance) : '—', cls: 'accent' },
    { label: 'Total sends', value: s.total_sends || 0, cls: '' },
    { label: 'Delivered', value: s.delivered || 0, cls: 'accent' },
    { label: 'Failed / undelivered', value: (s.api_failed || 0) + (s.dlr_negative || 0), cls: 'fail' },
  ];
  document.getElementById('dashStats').innerHTML = cards.map(c => `
    <div class="card stat-card"><div class="stat-label">${c.label}</div><div class="stat-value ${c.cls}">${c.value}</div></div>
  `).join('');

  const tbody = document.querySelector('#errorTable tbody');
  if (data.legacyFailed > 0 && !data.byErrorCode.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty-state">No failed sends in the last 7 days. (${data.legacyFailed} older failure${data.legacyFailed !== 1 ? 's' : ''} from before — not shown.)</td></tr>`;
  } else {
    tbody.innerHTML = data.byErrorCode.length
      ? data.byErrorCode.map(r => `<tr><td class="mono">${r.send_error_code}</td><td>${r.description}</td><td>${r.count}</td></tr>`).join('')
      : `<tr><td colspan="3" class="empty-state">No failed sends in the last 7 days.</td></tr>`;
  }

  refreshBalancePill();
}

// ---------- SEND SMS (quick) ----------
let qsMessageFileLines = 0;
let defaultRatePerSms = SMS_RATE_EUR;
let appTestMode = true;

function updateTestModeUI(testMode) {
  appTestMode = !!testMode;
  const banner = document.getElementById('testModeBanner');
  const pill = document.getElementById('sidebarMode');
  if (banner) banner.style.display = appTestMode ? 'block' : 'none';
  if (pill) {
    pill.style.display = 'block';
    pill.textContent = appTestMode ? 'TEST MODE' : 'LIVE';
    pill.className = 'mode-pill ' + (appTestMode ? 'mode-test' : 'mode-live');
  }
}

async function refreshTestModeUI() {
  try {
    const s = await api('/api/settings');
    updateTestModeUI(s.test_mode);
    return s;
  } catch (e) { return null; }
}

function countLines(text) {
  return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).length;
}

function updateQuickSendCount() {
  const nums = countLines(document.getElementById('qsNumbers').value);
  const msgText = document.getElementById('qsMessage').value.trim();
  const msgs = msgText ? countLines(document.getElementById('qsMessage').value) : qsMessageFileLines;
  const msgCount = msgs || (msgText ? 1 : qsMessageFileLines);
  document.getElementById('qsCountTag').textContent = `${nums} number${nums !== 1 ? 's' : ''} × ${msgCount || 0} message${msgCount !== 1 ? 's' : ''} = ${nums * (msgCount || 0)} SMS`;
  if (defaultRatePerSms && nums && msgCount) {
    document.getElementById('qsCostHint').textContent = `~${fmtEur(nums * msgCount * defaultRatePerSms)} est. (1 seg/msg)`;
  }
}

function setFileDropState(wrapId, hasFile) {
  const wrap = document.getElementById(wrapId);
  if (wrap) wrap.classList.toggle('has-file', !!hasFile);
}

function clearFileInput(input, label, defaultLabel, wrapId, onClear) {
  if (!input) return;
  input.value = '';
  if (label) label.textContent = defaultLabel;
  setFileDropState(wrapId, false);
  if (onClear) onClear();
}

function clearQsMessageFile() {
  clearFileInput(
    document.getElementById('qsMessageFile'),
    document.getElementById('qsMessageFileLabel'),
    'Or upload .txt / .csv — one message per line',
    'qsMessageFileWrap',
    () => { qsMessageFileLines = 0; updateQuickSendCount(); }
  );
}

function onQsMessageFile(input) {
  const file = input.files[0];
  document.getElementById('qsMessageFileLabel').textContent = file?.name || 'Or upload .txt / .csv — one message per line';
  setFileDropState('qsMessageFileWrap', !!file);
  if (!file) { qsMessageFileLines = 0; updateQuickSendCount(); return; }
  file.text().then(text => {
    qsMessageFileLines = countLines(text);
    updateQuickSendCount();
  });
}

function clearLaunchMessageFile() {
  clearFileInput(
    document.getElementById('launchMessageFile'),
    document.getElementById('launchMessageFileLabel'),
    'Upload message file (.txt/.csv)',
    'launchMessageFileWrap'
  );
}

function onLaunchMessageFile(input) {
  const file = input.files[0];
  document.getElementById('launchMessageFileLabel').textContent = file?.name || 'Upload message file (.txt/.csv)';
  setFileDropState('launchMessageFileWrap', !!file);
}

async function loadSendPage() {
  try {
    const s = await refreshTestModeUI() || await api('/api/settings');
    defaultRatePerSms = s.default_rate_per_sms || SMS_RATE_EUR;
    await loadSenderIdOptions();
    updateQuickSendCount();
  } catch (e) {}
}

function buildQuickSendFormData() {
  const fd = new FormData();
  fd.append('numbers', document.getElementById('qsNumbers').value);
  fd.append('source', document.getElementById('qsSource').value);
  const msg = document.getElementById('qsMessage').value.trim();
  if (msg) fd.append('message', msg);
  const file = document.getElementById('qsMessageFile').files[0];
  if (file) fd.append('message_file', file);
  return fd;
}

async function previewQuickSend() {
  try {
    const data = await api('/api/quick-send/preview', { method: 'POST', body: buildQuickSendFormData() });
    document.getElementById('qsPreviewWrap').innerHTML = `
      <div class="hint" style="margin-top:0;">${data.phone_count} numbers × ${data.message_count} messages = <strong>${data.total_sms} SMS</strong> · est. ${fmtMoney(data.estimated_cost)}</div>
      <div class="table-wrap"><table><thead><tr><th>Phone</th><th>Message</th><th>Seg</th></tr></thead><tbody>
        ${data.preview.map(p => `<tr><td class="mono">${p.phone}</td><td>${escapeHtml(p.text)}</td><td>${p.parts}</td></tr>`).join('')}
      </tbody></table></div>`;
  } catch (e) { toast(e.message, true); }
}

async function sendQuickSms() {
  const s = await refreshTestModeUI();
  const modeNote = s?.test_mode
    ? 'TEST MODE — this will NOT send to Otus (simulation only).'
    : 'LIVE MODE — this will send real SMS via Otus and may incur charges.';
  if (!confirm(`Send now?\n\n${modeNote}`)) return;
  try {
    const res = await api('/api/quick-send', { method: 'POST', body: buildQuickSendFormData() });
    toast(`Sending ${res.total_sms} SMS — check Reports for results`);
    document.getElementById('qsPreviewWrap').innerHTML = '';
    refreshBalancePill();
  } catch (e) { toast(e.message, true); }
}

// ---------- SENDER IDs ----------
async function loadSenderIds() {
  try {
    const data = await api('/api/sender-ids');
    availableSids = (data.otus || []).filter(s => s.source);
    fillSidSelect(document.getElementById('qsSource'));
    document.querySelectorAll('.seg-source').forEach(sel => fillSidSelect(sel));
    fillSidSelect(document.getElementById('campSource'));

    const otusBody = document.querySelector('#otusSidTable tbody');
    otusBody.innerHTML = (data.otus || []).length
      ? data.otus.map(s => `<tr>
          <td class="mono">${escapeHtml(s.source)}</td>
          <td>${escapeHtml(s.status || '—')}</td>
          <td class="mono">${s.otus_sender_id ?? '—'}</td>
          <td>${s.otus_sender_id ? `<button class="btn-secondary" style="padding:4px 10px;font-size:11px;" data-otus-id="${s.otus_sender_id}" data-source="${escapeHtml(s.source)}" onclick="deleteSenderId(this)">Delete</button>` : ''}</td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="muted">No sender IDs on account yet</td></tr>';

    const localBody = document.querySelector('#localSidTable tbody');
    localBody.innerHTML = (data.requests || []).length
      ? data.requests.map(r => `<tr>
          <td class="mono">${escapeHtml(r.source)}</td>
          <td>${escapeHtml(r.status)}</td>
          <td class="mono">${escapeHtml(r.created_at || '')}</td>
          <td>${escapeHtml(r.description || '')}</td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="muted">No requests submitted via Dispatch yet</td></tr>';
  } catch (e) {
    toast(e.message, true);
  }
}

async function requestSenderId() {
  const source = document.getElementById('sidRequestInput').value.trim();
  if (!source) return toast('Enter a sender ID', true);
  try {
    const res = await api('/api/sender-ids/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source })
    });
    document.getElementById('sidRequestInput').value = '';
    toast(`Request submitted for "${res.source}" — pending Otus approval`);
    loadSenderIds();
  } catch (e) { toast(e.message, true); }
}

async function deleteSenderId(btn) {
  const otusId = Number(btn.dataset.otusId);
  const source = btn.dataset.source || '';
  if (!otusId) return;
  if (!confirm(`Delete sender ID "${source}" from your Otus account?\n\nThis cannot be undone.`)) return;
  try {
    await api('/api/sender-ids/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otus_sender_ids: [otusId] })
    });
    toast(`Deleted "${source}"`);
    loadSenderIds();
  } catch (e) { toast(e.message, true); }
}

// ---------- LAUNCH CAMPAIGN ----------
let launchSegmentCount = 0;

function addLaunchSegment(data) {
  const idx = launchSegmentCount++;
  const host = document.getElementById('launchSegments');
  const div = document.createElement('div');
  div.className = 'segment-block';
  div.dataset.idx = idx;
  div.innerHTML = `
    <div class="seg-header">
      <strong>Client segment ${idx + 1}</strong>
      ${idx > 0 ? `<button class="btn-secondary" style="padding:4px 10px;font-size:11px;" onclick="this.closest('.segment-block').remove(); updateLaunchCount()">Remove</button>` : ''}
    </div>
    <div class="field-row">
      <div><label>Client label (optional)</label><input type="text" class="seg-label" placeholder="e.g. Client A" value="${data?.label || ''}"></div>
      <div><label>Sender ID (SID)</label><select class="seg-source"></select></div>
    </div>
    <label>Numbers (one per line) or upload .txt / .csv</label>
    <textarea class="seg-phones" placeholder="34612345678&#10;34698765432" oninput="updateLaunchCount()">${data?.phones || ''}</textarea>
    <div class="file-drop-wrap seg-file-wrap">
      <div class="file-drop" onclick="this.querySelector('input').click()">
        <div class="seg-file-label">Upload .txt or .csv for this client</div>
        <input type="file" class="seg-file" accept=".csv,.txt" onchange="onSegmentFile(this)">
      </div>
      <button type="button" class="file-drop-close" title="Remove file" onclick="event.stopPropagation(); clearSegmentFile(this)">×</button>
    </div>
  `;
  host.appendChild(div);
  fillSidSelect(div.querySelector('.seg-source'), data?.source || '');
  updateLaunchCount();
}

function onSegmentFile(input) {
  const file = input.files[0];
  const wrap = input.closest('.seg-file-wrap');
  const label = wrap?.querySelector('.seg-file-label');
  if (label) label.textContent = file?.name || 'Upload .txt or .csv for this client';
  if (wrap) wrap.classList.toggle('has-file', !!file);
  updateLaunchCount();
}

function clearSegmentFile(btn) {
  const wrap = btn.closest('.seg-file-wrap');
  const input = wrap?.querySelector('.seg-file');
  const label = wrap?.querySelector('.seg-file-label');
  if (input) input.value = '';
  if (label) label.textContent = 'Upload .txt or .csv for this client';
  if (wrap) wrap.classList.remove('has-file');
  updateLaunchCount();
}

function updateLaunchCount() {
  let total = 0;
  let segs = 0;
  document.querySelectorAll('#launchSegments .segment-block').forEach(block => {
    const phones = countLines(block.querySelector('.seg-phones').value);
    const hasFile = block.querySelector('.seg-file').files[0];
    if (phones || hasFile) { segs++; total += phones || 0; }
  });
  document.getElementById('launchCountTag').textContent = `${total || '?'} leads across ${segs} segment${segs !== 1 ? 's' : ''}`;
}

async function populateLaunchRosters() {
  const rosters = await api('/api/rosters');
  const sel = document.getElementById('launchRosterId');
  sel.innerHTML = '<option value="">— create from above —</option>' +
    rosters.map(r => `<option value="${r.id}">${r.name} (${r.template_count} msgs)</option>`).join('');
}

async function launchCampaign() {
  const name = document.getElementById('launchName').value.trim();
  if (!name) return toast('Campaign name required', true);

  const segments = [];
  const blocks = document.querySelectorAll('#launchSegments .segment-block');
  if (!blocks.length) return toast('Add at least one client segment', true);

  const fd = new FormData();
  for (const block of blocks) {
    const source = block.querySelector('.seg-source').value.trim();
    if (!source) return toast('Each client segment needs a Sender ID (SID)', true);
    const phones = block.querySelector('.seg-phones').value.trim();
    const file = block.querySelector('.seg-file').files[0];
    if (!phones && !file) return toast('Each segment needs numbers (paste or upload .txt / .csv)', true);
    segments.push({
      label: block.querySelector('.seg-label').value.trim(),
      source,
      phones
    });
    if (file) fd.append('segment_files', file);
  }

  const rosterId = document.getElementById('launchRosterId').value;
  const messages = document.getElementById('launchMessages').value.split('\n').map(m => m.trim()).filter(Boolean);
  const msgFile = document.getElementById('launchMessageFile').files[0];
  if (!rosterId && !messages.length && !msgFile) return toast('Add messages (paste, upload, or pick a saved roster)', true);

  const payload = {
    name,
    rotation_mode: document.getElementById('launchRotation').value,
    rate_per_sms: SMS_RATE_EUR,
    throttle_ms: parseInt(document.getElementById('launchThrottle').value) || 300,
    roster_id: rosterId ? parseInt(rosterId) : null,
    messages: rosterId ? [] : messages,
    segments
  };
  fd.append('payload', JSON.stringify(payload));
  if (msgFile && !rosterId) fd.append('message_file', msgFile);

  try {
    const res = await api('/api/campaigns/launch', { method: 'POST', body: fd });
    toast(`Campaign created (${res.segments} client${res.segments > 1 ? 's' : ''}) — open it below to preview & send`);
    document.getElementById('launchName').value = '';
    document.getElementById('launchMessages').value = '';
    clearLaunchMessageFile();
    loadCampaigns();
    openCampaignDetail(res.campaign_id);
  } catch (e) { toast(e.message, true); }
}

// ---------- LEADS ----------
async function loadLeads() {
  const lists = await api('/api/lead-lists');
  const host = document.getElementById('leadLists');
  if (!lists.length) {
    host.innerHTML = `<div class="empty-state"><div class="big">📋</div>No lead lists yet. Paste numbers or upload a .txt / .csv file.</div>`;
    return;
  }
  host.innerHTML = lists.map(l => `
    <div class="list-item">
      <div>
        <div class="li-title">${l.name}</div>
        <div class="li-meta">${l.lead_count} contacts · uploaded ${fmtDate(l.created_at)}</div>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn-secondary" onclick="event.stopPropagation(); deleteList(${l.id})">Delete</button>
      </div>
    </div>
  `).join('');
}
async function deleteList(id) {
  if (!confirm('Delete this lead list and all its contacts?')) return;
  await api('/api/lead-lists/' + id, { method: 'DELETE' });
  toast('List deleted');
  loadLeads();
}
async function uploadLeads() {
  const name = document.getElementById('leadListName').value.trim();
  const file = document.getElementById('leadFileInput').files[0];
  const numbers = document.getElementById('leadNumbersText').value.trim();
  if (!file && !numbers) return toast('Paste numbers or choose a file first', true);
  const fd = new FormData();
  if (file) fd.append('file', file);
  if (numbers) fd.append('numbers', numbers);
  if (name) fd.append('name', name);
  try {
    const res = await api('/api/lead-lists', { method: 'POST', body: fd });
    toast(`Imported ${res.inserted} contacts (${res.skipped} skipped as invalid/duplicate)`);
    closeModal('modal-upload-leads');
    document.getElementById('leadListName').value = '';
    document.getElementById('leadNumbersText').value = '';
    document.getElementById('leadFileInput').value = '';
    document.getElementById('leadFileLabel').textContent = 'Click to upload .txt or .csv';
    loadLeads();
  } catch (e) { toast(e.message, true); }
}

// ---------- ROSTERS ----------
async function loadRosters() {
  const rosters = await api('/api/rosters');
  const host = document.getElementById('rosterLists');
  if (!rosters.length) {
    host.innerHTML = `<div class="empty-state"><div class="big">💬</div>No message rosters yet. Create one with 50–100 variants.</div>`;
    return;
  }
  host.innerHTML = rosters.map(r => `
    <div class="list-item">
      <div>
        <div class="li-title">${r.name}</div>
        <div class="li-meta">${r.template_count} message variants · created ${fmtDate(r.created_at)}</div>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn-secondary" onclick="event.stopPropagation(); deleteRoster(${r.id})">Delete</button>
      </div>
    </div>
  `).join('');
}
async function deleteRoster(id) {
  if (!confirm('Delete this roster and all its message variants?')) return;
  await api('/api/rosters/' + id, { method: 'DELETE' });
  toast('Roster deleted');
  loadRosters();
}
async function createRoster() {
  const name = document.getElementById('rosterName').value.trim();
  const fileInput = document.getElementById('rosterFileInput');
  if (!name) return toast('Give the roster a name', true);
  try {
    let res;
    if (fileInput.files[0]) {
      const fd = new FormData();
      fd.append('file', fileInput.files[0]);
      fd.append('name', name);
      res = await api('/api/rosters/upload', { method: 'POST', body: fd });
    } else {
      const text = document.getElementById('rosterTextarea').value;
      const messages = text.split('\n').map(m => m.trim()).filter(Boolean);
      if (!messages.length) return toast('Add at least one message, or upload a file', true);
      res = await api('/api/rosters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, messages }) });
    }
    toast(`Saved roster with ${res.inserted} messages`);
    closeModal('modal-upload-roster');
    document.getElementById('rosterName').value = '';
    document.getElementById('rosterTextarea').value = '';
    fileInput.value = '';
    document.getElementById('rosterFileLabel').textContent = 'Or click to upload a .txt/.csv';
    loadRosters();
  } catch (e) { toast(e.message, true); }
}

// ---------- CAMPAIGNS ----------
let currentCampaignId = null;

async function loadCampaigns() {
  populateLaunchRosters();
  await loadSenderIdOptions();
  if (!document.querySelector('#launchSegments .segment-block')) addLaunchSegment();
  try {
    const s = await api('/api/settings');
    defaultRatePerSms = s.default_rate_per_sms || SMS_RATE_EUR;
  } catch (e) {}

  const campaigns = await api('/api/campaigns');
  const host = document.getElementById('campaignList');
  if (!campaigns.length) {
    host.innerHTML = `<div class="empty-state"><div class="big">🚀</div>No campaigns yet. Create one from a lead list + message roster.</div>`;
    return;
  }
  host.innerHTML = campaigns.map(c => {
    const statusBadge = { draft: 'neutral', sending: 'warn', completed: 'ok' }[c.status] || 'neutral';
    return `
    <div class="list-item" onclick="openCampaignDetail(${c.id})">
      <div>
        <div class="li-title">${c.name} <span class="badge ${statusBadge}" style="margin-left:6px;">${c.status}</span></div>
        <div class="li-meta">${c.list_name} → ${c.roster_name} · ${c.total_leads} leads · sent ${c.sent_count} · delivered ${c.delivered_count} · failed ${c.failed_count}${c.source ? ' · SID ' + escapeHtml(c.source) : ''}</div>
      </div>
      <div class="muted">→</div>
    </div>`;
  }).join('');
}

async function populateCampaignSelects() {
  const [lists, rosters] = await Promise.all([api('/api/lead-lists'), api('/api/rosters')]);
  await loadSenderIdOptions();
  document.getElementById('campListId').innerHTML = lists.map(l => `<option value="${l.id}">${l.name} (${l.lead_count})</option>`).join('') || '<option disabled>Upload a lead list first</option>';
  document.getElementById('campRosterId').innerHTML = rosters.map(r => `<option value="${r.id}">${r.name} (${r.template_count} variants)</option>`).join('') || '<option disabled>Create a message roster first</option>';
}
document.querySelector('button[onclick="openModal(\'modal-new-campaign\')"]')?.addEventListener('click', populateCampaignSelects);

async function createCampaign() {
  const payload = {
    name: document.getElementById('campName').value.trim(),
    list_id: document.getElementById('campListId').value,
    roster_id: document.getElementById('campRosterId').value,
    source: document.getElementById('campSource').value,
    rotation_mode: document.getElementById('campRotation').value,
    rate_per_sms: SMS_RATE_EUR,
    throttle_ms: parseInt(document.getElementById('campThrottle').value) || 300
  };
  if (!payload.name || !payload.source) return toast('Name and Sender ID are required', true);
  try {
    await api('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    toast('Campaign created');
    closeModal('modal-new-campaign');
    loadCampaigns();
  } catch (e) { toast(e.message, true); }
}

async function openCampaignDetail(id) {
  currentCampaignId = id;
  const { campaign, segments, stats } = await api(`/api/campaigns/${id}/status`);
  document.getElementById('cdTitle').textContent = campaign.name;
  const segInfo = segments?.length > 1
    ? `<div class="hint" style="margin-bottom:8px;">${segments.length} client segments: ${segments.map(s => `${s.label || s.list_name} (${s.source})`).join(' · ')}</div>`
    : '';
  document.getElementById('cdStats').innerHTML = `
    <div class="card stat-card"><div class="stat-label">Sent / Total</div><div class="stat-value">${stats.sent || 0} / ${stats.total || 0}</div></div>
    <div class="card stat-card"><div class="stat-label">Delivered</div><div class="stat-value accent">${stats.delivered || 0}</div></div>
    <div class="card stat-card"><div class="stat-label">Failed</div><div class="stat-value fail">${(stats.failed||0)}</div></div>
  `;
  document.getElementById('cdExportBtn').onclick = () => window.open(`/api/campaigns/${id}/export.csv`, '_blank');
  const sendBtn = document.getElementById('cdSendBtn');
  sendBtn.textContent = campaign.status === 'draft' ? 'Preview & Send' : (campaign.status === 'sending' ? 'Sending…' : 'Already sent');
  sendBtn.disabled = campaign.status !== 'draft';

  if (campaign.status === 'draft') {
    try {
      const preview = await api(`/api/campaigns/${id}/preview`);
      document.getElementById('cdPreviewWrap').innerHTML = segInfo + `
        <div class="hint" style="margin-top:0;">Preview of first ${preview.preview.length} of ${preview.total_leads} leads · ${preview.template_count} message variants · ${preview.segment_count || 1} segment(s) · estimated cost ${fmtMoney(preview.estimated_cost)}</div>
        <div class="table-wrap"><table><thead><tr><th>Phone</th><th>SID</th><th>Client</th><th>Message</th><th>Seg</th></tr></thead><tbody>
          ${preview.preview.map(p => `<tr><td class="mono">${p.phone}</td><td class="mono">${escapeHtml(p.source||'')}</td><td>${escapeHtml(p.segment||'')}</td><td>${escapeHtml(p.text)}</td><td>${p.parts}</td></tr>`).join('')}
        </tbody></table></div>
      `;
    } catch (e) {
      document.getElementById('cdPreviewWrap').innerHTML = `<div class="empty-state">${e.message}</div>`;
    }
  } else {
    const sends = await api(`/api/campaigns/${id}/sends`);
    document.getElementById('cdPreviewWrap').innerHTML = `
      <div class="table-wrap"><table><thead><tr><th>Phone</th><th>SID</th><th>Status</th><th>DLR</th><th>Cost</th></tr></thead><tbody>
        ${sends.slice(0, 100).map(s => `<tr>
          <td class="mono">${s.phone}</td>
          <td class="mono">${escapeHtml(s.source||'')}</td>
          <td><span class="badge ${s.send_status === 'sent' ? 'ok' : 'fail'}">${s.send_status}</span></td>
          <td><span class="badge ${s.dlr_status === 'Delivered' ? 'ok' : (s.dlr_status ? 'fail' : 'neutral')}">${s.dlr_status || 'pending'}</span></td>
          <td class="mono">${fmtMoney(s.cost)}</td>
        </tr>`).join('')}
      </tbody></table></div>
      ${sends.length > 100 ? `<p class="hint">Showing first 100 of ${sends.length}. Export CSV for the full list.</p>` : ''}
    `;
  }
  openModal('modal-campaign-detail');
}

async function sendCampaign() {
  const s = await refreshTestModeUI();
  const modeNote = s?.test_mode
    ? 'TEST MODE — will NOT reach Otus.'
    : 'LIVE MODE — real SMS will be sent via Otus.';
  if (!confirm(`Send this campaign now?\n\n${modeNote}`)) return;
  try {
    const res = await api(`/api/campaigns/${currentCampaignId}/send`, { method: 'POST' });
    toast(`Sending to ${res.lead_count} leads — check back in Reports for progress`);
    closeModal('modal-campaign-detail');
    loadCampaigns();
    refreshBalancePill();
  } catch (e) { toast(e.message, true); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- REPORTS ----------
async function loadReports() {
  const summary = await api('/api/reports/summary');
  const s = summary.stats;
  document.getElementById('reportStats').innerHTML = [
    { label: 'Total sends', value: s.total_sends || 0 },
    { label: 'Delivered', value: s.delivered || 0, cls: 'accent' },
    { label: 'Awaiting DLR', value: s.awaiting_dlr || 0, cls: 'warn' },
    { label: 'Total spend', value: fmtMoney(s.total_spend) },
  ].map(c => `<div class="card stat-card"><div class="stat-label">${c.label}</div><div class="stat-value ${c.cls||''}">${c.value}</div></div>`).join('');

  const campaigns = await api('/api/campaigns');
  const tbody = document.querySelector('#reportTable tbody');
  tbody.innerHTML = campaigns.length ? campaigns.map(c => `
    <tr>
      <td>${escapeHtml(c.name)}</td>
      <td>${c.sent_count || 0}</td>
      <td>${c.delivered_count || 0}</td>
      <td>${c.failed_count || 0}</td>
      <td class="mono">${fmtMoney(c.total_spend)}</td>
      <td><button class="btn-secondary" onclick="window.open('/api/campaigns/${c.id}/export.csv','_blank')">CSV</button></td>
    </tr>
  `).join('') : `<tr><td colspan="6" class="empty-state">No sends yet — use Send SMS or Launch Campaign first.</td></tr>`;
}

// ---------- SETTINGS ----------
async function loadSettings() {
  const s = await api('/api/settings');
  document.getElementById('setSignedInUser').textContent = s.vacotel_username || '—';
  document.getElementById('setTestMode').checked = !!s.test_mode;
  updateTestModeUI(s.test_mode);
  defaultRatePerSms = s.default_rate_per_sms || SMS_RATE_EUR;
  document.getElementById('dlrUrl').value = window.location.origin + '/api/dlr';
  refreshBalancePill();
}
async function saveSettings() {
  const payload = {
    test_mode: document.getElementById('setTestMode').checked
  };
  await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  toast(payload.test_mode ? 'Saved — TEST mode (no real SMS to Otus)' : 'Saved — LIVE mode (real SMS enabled)');
  loadSettings();
}

// ---------- init ----------
async function initApp() {
  try {
    const status = await api('/api/auth/status');
    if (status.authenticated) {
      showApp(status.username);
      await refreshTestModeUI();
      await loadSenderIdOptions();
      startBalancePolling();
      loadDashboard();
      refreshBalancePill();
      return;
    }
    showLogin(status.username || '');
  } catch (e) {
    showLogin();
  }
}

initApp();
