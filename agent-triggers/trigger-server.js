'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Manual .env loader — no external deps
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
})();

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace/memory');
const OPENCLAW_STATE_DIR = path.join(process.env.HOME, '.openclaw');
const OPENCLAW_BIN = 'openclaw';
const CONTEXT_OVERFLOW_PATTERNS = [
  /Context overflow/i,
  /prompt too large/i,
];

// ─── Brief sanitisation ───────────────────────────────────────────────────────
// Strip ASCII control characters (except \t and \n) from brief strings before
// embedding in file content or CLI args — prevents JSON SyntaxErrors in
// downstream consumers (Issue 5).
function sanitiseBrief(str) {
  if (typeof str !== 'string') return String(str || '');
  // Remove control chars 0x00–0x08, 0x0B–0x0C, 0x0E–0x1F, 0x7F
  // Keep: 0x09 (\t), 0x0A (\n), 0x0D (\r → collapsed below)
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r\n?/g, '\n');   // normalise CRLF / bare CR to LF
}

// ─── Stale session-lock detection ─────────────────────────────────────────────
// The gateway writes a PID-based lock file while a session is in use.  When a
// process dies without releasing the lock the gateway will time out on the next
// attempt (Issue 2).  Clear it here before every agent turn.
function clearStaleLock(agentId, sessionId) {
  if (!sessionId) return;
  const lockPath = path.join(
    OPENCLAW_STATE_DIR, 'agents', agentId, 'sessions',
    `${sessionId}.jsonl.lock`
  );
  try {
    if (!fs.existsSync(lockPath)) return;
    const raw = fs.readFileSync(lockPath, 'utf8');
    const { pid } = JSON.parse(raw);
    if (!pid) return;
    try {
      process.kill(pid, 0); // throws if PID is dead
    } catch (e) {
      if (e.code === 'ESRCH') {
        fs.unlinkSync(lockPath);
        console.log(`[${agentId}] Cleared stale session lock (dead PID ${pid}): ${path.basename(lockPath)}`);
      }
    }
  } catch (_) {
    // Lock unreadable or not valid JSON — leave it for the gateway to handle
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
// Bearer token loaded from env (set TRIGGER_AUTH_TOKEN=<gateway token> in PM2 env or .env)
const TRIGGER_AUTH_TOKEN = process.env.TRIGGER_AUTH_TOKEN || '';

// Permanent session IDs for each dept head — pin to existing session, never spawn new
const AGENTS = {
  'engineering-lead': {
    port:      3101,
    agentId:   'engineering-lead',
    sessionId: null, // resolved at startup
  },
  'commercial-director': {
    port:      3102,
    agentId:   'commercial-director',
    sessionId: null,
  },
  'head-of-product': {
    port:      3103,
    agentId:   'head-of-product',
    sessionId: null,
  },
  'client-delivery-director': {
    port:      3104,
    agentId:   'client-delivery-director',
    sessionId: null,
  },
};

fs.mkdirSync(WORKSPACE, { recursive: true });

// ─── Resolve permanent session IDs at startup ────────────────────────────────
function resolveSessionId(agentId) {
  return new Promise((resolve) => {
    const proc = spawn(OPENCLAW_BIN, ['sessions', '--agent', agentId, '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => {
      try {
        const data = JSON.parse(out);
        const sessions = data.sessions || [];
        // Pick the permanent "main" session (key ends with :main, not :heartbeat or :subagent:*)
        const main = sessions.find(
          (s) => s.key === `agent:${agentId}:main`
        );
        if (main?.sessionId) {
          console.log(`[${agentId}] Resolved session ID: ${main.sessionId}`);
          resolve(main.sessionId);
        } else {
          console.warn(`[${agentId}] Could not resolve session ID — will use --agent flag only`);
          resolve(null);
        }
      } catch {
        console.warn(`[${agentId}] Failed to parse sessions JSON — will use --agent flag only`);
        resolve(null);
      }
    });
    proc.on('error', () => resolve(null));
  });
}

function getSessionsFile(agentId) {
  return path.join(OPENCLAW_STATE_DIR, 'agents', agentId, 'sessions', 'sessions.json');
}

function isContextOverflow(output) {
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(output || ''));
}

function resetAgentMainSession(agentId, staleSessionId) {
  return new Promise((resolve) => {
    const sessionsFile = getSessionsFile(agentId);
    const sessionDir = path.dirname(sessionsFile);
    const now = new Date().toISOString().replace(/[:.]/g, '-');

    try {
      clearStaleLock(agentId, staleSessionId);

      if (staleSessionId) {
        const sessionFile = path.join(sessionDir, `${staleSessionId}.jsonl`);
        const lockFile = `${sessionFile}.lock`;
        const backupFile = path.join(sessionDir, `${staleSessionId}.jsonl.overflow-reset.${now}.bak`);

        if (fs.existsSync(sessionFile)) {
          fs.renameSync(sessionFile, backupFile);
          console.warn(`[${agentId}] Archived saturated session to ${path.basename(backupFile)}`);
        }

        if (fs.existsSync(lockFile)) {
          fs.unlinkSync(lockFile);
        }
      }

      if (fs.existsSync(sessionsFile)) {
        const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
        const mainKey = `agent:${agentId}:main`;
        if (sessions[mainKey]?.sessionId === staleSessionId) {
          delete sessions[mainKey];
          fs.writeFileSync(sessionsFile, `${JSON.stringify(sessions, null, 2)}\n`);
          console.warn(`[${agentId}] Cleared pinned main session mapping for overflowed session ${staleSessionId}`);
        }
      }
    } catch (err) {
      console.error(`[${agentId}] Failed to reset saturated session ${staleSessionId}: ${err.message}`);
      return resolve(null);
    }

    const bootstrap = spawn(OPENCLAW_BIN, [
      'agent',
      '--agent', agentId,
      '--message', 'Session reset after context overflow. Start a fresh main session and reply with READY only.',
      '--timeout', '120',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    bootstrap.stdout.on('data', (d) => { stdout += d.toString(); });
    bootstrap.stderr.on('data', (d) => { stderr += d.toString(); });
    bootstrap.on('close', async (code) => {
      if (code !== 0) {
        console.error(`[${agentId}] Failed to bootstrap fresh session after overflow (code ${code}): ${(stderr || stdout).slice(0, 400)}`);
        return resolve(null);
      }
      const newSessionId = await resolveSessionId(agentId);
      if (newSessionId) {
        console.log(`[${agentId}] Started fresh session after overflow: ${newSessionId}`);
      }
      resolve(newSessionId);
    });
    bootstrap.on('error', (err) => {
      console.error(`[${agentId}] Bootstrap spawn error after overflow: ${err.message}`);
      resolve(null);
    });
  });
}

// ─── Fire-and-forget agent turn ──────────────────────────────────────────────
// Targets the permanent session via --session-id when available.
// Falls back to --agent <id> (which routes to the same main session).
// On non-zero exit, retries once after a 10s delay without --session-id so the
// gateway can pick the session fresh (Issue 1 / Issue 2).
function fireAgentTurn(agentId, sessionId, message, taskId, isRetry = false, hasResetSession = false) {
  // Clear any stale PID lock on the target session before attempting (Issue 2)
  clearStaleLock(agentId, sessionId);

  const args = [
    'agent',
    '--agent', agentId,
    '--message', message,
    '--timeout', '300',
  ];

  // Pin to the existing permanent session if we have its ID
  if (sessionId && !isRetry) {
    args.push('--session-id', sessionId);
  }

  console.log(`[${agentId}] Firing agent turn for task ${taskId} (session: ${isRetry ? 'retry-no-pin' : (sessionId || 'main')})`);

  const proc = spawn(OPENCLAW_BIN, args, {
    detached: true,
    stdio:    ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  proc.on('close', async (code) => {
    const combinedOutput = `${stdout}\n${stderr}`;
    const preview = stdout.slice(0, 200).replace(/\n/g, ' ');
    console.log(`[${agentId}] Task ${taskId} finished (code ${code}): ${preview}`);
    if (stderr) console.error(`[${agentId}] stderr: ${stderr.slice(0, 200)}`);

    const shouldResetForOverflow = (
      agentId === 'client-delivery-director' &&
      !hasResetSession &&
      isContextOverflow(combinedOutput)
    );

    if (shouldResetForOverflow) {
      console.warn(`[${agentId}] Task ${taskId} hit context overflow, resetting session and retrying once`);
      const freshSessionId = await resetAgentMainSession(agentId, sessionId);
      if (freshSessionId) {
        AGENTS[agentId].sessionId = freshSessionId;
        setTimeout(() => fireAgentTurn(agentId, freshSessionId, message, taskId, false, true), 2000);
      } else {
        console.error(`[${agentId}] Could not start a fresh session after overflow for task ${taskId}`);
      }
      return;
    }

    // On failure, retry once without session pin to let the gateway route fresh
    if (code !== 0 && !isRetry) {
      console.log(`[${agentId}] Task ${taskId} exited ${code} — retrying in 10s without session pin`);
      setTimeout(() => fireAgentTurn(agentId, sessionId, message, taskId, true, hasResetSession), 10000);
    }
  });

  proc.on('error', (err) => {
    console.error(`[${agentId}] Spawn error for task ${taskId}: ${err.message}`);
    if (!isRetry) {
      console.log(`[${agentId}] Retrying via fallback spawn (no session-id)...`);
      setTimeout(() => fireAgentTurn(agentId, sessionId, message, taskId, true, hasResetSession), 5000);
    }
  });

  // Unref immediately — fire-and-forget, don't block the event loop
  proc.unref();
}

// ─── Build one Express server per agent ──────────────────────────────────────
function startServer(agentName, config) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.post('/task', (req, res) => {
    // ─── Bearer token auth ────────────────────────────────────────────────────
    if (TRIGGER_AUTH_TOKEN) {
      const authHeader = req.headers['authorization'] || '';
      const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (provided !== TRIGGER_AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const { task_id, priority = 'normal', from = 'peter' } = req.body;
    const brief = sanitiseBrief(req.body.brief); // Issue 5: strip control chars

    if (!task_id || !brief) {
      return res.status(400).json({ error: 'task_id and brief are required' });
    }

    const timestamp = new Date().toISOString();
    const filename  = `TASK-${task_id}-${agentName}.md`;
    const filepath  = path.join(WORKSPACE, filename);

    // 1. Write brief to memory file for durable record
    // Issue 6: ensure directory exists immediately before write (belt-and-suspenders
    // over the startup mkdirSync — guards against WORKSPACE being cleared at runtime)
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    const content = [
      `# TASK: ${task_id}`,
      `From: ${from}`,
      `Priority: ${priority}`,
      `Timestamp: ${timestamp}`,
      ``,
      brief,
      ``,
    ].join('\n');
    fs.writeFileSync(filepath, content);

    // 2. Respond immediately — agent spawn is async
    res.json({
      status:     'received',
      agent:      agentName,
      task_id,
      timestamp,
      brief_file: `memory/${filename}`,
      session_id: config.sessionId || null,
      spawning:   true,
    });

    // 3. Fire agent turn into the permanent session (fire-and-forget)
    const prompt = [
      `[TASK — ${task_id}] Priority: ${priority} | From: ${from}`,
      `Brief saved to: memory/${filename}`,
      ``,
      brief,
      ``,
      `Start working on this now. Report [STATUS TO PETER] when complete.`,
    ].join('\n');

    fireAgentTurn(agentName, config.sessionId, prompt, task_id);
  });

  app.get('/health', (_req, res) => {
    res.json({
      agent:      agentName,
      port:       config.port,
      session_id: config.sessionId || null,
      status:     'ok',
      timestamp:  new Date().toISOString(),
    });
  });

  app.listen(config.port, '127.0.0.1', () => {
    console.log(`[${agentName}] Listening on localhost:${config.port} (session: ${config.sessionId || 'pending'})`);
  });
}

// ─── Gateway keepalive ────────────────────────────────────────────────────────
// The OpenClaw gateway WebSocket will drop the embedded-agent connection after
// ~330 s of inactivity, causing the next agent turn to fall back to embedded
// mode which also fails.  Run `openclaw health` every 60 s to keep the gateway
// warm and detect restarts early (Issue 3).
function startGatewayKeepalive() {
  const ping = () => {
    const proc = spawn(OPENCLAW_BIN, ['health'], { stdio: 'pipe' });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.warn('[trigger-server] Gateway health check failed (code', code, ') — gateway may be down, will retry');
      }
    });
    proc.on('error', () => {
      console.warn('[trigger-server] Gateway health check spawn error — openclaw not in PATH?');
    });
  };
  const interval = setInterval(ping, 60000);
  interval.unref(); // don't prevent process exit
  console.log('[trigger-server] Gateway keepalive started (60 s interval).');
}

// ─── Main: resolve session IDs then start all servers ────────────────────────
(async () => {
  console.log('[trigger-server] Resolving permanent session IDs...');

  await Promise.all(
    Object.entries(AGENTS).map(async ([name, cfg]) => {
      cfg.sessionId = await resolveSessionId(cfg.agentId);
    })
  );

  for (const [name, config] of Object.entries(AGENTS)) {
    startServer(name, config);
  }

  startGatewayKeepalive();

  console.log('[trigger-server] All servers started (ENG-022 — session-pinned spawn).');
})();
