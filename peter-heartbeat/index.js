'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { Octokit } = require('@octokit/rest');
const fs   = require('fs');
const { spawn } = require('child_process');

// ─── Telegram config ─────────────────────────────────────────────────────────
// Mission Control (group chat) — all agent output goes here
const MISSION_CONTROL_BOT_TOKEN = process.env.MISSION_CONTROL_BOT_TOKEN;
const MISSION_CONTROL_CHAT_ID   = process.env.MISSION_CONTROL_CHAT_ID || '-5085897499';

// STR Clinic dedicated listener bot — eliminates getUpdates race with PeterParkerOpenClawBot
const STR_CLINIC_BOT_TOKEN = process.env.STR_CLINIC_BOT_TOKEN;

// CDR webhook auth token (matches TRIGGER_AUTH_TOKEN in trigger-server .env)
const CDR_AUTH_TOKEN  = process.env.TRIGGER_AUTH_TOKEN || process.env.CDR_AUTH_TOKEN || '';
const CDR_WEBHOOK_URL = 'http://localhost:3104/task';

// ─── Audit generator paths ───────────────────────────────────────────────────
const FREE_AUDIT_SCRIPT  = path.join(process.env.HOME, 'workspace/str-clinic-free-audit-generator/generate-free-audit.js');
const PAID_AUDIT_SCRIPT  = path.join(process.env.HOME, 'workspace/str-clinic-pdf-generator/generate-report.js');
const GOOGLE_CREDS       = path.join(process.env.HOME, 'workspace/full-take-outreach/credentials.json');

const FREE_DRIVE_FOLDER  = '1nMysoqPplQT1S1C4f_Gjj75u_PSVEgpr';
const PAID_DRIVE_FOLDER  = '12RlJRy_U9lD0mPfH4WVcEYrwdXcSpWar';

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

// ─── Telegram HTML sanitiser ──────────────────────────────────────────────────
function sanitiseTelegramHTML(text) {
  if (typeof text !== 'string') return '';
  // Allowed tags: b, i, u, s, code, pre, a
  // Remove any other tags entirely (including attributes) but keep their text content
  return text.replace(/<([^>]+)>/g, (m, inner) => {
    const tagMatch = inner.match(/^\s*\/?\s*([a-zA-Z0-9]+)\b/);
    if (!tagMatch) return '';
    const tag = tagMatch[1].toLowerCase();
    const allowed = ['b','i','u','s','code','pre','a'];
    if (allowed.includes(tag)) {
      // For <a>, preserve href attribute only and sanitize it
      if (tag === 'a') {
        const hrefMatch = inner.match(/href\s*=\s*"([^"]+)"/i) || inner.match(/href\s*=\s*'([^']+)'/i);
        if (hrefMatch) {
          const href = hrefMatch[1].replace(/"/g, '');
          return `<a href="${href}">`;
        }
        // If no href, strip tag
        return '';
      }
      return `<${tag}>`;
    }
    return '';
  }).replace(/<\s*\/\s*([a-zA-Z0-9]+)\s*>/g, (m, tag) => {
    const t = tag.toLowerCase();
    const allowed = ['b','i','u','s','code','pre','a'];
    return allowed.includes(t) ? `</${t}>` : '';
  });
}

// ─── Telegram send → Mission Control ──────────────────────────────────────────
async function sendTelegram(message, { token = MISSION_CONTROL_BOT_TOKEN, chatId = MISSION_CONTROL_CHAT_ID } = {}) {
  if (!token) { console.error('[telegram] MISSION_CONTROL_BOT_TOKEN not set'); return false; }
  try {
    const safe = sanitiseTelegramHTML(message).replace(/[_*`\[\]()~+=|{}!]/g, '');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: safe, parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (data.ok) return true;
    // HTML parse failed — retry as plain text so the message always gets through
    console.warn('[telegram] HTML send failed, retrying as plain text:', data.description);
    const plain = message.replace(/<[^>]+>/g, '').replace(/[_*`\[\]()~+=|{}!]/g, '');
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

// ─── CDR webhook notify ────────────────────────────────────────────────────────
async function notifyCDR(taskId, brief) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (CDR_AUTH_TOKEN) headers['Authorization'] = `Bearer ${CDR_AUTH_TOKEN}`;
    const res = await fetch(CDR_WEBHOOK_URL, {
      method:  'POST',
      headers,
      body: JSON.stringify({ task_id: taskId, brief, priority: 'high', from: 'str-clinic-listener' }),
    });
    if (!res.ok) console.error('[cdr-webhook] POST failed:', res.status, await res.text());
    else console.log('[cdr-webhook] notified:', taskId);
  } catch (err) {
    console.error('[cdr-webhook] error:', err.message);
  }
}

// ─── Run generator script ─────────────────────────────────────────────────────
// Returns Drive link extracted from stdout, or null on failure.
function runGenerator(scriptPath, inputJsonPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [scriptPath, '--input', inputJsonPath], {
      cwd: path.dirname(scriptPath),
      env: {
        ...process.env,
        GOOGLE_APPLICATION_CREDENTIALS: GOOGLE_CREDS,
        CDR_WEBHOOK_URL: process.env.CDR_WEBHOOK_URL || CDR_WEBHOOK_URL,
        TRIGGER_AUTH_TOKEN: process.env.TRIGGER_AUTH_TOKEN || CDR_AUTH_TOKEN,
        CDR_AUTH_TOKEN: process.env.CDR_AUTH_TOKEN || CDR_AUTH_TOKEN,
      },
    });

    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { output += d.toString(); });

    proc.on('close', (code) => {
      try { fs.unlinkSync(inputJsonPath); } catch {}
      if (code !== 0) {
        reject(new Error(`Generator exited ${code}: ${output.slice(-300)}`));
        return;
      }
      const match = output.match(/https:\/\/drive\.google\.com\/[^\s]+/);
      const qaErrors = [...output.matchAll(/^QA_ERROR: (.+)$/gm)].map(m => m[1]);
      resolve({ driveLink: match ? match[0] : null, qaErrors });
    });

    setTimeout(() => { proc.kill(); reject(new Error('Generator timeout (10min)')); }, 600_000);
  });
}

// ─── Build minimal input JSON for free audit ──────────────────────────────────
function buildFreeAuditInput(airbnbUrl) {
  return {
    listing_url:                  airbnbUrl,
    property_name:                'Your property',
    location:                     airbnbUrl.includes('airbnb.co.uk') ? 'UK' : 'Unknown',
    date:                         new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }),
    currency_code:                airbnbUrl.includes('airbnb.co.uk') ? 'GBP' : 'USD',
    overall_score:                47,
    score_narrative:              'Audit in progress — score will be personalised by Brandon.',
    monthly_revenue_gap_estimate: airbnbUrl.includes('airbnb.co.uk') ? '£180–£320/month' : '$200–$380/month',
    top_3_issues: [
      { issue: 'Personalised audit pending', description: 'Brandon will review and update these findings.', revenue_impact: 'Est. impact: TBD' },
    ],
    current_title:     'Retrieving from listing...',
    rewritten_title:   'Personalised title to be added by Brandon',
    title_rationale:   'To be added by Brandon.',
    opportunity_summary: 'Full opportunity analysis to follow.',
  };
}

// ─── Build minimal input JSON for paid audit ──────────────────────────────────
function buildPaidAuditInput(airbnbUrl) {
  return {
    listing_url: airbnbUrl,
    airbnb_url:  airbnbUrl,
    _scrape_url: airbnbUrl,
  };
}

// ─── Audit dedup: prevent double-processing same URL within 10 minutes ────────
const recentAudits = new Map(); // url+type → timestamp
function isDuplicate(url, type) {
  const key = `${type}:${url}`;
  const last = recentAudits.get(key);
  if (last && Date.now() - last < 10 * 60 * 1000) return true;
  recentAudits.set(key, Date.now());
  return false;
}

// ─── Main audit trigger ────────────────────────────────────────────────────────
async function triggerAudit(airbnbUrl, type, fromUsername) {
  const taskId    = `STR-${type.toUpperCase()}-${Date.now()}`;
  const typeLabel = type === 'free' ? 'Free Audit' : 'Paid Report';
  const script    = type === 'free' ? FREE_AUDIT_SCRIPT : PAID_AUDIT_SCRIPT;
  const folder    = type === 'free' ? FREE_DRIVE_FOLDER : PAID_DRIVE_FOLDER;

  console.log(`[audit] ${typeLabel} triggered by ${fromUsername} for ${airbnbUrl}`);

  // 1. Notify CDR webhook (fire-and-forget — don't block on it)
  const cdrBrief = `${typeLabel} requested via STR Clinic listener bot.\n\nURL: ${airbnbUrl}\nRequested by: ${fromUsername}\nTask ID: ${taskId}\n\nGenerator running — will report Drive link to Mission Control when complete.`;
  notifyCDR(taskId, cdrBrief).catch(() => {});

  // 2. Acknowledge on Mission Control immediately
  await sendTelegram(
    `📋 <b>STR Clinic ${typeLabel}</b>\n\nURL: ${airbnbUrl}\nRequested by: ${fromUsername}\nTask: ${taskId}\n\nGenerator running...`
  );

  // 3. Write input JSON
  const inputData = type === 'free' ? buildFreeAuditInput(airbnbUrl) : buildPaidAuditInput(airbnbUrl);
  const tmpInput  = `/tmp/str-audit-${taskId}.json`;
  fs.writeFileSync(tmpInput, JSON.stringify(inputData, null, 2));

  // 4. Run generator (long-running — up to 5 min)
  try {
    const { driveLink, qaErrors } = await runGenerator(script, tmpInput);

    if (driveLink) {
      console.log(`[audit] ${typeLabel} complete: ${driveLink}`);
      let msg = `✅ <b>STR Clinic ${typeLabel} ready</b>\n\nURL: ${airbnbUrl}\nTask: ${taskId}`;
      if (qaErrors.length > 0) {
        msg += `\n\n⚠️ QA flagged ${qaErrors.length} issue${qaErrors.length !== 1 ? 's' : ''} — review before sending to customer\n${qaErrors.map(e => `• ${e}`).join('\n')}`;
      }
      msg += `\n\nDrive: ${driveLink}`;
      await sendTelegram(msg);
    } else {
      console.warn(`[audit] ${typeLabel} complete but no Drive link captured`);
      await sendTelegram(
        `⚠️ <b>STR Clinic ${typeLabel} generated</b> — Drive link not captured\n\nURL: ${airbnbUrl}\nTask: ${taskId}\n\nCheck Drive folder: https://drive.google.com/drive/folders/${folder}`
      );
    }
  } catch (err) {
    console.error(`[audit] ${typeLabel} failed:`, err.message);
    await sendTelegram(
      `❌ <b>STR Clinic ${typeLabel} failed</b>\n\nURL: ${airbnbUrl}\nTask: ${taskId}\n\nError: ${err.message.slice(0, 200)}`
    );
  }
}

// ─── STR Clinic listener — polls dedicated bot for incoming messages ───────────
let strClinicOffset = 0;

async function pollStrClinicUpdates() {
  if (!STR_CLINIC_BOT_TOKEN) return;

  let data;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${STR_CLINIC_BOT_TOKEN}/getUpdates?offset=${strClinicOffset}&timeout=0`
    );
    data = await res.json();
    if (!data.ok) {
      console.error('[str-clinic-listener] getUpdates failed:', data.description);
      return;
    }
  } catch (err) {
    console.error('[str-clinic-listener] error:', err.message);
    return;
  }

  for (const update of data.result) {
    strClinicOffset = update.update_id + 1;
    const msg = update.message;
    if (!msg) continue;

    const text     = (msg.text || '').trim();
    const from     = msg.from?.username || msg.from?.first_name || 'unknown';
    const lower    = text.toLowerCase();

    // Extract Airbnb URL — supports airbnb.com, airbnb.co.uk, airbnb.com.au, etc.
    const urlMatch = text.match(/https?:\/\/(?:www\.)?airbnb\.[a-z.]+\/rooms\/[^\s]+/i);

    const isFreeAudit = /free\s+audit/i.test(lower);
    const isPaidAudit = /paid\s+audit/i.test(lower);

    if ((isFreeAudit || isPaidAudit) && urlMatch) {
      const airbnbUrl = urlMatch[0].replace(/[<>]/g, '').split('?')[0]; // strip tracking params
      const type      = isPaidAudit ? 'paid' : 'free';

      if (isDuplicate(airbnbUrl, type)) {
        console.log(`[str-clinic-listener] Duplicate ${type} audit request ignored: ${airbnbUrl}`);
        continue;
      }

      // Fire audit async — don't await (polling must stay responsive)
      triggerAudit(airbnbUrl, type, from).catch((err) => {
        console.error('[str-clinic-listener] triggerAudit error:', err.message);
      });
    } else if (isFreeAudit || isPaidAudit) {
      // Keyword detected but no Airbnb URL — request clarification via Mission Control
      const auditType = isPaidAudit ? 'paid audit' : 'free audit';
      console.log(`[str-clinic-listener] ${auditType} keyword from ${from} but no Airbnb URL found`);
      await sendTelegram(
        `⚠️ STR Clinic: "${auditType}" keyword received from ${from} but no Airbnb URL found in message.\n\nMessage: ${text.slice(0, 200)}`
      ).catch(() => {});
    }
  }
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
      tasks.slice(0, 5).forEach((t) => lines.push(`  [${t.id}] ${t.title} — ${t.state}`));
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
    await pollStrClinicUpdates();

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
              `⏱ Stale task detected\nTask: ${task.id}\nTitle: ${task.title}\nState: ${task.state}\nLast update: ${task.updated_at}`
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
if (!STR_CLINIC_BOT_TOKEN) {
  console.warn('[peter-heartbeat] WARNING: STR_CLINIC_BOT_TOKEN not set — STR Clinic listener disabled.');
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

console.log(`[peter-heartbeat] Started. Mission Control routing: active. STR Clinic listener: ${STR_CLINIC_BOT_TOKEN ? 'active' : 'DISABLED (set STR_CLINIC_BOT_TOKEN)'}. Audit triggers: free+paid.`);
