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
const { runMorningIntelBriefing } = require('./morning-briefing');
const { sendDailyProjectState } = require('./daily-project-state');

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
const SCHEDULE_PICKERS = new Map(); // draftId → { chatId, label, requestedAt }
const CUSTOM_TIME_PENDING = new Map(); // chatId → { draftId, requestedAt }
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

function parsePresetTime(preset, now = new Date()) {
  const nowUnix = Math.floor(now.getTime() / 1000);
  const match = String(preset || '').match(/^(\d+)h$/);
  if (match) return nowUnix + Number(match[1]) * 3600;
  if (preset === 't9pm') {
    const today = startOfTodayLondon(now);
    const t = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 21, 0, 0, 0);
    return t.getTime() > now.getTime() ? Math.floor(t.getTime() / 1000) : null;
  }
  if (preset === 'tm8am') {
    const today = startOfTodayLondon(now);
    const t = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 8, 0, 0, 0);
    return Math.floor(t.getTime() / 1000);
  }
  return null;
}

async function sendScheduleTimePicker(draftId, draft, chatId) {
  const labelPart = draft.label ? ` — ${draft.label}` : '';
  const indexPart = (draft.post_index && draft.total_posts)
    ? `📌 Post ${draft.post_index}/${draft.total_posts}${labelPart}`
    : `📌 Post${labelPart}`;
  const message = `🕐 When do you want to post this?\n\n${indexPart}`;
  const buttons = [
    [
      { text: 'In 1 hour', callback_data: `facebook:${draftId}:timepick:1h` },
      { text: 'In 3 hours', callback_data: `facebook:${draftId}:timepick:3h` },
      { text: 'In 6 hours', callback_data: `facebook:${draftId}:timepick:6h` },
    ],
    [
      { text: 'In 12 hours', callback_data: `facebook:${draftId}:timepick:12h` },
      { text: 'Tonight 9pm', callback_data: `facebook:${draftId}:timepick:t9pm` },
      { text: 'Tomorrow 8am', callback_data: `facebook:${draftId}:timepick:tm8am` },
    ],
    [
      { text: 'Custom time ⌨️', callback_data: `facebook:${draftId}:timepick:custom` },
    ],
  ];
  SCHEDULE_PICKERS.set(draftId, { chatId, label: indexPart, requestedAt: Date.now() });
  const resolvedChatId = chatId || MISSION_CONTROL_CHAT_ID;
  const res = await fetch(`https://api.telegram.org/bot${MISSION_CONTROL_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: resolvedChatId, text: message, reply_markup: { inline_keyboard: buttons } }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram time picker failed: ${data.description}`);
  return data;
}

async function sendScheduleConfirmation(draft, chatId) {
  const labelPart = draft.label ? ` — ${draft.label}` : '';
  const indexPart = (draft.post_index && draft.total_posts)
    ? `Post ${draft.post_index}/${draft.total_posts}${labelPart}`
    : `Post${labelPart}`;
  const formatted = formatRescheduleConfirmation(draft.scheduled_publish_time);
  const message = `✅ Scheduled\n\n📌 ${indexPart}\n📅 ${formatted}`;
  const buttons = [[
    { text: '🕐 Reschedule', callback_data: `facebook:${draft.id}:reschedule` },
    { text: '❌ Cancel', callback_data: `facebook:${draft.id}:cancel` },
  ]];
  const resolvedChatId = chatId || MISSION_CONTROL_CHAT_ID;
  const res = await fetch(`https://api.telegram.org/bot${MISSION_CONTROL_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: resolvedChatId, text: message, reply_markup: { inline_keyboard: buttons } }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram confirmation failed: ${data.description}`);
  return data;
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

  const inHoursMatch = normalized.match(/^in\s+(\d+(?:\.\d+)?)\s+hours?$/i);
  if (inHoursMatch) return Math.round(Math.floor(now.getTime() / 1000) + Number(inHoursMatch[1]) * 3600);

  const tonightMatch = normalized.match(/^tonight(?:\s+at)?\s+(.+)$/i);
  if (tonightMatch) {
    const time = parseTime(tonightMatch[1]);
    // "tonight at 10" means 10pm unless explicitly am
    if (time) {
      if (!tonightMatch[1].match(/\bam\b/i) && time.hour < 12) time.hour += 12;
      return buildTimestamp(today, time);
    }
  }

  // "Monday morning" etc.
  const morningEveningMatch = normalized.match(/^(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|tomorrow|today)\s+(morning|afternoon|evening|night)$/i);
  if (morningEveningMatch) {
    const dayWord = morningEveningMatch[1].toLowerCase();
    const period = morningEveningMatch[2].toLowerCase();
    const periodHour = { morning: 8, afternoon: 14, evening: 18, night: 20 }[period] || 9;
    const time = { hour: periodHour, minute: 0 };
    if (dayWord === 'today') return buildTimestamp(today, time);
    if (dayWord === 'tomorrow') return buildTimestamp(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1), time);
    const dayMap2 = { sun:0, sunday:0, mon:1, monday:1, tue:2, tues:2, tuesday:2, wed:3, wednesday:3, thu:4, thur:4, thurs:4, thursday:4, fri:5, friday:5, sat:6, saturday:6 };
    const target = dayMap2[dayWord];
    if (target !== undefined) {
      const current = today.getDay();
      const delta = (target - current + 7) % 7 || 7;
      const candidateDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + delta);
      return buildTimestamp(candidateDate, time);
    }
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

async function processAuditCallback(callback) {
  if (!callback?.data) return { ok: true, ignored: true };
  const parts = String(callback.data).split(':');
  if (parts[0] !== 'audit' || parts.length < 3) return { ok: true, ignored: true };
  const auditId = parts[1];
  const action = parts[2];

  console.log(`[audit callback] received: auditId=${auditId} action=${action}`);
  await answerTelegramCallback(callback.id, action === 'approve' ? 'Approving...' : 'Rejecting...');

  try {
    const authToken = process.env.TRIGGER_AUTH_TOKEN;
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch('http://localhost:3215/audit-approval', {
      method: 'POST',
      headers,
      body: JSON.stringify({ auditId, action }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`[audit callback] webhook returned ${res.status}:`, data);
      return { ok: false, error: data.error };
    }
    return { ok: true, action, auditId };
  } catch (err) {
    console.error('[audit callback] POST to webhook failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function processFacebookCallback(callback) {
  if (!callback?.data) return { ok: true, ignored: true };
  const parts = String(callback.data).split(':');
  const scope = parts[0];
  const draftId = parts[1];
  const action = parts[2];
  const actionParam = parts.slice(3).join(':');
  if (scope !== 'facebook' || !draftId || !action) return { ok: false, error: 'invalid_callback' };

  console.log(`[FB callback] received: draftId=${draftId} action=${action} param=${actionParam}`);
  const chatId = String(callback.message?.chat?.id || MISSION_CONTROL_CHAT_ID);

  if (action === 'schedule') {
    const drafts = listFacebookDrafts();
    const draft = drafts.find((item) => item.id === draftId);
    if (!draft) return { ok: false, error: 'draft_not_found' };
    await answerTelegramCallback(callback.id, 'Choose a time');
    await sendScheduleTimePicker(draftId, draft, chatId);
    return { ok: true, action, draftId, awaiting_time: true };
  }

  if (action === 'reject') {
    const draft = rejectFacebookDraft(draftId);
    RESCHEDULE_PROMPTS.delete(chatId);
    CUSTOM_TIME_PENDING.delete(chatId);
    SCHEDULE_PICKERS.delete(draftId);
    await answerTelegramCallback(callback.id, 'Draft rejected');
    await sendTelegram(`❌ Rejected: ${escapeHtml(firstLine(draft.text))}`);
    return { ok: true, action, draftId };
  }

  if (action === 'cancel') {
    const draft = rejectFacebookDraft(draftId);
    CUSTOM_TIME_PENDING.delete(chatId);
    SCHEDULE_PICKERS.delete(draftId);
    await answerTelegramCallback(callback.id, 'Post cancelled');
    await sendTelegram(`❌ Cancelled: ${escapeHtml(firstLine(draft.text))}`);
    return { ok: true, action, draftId };
  }

  if (action === 'reschedule') {
    const drafts = listFacebookDrafts();
    const draft = drafts.find((item) => item.id === draftId);
    if (!draft) return { ok: false, error: 'draft_not_found' };
    await answerTelegramCallback(callback.id, 'Choose a new time');
    await sendScheduleTimePicker(draftId, draft, chatId);
    return { ok: true, action, draftId, awaiting_time: true };
  }

  if (action === 'timepick') {
    if (!actionParam) return { ok: false, error: 'missing_param' };
    if (actionParam === 'custom') {
      CUSTOM_TIME_PENDING.set(chatId, { draftId, requestedAt: Date.now() });
      await answerTelegramCallback(callback.id, 'Type your preferred time');
      await sendTelegram("Reply with your preferred time (e.g. 'tomorrow 7am', 'Friday 9pm', 'in 2 hours')", { chatId });
      return { ok: true, action, draftId, awaiting_custom: true };
    }

    const scheduledTime = parsePresetTime(actionParam);
    if (!scheduledTime) {
      await answerTelegramCallback(callback.id, 'That time has passed — pick another');
      return { ok: false, error: 'preset_time_past' };
    }

    const draft = await approveFacebookDraft(draftId, { action: 'schedule', scheduled_time: scheduledTime });
    SCHEDULE_PICKERS.delete(draftId);
    CUSTOM_TIME_PENDING.delete(chatId);
    await answerTelegramCallback(callback.id, 'Scheduled ✅');
    await sendScheduleConfirmation(draft, chatId);
    return { ok: true, action, draftId, scheduled_time: scheduledTime };
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

async function processCustomTimeReply(message) {
  const chatId = String(message?.chat?.id || '');
  const pending = CUSTOM_TIME_PENDING.get(chatId);
  const text = String(message?.text || '').trim();
  if (!pending || !text) return false;

  const nowUnix = Math.floor(Date.now() / 1000);
  const maxUnix = nowUnix + 24 * 60 * 60;

  // First try natural language parser
  let scheduledTime = parseSimpleRescheduleTime(text);
  // Also try "in N hours" pattern not covered by parseSimpleRescheduleTime
  if (!scheduledTime) {
    const inHours = text.match(/^in\s+(\d+(?:\.\d+)?)\s+hours?$/i);
    if (inHours) scheduledTime = Math.round(nowUnix + Number(inHours[1]) * 3600);
  }

  if (!scheduledTime) {
    await sendTelegram("Couldn't parse that time. Try 'tomorrow 7am', 'Friday 9pm', or 'in 2 hours'.", { chatId });
    return true;
  }

  if (scheduledTime <= nowUnix) {
    await sendTelegram("That time is in the past. Try a time in the next 24 hours.", { chatId });
    return true;
  }

  if (scheduledTime > maxUnix) {
    await sendTelegram("That time is more than 24 hours away. Please pick a time within the next 24 hours.", { chatId });
    return true;
  }

  const draft = await approveFacebookDraft(pending.draftId, { action: 'schedule', scheduled_time: scheduledTime });
  CUSTOM_TIME_PENDING.delete(chatId);
  SCHEDULE_PICKERS.delete(pending.draftId);
  await sendScheduleConfirmation(draft, chatId);
  return true;
}

async function handleTelegramUpdate(update) {
  if (update.callback_query) {
    const data = String(update.callback_query?.data || '');
    if (data.startsWith('audit:')) return processAuditCallback(update.callback_query);
    return processFacebookCallback(update.callback_query);
  }
  if (update.message?.text) {
    const handledCustom = await processCustomTimeReply(update.message);
    if (handledCustom) return { ok: true, handled: true };
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

function getNextUkDailyRun(hour, minute, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  const ukNowAsUtc = new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  ));
  const ukTargetAsUtc = new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    minute,
    0,
  ));
  if (ukTargetAsUtc <= ukNowAsUtc) ukTargetAsUtc.setUTCDate(ukTargetAsUtc.getUTCDate() + 1);
  return new Date(now.getTime() + (ukTargetAsUtc - ukNowAsUtc));
}

function scheduleDailyUkJob({ label, hour, minute, job }) {
  const scheduleNext = () => {
    const next = getNextUkDailyRun(hour, minute);
    const delay = Math.max(1000, next - new Date());
    console.log(`[${label}] Scheduled in ${Math.round(delay / 60000)} minutes (at ${next.toISOString()}, ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} Europe/London)`);
    setTimeout(async () => {
      try {
        await job();
      } catch (err) {
        console.error(`[${label}] uncaught error:`, err.message);
      } finally {
        scheduleNext();
      }
    }, delay);
  };
  scheduleNext();
}

scheduleDailyUkJob({
  label: 'heartbeat-morning-briefing',
  hour: 8,
  minute: 0,
  job: sendMorningBriefing,
});

scheduleDailyUkJob({
  label: 'morning-intel-briefing',
  hour: 7,
  minute: 30,
  job: async () => {
    const result = await runMorningIntelBriefing();
    console.log(`[morning-intel-briefing] completed sent=${result.sent}`);
  },
});

scheduleDailyUkJob({
  label: 'daily-project-state',
  hour: 23,
  minute: 0,
  job: sendDailyProjectState,
});

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
