#!/bin/bash
# Peter context watchdog — runs every 30 min
# Checks context usage for Peter's Telegram session and resets if > 80%

LOG_FILE="/tmp/peter-session-resets.log"
THRESHOLD=${THRESHOLD:-80}
SESSION_KEY="agent:main:telegram:direct:5821364140"
SESSIONS_JSON="$HOME/.openclaw/agents/main/sessions/sessions.json"
SESSIONS_DIR="$HOME/.openclaw/agents/main/sessions"

timestamp() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { echo "[$(timestamp)] $1" | tee -a "$LOG_FILE"; }

if [ ! -f "$SESSIONS_JSON" ]; then
  log "CHECK — sessions.json not found at $SESSIONS_JSON"
  exit 1
fi

# sessions.json is a flat object keyed by session key
SESSION_ID=$(jq -r --arg key "$SESSION_KEY" '.[$key].sessionId // empty' "$SESSIONS_JSON" 2>/dev/null)
TOTAL_TOKENS=$(jq -r --arg key "$SESSION_KEY" '.[$key].totalTokens // empty' "$SESSIONS_JSON" 2>/dev/null)
CONTEXT_LIMIT=$(jq -r --arg key "$SESSION_KEY" '.[$key].contextTokens // empty' "$SESSIONS_JSON" 2>/dev/null)

if [ -z "$SESSION_ID" ]; then
  log "CHECK — session $SESSION_KEY not found in sessions.json"
  exit 0
fi

TOTAL_TOKENS=${TOTAL_TOKENS:-0}
CONTEXT_LIMIT=${CONTEXT_LIMIT:-0}

if [ "$CONTEXT_LIMIT" -eq 0 ]; then
  log "CHECK — contextTokens limit is 0 or missing for $SESSION_KEY, skipping"
  exit 0
fi

CONTEXT_PCT=$((TOTAL_TOKENS * 100 / CONTEXT_LIMIT))

log "CHECK — session: $SESSION_ID — context: ${CONTEXT_PCT}% (${TOTAL_TOKENS}/${CONTEXT_LIMIT} tokens)"

if [ "$CONTEXT_PCT" -gt "$THRESHOLD" ]; then
  SESSION_FILE="$SESSIONS_DIR/$SESSION_ID.jsonl"
  if [ -f "$SESSION_FILE" ]; then
    BACKUP="${SESSION_FILE}.deleted.$(date -u +"%Y-%m-%dT%H-%M-%S.000Z")"
    mv "$SESSION_FILE" "$BACKUP"
    log "RESET — session: $SESSION_ID — context: ${CONTEXT_PCT}% — file moved to $(basename $BACKUP)"
  else
    log "RESET — session: $SESSION_ID — context: ${CONTEXT_PCT}% — .jsonl file not found (may already be reset)"
  fi
  # Remove lock file if present
  LOCK_FILE="$SESSIONS_DIR/$SESSION_ID.jsonl.lock"
  [ -f "$LOCK_FILE" ] && rm -f "$LOCK_FILE" && log "RESET — removed lock file"
else
  log "OK — context at ${CONTEXT_PCT}%, below threshold of ${THRESHOLD}%"
fi

# ─── ENG-ARCH-001 Phase 4: Monitor all dept head sessions ───────────────────

check_dept_session() {
  local SESSION_KEY="$1"
  local AGENT_LABEL="$2"
  local SESSIONS_JSON="$HOME/.openclaw/agents/main/sessions/sessions.json"

  if [ ! -f "$SESSIONS_JSON" ]; then return; fi

  local TOKENS LIMIT PCT SESSION_ID
  SESSION_ID=$(jq -r --arg key "$SESSION_KEY" '.[$key].sessionId // empty' "$SESSIONS_JSON" 2>/dev/null)
  if [ -z "$SESSION_ID" ]; then
    log "CHECK [$AGENT_LABEL] — no active session found for $SESSION_KEY"
    return
  fi

  TOKENS=$(jq -r --arg key "$SESSION_KEY" '.[$key].contextTokens // 0' "$SESSIONS_JSON" 2>/dev/null)
  LIMIT=$(jq -r --arg key "$SESSION_KEY" '.[$key].contextTokensLimit // 200000' "$SESSIONS_JSON" 2>/dev/null)
  PCT=$(echo "scale=0; $TOKENS * 100 / $LIMIT" | bc 2>/dev/null || echo 0)

  log "CHECK [$AGENT_LABEL] — session: $SESSION_ID — context: ${PCT}% (${TOKENS}/${LIMIT} tokens)"

  if [ "$PCT" -gt "$THRESHOLD" ]; then
    local SESSION_FILE="$HOME/.openclaw/agents/main/sessions/${SESSION_ID}.jsonl"
    if [ -f "$SESSION_FILE" ]; then
      local BACKUP="${SESSION_FILE}.deleted.$(date -u +%Y-%m-%dT%H-%M-%S.000Z)"
      mv "$SESSION_FILE" "$BACKUP"
      log "RESET [$AGENT_LABEL] — session: $SESSION_ID — context: ${PCT}% — file moved to $BACKUP"
    else
      log "RESET_SKIP [$AGENT_LABEL] — session file not found: ${SESSION_ID}.jsonl"
    fi
  fi
}

# Check all dept head sessions
check_dept_session "agent:engineering-lead:main" "ENGINEERING-LEAD"
check_dept_session "agent:head-of-product:main" "HEAD-OF-PRODUCT"
check_dept_session "agent:client-delivery-director:main" "CLIENT-DELIVERY"
check_dept_session "agent:commercial-director:main" "COMMERCIAL-DIRECTOR"

# ─── End ENG-ARCH-001 Phase 4 extension ─────────────────────────────────────
