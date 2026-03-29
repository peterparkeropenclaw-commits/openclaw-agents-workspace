'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { Octokit } = require('@octokit/rest');
const fs = require('fs');

const PETER_TELEGRAM_TOKEN = process.env.PETER_TELEGRAM_TOKEN;
const BRANDON_CHAT_ID = process.env.BRANDON_CHAT_ID;

const LIVE_URLS = {
  'review-responder': 'https://review-responder-hazel.vercel.app',
  'airbnb-optimiser': 'https://airbnb-optimiser.vercel.app',
  'optilyst-app': 'https://optilyst.io',
};

const OWNER = 'peterparkeropenclaw-commits';
const REPOS = ['review-responder', 'airbnb-optimiser', 'optilyst-app'];

const STATE_FILE = path.join(process.env.HOME, '.openclaw', 'peter-state.json');
const COOLDOWNS_FILE = path.join(process.env.HOME, '.openclaw', 'heartbeat-cooldowns.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      lastTelegramSent: null,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadCooldowns() {
  try {
    return JSON.parse(fs.readFileSync(COOLDOWNS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCooldowns(cooldowns) {
  fs.writeFileSync(COOLDOWNS_FILE, JSON.stringify(cooldowns, null, 2));
}

async function sendTelegram(message) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${PETER_TELEGRAM_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: BRANDON_CHAT_ID,
          text: message,
          parse_mode: 'Markdown',
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

async function notifyControlPlaneDeployed(taskId, liveUrl) {
  try {
    const res = await fetch(`http://localhost:3210/tasks/${taskId}/deployed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor: 'deploy-hook',
        environment: 'production',
        live_url: liveUrl,
        status: 'success',
      }),
    });
    if (!res.ok) {
      console.error('[control-plane] deployed POST failed:', await res.text());
    }
  } catch (err) {
    console.error('[control-plane] deployed POST error:', err.message);
  }
}

async function sendMorningBriefing() {
  const state = loadState();
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const lines = ['☀️ Good morning.\n'];

  for (const repo of REPOS) {
    try {
      const url = LIVE_URLS[repo];
      const res = await fetch(url, { method: 'HEAD' });
      lines.push(
        `• ${repo}: ${res.status === 200 ? '✅ live' : `⚠️ status ${res.status}`}`
      );
    } catch {
      lines.push(`• ${repo}: ❌ unreachable`);
    }
  }

  let openPRCount = 0;
  const prTitles = [];
  for (const repo of REPOS) {
    try {
      const { data: prs } = await octokit.pulls.list({
        owner: OWNER,
        repo,
        state: 'open',
      });
      openPRCount += prs.length;
      prs.forEach((pr) => prTitles.push(`#${pr.number} ${pr.title}`));
    } catch {}
  }

  lines.push(`\nOPEN PRs: ${openPRCount}`);
  prTitles.forEach((t) => lines.push(`  ${t}`));

  let cpStatus = '';
  try {
    const cpRes = await fetch('http://localhost:3210/tasks/active');
    if (cpRes.ok) {
      const tasks = await cpRes.json();
      const activeCount = tasks.length;
      cpStatus = `\nACTIVE TASKS (Control Plane): ${activeCount}`;
      tasks.slice(0, 5).forEach((t) => {
        cpStatus += `\n  [${t.id}] ${t.title} — ${t.state}`;
      });
    }
  } catch {
    cpStatus = '\nControl Plane: unreachable';
  }
  lines.push(cpStatus);

  await sendTelegram(lines.join('\n'));
  state.lastTelegramSent = new Date().toISOString();
  saveState(state);
}

async function runHeartbeat() {
  console.log(`[heartbeat] Running at ${new Date().toISOString()}`);

  try {
    const res = await fetch('http://localhost:3210/tasks/active');
    if (!res.ok) {
      console.error('[heartbeat] Control Plane unreachable:', res.status);
      return;
    }
    const tasks = await res.json();

    const thresholds = {
      build_in_progress: 90,
      review_pending: 30,
      pr_opened: 15,
      merge_pending: 10,
      builder_dispatched: 20,
    };

    const cooldowns = loadCooldowns();
    let cooldownsDirty = false;

    for (const task of tasks) {
      const threshold = thresholds[task.state];
      if (!threshold) continue;

      const minutesInState = (Date.now() - new Date(task.updated_at).getTime()) / 60000;

      if (minutesInState > threshold) {
        const cooldownKey = `${task.id}-${task.state}`;
        const lastAlert = cooldowns[cooldownKey];

        if (!lastAlert || Date.now() - lastAlert > 30 * 60 * 1000) {
          // Stamp cooldown BEFORE sending to prevent re-alert if sendTelegram throws
          cooldowns[cooldownKey] = Date.now();
          cooldownsDirty = true;
          try {
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

    // Save once after the full loop — atomic write
    if (cooldownsDirty) {
      saveCooldowns(cooldowns);
    }
  } catch (err) {
    console.error('[heartbeat] error:', err.message);
  }
}

// Schedule morning briefing at 8am daily
const now = new Date();
const next8am = new Date();
next8am.setHours(8, 0, 0, 0);
if (next8am <= now) next8am.setDate(next8am.getDate() + 1);
const msUntil8am = next8am - now;
setTimeout(() => {
  sendMorningBriefing();
  setInterval(sendMorningBriefing, 24 * 60 * 60 * 1000);
}, msUntil8am);

// Run immediately then every 5 minutes
runHeartbeat();
setInterval(runHeartbeat, 5 * 60 * 1000);

console.log('[peter-heartbeat] Started. Watchdog-only mode. Interval: 5 min. Morning briefing scheduled.');
