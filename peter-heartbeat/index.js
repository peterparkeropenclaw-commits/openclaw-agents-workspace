'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { Octokit } = require('@octokit/rest');
const fs = require('fs');

// ─── Telegram config ─────────────────────────────────────────────────────────
// Mission Control (group chat) — receives all agent Telegram output
const MISSION_CONTROL_BOT_TOKEN = process.env.MISSION_CONTROL_BOT_TOKEN;
const MISSION_CONTROL_CHAT_ID   = process.env.MISSION_CONTROL_CHAT_ID || '-5085897499';

// STR Clinic dedicated listener bot — eliminates getUpdates race with PeterParkerOpenClawBot
// Token generated via BotFather: @STRClinicListenerBot (or similar)
// Set STR_CLINIC_BOT_TOKEN in .env once Brandon has created the bot
const STR_CLINIC_BOT_TOKEN = process.env.STR_CLINIC_BOT_TOKEN;

// ─── Project config ──────────────────────────────────────────────────────────
const LIVE_URLS = {
  'review-responder': 'https://replywave.io',
  'optilyst-app':     'https://optilyst.io',
};

const OWNER = 'peterparkeropenclaw-commits';
const REPOS = ['review-responder', 'optilyst-app'];

const STATE_FILE     = path.join(process.env.HOME, '.openclaw', 'peter-state.json');
const COOLDOWNS_FILE = path.join(process.env.HOME, '.openclaw', 'heartbeat-cooldowns.json');

// ─── State helpers ────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastTelegramSent: null }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadCooldowns() {
  try { return JSON.parse(fs.readFileSync(COOLDOWNS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveCooldowns(cooldowns) {
  fs.writeFileSync(COOLDOWNS_FILE, JSON.stringify(cooldowns, null, 2));
}

// ─── Telegram send ─────────────────────────────────────────────────────────
// All agent output goes to Mission Control — never to Brandon's direct chat.
async function sendTelegram(message, { token = MISSION_CONTROL_BOT_TOKEN, chatId = MISSION_CONTROL_CHAT_ID } = {}) {
  if (!token) {
    console.error('[telegram] MISSION_CONTROL_BOT_TOKEN not set — cannot send');
    return false;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message.replace(/[_*`\[\]()~>#+=|{}.!]/g, ''),
        }),
      }
    );
    const data = await res.json();
    if (!data.ok) console.error('[telegram] send failed:', data.description);
    return data.ok;
  } catch (err) {
    console.error('[telegram] error:', err.message);
    return false;
  }
}

// ─── STR Clinic listener ──────────────────────────────────────────────────────
// Polls getUpdates on the dedicated STR Clinic bot.
// This eliminates the getUpdates race condition caused by both PeterParkerOpenClawBot
// and the heartbeat service polling the same bot token simultaneously.
let strClinicOffset = 0;

async function pollStrClinicUpdates() {
  if (!STR_CLINIC_BOT_TOKEN) {
    // Soft failure — log once and skip silently thereafter
    return;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${STR_CLINIC_BOT_TOKEN}/getUpdates?offset=${strClinicOffset}&timeout=0`
    );
    const data = await res.json();
    if (!data.ok) {
      console.error('[str-clinic-listener] getUpdates failed:', data.description);
      return;
    }
    for (const update of data.result) {
      strClinicOffset = update.update_id + 1;
      const msg = update.message;
      if (!msg) continue;
      const text = msg.text || '';
      const from = msg.from?.username || msg.from?.first_name || 'unknown';
      console.log(`[str-clinic-listener] Message from ${from}: ${text.slice(0, 80)}`);
      // Forward urgent/unknown messages to Mission Control for visibility
      // (STR Clinic bot is a listener — it does not reply autonomously)
    }
  } catch (err) {
    console.error('[str-clinic-listener] error:', err.message);
  }
}

// ─── Control Plane notify ─────────────────────────────────────────────────────
async function notifyControlPlaneDeployed(taskId, liveUrl) {
  try {
    const res = await fetch(`http://localhost:3210/tasks/${taskId}/deployed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor:       'deploy-hook',
        environment: 'production',
        live_url:    liveUrl,
        status:      'success',
      }),
    });
    if (!res.ok) {
      console.error('[control-plane] deployed POST failed:', await res.text());
    }
  } catch (err) {
    console.error('[control-plane] deployed POST error:', err.message);
  }
}

// ─── Morning briefing → Mission Control ──────────────────────────────────────
async function sendMorningBriefing() {
  const state   = loadState();
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const lines   = ['☀️ Morning briefing.\n'];

  for (const repo of REPOS) {
    try {
      const url = LIVE_URLS[repo];
      const res = await fetch(url, { method: 'HEAD' });
      lines.push(`• ${repo}: ${res.status === 200 ? '✅ live' : `⚠️ status ${res.status}`}`);
    } catch {
      lines.push(`• ${repo}: ❌ unreachable`);
    }
  }

  let openPRCount = 0;
  const prTitles = [];
  for (const repo of REPOS) {
    try {
      const { data: prs } = await octokit.pulls.list({ owner: OWNER, repo, state: 'open' });
      openPRCount += prs.length;
      prs.forEach((pr) => prTitles.push(`#${pr.number} ${pr.title}`));
    } catch {}
  }

  lines.push(`\nOPEN PRs: ${openPRCount}`);
  prTitles.forEach((t) => lines.push(`  ${t}`));

  try {
    const cpRes = await fetch('http://localhost:3210/tasks/active');
    if (cpRes.ok) {
      const tasks = await cpRes.json();
      lines.push(`\nACTIVE TASKS (CP): ${tasks.length}`);
      tasks.slice(0, 5).forEach((t) => {
        lines.push(`  [${t.id}] ${t.title} — ${t.state}`);
      });
    } else {
      lines.push('\nControl Plane: unreachable');
    }
  } catch {
    lines.push('\nControl Plane: unreachable');
  }

  // Send to Mission Control — not Brandon's direct chat
  await sendTelegram(lines.join('\n'));
  state.lastTelegramSent = new Date().toISOString();
  saveState(state);
}

// ─── Stale task watchdog → Mission Control ────────────────────────────────────
async function runHeartbeat() {
  console.log(`[heartbeat] Running at ${new Date().toISOString()}`);

  // Poll STR Clinic listener on every heartbeat cycle
  await pollStrClinicUpdates();

  try {
    const res = await fetch('http://localhost:3210/tasks/active');
    if (!res.ok) {
      console.error('[heartbeat] Control Plane unreachable:', res.status);
      return;
    }
    const tasks = await res.json();

    const activeTasks = tasks.filter(
      (t) => !['archived', 'cancelled', 'abandoned'].includes(t.state)
    );

    const thresholds = {
      build_in_progress:   90,
      review_pending:      30,
      pr_opened:           15,
      merge_pending:       10,
      builder_dispatched:  20,
    };

    const cooldowns     = loadCooldowns();
    let cooldownsDirty  = false;

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
            // Alert goes to Mission Control — not Brandon's direct chat
            await sendTelegram(
              `⏱ Stale task detected\n` +
              `Task: ${task.id}\n` +
              `Title: ${task.title}\n` +
              `State: ${task.state}\n` +
              `Last update: ${task.updated_at}`
            );
          } catch (telegramErr) {
            console.error('[heartbeat] telegram send error:', telegramErr.message);
          }
        }
      }
    }

    if (cooldownsDirty) saveCooldowns(cooldowns);
  } catch (err) {
    console.error('[heartbeat] error:', err.message);
  }
}

// ─── Startup checks ───────────────────────────────────────────────────────────
if (!MISSION_CONTROL_BOT_TOKEN) {
  console.error('[peter-heartbeat] FATAL: MISSION_CONTROL_BOT_TOKEN not set. Morning briefings and alerts will fail.');
}

if (!STR_CLINIC_BOT_TOKEN) {
  console.warn('[peter-heartbeat] WARNING: STR_CLINIC_BOT_TOKEN not set. STR Clinic listener disabled. Create bot via BotFather and set this env var.');
}

// ─── Schedule ─────────────────────────────────────────────────────────────────
// Morning briefing at 08:00 daily
const now    = new Date();
const next8am = new Date();
next8am.setHours(8, 0, 0, 0);
if (next8am <= now) next8am.setDate(next8am.getDate() + 1);
const msUntil8am = next8am - now;

setTimeout(() => {
  sendMorningBriefing();
  setInterval(sendMorningBriefing, 24 * 60 * 60 * 1000);
}, msUntil8am);

// Heartbeat every 5 minutes
runHeartbeat();
setInterval(runHeartbeat, 5 * 60 * 1000);

console.log('[peter-heartbeat] Started. Mission Control routing active. STR Clinic listener:', STR_CLINIC_BOT_TOKEN ? 'active' : 'DISABLED (set STR_CLINIC_BOT_TOKEN)');
