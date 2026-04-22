'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
const TRIGGER_STATE_FILE = path.join(OPENCLAW_STATE_DIR, 'agent-triggers-state.json');
const CDR_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;
const CDR_SESSION_ROTATE_AFTER = 8;
const SESSION_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const MAX_TASK_ATTEMPTS_RECORDED = 10;
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

// Permanent session IDs for the retained internal lanes
const AGENTS = {
  'engineering-lead': {
    port:      3101,
    agentId:   'engineering-lead',
    sessionId: null, // resolved at startup
  },
  'client-delivery-director': {
    port:      3104,
    agentId:   'client-delivery-director',
    sessionId: null,
  },
};

fs.mkdirSync(WORKSPACE, { recursive: true });

function ownerLaneFor(agentId) {
  return agentId === 'client-delivery-director' ? 'cdr' : 'engineering';
}

function nowIso() {
  return new Date().toISOString();
}

function buildDefaultTriggerState() {
  return {
    version: 2,
    agents: {},
    tasks: {},
    cdr: {
      fingerprints: {},
      completedSinceReset: 0,
    },
  };
}

function normaliseTriggerState(state) {
  const next = state && typeof state === 'object' ? state : buildDefaultTriggerState();
  next.version = 2;
  next.agents = next.agents && typeof next.agents === 'object' ? next.agents : {};
  next.tasks = next.tasks && typeof next.tasks === 'object' ? next.tasks : {};
  next.cdr = next.cdr && typeof next.cdr === 'object' ? next.cdr : {};
  next.cdr.fingerprints = next.cdr.fingerprints && typeof next.cdr.fingerprints === 'object' ? next.cdr.fingerprints : {};
  next.cdr.completedSinceReset = Number(next.cdr.completedSinceReset || 0);
  return next;
}

function loadTriggerState() {
  try {
    return normaliseTriggerState(JSON.parse(fs.readFileSync(TRIGGER_STATE_FILE, 'utf8')));
  } catch {
    return buildDefaultTriggerState();
  }
}

function saveTriggerState(state) {
  fs.writeFileSync(TRIGGER_STATE_FILE, `${JSON.stringify(normaliseTriggerState(state), null, 2)}\n`);
}

function getAgentRuntime(agentId) {
  return AGENTS[agentId];
}

function updateAgentRuntimeState(agentId, patch) {
  const state = loadTriggerState();
  const runtime = getAgentRuntime(agentId);
  const ownerLane = ownerLaneFor(agentId);
  state.agents[agentId] = {
    agentId,
    ownerLane,
    port: runtime.port,
    sessionId: runtime.sessionId || null,
    sessionStatus: runtime.sessionStatus || 'unknown',
    sessionSource: runtime.sessionSource || null,
    sessionUpdatedAt: runtime.sessionUpdatedAt || null,
    lastResolveReason: runtime.lastResolveReason || null,
    lastResolveError: runtime.lastResolveError || null,
    lastTaskId: runtime.lastTaskId || null,
    ...state.agents[agentId],
    ...patch,
    sessionId: patch.sessionId !== undefined ? patch.sessionId : (runtime.sessionId || null),
    sessionStatus: patch.sessionStatus !== undefined ? patch.sessionStatus : (runtime.sessionStatus || 'unknown'),
    sessionSource: patch.sessionSource !== undefined ? patch.sessionSource : (runtime.sessionSource || null),
    sessionUpdatedAt: patch.sessionUpdatedAt !== undefined ? patch.sessionUpdatedAt : (runtime.sessionUpdatedAt || null),
    lastResolveReason: patch.lastResolveReason !== undefined ? patch.lastResolveReason : (runtime.lastResolveReason || null),
    lastResolveError: patch.lastResolveError !== undefined ? patch.lastResolveError : (runtime.lastResolveError || null),
    lastTaskId: patch.lastTaskId !== undefined ? patch.lastTaskId : (runtime.lastTaskId || null),
  };
  saveTriggerState(state);
}

function upsertTaskRecord(taskId, patch) {
  const state = loadTriggerState();
  const existing = state.tasks[taskId] || {};
  state.tasks[taskId] = {
    ...existing,
    ...patch,
    updatedAt: Date.now(),
    updatedAtIso: nowIso(),
  };
  saveTriggerState(state);
  return state.tasks[taskId];
}

function getTaskRecord(taskId) {
  const state = loadTriggerState();
  return state.tasks[taskId] || null;
}

function normaliseBriefForFingerprint(agentId, brief) {
  const compact = (brief || '').replace(/\s+/g, ' ').trim();
  if (agentId !== 'client-delivery-director') return compact;

  return compact
    .replace(/CDR-[A-Z-]+-\d+(?:-[a-f0-9]+)?/gi, 'CDR-TASK')
    .replace(/STR-[A-Z-]+-\d+(?:-[a-f0-9]+)?/gi, 'STR-TASK')
    .replace(/\/Users\/robotmac\/\.openclaw\/workspace\/memory\/[^\s]+/g, '/memory/OUTPUT.json')
    .replace(/\b\d{13,}\b/g, 'TIMESTAMP')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID');
}

function briefFingerprint(agentId, brief) {
  const normalised = normaliseBriefForFingerprint(agentId, brief);
  return crypto.createHash('sha1').update(`${agentId}:${normalised}`).digest('hex');
}

function findCdrDuplicate(taskId, fingerprint) {
  const state = loadTriggerState();
  const existing = state.cdr.fingerprints[fingerprint];
  if (!existing) return null;
  if (existing.taskId === taskId) return null;
  if (!['running', 'succeeded'].includes(existing.status)) return null;
  if ((Date.now() - existing.updatedAt) > CDR_DEDUPE_WINDOW_MS) return null;
  return existing;
}

function ensureTaskRecord(agentId, taskId, fingerprint, briefFile, meta = {}) {
  const state = loadTriggerState();
  const ownerLane = ownerLaneFor(agentId);
  const existing = state.tasks[taskId] || {};
  state.tasks[taskId] = {
    ...existing,
    taskId,
    agentId,
    ownerLane,
    fingerprint,
    briefFile,
    status: meta.status || existing.status || 'received',
    resultState: meta.resultState || existing.resultState || 'received',
    createdAt: existing.createdAt || Date.now(),
    createdAtIso: existing.createdAtIso || nowIso(),
    updatedAt: Date.now(),
    updatedAtIso: nowIso(),
    sessionId: meta.sessionId !== undefined ? meta.sessionId : (existing.sessionId || null),
    sessionStatus: meta.sessionStatus !== undefined ? meta.sessionStatus : (existing.sessionStatus || 'unknown'),
    sessionSource: meta.sessionSource !== undefined ? meta.sessionSource : (existing.sessionSource || null),
    attemptCount: Number(existing.attemptCount || 0),
    attempts: Array.isArray(existing.attempts) ? existing.attempts : [],
    duplicateOfTask: meta.duplicateOfTask !== undefined ? meta.duplicateOfTask : (existing.duplicateOfTask || null),
    failureClass: meta.failureClass !== undefined ? meta.failureClass : (existing.failureClass || null),
    lastError: meta.lastError !== undefined ? meta.lastError : (existing.lastError || null),
    lastSummary: meta.lastSummary !== undefined ? meta.lastSummary : (existing.lastSummary || null),
    lastStatusBlock: meta.lastStatusBlock !== undefined ? meta.lastStatusBlock : (existing.lastStatusBlock || null),
  };
  if (agentId === 'client-delivery-director' && fingerprint) {
    state.cdr.fingerprints[fingerprint] = {
      taskId,
      briefFile,
      status: meta.cdrFingerprintStatus || 'running',
      updatedAt: Date.now(),
    };
  }
  saveTriggerState(state);
  return state.tasks[taskId];
}

function markTaskAccepted(agentId, taskId, fingerprint, briefFile, meta = {}) {
  return ensureTaskRecord(agentId, taskId, fingerprint, briefFile, {
    ...meta,
    status: 'accepted',
    resultState: 'accepted',
  });
}

function markTaskDuplicate(agentId, taskId, fingerprint, briefFile, duplicate) {
  ensureTaskRecord(agentId, taskId, fingerprint, briefFile, {
    status: 'duplicate',
    resultState: 'duplicate',
    duplicateOfTask: duplicate.taskId,
    lastSummary: `Duplicate suppressed; reusing ${duplicate.taskId}`,
    cdrFingerprintStatus: 'succeeded',
  });
}

function markTaskSessionUnavailable(agentId, taskId, fingerprint, briefFile, meta = {}) {
  ensureTaskRecord(agentId, taskId, fingerprint, briefFile, {
    ...meta,
    status: 'failed',
    resultState: 'session_unavailable',
    failureClass: 'session_unavailable',
    lastError: meta.lastError || 'No stable session binding available',
  });
}

function startTaskAttempt(agentId, taskId, meta = {}) {
  const state = loadTriggerState();
  const task = state.tasks[taskId];
  if (!task) return 0;

  const attempt = {
    attempt: Number(task.attemptCount || 0) + 1,
    startedAt: Date.now(),
    startedAtIso: nowIso(),
    retry: Boolean(meta.retry),
    retryReason: meta.retryReason || null,
    sessionId: meta.sessionId || null,
    sessionStatus: meta.sessionStatus || 'unknown',
    sessionSource: meta.sessionSource || null,
    mode: meta.sessionId ? 'pinned' : 'unresolved',
    exitCode: null,
    resultState: 'running',
    failureClass: null,
    retryScheduled: false,
    summary: null,
  };

  task.attemptCount = attempt.attempt;
  task.status = 'running';
  task.resultState = 'running';
  task.sessionId = attempt.sessionId;
  task.sessionStatus = attempt.sessionStatus;
  task.sessionSource = attempt.sessionSource;
  task.updatedAt = Date.now();
  task.updatedAtIso = nowIso();
  task.attempts = Array.isArray(task.attempts) ? task.attempts : [];
  task.attempts.push(attempt);
  task.attempts = task.attempts.slice(-MAX_TASK_ATTEMPTS_RECORDED);
  state.tasks[taskId] = task;
  saveTriggerState(state);
  return attempt.attempt;
}

function finishTaskAttempt(agentId, taskId, meta = {}) {
  const state = loadTriggerState();
  const task = state.tasks[taskId];
  if (!task) return;

  const attempts = Array.isArray(task.attempts) ? task.attempts : [];
  const currentAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
  if (currentAttempt) {
    currentAttempt.completedAt = Date.now();
    currentAttempt.completedAtIso = nowIso();
    currentAttempt.exitCode = meta.exitCode;
    currentAttempt.resultState = meta.resultState;
    currentAttempt.failureClass = meta.failureClass || null;
    currentAttempt.retryScheduled = Boolean(meta.retryScheduled);
    currentAttempt.summary = meta.summary || null;
    currentAttempt.reportedStatus = meta.reportedStatus || null;
    currentAttempt.reportedOutput = meta.reportedOutput || null;
  }

  task.status = meta.finalStatus || task.status || 'running';
  task.resultState = meta.resultState || task.resultState || 'running';
  task.failureClass = meta.failureClass || null;
  task.lastError = meta.lastError || null;
  task.lastSummary = meta.summary || null;
  task.lastStatusBlock = meta.statusBlock || null;
  task.sessionId = meta.sessionId !== undefined ? meta.sessionId : task.sessionId;
  task.sessionStatus = meta.sessionStatus !== undefined ? meta.sessionStatus : task.sessionStatus;
  task.sessionSource = meta.sessionSource !== undefined ? meta.sessionSource : task.sessionSource;
  task.updatedAt = Date.now();
  task.updatedAtIso = nowIso();

  if (agentId === 'client-delivery-director' && task.fingerprint) {
    state.cdr.fingerprints[task.fingerprint] = {
      taskId,
      briefFile: task.briefFile,
      status: task.status === 'succeeded' ? 'succeeded' : 'failed',
      updatedAt: Date.now(),
    };
    if (task.status === 'succeeded') {
      state.cdr.completedSinceReset += 1;
    }
  }

  saveTriggerState(state);
}

function parseStatusBlock(output) {
  const text = String(output || '');
  const match = text.match(/\[STATUS TO PETER\]([\s\S]*?)(?:\[\/STATUS TO PETER\]|$)/i);
  if (!match) return null;

  const block = match[0].trim();
  const fields = {};
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fieldMatch = trimmed.match(/^([A-Za-z ]+):\s*(.*)$/);
    if (!fieldMatch) continue;
    fields[fieldMatch[1].toLowerCase().replace(/\s+/g, '_')] = fieldMatch[2];
  }

  return {
    raw: block,
    owner: fields.owner || null,
    task: fields.task || null,
    status: fields.status || null,
    pr: fields.pr || null,
    output: fields.output || null,
    summary: fields.summary || null,
    blockers: fields.blockers || null,
  };
}

function summariseOutput(stdout, stderr) {
  const statusBlock = parseStatusBlock(`${stdout || ''}\n${stderr || ''}`);
  if (statusBlock?.summary) return statusBlock.summary;

  const lines = `${stdout || ''}\n${stderr || ''}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[0] ? lines[0].slice(0, 240) : null;
}

function classifyFailure(combinedOutput, code) {
  const text = String(combinedOutput || '');
  if (code === 0) return null;
  if (isContextOverflow(text)) return 'context_overflow';
  if (/session file locked/i.test(text) || /session .*locked/i.test(text)) return 'session_locked';
  if (/gateway timeout/i.test(text)) return 'gateway_timeout';
  if (/falling back to embedded/i.test(text) && /timeout/i.test(text)) return 'gateway_fallback_timeout';
  if (/config invalid/i.test(text)) return 'config_invalid';
  if (/failed to parse sessions json/i.test(text) || /could not resolve session id/i.test(text)) return 'session_resolution_failed';
  if (/timed out|timeout/i.test(text)) return 'transport_timeout';
  return 'agent_failure';
}

function isRetryableFailureClass(failureClass) {
  return new Set([
    'gateway_timeout',
    'gateway_fallback_timeout',
    'session_locked',
    'session_resolution_failed',
    'transport_timeout',
  ]).has(failureClass);
}

function resetCdrRotationCounter() {
  const state = loadTriggerState();
  state.cdr.completedSinceReset = 0;
  saveTriggerState(state);
}

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

function readSessionIdFromSessionsFile(agentId) {
  try {
    const sessionsFile = getSessionsFile(agentId);
    if (!fs.existsSync(sessionsFile)) return null;
    const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    const mainKey = `agent:${agentId}:main`;
    return sessions?.[mainKey]?.sessionId || null;
  } catch {
    return null;
  }
}

function isContextOverflow(output) {
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(output || ''));
}

async function refreshSessionBinding(agentId, reason = 'runtime', options = {}) {
  const runtime = getAgentRuntime(agentId);
  const previousSessionId = runtime.sessionId || null;
  let sessionId = readSessionIdFromSessionsFile(agentId);
  let sessionSource = sessionId ? 'sessions_file' : null;
  let sessionStatus = sessionId ? 'ready' : 'unavailable';
  let resolveError = null;

  if (!sessionId) {
    sessionId = await resolveSessionId(agentId);
    if (sessionId) {
      sessionSource = 'openclaw_cli';
      sessionStatus = 'ready';
    } else if (previousSessionId && options.allowCached !== false) {
      sessionId = previousSessionId;
      sessionSource = runtime.sessionSource || 'cached_previous';
      sessionStatus = 'stale_cached';
      resolveError = 'fresh_session_lookup_failed_using_cached_session';
    } else {
      resolveError = 'fresh_session_lookup_failed';
    }
  }

  runtime.sessionId = sessionId || null;
  runtime.sessionSource = sessionSource;
  runtime.sessionStatus = sessionStatus;
  runtime.sessionUpdatedAt = nowIso();
  runtime.lastResolveReason = reason;
  runtime.lastResolveError = resolveError;

  updateAgentRuntimeState(agentId, {
    sessionId: runtime.sessionId,
    sessionSource: runtime.sessionSource,
    sessionStatus: runtime.sessionStatus,
    sessionUpdatedAt: runtime.sessionUpdatedAt,
    lastResolveReason: runtime.lastResolveReason,
    lastResolveError: runtime.lastResolveError,
  });

  return {
    sessionId: runtime.sessionId,
    sessionSource: runtime.sessionSource,
    sessionStatus: runtime.sessionStatus,
    lastResolveError: runtime.lastResolveError,
  };
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
  const runtime = getAgentRuntime(agentId);

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

  const attemptNumber = startTaskAttempt(agentId, taskId, {
    retry: isRetry,
    retryReason: isRetry ? 'classified_retry' : 'initial',
    sessionId: sessionId || null,
    sessionStatus: runtime.sessionStatus || (sessionId ? 'ready' : 'unavailable'),
    sessionSource: runtime.sessionSource || null,
  });

  console.log(
    `[${agentId}] task=${taskId} owner=${ownerLaneFor(agentId)} attempt=${attemptNumber} session=${sessionId || 'unresolved'} retry=${isRetry ? 'yes' : 'no'}`
  );

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
    if (stderr) console.error(`[${agentId}] stderr: ${stderr.slice(0, 200)}`);
    const overflow = isContextOverflow(combinedOutput);
    const failureClass = classifyFailure(combinedOutput, code);
    const statusBlock = parseStatusBlock(combinedOutput);
    const summary = summariseOutput(stdout, stderr);
    const retryableFailure = isRetryableFailureClass(failureClass);

    console.log(
      `[${agentId}] task=${taskId} attempt=${attemptNumber} code=${code} result=${code === 0 ? 'succeeded' : 'failed'} failure_class=${failureClass || 'none'} summary=${summary || 'n/a'}`
    );

    const shouldResetForOverflow = (
      agentId === 'client-delivery-director' &&
      !hasResetSession &&
      overflow
    );

    if (shouldResetForOverflow) {
      console.warn(`[${agentId}] Task ${taskId} hit context overflow, resetting session and retrying once`);
      const resetSessionId = await resetAgentMainSession(agentId, sessionId);
      if (resetSessionId) {
        AGENTS[agentId].sessionId = resetSessionId;
        AGENTS[agentId].sessionSource = 'overflow_reset';
        AGENTS[agentId].sessionStatus = 'ready';
        AGENTS[agentId].sessionUpdatedAt = nowIso();
        AGENTS[agentId].lastResolveReason = 'overflow_reset';
        AGENTS[agentId].lastResolveError = null;
        updateAgentRuntimeState(agentId, {
          sessionId: resetSessionId,
          sessionSource: 'overflow_reset',
          sessionStatus: 'ready',
          sessionUpdatedAt: AGENTS[agentId].sessionUpdatedAt,
          lastResolveReason: 'overflow_reset',
          lastResolveError: null,
          lastTaskId: taskId,
        });
        resetCdrRotationCounter();
      } else {
        console.error(`[${agentId}] Could not start a fresh session after overflow for task ${taskId}`);
      }

      finishTaskAttempt(agentId, taskId, {
        exitCode: code,
        resultState: 'overflow_reset',
        finalStatus: 'retrying',
        failureClass: 'context_overflow',
        sessionId: AGENTS[agentId].sessionId || null,
        sessionStatus: AGENTS[agentId].sessionStatus || 'unavailable',
        sessionSource: AGENTS[agentId].sessionSource || null,
        summary,
        lastError: combinedOutput.slice(0, 400) || 'context_overflow',
        retryScheduled: Boolean(AGENTS[agentId].sessionId),
        statusBlock: statusBlock?.raw || null,
        reportedStatus: statusBlock?.status || null,
        reportedOutput: statusBlock?.output || null,
      });

      const retrySessionId = AGENTS[agentId].sessionId;
      if (retrySessionId) {
        setTimeout(() => fireAgentTurn(agentId, retrySessionId, message, taskId, false, true), 2000);
      } else {
        console.error(`[${agentId}] Could not start a fresh session after overflow for task ${taskId}`);
      }
      return;
    }

    if (agentId === 'client-delivery-director' && !hasResetSession) {
      const state = loadTriggerState();
      if (state.cdr.completedSinceReset >= CDR_SESSION_ROTATE_AFTER) {
        console.warn(`[${agentId}] Rotating session after ${state.cdr.completedSinceReset} completed tasks`);
        const freshSessionId = await resetAgentMainSession(agentId, sessionId);
        if (freshSessionId) {
          AGENTS[agentId].sessionId = freshSessionId;
          AGENTS[agentId].sessionSource = 'rotation_reset';
          AGENTS[agentId].sessionStatus = 'ready';
          AGENTS[agentId].sessionUpdatedAt = nowIso();
          AGENTS[agentId].lastResolveReason = 'rotation_reset';
          AGENTS[agentId].lastResolveError = null;
          updateAgentRuntimeState(agentId, {
            sessionId: freshSessionId,
            sessionSource: 'rotation_reset',
            sessionStatus: 'ready',
            sessionUpdatedAt: AGENTS[agentId].sessionUpdatedAt,
            lastResolveReason: 'rotation_reset',
            lastResolveError: null,
            lastTaskId: taskId,
          });
          resetCdrRotationCounter();
        } else {
          console.error(`[${agentId}] Could not rotate session after task ${taskId}`);
        }
      }
    }

    if (code === 0) {
      finishTaskAttempt(agentId, taskId, {
        exitCode: code,
        resultState: 'succeeded',
        finalStatus: 'succeeded',
        failureClass: null,
        sessionId: runtime.sessionId || sessionId || null,
        sessionStatus: runtime.sessionStatus || (sessionId ? 'ready' : 'unavailable'),
        sessionSource: runtime.sessionSource || null,
        summary,
        lastError: null,
        retryScheduled: false,
        statusBlock: statusBlock?.raw || null,
        reportedStatus: statusBlock?.status || null,
        reportedOutput: statusBlock?.output || null,
      });
      return;
    }

    if (!isRetry && retryableFailure) {
      const refreshed = await refreshSessionBinding(agentId, `retry_after_${failureClass}`, { allowCached: true });
      finishTaskAttempt(agentId, taskId, {
        exitCode: code,
        resultState: 'retrying',
        finalStatus: 'retrying',
        failureClass,
        sessionId: refreshed.sessionId || null,
        sessionStatus: refreshed.sessionStatus || 'unavailable',
        sessionSource: refreshed.sessionSource || null,
        summary,
        lastError: combinedOutput.slice(0, 400) || failureClass,
        retryScheduled: Boolean(refreshed.sessionId),
        statusBlock: statusBlock?.raw || null,
        reportedStatus: statusBlock?.status || null,
        reportedOutput: statusBlock?.output || null,
      });
      if (refreshed.sessionId) {
        console.log(`[${agentId}] task=${taskId} attempt=${attemptNumber} retrying with refreshed pinned session after ${failureClass}`);
        setTimeout(() => fireAgentTurn(agentId, refreshed.sessionId, message, taskId, true, hasResetSession), 5000);
      } else {
        console.error(`[${agentId}] task=${taskId} no stable session after ${failureClass}; not retrying`);
      }
      return;
    }

    finishTaskAttempt(agentId, taskId, {
      exitCode: code,
      resultState: 'failed',
      finalStatus: 'failed',
      failureClass,
      sessionId: runtime.sessionId || sessionId || null,
      sessionStatus: runtime.sessionStatus || (sessionId ? 'ready' : 'unavailable'),
      sessionSource: runtime.sessionSource || null,
      summary,
      lastError: combinedOutput.slice(0, 400) || failureClass || 'agent_failure',
      retryScheduled: false,
      statusBlock: statusBlock?.raw || null,
      reportedStatus: statusBlock?.status || null,
      reportedOutput: statusBlock?.output || null,
    });
  });

  proc.on('error', (err) => {
    console.error(`[${agentId}] Spawn error for task ${taskId}: ${err.message}`);
    if (!isRetry) {
      finishTaskAttempt(agentId, taskId, {
        exitCode: null,
        resultState: 'retrying',
        finalStatus: 'retrying',
        failureClass: 'spawn_error',
        sessionId: runtime.sessionId || sessionId || null,
        sessionStatus: runtime.sessionStatus || (sessionId ? 'ready' : 'unavailable'),
        sessionSource: runtime.sessionSource || null,
        summary: err.message,
        lastError: err.message,
        retryScheduled: true,
      });
      console.log(`[${agentId}] Retrying after spawn_error with refreshed session binding...`);
      setTimeout(async () => {
        const refreshed = await refreshSessionBinding(agentId, 'retry_after_spawn_error', { allowCached: true });
        if (!refreshed.sessionId) {
          finishTaskAttempt(agentId, taskId, {
            exitCode: null,
            resultState: 'failed',
            finalStatus: 'failed',
            failureClass: 'session_unavailable',
            sessionId: null,
            sessionStatus: 'unavailable',
            sessionSource: null,
            summary: 'Retry aborted: no stable session binding available',
            lastError: 'Retry aborted: no stable session binding available',
            retryScheduled: false,
          });
          return;
        }
        fireAgentTurn(agentId, refreshed.sessionId, message, taskId, true, hasResetSession);
      }, 5000);
    }
  });

  // Unref immediately — fire-and-forget, don't block the event loop
  proc.unref();
}

// ─── Build one Express server per agent ──────────────────────────────────────
function startServer(agentName, config) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.post('/task', async (req, res) => {
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
    const ownerLane = ownerLaneFor(agentName);

    if (!task_id || !brief) {
      return res.status(400).json({ error: 'task_id and brief are required' });
    }

    const fingerprint = briefFingerprint(agentName, brief);
    const timestamp = nowIso();
    const filename  = `TASK-${task_id}-${agentName}.md`;
    const filepath  = path.join(WORKSPACE, filename);

    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    const content = [
      `# TASK: ${task_id}`,
      `Owner Lane: ${ownerLane}`,
      `From: ${from}`,
      `Priority: ${priority}`,
      `Timestamp: ${timestamp}`,
      ``,
      brief,
      ``,
    ].join('\n');
    fs.writeFileSync(filepath, content);

    if (agentName === 'client-delivery-director') {
      const duplicate = findCdrDuplicate(task_id, fingerprint);
      if (duplicate) {
        markTaskDuplicate(agentName, task_id, fingerprint, `memory/${filename}`, duplicate);
        return res.json({
          status: 'duplicate',
          owner_lane: ownerLane,
          agent: agentName,
          task_id,
          duplicate_of_task: duplicate.taskId,
          brief_file: duplicate.briefFile,
          session_id: config.sessionId || null,
          session_status: config.sessionStatus || 'unknown',
          session_source: config.sessionSource || null,
          spawning: false,
        });
      }
    }

    const binding = await refreshSessionBinding(agentName, `task_${task_id}`, { allowCached: true });
    updateAgentRuntimeState(agentName, { lastTaskId: task_id });
    AGENTS[agentName].lastTaskId = task_id;

    if (!binding.sessionId) {
      markTaskSessionUnavailable(agentName, task_id, fingerprint, `memory/${filename}`, {
        sessionId: null,
        sessionStatus: 'unavailable',
        sessionSource: null,
        lastError: binding.lastResolveError || 'No stable session binding available',
      });
      return res.status(503).json({
        error: 'session_unavailable',
        failure_class: 'session_unavailable',
        owner_lane: ownerLane,
        agent: agentName,
        task_id,
        timestamp,
        brief_file: `memory/${filename}`,
        session_id: null,
        session_status: 'unavailable',
        session_source: null,
        last_resolve_error: binding.lastResolveError || 'No stable session binding available',
        spawning: false,
      });
    }

    // 2. Respond immediately — agent spawn is async
    markTaskAccepted(agentName, task_id, fingerprint, `memory/${filename}`, {
      sessionId: binding.sessionId,
      sessionStatus: binding.sessionStatus,
      sessionSource: binding.sessionSource,
    });
    res.json({
      status:     'received',
      owner_lane: ownerLane,
      agent:      agentName,
      task_id,
      timestamp,
      brief_file: `memory/${filename}`,
      session_id: binding.sessionId,
      session_status: binding.sessionStatus,
      session_source: binding.sessionSource,
      spawning:   true,
    });

    // 3. Fire agent turn into the permanent session (fire-and-forget)
    const prompt = [
      `[TASK — ${task_id}] Priority: ${priority} | From: ${from}`,
      `[OWNER LANE — ${ownerLane}]`,
      `Brief saved to: memory/${filename}`,
      ``,
      brief,
      ``,
      `Start working on this now. Report [STATUS TO PETER] when complete.`,
    ].join('\n');

    fireAgentTurn(agentName, binding.sessionId, prompt, task_id);
  });

  app.get('/tasks/:taskId', (req, res) => {
    const task = getTaskRecord(req.params.taskId);
    if (!task || task.agentId !== agentName) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json(task);
  });

  app.get('/health', (_req, res) => {
    const state = loadTriggerState();
    const agentState = state.agents[agentName] || {};
    const latestTask = agentState.lastTaskId ? state.tasks[agentState.lastTaskId] : null;
    res.json({
      agent:      agentName,
      port:       config.port,
      session_id: config.sessionId || null,
      session_status: config.sessionStatus || 'unknown',
      session_source: config.sessionSource || null,
      session_updated_at: config.sessionUpdatedAt || null,
      last_resolve_error: config.lastResolveError || null,
      last_task_id: config.lastTaskId || null,
      last_task_status: latestTask?.status || null,
      last_task_failure_class: latestTask?.failureClass || null,
      status:     'ok',
      timestamp:  nowIso(),
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

function startSessionRefresh() {
  const refresh = async () => {
    await Promise.all(
      Object.keys(AGENTS).map(async (agentId) => {
        await refreshSessionBinding(agentId, 'periodic_refresh', { allowCached: true });
      })
    );
  };
  const interval = setInterval(refresh, SESSION_REFRESH_INTERVAL_MS);
  interval.unref();
  console.log(`[trigger-server] Session refresh started (${SESSION_REFRESH_INTERVAL_MS / 1000}s interval).`);
}

// ─── Main: resolve session IDs then start all servers ────────────────────────
(async () => {
  console.log('[trigger-server] Resolving permanent session IDs...');

  await Promise.all(
    Object.entries(AGENTS).map(async ([name, cfg]) => {
      const binding = await refreshSessionBinding(cfg.agentId, 'startup', { allowCached: true });
      cfg.sessionId = binding.sessionId;
    })
  );

  for (const [name, config] of Object.entries(AGENTS)) {
    startServer(name, config);
  }

  startGatewayKeepalive();
  startSessionRefresh();

  console.log('[trigger-server] All servers started (engineering + cdr only).');
})();
