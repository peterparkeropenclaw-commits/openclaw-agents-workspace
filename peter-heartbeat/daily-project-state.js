'use strict';

const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const TELEGRAM_MAX_LENGTH = 4096;
const DAILY_PROJECT_STATE_CHAT_ID = '5821364140';
const DAILY_PROJECT_STATE_CRON = '0 23 * * *';

const REPOS = [
  { name: 'str-clinic-pdf-generator', path: path.join(process.env.HOME, 'workspace', 'str-clinic-pdf-generator') },
  { name: 'full-take-final', path: path.join(process.env.HOME, 'workspace', 'full-take-final') },
  { name: 'peter-heartbeat', path: __dirname },
];

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripHtml(text) {
  return String(text || '').replace(/<[^>]+>/g, '');
}

function truncate(text, maxLength) {
  const value = String(text || '').trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 28)).trimEnd()}\n… truncated for Telegram`;
}

async function runCommand(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: options.timeout || 15000,
      maxBuffer: options.maxBuffer || 1024 * 1024,
      cwd: options.cwd,
    });
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    return output || '(no output)';
  } catch (err) {
    const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    return `ERROR: ${err.message}${output ? `\n${output}` : ''}`;
  }
}

async function getRepoCommits(repo) {
  const output = await runCommand('git', ['-C', repo.path, 'log', '--oneline', '-10']);
  return `• ${repo.name}\n${output}`;
}

async function getRepoStatus(repo) {
  const output = await runCommand('git', ['-C', repo.path, 'status', '--short']);
  return { repo: repo.name, status: output === '(no output)' ? 'clean' : output };
}

function formatActiveTasks(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return 'No active tasks.';
      return parsed.map((task) => {
        const id = task.id || task.task_id || 'unknown';
        const state = task.state || task.status || 'unknown';
        const title = task.title || task.name || task.description || '';
        return `• [${id}] ${title}${title ? ' — ' : ''}${state}`;
      }).join('\n');
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw || '(no output)';
  }
}

function formatDirtyRepos(statuses) {
  const dirty = statuses.filter((item) => item.status !== 'clean');
  if (dirty.length === 0) return 'All tracked repos clean.';
  return dirty.map((item) => `• ${item.repo}\n${item.status}`).join('\n\n');
}

async function sendTelegram(message, { token = process.env.MISSION_CONTROL_BOT_TOKEN, chatId = DAILY_PROJECT_STATE_CHAT_ID } = {}) {
  if (!token) {
    console.error('[daily-project-state] MISSION_CONTROL_BOT_TOKEN not set');
    return false;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(message || ''), parse_mode: 'HTML' }),
  });
  const data = await res.json();
  if (data.ok) return true;

  console.warn('[daily-project-state] HTML send failed, retrying as plain text:', data.description);
  const res2 = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: stripHtml(message) }),
  });
  const data2 = await res2.json();
  if (!data2.ok) console.error('[daily-project-state] plain text send failed:', data2.description);
  return data2.ok;
}

async function buildDailyProjectStateMessage(now = new Date()) {
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  }).format(now);

  const [commitSections, pm2Health, activeTasksRaw, statuses] = await Promise.all([
    Promise.all(REPOS.map(getRepoCommits)),
    runCommand('pm2', ['list'], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 }),
    runCommand('curl', ['-s', 'localhost:3210/tasks/active'], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }),
    Promise.all(REPOS.map(getRepoStatus)),
  ]);

  const sections = [
    `<b>📋 Daily Project State — ${escapeHtml(date)}</b>`,
    `<b>Commits Today</b>\n<pre>${escapeHtml(truncate(commitSections.join('\n\n'), 1300))}</pre>`,
    `<b>PM2 Health</b>\n<pre>${escapeHtml(truncate(pm2Health, 900))}</pre>`,
    `<b>Active Tasks</b>\n<pre>${escapeHtml(truncate(formatActiveTasks(activeTasksRaw), 900))}</pre>`,
    `<b>Dirty Repos</b>\n<pre>${escapeHtml(truncate(formatDirtyRepos(statuses), 650))}</pre>`,
  ];

  return truncate(sections.join('\n\n'), TELEGRAM_MAX_LENGTH - 50);
}

async function sendDailyProjectState() {
  console.log('[daily-project-state] Generating daily project state at', new Date().toISOString());
  const message = await buildDailyProjectStateMessage();
  const sent = await sendTelegram(message);
  console.log(`[daily-project-state] completed sent=${sent}`);
  return { sent };
}

module.exports = {
  DAILY_PROJECT_STATE_CHAT_ID,
  DAILY_PROJECT_STATE_CRON,
  buildDailyProjectStateMessage,
  sendDailyProjectState,
};

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });
  sendDailyProjectState().catch((err) => {
    console.error('[daily-project-state] failed:', err.message);
    process.exitCode = 1;
  });
}
