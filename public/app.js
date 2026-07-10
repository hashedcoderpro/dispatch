// ---------- navigation ----------
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelector(`.nav-item[data-page="${name}"]`).classList.add('active');
  const loaders = { dashboard: loadDashboard, send: loadSendPage, 'sender-ids': loadSenderIds, campaigns: loadCampaigns, reports: loadTrafficPage, settings: loadSettings };
  loaders[name] && loaders[name]();
}

function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

let confirmSendResolver = null;

function closeConfirmSend(confirmed) {
  document.getElementById('modal-confirm-send').style.display = 'none';
  if (confirmSendResolver) {
    const resolve = confirmSendResolver;
    confirmSendResolver = null;
    resolve(!!confirmed);
  }
}

async function confirmSendModal({ title, testMode, stats, confirmLabel, showMode = true }) {
  document.getElementById('confirmSendTitle').textContent = title || 'Confirm send';
  const modeCls = testMode ? 'mode-test' : 'mode-live';
  const modeLabel = testMode ? 'TEST MODE' : 'LIVE MODE';
  const modeBlock = showMode
    ? `<span class="confirm-mode ${modeCls}">${modeLabel}</span>`
    : '';
  const lines = [
    modeBlock,
    stats.map(s => `<div class="confirm-stat"><span class="muted">${s.label}</span><strong>${s.value}</strong></div>`).join('')
  ].join('');
  document.getElementById('confirmSendBody').innerHTML = lines;
  document.getElementById('confirmSendBtn').textContent = confirmLabel || (testMode ? 'Send (test)' : 'Send now');
  document.getElementById('modal-confirm-send').style.display = 'flex';
  return new Promise(resolve => { confirmSendResolver = resolve; });
}

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
  stopTrafficPolling();
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
let testTemplates = { m: [], p: [] };
let campaignTemplates = { m: [], p: [] };

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
    fillSidSelect(document.getElementById('launchSource'));
    const trafficSel = document.getElementById('trafficSenderFilter');
    if (trafficSel) {
      const prev = trafficSel.value;
      trafficSel.innerHTML = '<option value="">All</option>' +
        availableSids.map(s => `<option value="${escapeHtml(s.source)}"${s.source === prev ? ' selected' : ''}>${escapeHtml(sidOptionLabel(s))}</option>`).join('');
    }
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
let defaultRatePerSms = SMS_RATE_EUR;
let appTestMode = true;

async function loadTestTemplates() {
  try {
    testTemplates = await api('/api/templates?purpose=test');
    const seg = document.getElementById('qsSegment')?.value || 'm';
    const count = (testTemplates[seg] || []).length;
    const hint = document.getElementById('qsTemplateHint');
    if (hint) hint.textContent = count
      ? `${count} message variant${count !== 1 ? 's' : ''} loaded for ${seg.toUpperCase()}`
      : `No test templates for ${seg.toUpperCase()} — ask admin to configure`;
    return testTemplates;
  } catch (e) {
    return testTemplates;
  }
}

async function loadCampaignTemplates() {
  try {
    campaignTemplates = await api('/api/templates?purpose=campaign');
    const seg = document.getElementById('launchSegment')?.value || 'm';
    const count = (campaignTemplates[seg] || []).length;
    const hint = document.getElementById('launchTemplateHint');
    if (hint) hint.textContent = count
      ? `${count} campaign variant${count !== 1 ? 's' : ''} for ${seg.toUpperCase()}`
      : `No campaign templates for ${seg.toUpperCase()} — ask admin to configure`;
    return campaignTemplates;
  } catch (e) {
    return campaignTemplates;
  }
}

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
  const seg = document.getElementById('qsSegment').value;
  const msgCount = (testTemplates[seg] || []).length;
  const hint = document.getElementById('qsTemplateHint');
  if (hint) hint.textContent = msgCount
    ? `${msgCount} message variant${msgCount !== 1 ? 's' : ''} for ${seg.toUpperCase()}`
    : `No test templates for ${seg.toUpperCase()} — ask admin to configure`;
  document.getElementById('qsCountTag').textContent = `${nums} number${nums !== 1 ? 's' : ''} × ${msgCount || 0} message${msgCount !== 1 ? 's' : ''} = ${nums * (msgCount || 0)} SMS`;
  if (defaultRatePerSms && nums && msgCount) {
    document.getElementById('qsCostHint').textContent = `~${fmtEur(nums * msgCount * defaultRatePerSms)} est. (1 seg/msg)`;
  } else {
    document.getElementById('qsCostHint').textContent = '';
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

function onLaunchLeadsFile(input) {
  const file = input.files[0];
  document.getElementById('launchLeadsFileLabel').textContent = file?.name || 'Upload leads (.txt / .csv)';
  setFileDropState('launchLeadsFileWrap', !!file);
  updateLaunchCount();
}

function clearLaunchLeadsFile() {
  clearFileInput(
    document.getElementById('launchLeadsFile'),
    document.getElementById('launchLeadsFileLabel'),
    'Upload leads (.txt / .csv)',
    'launchLeadsFileWrap',
    () => updateLaunchCount()
  );
}

function updateLaunchCount() {
  const phones = countLines(document.getElementById('launchPhones').value);
  const hasLeadsFile = document.getElementById('launchLeadsFile').files[0];
  const seg = document.getElementById('launchSegment').value;
  const msgCount = (campaignTemplates[seg] || []).length;
  const leadLabel = phones ? `${phones} lead${phones !== 1 ? 's' : ''}` : (hasLeadsFile ? 'leads from file' : '0 leads');
  const msgLabel = msgCount ? `${msgCount} variant${msgCount !== 1 ? 's' : ''} (${seg.toUpperCase()})` : `0 variants (${seg.toUpperCase()})`;
  document.getElementById('launchCountTag').textContent = `${leadLabel} · ${msgLabel}`;
  const hint = document.getElementById('launchTemplateHint');
  if (hint) hint.textContent = msgCount
    ? `${msgCount} campaign variant${msgCount !== 1 ? 's' : ''} for ${seg.toUpperCase()}`
    : `No campaign templates for ${seg.toUpperCase()} — ask admin to configure`;
}

function getLaunchRotationMode() {
  const v = Number(document.getElementById('launchDeliveryMode').value);
  return v === 1 ? 'random' : 'sequential';
}

function getLaunchThrottleMs() {
  const perSec = Math.min(15, Math.max(5, parseInt(document.getElementById('launchSmsPerSec').value, 10) || 10));
  return Math.round(1000 / perSec);
}

function updateLaunchDeliveryLabel() {
  const v = Number(document.getElementById('launchDeliveryMode').value);
  document.getElementById('launchDeliveryValue').textContent = v === 1 ? 'Mix 2' : 'Mix';
}

function updateLaunchRateLabel() {
  const perSec = document.getElementById('launchSmsPerSec').value;
  document.getElementById('launchRateValue').textContent = `${perSec} / sec`;
}

async function launchCampaign() {
  const name = document.getElementById('launchName').value.trim();
  if (!name) return toast('Campaign name required', true);

  const source = document.getElementById('launchSource').value;
  if (!source) return toast('Select a Sender ID (SID)', true);

  const phones = document.getElementById('launchPhones').value.trim();
  const leadsFile = document.getElementById('launchLeadsFile').files[0];
  if (!phones && !leadsFile) return toast('Add leads (paste numbers or upload a file)', true);

  const segment = document.getElementById('launchSegment').value;
  await loadCampaignTemplates();
  if (!(campaignTemplates[segment] || []).length) {
    return toast(`No campaign templates for segment ${segment.toUpperCase()}`, true);
  }

  const fd = new FormData();
  if (leadsFile) fd.append('segment_files', leadsFile);

  const payload = {
    name,
    segment,
    rotation_mode: getLaunchRotationMode(),
    rate_per_sms: SMS_RATE_EUR,
    throttle_ms: getLaunchThrottleMs(),
    roster_id: null,
    segments: [{ source, phones }]
  };
  fd.append('payload', JSON.stringify(payload));

  try {
    const res = await api('/api/campaigns/launch', { method: 'POST', body: fd });
    toast('Campaign created — preview and send below');
    document.getElementById('launchName').value = '';
    document.getElementById('launchPhones').value = '';
    clearLaunchLeadsFile();
    updateLaunchCount();
    loadCampaigns();
    openCampaignDetail(res.campaign_id);
  } catch (e) { toast(e.message, true); }
}

async function loadSendPage() {
  try {
    const s = await refreshTestModeUI() || await api('/api/settings');
    defaultRatePerSms = s.default_rate_per_sms || SMS_RATE_EUR;
    await loadSenderIdOptions();
    await loadTestTemplates();
    updateQuickSendCount();
  } catch (e) {}
}

function buildQuickSendFormData() {
  const fd = new FormData();
  fd.append('numbers', document.getElementById('qsNumbers').value);
  fd.append('source', document.getElementById('qsSource').value);
  fd.append('segment', document.getElementById('qsSegment').value);
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
  const seg = document.getElementById('qsSegment').value;
  await loadTestTemplates();
  if (!(testTemplates[seg] || []).length) {
    return toast(`No test templates for segment ${seg.toUpperCase()}`, true);
  }

  let preview;
  try {
    preview = await api('/api/quick-send/preview', { method: 'POST', body: buildQuickSendFormData() });
  } catch (e) { return toast(e.message, true); }

  let balance = null;
  try {
    const bal = await api('/api/balance');
    balance = bal.balance;
  } catch (e) {}

  const confirmed = await confirmSendModal({
    title: 'Send test SMS?',
    testMode: !!s?.test_mode,
    stats: [
      { label: 'Segment', value: seg.toUpperCase() },
      { label: 'Total SMS', value: String(preview.total_sms) },
      { label: 'Estimated cost', value: fmtMoney(preview.estimated_cost) },
      { label: 'Account balance', value: balance != null ? fmtEur(balance) : '—' }
    ]
  });
  if (!confirmed) return;

  try {
    const res = await api('/api/quick-send', { method: 'POST', body: buildQuickSendFormData() });
    toast(`Sending ${res.total_sms} SMS — check Traffic Report for delivery status`);
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
    fillSidSelect(document.getElementById('launchSource'));

    const otusBody = document.querySelector('#otusSidTable tbody');
    otusBody.innerHTML = (data.otus || []).length
      ? data.otus.map(s => `<tr>
          <td class="mono">${escapeHtml(s.source)}</td>
          <td>${escapeHtml(s.status || '—')}</td>
          <td class="mono">${s.otus_sender_id ?? '—'}</td>
          <td>${s.otus_sender_id ? `<button class="btn-secondary" style="padding:4px 10px;font-size:11px;" data-otus-id="${s.otus_sender_id}" data-source="${escapeHtml(s.source)}" onclick="deleteSenderId(this)">Delete</button>` : ''}</td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="muted">No sender IDs on account yet</td></tr>';
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
  const confirmed = await confirmSendModal({
    title: 'Delete sender ID?',
    showMode: false,
    confirmLabel: 'Delete',
    stats: [
      { label: 'Sender ID', value: source },
      { label: 'Warning', value: 'Cannot be undone' }
    ]
  });
  if (!confirmed) return;
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

// ---------- CAMPAIGNS ----------
let currentCampaignId = null;

async function loadCampaigns() {
  await loadSenderIdOptions();
  await loadCampaignTemplates();
  updateLaunchCount();

  const campaigns = await api('/api/campaigns');
  const host = document.getElementById('campaignList');
  if (!campaigns.length) {
    host.innerHTML = `<div class="empty-state"><div class="big">🚀</div>No campaigns yet. Set up a campaign above.</div>`;
    return;
  }
  host.innerHTML = campaigns.map(c => {
    const statusBadge = { draft: 'neutral', sending: 'warn', completed: 'ok' }[c.status] || 'neutral';
    return `
    <div class="list-item" onclick="openCampaignDetail(${c.id})">
      <div>
        <div class="li-title">${c.name} <span class="badge ${statusBadge}" style="margin-left:6px;">${c.status}</span></div>
        <div class="li-meta">${c.total_leads} leads · sent ${c.sent_count} · delivered ${c.delivered_count} · failed ${c.failed_count}${c.source ? ' · SID ' + escapeHtml(c.source) : ''}</div>
      </div>
      <div class="muted">→</div>
    </div>`;
  }).join('');
}

async function openCampaignDetail(id) {
  currentCampaignId = id;
  const { campaign, segments, stats } = await api(`/api/campaigns/${id}/status`);
  document.getElementById('cdTitle').textContent = campaign.name;
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
      document.getElementById('cdPreviewWrap').innerHTML = `
        <div class="hint" style="margin-top:0;">Preview of first ${preview.preview.length} of ${preview.total_leads} leads · ${preview.template_count} message variants · estimated cost ${fmtMoney(preview.estimated_cost)}</div>
        <div class="table-wrap"><table><thead><tr><th>Phone</th><th>SID</th><th>Message</th><th>Seg</th></tr></thead><tbody>
          ${preview.preview.map(p => `<tr><td class="mono">${p.phone}</td><td class="mono">${escapeHtml(p.source||'')}</td><td>${escapeHtml(p.text)}</td><td>${p.parts}</td></tr>`).join('')}
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
  let preview;
  try {
    preview = await api(`/api/campaigns/${currentCampaignId}/preview`);
  } catch (e) { return toast(e.message, true); }

  let balance = null;
  try {
    const bal = await api('/api/balance');
    balance = bal.balance;
  } catch (e) {}

  const confirmed = await confirmSendModal({
    title: 'Send campaign?',
    testMode: !!s?.test_mode,
    stats: [
      { label: 'Leads', value: String(preview.total_leads) },
      { label: 'Message variants', value: String(preview.template_count) },
      { label: 'Estimated cost', value: fmtMoney(preview.estimated_cost) },
      { label: 'Account balance', value: balance != null ? fmtEur(balance) : '—' }
    ]
  });
  if (!confirmed) return;

  try {
    const res = await api(`/api/campaigns/${currentCampaignId}/send`, { method: 'POST' });
    toast(`Sending to ${res.lead_count} leads — check Traffic Report for delivery status`);
    closeModal('modal-campaign-detail');
    loadCampaigns();
    refreshBalancePill();
  } catch (e) { toast(e.message, true); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- TRAFFIC REPORT ----------
let trafficPollTimer = null;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function trafficStatusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'delivered') return 'ok';
  if (s === 'sent') return 'warn';
  if (s === 'failed' || s === 'rejected') return 'fail';
  return 'neutral';
}

function truncateText(text, max = 48) {
  const t = String(text || '');
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function stopTrafficPolling() {
  if (trafficPollTimer) clearInterval(trafficPollTimer);
  trafficPollTimer = null;
}

function startTrafficPolling() {
  stopTrafficPolling();
  if (!document.getElementById('trafficAutoRefresh')?.checked) return;
  trafficPollTimer = setInterval(() => loadTrafficReport(true), 10000);
}

function onTrafficAutoRefreshChange() {
  if (document.getElementById('trafficAutoRefresh')?.checked) startTrafficPolling();
  else stopTrafficPolling();
}

async function loadTrafficPage() {
  const from = document.getElementById('trafficDateFrom');
  const to = document.getElementById('trafficDateTo');
  if (from && !from.value) from.value = todayIso();
  if (to && !to.value) to.value = todayIso();
  await loadSenderIdOptions();
  await loadTrafficReport();
  onTrafficAutoRefreshChange();
}

async function loadTrafficReport(silent) {
  const dateFrom = document.getElementById('trafficDateFrom').value;
  const dateTo = document.getElementById('trafficDateTo').value;
  if (!dateFrom || !dateTo) return toast('Select date range', true);

  const params = new URLSearchParams({
    date_from: dateFrom,
    date_to: dateTo,
    sender_id: document.getElementById('trafficSenderFilter').value,
    address: document.getElementById('trafficAddress').value.trim(),
    status: document.getElementById('trafficStatus').value
  });

  try {
    const data = await api('/api/traffic?' + params.toString());
    document.getElementById('trafficStats').innerHTML = [
      { label: 'Total traffic', value: data.totalTraffic ?? 0 },
      { label: 'Total parts', value: data.totalParts ?? 0 },
      { label: 'Delivered', value: data.totalDelivered ?? 0, cls: 'accent' },
      { label: 'Total cost', value: fmtEur(data.totalCost ?? 0) },
    ].map(c => `<div class="card stat-card"><div class="stat-label">${c.label}</div><div class="stat-value ${c.cls||''}">${c.value}</div></div>`).join('');

    const tbody = document.querySelector('#trafficTable tbody');
    tbody.innerHTML = (data.data || []).length ? data.data.map(row => {
      const name = [row.FirstName, row.LastName].filter(Boolean).join(' ') || '—';
      return `<tr>
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(row.DestinationCountry || '—')}</td>
        <td>${escapeHtml(row.DestinationOperator || '—')}</td>
        <td title="${escapeHtml(row.Text || '')}">${escapeHtml(truncateText(row.Text))}</td>
        <td class="mono">${escapeHtml(row.DestinationAddress || '')}</td>
        <td class="mono">${fmtEur(row.TotalRate ?? 0)}</td>
        <td class="mono">${escapeHtml(row.OriginatingAddress || '')}</td>
        <td><span class="badge ${trafficStatusClass(row.StringStatus)}">${escapeHtml(row.StringStatus || '—')}</span></td>
        <td class="mono">${escapeHtml(row.ReceivedDate || '')}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="9" class="empty-state">No traffic for this date range.</td></tr>`;

    if (!silent) startTrafficPolling();
  } catch (e) {
    if (!silent) toast(e.message, true);
  }
}

// ---------- SETTINGS ----------
async function loadSettings() {
  const s = await api('/api/settings');
  document.getElementById('setSignedInUser').textContent = s.vacotel_username || '—';
  document.getElementById('setTestMode').checked = !!s.test_mode;
  updateTestModeUI(s.test_mode);
  defaultRatePerSms = s.default_rate_per_sms || SMS_RATE_EUR;
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
