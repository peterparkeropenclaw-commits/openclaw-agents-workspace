'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { Octokit } = require('@octokit/rest');
const fs   = require('fs');
const http = require('http');
const { URL } = require('url');
const {
  scheduleDailyFacebookCronJob,
  healthcheck: facebookHealthcheck,
  testPublish: facebookTestPublish,
  testSchedule: facebookTestSchedule,
  listDrafts: listFacebookDrafts,
  approveDraft: approveFacebookDraft,
  rejectDraft: rejectFacebookDraft,
  formatTelegramSchedule,
} = require('./facebook-daily-cron');

const MISSION_CONTROL_BOT_TOKEN = process.env.MISSION_CONTROL_BOT_TOKEN;
const MISSION_CONTROL_CHAT_ID   = process.env.MISSION_CONTROL_CHAT_ID || '-5085897499';

const LIVE_URLS = {
  'review-responder': 'https://review-responder-hazel.vercel.app',
  'airbnb-optimiser': 'https://airbnb-optimiser.vercel.app',
  'optilyst-app':     'https://optilyst.io',
};

const OWNER = 'peterparkeropenclaw-commits';
const REPOS = ['review-responder', 'airbnb-optimiser', 'optilyst-app'];

const STATE_FILE     = path.join(process.env.HOME, '.openclaw', 'workspace', 'memory', 'heartbeat-state.json');
const COOLDOWNS_FILE = path.join(process.env.HOME, '.openclaw', 'heartbeat-cooldowns.json');
const FACEBOOK_API_HOST = '127.0.0.1';
const FACEBOOK_API_PORT = Number(process.env.FACEBOOK_LOCAL_API_PORT || 3216);
const FACEBOOK_CALLBACK_ALLOWED_UPDATES = JSON.stringify(['callback_query', 'message']);
const RESCHEDULE_PROMPTS = new Map();
let telegramPollingOffset = 0;
let telegramPollingStarted = false;

function loadState()  {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      const initial = { lastTelegramSent: null, lastChecks: {} };
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(initial, null, 2));
      return initial;
    }
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('[state] load error:', e.message);
    return { lastTelegramSent: null, lastChecks: {} };
  }
}
function saveState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) { console.error('[state] save error:', e.message); }
}
function loadCooldowns()  { try { return JSON.parse(fs.readFileSync(COOLDOWNS_FILE, 'utf8')); } catch { return {}; } }
function saveCooldowns(c) { try { fs.writeFileSync(COOLDOWNS_FILE, JSON.stringify(c, null, 2)); } catch (e) { console.error('[state] saveCooldowns error:', e.message); } }

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripHtml(text) {
  return String(text || '').replace(/<[^>]+>/g, '');
}

async function sendTelegram(message, { token = MISSION_CONTROL_BOT_TOKEN, chatId = MISSION_CONTROL_CHAT_ID } = {}) {
  if (!token) { console.error('[telegram] MISSION_CONTROL_BOT_TOKEN not set'); return false; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(message || ''), parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (data.ok) return true;
    console.warn('[telegram] HTML send failed, retrying as plain text:', data.description);
    const plain = stripHtml(message);
    const res2 = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: plain }),
    });
    const data2 = await res2.json();
    if (!data2.ok) console.error('[telegram] plain text send also failed:', data2.description);
    return data2.ok;
  } catch (err) { console.error('[telegram] error:', err.message); return false; }
}

async function notifyControlPlaneDeployed(taskId, liveUrl) {
  try {
    const res = await fetch(`http://localhost:3210/tasks/${taskId}/deployed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'deploy-hook', environment: 'production', live_url: liveUrl, status: 'success' }),
    });
    if (!res.ok) console.error('[control-plane] deployed POST failed:', await res.text());
  } catch (err) { console.error('[control-plane] deployed POST error:', err.message); }
}

async function sendMorningBriefing() {
  console.log('[heartbeat] Morning briefing triggered at', new Date().toISOString());
  const state   = loadState();
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const lines   = ['☀️ Morning briefing.\n'];

  for (const repo of REPOS) {
    try {
      const res = await fetch(LIVE_URLS[repo], { method: 'HEAD' });
      lines.push(`• ${repo}: ${res.status === 200 ? '✅ live' : `⚠️ status ${res.status}`}`);
    } catch { lines.push(`• ${repo}: ❌ unreachable`); }
  }

  let openPRCount = 0;
  const prTitles = [];
  for (const repo of REPOS) {
    try {
      const { data: prs } = await octokit.pulls.list({ owner: OWNER, repo, state: 'open' });
      openPRCount += prs.length;
      prs.forEach((pr) => prTitles.push(`#${pr.number} ${escapeHtml(pr.title)}`));
    } catch {}
  }

  lines.push(`\nOPEN PRs: ${openPRCount}`);
  prTitles.forEach((t) => lines.push(`  ${t}`));

  try {
    const cpRes = await fetch('http://localhost:3210/tasks/active');
    if (cpRes.ok) {
      const tasks = await cpRes.json();
      lines.push(`\nACTIVE TASKS (CP): ${tasks.length}`);
      tasks.slice(0, 5).forEach((t) => lines.push(`  [${escapeHtml(t.id)}] ${escapeHtml(t.title)} — ${escapeHtml(t.state)}`));
    } else {
      lines.push('\nControl Plane: unreachable');
    }
  } catch { lines.push('\nControl Plane: unreachable'); }

  try {
    await sendTelegram(lines.join('\n'));
    state.lastTelegramSent = new Date().toISOString();
    saveState(state);
    console.log('[heartbeat] Morning briefing sent successfully');
  } catch (err) {
    console.error('[heartbeat] Morning briefing sendTelegram failed:', err.message);
  }
}

async function runHeartbeat() {
  const state = loadState();
  console.log(`[heartbeat] Running at ${new Date().toISOString()}`);

  try {
    const res = await fetch('http://localhost:3210/tasks/active');
    if (!res.ok) { console.error('[heartbeat] Control Plane unreachable:', res.status); return; }

    const tasks = await res.json();
    const activeTasks = tasks.filter((t) => !['archived', 'cancelled', 'abandoned'].includes(t.state));

    const thresholds = {
      build_in_progress:  90,
      review_pending:     30,
      pr_opened:          15,
      merge_pending:      10,
      builder_dispatched: 20,
    };

    const cooldowns    = loadCooldowns();
    let cooldownsDirty = false;

    for (const task of activeTasks) {
      const threshold = thresholds[task.state];
      if (!threshold) continue;

      const minutesInState = (Date.now() - new Date(task.updated_at).getTime()) / 60000;

      if (minutesInState > threshold) {
        const cooldownKey = `${task.id}-${task.state}`;
        const lastAlert   = cooldowns[cooldownKey];

        if (!lastAlert || Date.now() - lastAlert > 30 * 60 * 1000) {
          cooldowns[cooldownKey] = Date.now();
          cooldownsDirty = true;
          try {
            await sendTelegram(
              `⏱ Stale task detected\nTask: ${escapeHtml(task.id)}\nTitle: ${escapeHtml(task.title)}\nState: ${escapeHtml(task.state)}\nLast update: ${escapeHtml(task.updated_at)}`
            );
          } catch (err) { console.error('[heartbeat] telegram send error:', err.message); }
        }
      }
    }

    if (cooldownsDirty) saveCooldowns(cooldowns);

    state.lastChecks = state.lastChecks || {};
    state.lastChecks.heartbeat = Date.now();
  } catch (err) {
    console.error('[heartbeat] error:', err.message);
  } finally {
    saveState(state);
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function answerTelegramCallback(callbackQueryId, text) {
  if (!MISSION_CONTROL_BOT_TOKEN) return false;
  const res = await fetch(`https://api.telegram.org/bot${MISSION_CONTROL_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
  const data = await res.json();
  return data.ok;
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/).find(Boolean) || String(text || '').slice(0, 80);
}

function formatRescheduleConfirmation(unixTime) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(unixTime * 1000));
}

function startOfTodayLondon(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return new Date(get('year'), get('month') - 1, get('day'));
}

function parseSimpleRescheduleTime(input, now = new Date()) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const today = startOfTodayLondon(now);

  const parseTime = (value) => {
    const match = value.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const suffix = (match[3] || '').toLowerCase();
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    if (!suffix && hour > 23) return null;
    if (minute > 59 || hour > 23) return null;
    return { hour, minute };
  };

  const buildTimestamp = (date, time) => {
    if (!time) return null;
    const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), time.hour, time.minute, 0, 0);
    return Math.floor(candidate.getTime() / 1000);
  };

  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2}):(\d{2}))?$/i);
  if (isoMatch) {
    const [, year, month, day, hour = '9', minute = '0'] = isoMatch;
    return Math.floor(new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0, 0).getTime() / 1000);
  }

  const monthMap = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  const dateMatch = normalized.match(/^(\d{1,2})\s+([a-z]{3,9})\s+(?:at\s+)?(.+)$/i);
  if (dateMatch) {
    const day = Number(dateMatch[1]);
    const month = monthMap[dateMatch[2].slice(0, 3)];
    const time = parseTime(dateMatch[3]);
    if (month !== undefined && time) {
      let candidate = new Date(now.getFullYear(), month, day, time.hour, time.minute, 0, 0);
      if (candidate.getTime() <= now.getTime()) candidate = new Date(now.getFullYear() + 1, month, day, time.hour, time.minute, 0, 0);
      return Math.floor(candidate.getTime() / 1000);
    }
  }

  const tomorrowMatch = normalized.match(/^tomorrow(?:\s+at)?\s+(.+)$/i);
  if (tomorrowMatch) {
    const time = parseTime(tomorrowMatch[1]);
    if (time) return buildTimestamp(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1), time);
  }

  const dayMap = { sun:0, sunday:0, mon:1, monday:1, tue:2, tues:2, tuesday:2, wed:3, wednesday:3, thu:4, thur:4, thurs:4, thursday:4, fri:5, friday:5, sat:6, saturday:6 };
  const weekdayMatch = normalized.match(/^(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)(?:\s+at)?\s+(.+)$/i);
  if (weekdayMatch) {
    const target = dayMap[weekdayMatch[1].toLowerCase()];
    const time = parseTime(weekdayMatch[2]);
    if (target !== undefined && time) {
      const current = today.getDay();
      const delta = (target - current + 7) % 7;
      let candidateDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + delta);
      let candidateTs = buildTimestamp(candidateDate, time);
      if (candidateTs && candidateTs <= Math.floor(now.getTime() / 1000)) {
        candidateDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + delta + 7);
        candidateTs = buildTimestamp(candidateDate, time);
      }
      return candidateTs;
    }
  }

  return null;
}

async function processFacebookCallback(callback) {
  if (!callback?.data) return { ok: true, ignored: true };
  const [scope, draftId, action] = String(callback.data).split(':');
  if (scope !== 'facebook' || !draftId || !action) return { ok: false, error: 'invalid_callback' };

  console.log(`[FB callback] received: draftId=${draftId} action=${action}`);

  if (action === 'schedule') {
    const draft = await approveFacebookDraft(draftId, {
      action: 'schedule',
      scheduled_time: listFacebookDrafts().find((item) => item.id === draftId)?.scheduled_publish_time,
    });
    RESCHEDULE_PROMPTS.delete(String(callback.message?.chat?.id || ''));
    await answerTelegramCallback(callback.id, 'Draft scheduled');
    await sendTelegram(`✅ Scheduled: ${escapeHtml(firstLine(draft.text))} - going live ${escapeHtml(formatTelegramSchedule(draft.scheduled_publish_time))}`);
    return { ok: true, action, draftId };
  }

  if (action === 'reject') {
    const draft = rejectFacebookDraft(draftId);
    RESCHEDULE_PROMPTS.delete(String(callback.message?.chat?.id || ''));
    await answerTelegramCallback(callback.id, 'Draft rejected');
    await sendTelegram(`❌ Rejected: ${escapeHtml(firstLine(draft.text))}`);
    return { ok: true, action, draftId };
  }

  if (action === 'reschedule') {
    const chatId = String(callback.message?.chat?.id || MISSION_CONTROL_CHAT_ID);
    RESCHEDULE_PROMPTS.set(chatId, { draftId, requestedAt: Date.now() });
    await answerTelegramCallback(callback.id, 'Send a new time');
    await sendTelegram("Reply with your preferred time (e.g. 'tomorrow 9am' or 'Fri 3pm')", { chatId });
    return { ok: true, action, draftId, awaiting_time: true };
  }

  return { ok: false, error: 'unsupported_action' };
}

async function processRescheduleReply(message) {
  const chatId = String(message?.chat?.id || '');
  const pending = RESCHEDULE_PROMPTS.get(chatId);
  const text = String(message?.text || '').trim();
  if (!pending || !text) return false;

  const scheduledTime = parseSimpleRescheduleTime(text);
  if (!scheduledTime) {
    await sendTelegram("Couldn't parse that time - try something like 'Fri 3pm' or 'tomorrow 9am'", { chatId });
    return true;
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  const maxUnix = nowUnix + 30 * 24 * 60 * 60;
  if (scheduledTime <= nowUnix || scheduledTime > maxUnix) {
    await sendTelegram("Couldn't parse that time - try something like 'Fri 3pm' or 'tomorrow 9am'", { chatId });
    return true;
  }

  const draft = await approveFacebookDraft(pending.draftId, { action: 'schedule', scheduled_time: scheduledTime });
  RESCHEDULE_PROMPTS.delete(chatId);
  await sendTelegram(`✅ Rescheduled to ${escapeHtml(formatRescheduleConfirmation(draft.scheduled_publish_time))}`, { chatId });
  return true;
}

async function handleTelegramUpdate(update) {
  if (update.callback_query) return processFacebookCallback(update.callback_query);
  if (update.message?.text) {
    const handled = await processRescheduleReply(update.message);
    return { ok: true, handled };
  }
  return { ok: true, ignored: true };
}

async function startTelegramCallbackPolling() {
  if (telegramPollingStarted || !MISSION_CONTROL_BOT_TOKEN) return;
  telegramPollingStarted = true;

  while (true) {
    try {
      const url = `https://api.telegram.org/bot${MISSION_CONTROL_BOT_TOKEN}/getUpdates?offset=${telegramPollingOffset}&timeout=30&allowed_updates=${encodeURIComponent(FACEBOOK_CALLBACK_ALLOWED_UPDATES)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`);

      for (const update of data.result || []) {
        telegramPollingOffset = Math.max(telegramPollingOffset, Number(update.update_id) + 1);
        try {
          await handleTelegramUpdate(update);
        } catch (error) {
          console.error('[FB callback] update handling failed:', error.message);
        }
      }
    } catch (error) {
      console.error('[FB callback] getUpdates failed:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

function isAuthorized(req) {
  const expected = process.env.TRIGGER_AUTH_TOKEN;
  if (!expected) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${expected}`;
}

async function handleFacebookApi(req, res) {
  if (!isAuthorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
  const url = new URL(req.url, `http://${FACEBOOK_API_HOST}:${FACEBOOK_API_PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/facebook/health') {
      return sendJson(res, 200, await facebookHealthcheck());
    }
    if (req.method === 'POST' && url.pathname === '/facebook/test-publish') {
      return sendJson(res, 200, await facebookTestPublish());
    }
    if (req.method === 'POST' && url.pathname === '/facebook/test-schedule') {
      return sendJson(res, 200, await facebookTestSchedule());
    }
    if (req.method === 'GET' && url.pathname === '/facebook/drafts') {
      return sendJson(res, 200, { drafts: listFacebookDrafts() });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/facebook/approve/')) {
      const draftId = decodeURIComponent(url.pathname.split('/').pop());
      const body = await readJsonBody(req);
      const draft = await approveFacebookDraft(draftId, body || {});
      return sendJson(res, 200, draft);
    }
    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
}

if (!MISSION_CONTROL_BOT_TOKEN) {
  console.error('[peter-heartbeat] FATAL: MISSION_CONTROL_BOT_TOKEN not set, briefings and alerts will fail.');
}

const now    = new Date();
const next8am = new Date();
next8am.setHours(8, 0, 0, 0);
if (next8am <= now) next8am.setDate(next8am.getDate() + 1);
console.log('[heartbeat] Morning briefing scheduled in', Math.round((next8am - now) / 60000), 'minutes (at', next8am.toISOString() + ')');
setTimeout(() => {
  sendMorningBriefing().catch((err) => console.error('[heartbeat] Morning briefing uncaught error:', err.message));
  setInterval(() => {
    sendMorningBriefing().catch((err) => console.error('[heartbeat] Morning briefing uncaught error:', err.message));
  }, 24 * 60 * 60 * 1000);
}, next8am - now);

runHeartbeat();
setInterval(runHeartbeat, 5 * 60 * 1000);

scheduleDailyFacebookCronJob({ logger: console });
startTelegramCallbackPolling().catch((error) => console.error('[FB callback] polling crashed:', error.message));

http.createServer((req, res) => {
  handleFacebookApi(req, res).catch((error) => {
    console.error('[facebook-api] uncaught error:', error.message);
    sendJson(res, 500, { error: 'internal_error' });
  });
}).listen(FACEBOOK_API_PORT, FACEBOOK_API_HOST, () => {
  console.log(`[facebook-api] Listening on http://${FACEBOOK_API_HOST}:${FACEBOOK_API_PORT}`);
});

console.log('[peter-heartbeat] Started. Mission Control routing: active. STR Clinic polling moved to strclinic-listener. Facebook daily cron scheduling active.');
