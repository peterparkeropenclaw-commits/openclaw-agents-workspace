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
    req.on('error', e => { console.error('[peter-notify] error:', e.message); resolve(null); });
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

  try {
    const cpRes = await fetch(`http://localhost:3210/tasks/OC-${ocTaskId}/verdict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(verdictPayload),
    });
    if (!cpRes.ok) {
      const errText = await cpRes.text();
      console.error(`[control-plane] verdict POST failed for OC-${ocTaskId}:`, errText);
      await sendTelegram(`⚠️ Reviewer Bot could not reach Control Plane for task OC-${ocTaskId}.\nManual state update needed.`);
    }
  } catch (err) {
    console.error('[control-plane] verdict POST error:', err.message);
    await sendTelegram(`⚠️ Reviewer Bot could not reach Control Plane for task OC-${ocTaskId}.\nManual state update needed.`);
  }

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

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200); res.end(JSON.stringify({ status: 'ok', port: PORT })); return;
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

    try {
      await runReview({ owner, repo, prNumber, title, body: prBody });
    } catch (err) {
      console.error('[reviewer-bot] review failed:', err.message);
      log({ type: 'error', owner, repo, prNumber, error: err.message });

      if (attempt === 1) {
        console.log('[reviewer-bot] retrying...');
        setTimeout(() => runReview({ owner, repo, prNumber, title, body: prBody }, 2).catch(e => {
          notifyPeter(`⚠️ Reviewer bot FAILED on PR #${prNumber} (${owner}/${repo})\nError: ${e.message}\nManual review needed.\nhttps://github.com/${owner}/${repo}/pull/${prNumber}`);
        }), 5000);
      } else {
        notifyPeter(`⚠️ Reviewer bot FAILED on PR #${prNumber} (${owner}/${repo})\nError: ${err.message}\nManual review needed.\nhttps://github.com/${owner}/${repo}/pull/${prNumber}`);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`[reviewer-bot-github] HTTP server on port ${PORT}`);
  console.log(`[reviewer-bot-github] Webhook endpoint: POST http://localhost:${PORT}/webhook`);
  console.log(`[reviewer-bot-github] Health: GET http://localhost:${PORT}/health`);
});
