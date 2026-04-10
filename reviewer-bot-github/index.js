'use strict';

require('dotenv').config({ path: __dirname + '/.env' });
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const OpenAI = require('openai');

const PORT = parseInt(process.env.PORT || '3205');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
const PETER_BRIDGE_URL = process.env.PETER_BRIDGE_URL || 'http://localhost:3001/deliver';
const PETER_CHANNEL = process.env.PETER_CHANNEL || '1482399843627438131';
const LOG_PATH = process.env.LOG_PATH || '/Users/robotmac/.openclaw/reviewer-log.json';
const SOUL_PATH = '/Users/robotmac/.openclaw/agents/reviewer/SOUL.md';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Load SOUL.md once at startup
let soulMd = '';
try {
  soulMd = fs.readFileSync(SOUL_PATH, 'utf8');
  console.log('[reviewer-bot] SOUL.md loaded:', soulMd.length, 'chars');
} catch (e) {
  console.error('[reviewer-bot] Failed to load SOUL.md:', e.message);
}

function log(entry) {
  const entries = [];
  try { entries.push(...JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'))); } catch {}
  entries.push({ ...entry, ts: new Date().toISOString() });
  fs.writeFileSync(LOG_PATH, JSON.stringify(entries.slice(-500), null, 2));
}

function githubRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'reviewer-bot-github/1.0',
        'Content-Type': 'application/json',
      },
    };
    if (method === 'GET') {
      if (path.includes('/pulls/') && !path.includes('/reviews')) {
        options.headers['Accept'] = 'application/vnd.github.v3.diff';
      }
    }
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function getDiff(owner, repo, prNumber) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/pulls/${prNumber}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3.diff',
        'User-Agent': 'reviewer-bot-github/1.0',
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
}

async function postReview(owner, repo, prNumber, body, event) {
  return githubRequest(
    `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    'POST',
    { body, event }
  );
}

async function notifyPeter(message) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ channelKey: 'peter', content: message });
    const url = new URL(PETER_BRIDGE_URL);
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 3001,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', e => { console.error('[peter-notify] error:', e.message || e.code || String(e)); resolve(null); });
    req.write(payload);
    req.end();
  });
}

async function sendTelegram(message) {
  const TELEGRAM_TOKEN = process.env.PETER_TELEGRAM_TOKEN;
  const CHAT_ID = process.env.BRANDON_CHAT_ID;
  if (!TELEGRAM_TOKEN || !CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message }),
    });
  } catch (err) {
    console.error('[telegram] error:', err.message);
  }
}

const MISSION_CONTROL_CHAT_ID = '-5085897499';

async function sendMissionControl(message) {
  const TELEGRAM_TOKEN = process.env.MISSION_CONTROL_BOT_TOKEN || process.env.PETER_TELEGRAM_TOKEN;
  if (!TELEGRAM_TOKEN) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: MISSION_CONTROL_CHAT_ID, text: message }),
    });
    if (!res.ok) console.error('[mission-control] send failed:', res.status, await res.text());
  } catch (err) {
    console.error('[mission-control] error:', err.message || String(err));
  }
}

// Track PRs received via webhook. Removed when review completes (success or failure after retry).
// key: "owner/repo#prNumber"
const pendingPRs = new Map();

async function runReview(prData, attempt = 1) {
  const { owner, repo, prNumber, title, body } = prData;

  // Extract Control Plane task ID from PR title
  const taskIdMatch = title.match(/\[OC-([^\]]+)\]/);
  if (!taskIdMatch) {
    console.error('No task ID in PR title:', title);
    await postReview(owner, repo, prNumber,
      '⚠️ No task ID found in PR title.\nExpected format: [OC-{id}] Title\nCannot link to Control Plane.',
      'COMMENT'
    );
    return;
  }
  const ocTaskId = taskIdMatch[1];

  const diff = await getDiff(owner, repo, prNumber);
  const diffLines = diff.split('\n').length;
  const diffTruncated = diffLines > 800 ? diff.split('\n').slice(0, 800).join('\n') + '\n\n[diff truncated at 800 lines]' : diff;

  const newPackages = diff.includes('package.json') && (diff.includes('"dependencies"') || diff.includes('"devDependencies"'));
  const authTouched = diff.includes('auth') || diff.includes('signIn') || diff.includes('signOut') || diff.includes('stripe') || diff.includes('payment');
  const dbTouched = diff.includes('schema') || diff.includes('migration') || diff.includes('supabase');
  const needsEscalation = newPackages || authTouched || dbTouched || diffLines > 500;

  const prompt = `You are the OpenClaw Reviewer agent. Review this PR diff against the criteria below. Be precise. Be brief. Never guess.

SOUL.md CRITERIA:
${soulMd}

PR TITLE: ${title}
PR DESCRIPTION: ${body || '(none)'}
REPO: ${owner}/${repo}
DIFF SIZE: ${diffLines} lines
${needsEscalation ? 'NOTE: This PR may need escalation to Brandon (new packages, auth/payment touched, or large diff).' : ''}

DIFF:
${diffTruncated}

Return your review in EXACTLY this format (no extra text before or after):

CSS Framework: PASS or FAIL — reason
Mobile: PASS or FAIL — reason
Content: PASS or FAIL — reason
Routing: PASS or FAIL — reason
Performance: PASS or FAIL — reason

Overall: APPROVED or CHANGES REQUESTED

If CHANGES REQUESTED list each issue with exact file name and line number where possible.`;

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_completion_tokens: 1000,
    temperature: 0.2,
  });

  const reviewText = completion.choices[0].message.content.trim();
  const approved = reviewText.includes('Overall: APPROVED');

  const githubEvent = 'COMMENT';
  const fullReview = `## [OpenClaw Reviewer] PR #${prNumber} — ${owner}/${repo}\n\n${reviewText}\n\n---\n*Reviewed by reviewer-bot-github | ${new Date().toISOString()}*`;

  await postReview(owner, repo, prNumber, fullReview, githubEvent);

  log({ type: 'review', owner, repo, prNumber, title, approved, needsEscalation, diffLines });

  // Notify Control Plane of verdict
  const verdictPayload = {
    verdict: approved ? 'approved' : 'changes_requested',
    actor: 'reviewer-bot',
    reviewer: 'openclawreviewer-a11y',
    repo: `${owner}/${repo}`,
    pr_number: prNumber,
    pr_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
    summary: reviewText.slice(0, 500),
  };

  await postVerdictWithRetry(ocTaskId, verdictPayload, prNumber, `${owner}/${repo}`);

  if (!approved || needsEscalation) {
    const issues = reviewText.split('\n').filter(l => l.includes('FAIL') || l.startsWith('-')).join('\n');
    await notifyPeter(
      `${approved ? '⚠️ ESCALATION' : '❌ CHANGES REQUESTED'}: PR #${prNumber} on ${owner}/${repo}\n"${title}"\n\n${issues || reviewText.slice(0, 400)}\n\n${approved ? 'Approved but needs your attention (new packages/auth/large diff).' : 'Changes requested before merge.'}\nhttps://github.com/${owner}/${repo}/pull/${prNumber}`
    );
  } else {
    console.log(`[reviewer-bot] PR #${prNumber} APPROVED — no escalation needed`);
  }

  return { approved, reviewText };
}

function verifySignature(payload, signature) {
  if (!WEBHOOK_SECRET) return true;
  const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } catch { return false; }
}

async function postVerdictWithRetry(ocTaskId, verdictPayload, prNumber, repo) {
  const delays = [0, 5000, 30000, 120000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await new Promise(r => setTimeout(r, delays[attempt]));
    try {
      const cpRes = await fetch(`http://localhost:3210/tasks/OC-${ocTaskId}/verdict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(verdictPayload),
      });
      if (cpRes.ok) return;
      const errText = await cpRes.text();
      console.error(`[control-plane] verdict attempt ${attempt + 1} failed for OC-${ocTaskId}:`, errText);
    } catch (err) {
      console.error(`[control-plane] verdict attempt ${attempt + 1} error for OC-${ocTaskId}:`, err.message);
    }
  }
  await sendTelegram(`⚠️ CP verdict POST failed for task OC-${ocTaskId} PR #${prNumber}.\nManual state update needed.`);
}

async function runSmokeTest() {
  const checks = {
    process: 'pass',
    tunnel: 'fail',
    github: 'fail',
    openai: 'fail',
    control_plane: 'fail',
    secret: WEBHOOK_SECRET ? 'pass' : 'fail',
  };

  try {
    const r = await fetch('https://reviewer.ocpipe.live/health', { signal: AbortSignal.timeout(5000) });
    if (r.ok) checks.tunnel = 'pass';
  } catch {}

  try {
    const r = await githubRequest('/user');
    if (r.login) checks.github = 'pass';
  } catch {}

  try {
    const r = await openai.models.list();
    if (r) checks.openai = 'pass';
  } catch {}

  try {
    const r = await fetch('http://localhost:3210/health', { signal: AbortSignal.timeout(3000) });
    if (r.ok) checks.control_plane = 'pass';
  } catch {}

  return checks;
}

async function runReconciliation() {
  let tasks;
  try {
    tasks = await new Promise((resolve, reject) => {
      http.get('http://localhost:3210/tasks/active', res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON from /tasks/active')); }
        });
      }).on('error', reject);
    });
  } catch (err) {
    console.error('[reconciliation] failed to fetch active tasks:', err.message);
    return;
  }

  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  const pending = (Array.isArray(tasks) ? tasks : []).filter(t =>
    t.state === 'review_pending' && new Date(t.updated_at).getTime() < tenMinutesAgo
  );

  for (const task of pending) {
    let owner, repoName, prNumber;
    if (task.pr_url) {
      const m = task.pr_url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      if (!m) continue;
      [, owner, repoName, prNumber] = m;
      prNumber = parseInt(prNumber);
    } else if (task.pr_number && task.repo) {
      const parts = task.repo.split('/');
      if (parts.length !== 2) continue;
      [owner, repoName] = parts;
      prNumber = task.pr_number;
    } else {
      continue;
    }

    let reviews;
    try {
      reviews = await githubRequest(`/repos/${owner}/${repoName}/pulls/${prNumber}/reviews`);
    } catch (err) {
      console.error('[reconciliation] failed to fetch reviews for PR', prNumber, ':', err.message);
      continue;
    }

    if (!Array.isArray(reviews)) continue;

    const botReview = reviews.find(r => r.user && r.user.login === 'openclawreviewer-a11y');

    if (!botReview) {
      try {
        const prDetails = await githubRequest(`/repos/${owner}/${repoName}/pulls/${prNumber}`);
        await runReview({
          owner,
          repo: repoName,
          prNumber,
          title: prDetails.title || '',
          body: prDetails.body || '',
        });
        log({ type: 'reconciliation', action: 'review_triggered', taskId: task.id });
      } catch (err) {
        console.error('[reconciliation] review trigger failed for task', task.id, ':', err.message);
      }
    } else {
      const verdict = botReview.state === 'APPROVED' ? 'approved' : 'changes_requested';
      const verdictPayload = {
        verdict,
        actor: 'reconciliation',
        reviewer: 'openclawreviewer-a11y',
        repo: `${owner}/${repoName}`,
        pr_number: prNumber,
        pr_url: `https://github.com/${owner}/${repoName}/pull/${prNumber}`,
        summary: '(recovered by reconciliation)',
      };
      try {
        await fetch(`http://localhost:3210/tasks/${task.id}/verdict`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(verdictPayload),
        });
        log({ type: 'reconciliation', action: 'verdict_recovered', taskId: task.id });
        console.log('Reconciliation: verdict recovered from GitHub for', task.id);
      } catch (err) {
        console.error('[reconciliation] verdict recovery failed for task', task.id, ':', err.message);
      }
    }
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200); res.end(JSON.stringify({ status: 'ok', port: PORT })); return;
  }

  if (req.method === 'GET' && req.url === '/smoke-test') {
    const checks = await runSmokeTest();
    const overall = Object.values(checks).every(v => v === 'pass') ? 'pass' : 'fail';
    res.writeHead(overall === 'pass' ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ overall, checks }, null, 2));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404); res.end('Not found'); return;
  }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    const sig = req.headers['x-hub-signature-256'] || '';
    if (!verifySignature(body, sig)) {
      console.warn('[webhook] invalid signature');
      res.writeHead(401); res.end('Unauthorized'); return;
    }

    const event = req.headers['x-github-event'];
    if (event !== 'pull_request') {
      res.writeHead(200); res.end('ignored'); return;
    }

    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }

    const action = payload.action;
    if (!['opened', 'synchronize'].includes(action)) {
      res.writeHead(200); res.end('ignored'); return;
    }

    res.writeHead(200); res.end('accepted');

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const prNumber = payload.pull_request.number;
    const title = payload.pull_request.title;
    const prBody = payload.pull_request.body || '';

    console.log(`[reviewer-bot] PR #${prNumber} ${action}: ${owner}/${repo} — "${title}"`);
    log({ type: 'received', owner, repo, prNumber, title, action });

    const prKey = `${owner}/${repo}#${prNumber}`;
    if (action === 'opened') {
      pendingPRs.set(prKey, { owner, repo, prNumber, title, openedAt: Date.now() });
    }

    try {
      await runReview({ owner, repo, prNumber, title, body: prBody });
      pendingPRs.delete(prKey);
    } catch (err) {
      console.error('[reviewer-bot] review failed:', err.message);
      log({ type: 'error', owner, repo, prNumber, error: err.message });

      console.log('[reviewer-bot] retrying once...');
      setTimeout(() => runReview({ owner, repo, prNumber, title, body: prBody }, 2).then(() => {
        pendingPRs.delete(prKey);
      }).catch(e => {
        console.error('[reviewer-bot] retry failed:', e.message);
        pendingPRs.delete(prKey);
        notifyPeter(`⚠️ Reviewer bot FAILED on PR #${prNumber} (${owner}/${repo})\nError: ${e.message}\nManual review needed.\nhttps://github.com/${owner}/${repo}/pull/${prNumber}`);
      }), 5000);
    }
  });
});

server.listen(PORT, async () => {
  console.log(`[reviewer-bot-github] HTTP server on port ${PORT}`);
  console.log(`[reviewer-bot-github] Webhook endpoint: POST http://localhost:${PORT}/webhook`);
  console.log(`[reviewer-bot-github] Health: GET http://localhost:${PORT}/health`);

  const checks = await runSmokeTest();
  console.log('[reviewer-bot] Startup verification:');
  console.log('  Secret present:', checks.secret);
  console.log('  Tunnel reachable:', checks.tunnel);
  console.log('  GitHub auth valid:', checks.github);
  console.log('  Control Plane reachable:', checks.control_plane);

  const criticalFailed = ['secret', 'github', 'control_plane'].filter(k => checks[k] !== 'pass');
  if (criticalFailed.length > 0) {
    const msg = `⚠️ Reviewer Bot startup check failed: ${criticalFailed.join(', ')}\nManual intervention needed.`;
    console.error('[reviewer-bot] STARTUP FAILURE:', msg);
    await sendTelegram(msg);
  }
});

setTimeout(() => {
  setInterval(() => runReconciliation().catch(e => console.error('[reconciliation] error:', e.message)), 10 * 60 * 1000);
}, 2 * 60 * 1000);

// 10-minute PR response watchdog: alert Mission Control if a PR has had no response after 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [prKey, { owner, repo, prNumber, title, openedAt }] of pendingPRs) {
    if (now - openedAt >= 10 * 60 * 1000) {
      pendingPRs.delete(prKey);
      const ageMin = Math.round((now - openedAt) / 60000);
      console.warn(`[watchdog] PR #${prNumber} on ${owner}/${repo} has had no review after ${ageMin}m — alerting Mission Control`);
      sendMissionControl(
        `⚠️ Reviewer Bot silent alert\nPR #${prNumber} on ${owner}/${repo} has had no review after ${ageMin} minutes.\n"${title}"\nhttps://github.com/${owner}/${repo}/pull/${prNumber}\nCheck reviewer-bot-github logs.`
      );
    }
  }
}, 2 * 60 * 1000);
