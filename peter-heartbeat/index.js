'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { Octokit } = require('@octokit/rest');
const fs   = require('fs');
const { scheduleDailyFacebookSocialJob } = require('./social-post-pipeline');

// ─── Telegram config ─────────────────────────────────────────────────────────
// Mission Control (group chat) — all agent output goes here
const MISSION_CONTROL_BOT_TOKEN = process.env.MISSION_CONTROL_BOT_TOKEN;
const MISSION_CONTROL_CHAT_ID   = process.env.MISSION_CONTROL_CHAT_ID || '-5085897499';

// ─── Project config ──────────────────────────────────────────────────────────
const LIVE_URLS = {
  'review-responder': 'https://review-responder-hazel.vercel.app',
  'airbnb-optimiser': 'https://airbnb-optimiser.vercel.app',
  'optilyst-app':     'https://optilyst.io',
};

const OWNER = 'peterparkeropenclaw-commits';
const REPOS = ['review-responder', 'airbnb-optimiser', 'optilyst-app'];

const STATE_FILE     = path.join(process.env.HOME, '.openclaw', 'workspace', 'memory', 'heartbeat-state.json');
const COOLDOWNS_FILE = path.join(process.env.HOME, '.openclaw', 'heartbeat-cooldowns.json');

// ─── State helpers ─────────────────────────────────────────────────────────────
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

// ─── Telegram HTML helpers ────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripHtml(text) {
  return String(text || '').replace(/<[^>]+>/g, '');
}

// ─── Telegram send → Mission Control ──────────────────────────────────────────
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
    // HTML parse failed — retry as plain text so the message always gets through
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

// ─── Control Plane notify (deploy hooks) ──────────────────────────────────────
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

// ─── Morning briefing → Mission Control ───────────────────────────────────────
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

// ─── Stale task watchdog → Mission Control ─────────────────────────────────────
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

    // record last successful run time
    state.lastChecks = state.lastChecks || {};
    state.lastChecks.heartbeat = Date.now();
  } catch (err) {
    console.error('[heartbeat] error:', err.message);
  } finally {
    // Persist state on every tick so we survive restarts
    saveState(state);
  }
}

// ─── Startup checks ────────────────────────────────────────────────────────────
if (!MISSION_CONTROL_BOT_TOKEN) {
  console.error('[peter-heartbeat] FATAL: MISSION_CONTROL_BOT_TOKEN not set — briefings and alerts will fail.');
}
// ─── Schedule ──────────────────────────────────────────────────────────────────
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

scheduleDailyFacebookSocialJob({
  stateLoader: loadState,
  saveState,
  sendTelegram,
  logger: console,
});

console.log('[peter-heartbeat] Started. Mission Control routing: active. STR Clinic polling moved to strclinic-listener. Facebook pack scheduling active at 08:00 Europe/London by default.');
