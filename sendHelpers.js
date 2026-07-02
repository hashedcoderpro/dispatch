const { analyzeMessage } = require('./vacotelClient');

function parseLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
}

function parsePhones(text) {
  const { normalizeDestination } = require('./vacotelClient');
  const seen = new Set();
  const phones = [];
  for (const line of parseLines(text)) {
    const phone = normalizeDestination(line);
    if (!/^\d{7,15}$/.test(phone) || seen.has(phone)) continue;
    seen.add(phone);
    phones.push(phone);
  }
  return phones;
}

/** Proportional interleave: 1k + 2k leads → A, B, B, A, B, B… */
function buildInterleavedQueue(segments) {
  const state = segments.map(s => ({
    source: s.source,
    label: s.label || '',
    leads: s.leads,
    sent: 0
  }));
  const weights = state.map(s => s.leads.length);
  const total = weights.reduce((a, b) => a + b, 0);
  const queue = [];

  while (queue.length < total) {
    let pick = -1;
    let bestDeficit = -Infinity;
    for (let i = 0; i < state.length; i++) {
      if (state[i].sent >= state[i].leads.length) continue;
      const fairShare = (queue.length + 1) * (weights[i] / total);
      const deficit = fairShare - state[i].sent;
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        pick = i;
      }
    }
    if (pick < 0) break;
    const seg = state[pick];
    queue.push({
      lead: seg.leads[seg.sent],
      source: seg.source,
      segmentLabel: seg.label,
      segmentIndex: pick
    });
    seg.sent++;
  }
  return queue;
}

/** Each number × each message = one SMS (same SID). */
function buildCartesianQueue(phones, messages) {
  const queue = [];
  for (const phone of phones) {
    for (const text of messages) {
      queue.push({ phone, text });
    }
  }
  return queue;
}

function assignTemplates(queue, templates, rotationMode) {
  return queue.map((item, i) => {
    const tpl = rotationMode === 'random'
      ? templates[Math.floor(Math.random() * templates.length)]
      : templates[i % templates.length];
    return { ...item, template: tpl };
  });
}

function estimateCost(queue, ratePerSms, getText) {
  let total = 0;
  for (const item of queue) {
    const text = getText ? getText(item) : item.text;
    total += analyzeMessage(text).parts * ratePerSms;
  }
  return +total.toFixed(4);
}

module.exports = {
  parseLines,
  parsePhones,
  buildInterleavedQueue,
  buildCartesianQueue,
  assignTemplates,
  estimateCost
};
