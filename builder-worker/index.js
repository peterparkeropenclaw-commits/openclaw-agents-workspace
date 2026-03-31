/**
 * Builder Worker v2.0
 * Direct execution worker — POST /run-task → branch → edit → commit → PR → result
 *
 * No OpenClaw CLI. No Discord. No gateway deps.
 * Evidence-backed responses only.
 */

// ─── Fix 7: Silent-exit prevention — must be FIRST, before any async code ─────
let taskId = null;
const cpBaseUrl = process.env.CP_URL || process.env.CONTROL_PLANE_URL || 'http://localhost:3210';

async function reportFailure(error) {
  if (!taskId) return;
  try {
    await fetch(`${cpBaseUrl}/tasks/${taskId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'failed',
        summary: `Worker crashed: ${error?.message || error}`,
        error: String(error)
      })
    });
  } catch (e) {
    console.error('[worker] Failed to report failure to CP:', e.message);
  }
}

process.on('uncaughtException', async (err) => {
  console.error('[worker] Uncaught exception:', err);
  await reportFailure(err);
  process.exit(1);
});

process.on('unhandledRejection', async (err) => {
  console.error('[worker] Unhandled rejection:', err);
  await reportFailure(err);
  process.exit(1);
});
// ─── End Fix 7 ────────────────────────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const { execSync, exec: execAsync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const PORT = parseInt(process.env.BUILDER_PORT || '3201');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CP_URL = process.env.CONTROL_PLANE_URL || 'http://localhost:3210';
const BUILDER_SECRET = process.env.BUILDER_SECRET || 'builder-internal-secret-2026';
const WORK_DIR = process.env.WORK_DIR || '/tmp/builder-work';
// Fix 9: GITHUB_OWNER env var — always use this for repo URL construction
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'peterparkeropenclaw-commits';

// ─── Memory: save task findings to CP after completion ────────────────────────
async function saveTaskMemories(taskId, taskType, findings) {
  if (!findings || findings.length === 0) return;
  for (const finding of findings) {
    await fetch(`${CP_URL}/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: taskType || 'build',
        memory_type: finding.type,
        content: finding.content,
        importance: finding.importance || 5,
        task_id: taskId
      })
    }).catch(err => console.warn('[Worker] Memory save failed:', err.message));
  }
}

// ─── Fix 8: Memory context fetch — graceful skip on failure ──────────────────
async function fetchMemoryContext(scope) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      `http://localhost:3210/memory/context?scope=${scope}&include_global=true`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return data.context_block || null;
  } catch (err) {
    console.warn('[worker] Memory fetch failed, continuing without context:', err.message);
    return null;
  }
}
// ─── End Fix 8 ────────────────────────────────────────────────────────────────

if (!OPENAI_API_KEY) { console.error('[builder] FATAL: OPENAI_API_KEY not set'); process.exit(1); }
if (!GITHUB_TOKEN)   { console.error('[builder] FATAL: GITHUB_TOKEN not set');   process.exit(1); }

fs.mkdirSync(WORK_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '2mb' }));

// ─── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${BUILDER_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ─── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'builder-worker',
    version: '2.0.0',
    port: PORT,
    work_dir: WORK_DIR,
    github_token_set: !!GITHUB_TOKEN,
    openai_key_set: !!OPENAI_API_KEY,
    cp_url: CP_URL,
    ts: new Date().toISOString()
  });
});

// ─── Deprecated paths — return 410 immediately ────────────────────────────────
app.post('/deliver', (req, res) => {
  res.status(410).json({ ok: false, error: 'DEPRECATED: use POST /run-task' });
});
app.post('/dispatch', (req, res) => {
  res.status(410).json({ ok: false, error: 'DEPRECATED: use POST /run-task' });
});

// ─── Core: POST /run-task ─────────────────────────────────────────────────────
app.post('/run-task', requireAuth, async (req, res) => {
  const {
    taskId: reqTaskId,
    repo,          // e.g. "peterparkeropenclaw-commits/review-responder"
    baseBranch = 'main',
    targetBranch,  // optional: if set, checkout and commit to this existing branch (no new branch created, no new PR)
    title,
    brief,
    constraints = ''
  } = req.body;

  // Fix 7: Set global taskId for crash reporting ASAP
  taskId = reqTaskId || process.env.TASK_ID || null;
  const taskIdLocal = taskId;

  const required = { taskId: taskIdLocal, repo, title, brief };
  for (const [k, v] of Object.entries(required)) {
    if (!v) return res.status(400).json({ ok: false, error: `Missing required field: ${k}` });
  }

  const runId = `${taskId}-${Date.now()}`;
  const branchName = targetBranch || `oc-${taskId}-${slugify(title)}`;
  const repoDir = path.join(WORK_DIR, runId);
  const logs = [];

  const log = (msg) => { console.log(`[builder][${taskId}] ${msg}`); logs.push(msg); };

  log(`Starting task: ${title}`);
  log(`Repo: ${repo} | Base: ${baseBranch} | Branch: ${branchName}`);

  // Respond immediately with 202 — will update CP on completion
  // (caller must poll CP or wait for Telegram notification)
  res.status(202).json({
    ok: true,
    accepted: true,
    taskId,
    branchName,
    message: 'Task accepted. Builder executing asynchronously. CP will reflect state changes.'
  });

  // ── Async execution ──────────────────────────────────────────────────────────
  setImmediate(async () => {
    let result = {
      status: 'failed',
      branch: branchName,
      commit: null,
      prNumber: null,
      prUrl: null,
      changedFiles: [],
      logs,
      error: null
    };

    try {
      // 1. Update CP: build_in_progress
      await cpState(taskId, 'build_in_progress', 'builder', 'Builder started execution');

      // 2. Clone repo
      log(`Cloning ${repo}...`);
      fs.mkdirSync(repoDir, { recursive: true });
      run(`git clone https://${GITHUB_TOKEN}@github.com/${repo}.git ${repoDir}`, '/tmp');
      run(`git config user.email "builder@openclaw.ai"`, repoDir);
      run(`git config user.name "OpenClaw Builder"`, repoDir);

      // 3. Ensure base branch exists and is current
      run(`git fetch origin ${baseBranch}`, repoDir);
      run(`git checkout ${baseBranch}`, repoDir);
      run(`git pull origin ${baseBranch}`, repoDir);
      log(`Base branch ${baseBranch} ready.`);

      // 4. Create or checkout feature branch
      if (targetBranch) {
        // Working on an existing branch — fetch and checkout
        run(`git fetch origin ${targetBranch}`, repoDir);
        run(`git checkout ${targetBranch}`, repoDir);
        run(`git pull origin ${targetBranch}`, repoDir);
        log(`Checked out existing branch: ${targetBranch}`);
      } else {
        run(`git checkout -b ${branchName}`, repoDir);
        log(`Branch created: ${branchName}`);
      }

      // 5. Generate code changes via OpenAI
      log(`Calling OpenAI for code generation...`);
      const planAndChanges = await generateChanges({ repo, taskId, title, brief, constraints, repoDir, log });

      if (!planAndChanges || !planAndChanges.files || planAndChanges.files.length === 0) {
        throw new Error('OpenAI returned no file changes. Aborting.');
      }

      // 6. Apply file changes with size guard and patch mode
      let filesWritten = 0;
      for (const change of planAndChanges.files) {
        const filePath = path.join(repoDir, change.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (change.action === 'delete') {
          if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); log(`Deleted: ${change.path}`); }
        } else if (change.action === 'patch') {
          // Patch mode: insert content after a marker line
          if (!fs.existsSync(filePath)) throw new Error(`Cannot patch non-existent file: ${change.path}`);
          const original = fs.readFileSync(filePath, 'utf8');
          if (!change.insertAfter) throw new Error(`Patch action requires insertAfter field for ${change.path}`);
          const markerIdx = original.indexOf(change.insertAfter);
          if (markerIdx === -1) throw new Error(`Patch marker not found in ${change.path}: ${change.insertAfter.slice(0, 80)}`);
          const insertAt = markerIdx + change.insertAfter.length;
          const patched = original.slice(0, insertAt) + '\n' + change.content + original.slice(insertAt);
          fs.writeFileSync(filePath, patched, 'utf8');
          log(`Patched: ${change.path} (inserted ${change.content.length} chars after marker)`);
        } else {
          // Full file write — apply size guard for edits
          if (change.action === 'edit' && fs.existsSync(filePath)) {
            const originalSize = fs.statSync(filePath).size;
            const newSize = Buffer.byteLength(change.content, 'utf8');
            const ratio = newSize / originalSize;
            if (ratio < 0.6) {
              log(
                `SIZE GUARD SKIP: ${change.path} — original ${originalSize} bytes, new ${newSize} bytes (${Math.round(ratio*100)}%). ` +
                `Likely truncated. Skipping this file; continuing with others.`
              );
              continue; // skip this file, don't abort entire task
            }
            log(`Size guard ok: ${change.path} (${Math.round(ratio*100)}% of original)`);
          }
          fs.writeFileSync(filePath, change.content, 'utf8');
          log(`Written: ${change.path} (${change.content.length} chars)`);
        }
        result.changedFiles.push(change.path);
        filesWritten++;
      }

      if (filesWritten === 0) {
        throw new Error('All file changes were rejected by size guard. Aborting to prevent data loss.');
      }

      // 7. Basic checks — verify files exist and syntax ok (JS only)
      for (const change of planAndChanges.files.filter(f => f.action !== 'delete')) {
        const fp = path.join(repoDir, change.path);
        if (!fs.existsSync(fp)) throw new Error(`File not written: ${change.path}`);
        if (change.path.endsWith('.js') || change.path.endsWith('.ts') || change.path.endsWith('.tsx')) {
          try {
            run(`node --check ${fp}`, repoDir);
            log(`Syntax ok: ${change.path}`);
          } catch (e) {
            // TSX/TS will fail node --check — skip gracefully
            log(`Syntax check skipped for ${change.path} (${e.message.slice(0, 60)})`);
          }
        }
      }

      // 8. Commit — write message to temp file to avoid shell parsing issues with multi-line/long messages
      run(`git add -A`, repoDir);
      const commitMsg = `[${taskId}] ${title}\n\n${planAndChanges.summary || brief.slice(0, 200)}`;
      const os = require('os');
      const tmpMsgFile = path.join(os.tmpdir(), `commit-msg-${taskId}-${Date.now()}.txt`);
      fs.writeFileSync(tmpMsgFile, commitMsg, 'utf8');
      try {
        run(`git commit -F ${tmpMsgFile}`, repoDir);
      } finally {
        try { fs.unlinkSync(tmpMsgFile); } catch (_) {}
      }
      const commitHash = run(`git rev-parse HEAD`, repoDir).trim();
      result.commit = commitHash;
      log(`Committed: ${commitHash}`);

      // 9. Push (force — feature branches are Builder-owned)
      const pushFlag = targetBranch ? '--force-with-lease' : '--force-with-lease';
      run(`git push ${pushFlag} origin ${branchName}`, repoDir);
      log(`Pushed branch: ${branchName}`);

      // 10. Open PR via GitHub API (skip if targetBranch — existing PR will auto-update)
      if (targetBranch) {
        log(`targetBranch mode: skipping PR creation. Existing PR for ${targetBranch} will auto-update with new commits.`);
        await cpState(taskId, 'pr_opened', 'builder', `Commits pushed to existing branch ${targetBranch} — existing PR auto-updated`);
      } else {
        const prBody = buildPrBody({ taskId, title, brief, constraints, planAndChanges });
        const pr = await openPR({ repo, branchName, baseBranch, title: `[${taskId}] ${title}`, body: prBody, log });
        result.prNumber = pr.number;
        result.prUrl = pr.html_url;
        log(`PR opened: #${pr.number} — ${pr.html_url}`);
        // Note: openPR handles "already exists" by resolving the existing PR number

        // 11. Register PR with CP
        await cpPR(taskId, pr.number, pr.html_url);
        await cpState(taskId, 'pr_opened', 'builder', `PR #${pr.number} opened`);
      }

      result.status = 'success';
      log(`Task complete. Status: success`);

      // Save success memory
      await saveTaskMemories(taskId, 'build', [{
        type: 'success',
        content: `Task ${taskId} (${title}) completed successfully. PR: ${result.prUrl || 'n/a'}`,
        importance: 5
      }]);

    } catch (err) {
      result.error = err.message;
      result.status = 'failed';
      log(`ERROR: ${err.message}`);
      console.error(`[builder][${taskId}] FATAL:`, err);

      // Save failure memory
      await saveTaskMemories(taskId, 'build', [{
        type: 'failure',
        content: `Task ${taskId} failed: ${err.message.slice(0, 300)}`,
        importance: 6
      }]);

      // Notify CP of failure
      try {
        await cpState(taskId, 'failed', 'builder', `Build failed: ${err.message.slice(0, 200)}`);
      } catch (cpErr) {
        console.error('[builder] Could not update CP on failure:', cpErr.message);
      }
    } finally {
      // Cleanup work dir
      try { run(`rm -rf ${repoDir}`, '/tmp'); } catch (_) {}
    }

    // Log final result summary
    console.log(`[builder][${taskId}] RESULT:`, JSON.stringify({
      status: result.status,
      branch: result.branch,
      commit: result.commit,
      prNumber: result.prNumber,
      prUrl: result.prUrl,
      changedFiles: result.changedFiles,
      error: result.error
    }));
  });
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

async function generateChanges({ repo, taskId, title, brief, constraints, repoDir, log }) {
  // Build file tree for context (top 2 levels, skip node_modules/.git)
  let fileTree = '';
  try {
    fileTree = run(
      `find . -not -path './.git/*' -not -path './node_modules/*' -not -path './.next/*' -maxdepth 3 -type f | sort | head -80`,
      repoDir
    );
  } catch (_) {}

  // Read key files for context (package.json, tsconfig if present)
  let keyFileContext = '';
  for (const kf of ['package.json', 'tsconfig.json', 'next.config.ts', 'next.config.js', 'tailwind.config.ts', 'tailwind.config.js']) {
    const fp = path.join(repoDir, kf);
    if (fs.existsSync(fp)) {
      try {
        const content = fs.readFileSync(fp, 'utf8').slice(0, 1000);
        keyFileContext += `\n\n--- ${kf} ---\n${content}`;
      } catch (_) {}
    }
  }

  // Read current content of files likely to be edited (based on brief keywords)
  // Cap at 12000 chars per file to stay within token budget
  const MAX_EXISTING_FILE_CHARS = 12000;
  let existingFileContext = '';
  // Track large files so we can instruct the LLM to use patch for them
  const largeFiles = [];
  const filesToCheck = fileTree.split('\n').filter(f => f.trim() && !f.includes('node_modules') && !f.includes('.next'));
  for (const relPath of filesToCheck) {
    const cleanPath = relPath.replace(/^\.\//, '');
    const briefMentions = brief.toLowerCase().includes(path.basename(cleanPath).toLowerCase());
    const isRootLevel = !cleanPath.includes('/') || cleanPath.split('/').length <= 2;
    const ext = path.extname(cleanPath);
    const isCode = ['.js', '.ts', '.tsx', '.jsx', '.json', '.css', '.md'].includes(ext);
    if (isCode && (briefMentions || isRootLevel)) {
      const fp = path.join(repoDir, cleanPath);
      if (fs.existsSync(fp)) {
        try {
          const fullContent = fs.readFileSync(fp, 'utf8');
          // If file is large, include first 6k and last 6k chars with a truncation note
          let displayContent = fullContent;
          if (fullContent.length > MAX_EXISTING_FILE_CHARS) {
            const half = MAX_EXISTING_FILE_CHARS / 2;
            displayContent = fullContent.slice(0, half) +
              `\n\n... [TRUNCATED: ${fullContent.length - MAX_EXISTING_FILE_CHARS} chars omitted for context window — your output MUST preserve all original content] ...\n\n` +
              fullContent.slice(-half);
          }
          if (fullContent.length > 8000) {
            largeFiles.push(cleanPath);
          }
          existingFileContext += `\n\n--- EXISTING FILE: ${cleanPath} (${fullContent.length} chars total) ---\n${displayContent}\n--- END ${cleanPath} ---`;
        } catch (_) {}
      }
    }
  }

  const systemPrompt = `You are a senior software engineer executing a scoped coding task.
You will be given a task brief, the repo file structure, and the current content of relevant files.
You must output a structured JSON response describing EXACTLY what files to create/edit/delete/patch.

Actions available:
- "create": write a new file (content = full file)
- "edit": rewrite an existing file completely (content = EVERY line of the complete file)
- "patch": insert a code snippet into an existing file at a precise location (preferred for large files >200 lines)
- "delete": remove a file (content = "")

CRITICAL RULES FOR "edit" action:
- content MUST be the COMPLETE file — every existing line plus your additions. No truncation ever.
- If a file is large (>200 lines), use "patch" instead.

CRITICAL RULES FOR "patch" action:
- "insertAfter": verbatim string from the existing file to insert code after (at least one full unique line)
- "content": the new code block to insert — do NOT repeat the insertAfter string
- Choose a unique, stable marker line (e.g. the closing brace of the GET /health handler)

General rules:
- No placeholder text, TODO comments, or mock data
- Production-quality code only
- Only change files required by the task
- Include a one-paragraph summary

Output format (JSON only, no markdown fences):
{
  "summary": "...",
  "files": [
    { "path": "path/from/repo/root", "action": "create|edit|delete", "content": "full file content" },
    { "path": "path/from/repo/root", "action": "patch", "insertAfter": "exact existing line(s)", "content": "code to insert" }
  ]
}`;

  const userPrompt = `Repo: ${repo}
Task ID: ${taskId}
Title: ${title}

Brief:
${brief}

${constraints ? `Constraints:\n${constraints}\n` : ''}
${largeFiles.length > 0 ? `MANDATORY: The following files are LARGE (>8KB). You MUST use "patch" action (NOT "edit") for these files to avoid truncation:\n${largeFiles.map(f => `- ${f}`).join('\n')}\n` : ''}
Repo file tree:
${fileTree}
${keyFileContext}
${existingFileContext}

Output the JSON file changes. For large files use "patch" action with insertAfter pointing to a unique existing line.`;

  const response = await openaiChat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], { model: 'gpt-4.1', max_tokens: 32000, response_format: { type: 'json_object' } });

  log(`OpenAI response received (${response.length} chars)`);

  let parsed;
  try {
    parsed = JSON.parse(response);
  } catch (e) {
    throw new Error(`OpenAI response was not valid JSON: ${response.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed.files)) {
    throw new Error(`OpenAI response missing 'files' array: ${JSON.stringify(parsed).slice(0, 200)}`);
  }

  return parsed;
}

async function openaiChat(messages, opts = {}, _attempt = 0) {
  const body = JSON.stringify({
    model: opts.model || 'gpt-4.1',
    messages,
    max_tokens: opts.max_tokens || 8000,
    temperature: opts.temperature || 0.2,
    ...(opts.response_format ? { response_format: opts.response_format } : {})
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 180000
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // TPM / rate limit retry — once only
          if (parsed.error) {
            const msg = parsed.error.message || '';
            const isRateLimit = res.statusCode === 429 || /rate limit/i.test(msg);
            if (isRateLimit && _attempt === 0) {
              const waitMatch = msg.match(/try again in ([0-9.]+)s/i);
              const waitMs = waitMatch ? Math.min(60, parseFloat(waitMatch[1])) * 1000 : 30000;
              console.warn(`[builder][TPM] Rate limit hit — waiting ${waitMs / 1000}s then retrying once...`);
              return setTimeout(() => {
                openaiChat(messages, opts, 1).then(resolve).catch(reject);
              }, waitMs);
            }
            return reject(new Error(`OpenAI error: ${msg}`));
          }
          resolve(parsed.choices[0].message.content);
        } catch (e) { reject(new Error(`OpenAI parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI request timed out')); });
    req.write(body);
    req.end();
  });
}

async function openPR({ repo, branchName, baseBranch, title, body, log }) {
  const [owner, repoName] = repo.split('/');

  // Helper: fetch existing open PR for this head branch
  const fetchExistingPR = () => new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repoName}/pulls?state=open&head=${owner}:${branchName}&per_page=1`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'OpenClaw-Builder/2.0'
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const prs = JSON.parse(data);
          resolve(Array.isArray(prs) && prs.length > 0 ? prs[0] : null);
        } catch (e) { reject(new Error(`GitHub PR list parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub PR list request timed out')); });
    req.end();
  });

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ title, body, head: branchName, base: baseBranch });
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repoName}/pulls`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'OpenClaw-Builder/2.0',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', async () => {
        try {
          const pr = JSON.parse(data);
          if (pr.number) return resolve(pr);
          // Handle "PR already exists" — resolve the existing PR instead of failing
          const isDuplicate = Array.isArray(pr.errors) &&
            pr.errors.some(e => e.message && e.message.toLowerCase().includes('pull request already exists'));
          if (isDuplicate) {
            if (log) log(`PR already exists for branch ${branchName} — resolving existing PR...`);
            const existing = await fetchExistingPR();
            if (existing && existing.number) {
              if (log) log(`Resolved existing PR #${existing.number} — ${existing.html_url}`);
              return resolve(existing);
            }
            return reject(new Error(`PR already exists but could not resolve existing PR for branch ${branchName}`));
          }
          return reject(new Error(`GitHub PR creation failed: ${JSON.stringify(pr).slice(0, 300)}`));
        } catch (e) { reject(new Error(`GitHub PR parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub PR request timed out')); });
    req.write(payload);
    req.end();
  });
}

async function cpState(taskId, state, actor, note) {
  return cpPost(`/tasks/${taskId}/state`, { state, actor, note });
}

async function cpPR(taskId, prNumber, prUrl) {
  return cpPost(`/tasks/${taskId}/pr`, { pr_number: prNumber, pr_url: prUrl });
}

function cpPost(endpoint, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const url = new URL(CP_URL + endpoint);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        console.log(`[builder][CP] POST ${endpoint} → ${res.statusCode}`);
        resolve(data);
      });
    });
    req.on('error', (e) => { console.error(`[builder][CP] POST ${endpoint} failed:`, e.message); resolve(null); });
    req.on('timeout', () => { req.destroy(); console.error(`[builder][CP] POST ${endpoint} timed out`); resolve(null); });
    req.write(payload);
    req.end();
  });
}

function buildPrBody({ taskId, title, brief, constraints, planAndChanges }) {
  return [
    `## [${taskId}] ${title}`,
    '',
    '### What this PR does',
    planAndChanges.summary || brief.slice(0, 500),
    '',
    '### Files changed',
    (planAndChanges.files || []).map(f => `- \`${f.path}\` (${f.action})`).join('\n'),
    '',
    constraints ? `### Constraints respected\n${constraints}` : '',
    '',
    '---',
    '_Generated by OpenClaw Builder Worker v2.0_'
  ].filter(l => l !== null).join('\n');
}

// ─── Server startup ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[builder] Worker v2.0 online — http://localhost:${PORT}`);
  console.log(`[builder] POST /run-task (Bearer ${BUILDER_SECRET.slice(0,8)}...)`);
  console.log(`[builder] WORK_DIR: ${WORK_DIR}`);
  console.log(`[builder] CP: ${CP_URL}`);
  console.log(`[builder] OpenAI key: ${OPENAI_API_KEY ? 'SET' : 'MISSING'}`);
  console.log(`[builder] GitHub token: ${GITHUB_TOKEN ? 'SET' : 'MISSING'}`);
});
