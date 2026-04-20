'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_GRAPHICS_DIR = path.join(__dirname, 'social-graphics', 'facebook');
const DEFAULT_GRAPHIC_COUNT = 3;
const DEFAULT_SCHEDULE = '09:00';

function parseBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function getStateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function readDirIfExists(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function resolveGraphicAssets(graphicsDir, expectedCount = DEFAULT_GRAPHIC_COUNT) {
  const supportedExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
  const entries = readDirIfExists(graphicsDir)
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => supportedExtensions.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const assets = entries.slice(0, expectedCount).map((name, index) => ({
    slot: index + 1,
    fileName: name,
    path: path.join(graphicsDir, name),
    source: 'designer-supplied',
  }));

  const missingSlots = [];
  for (let slot = assets.length + 1; slot <= expectedCount; slot += 1) {
    missingSlots.push({
      slot,
      fileName: `graphic-${slot}.png`,
      path: path.join(graphicsDir, `graphic-${slot}.png`),
      source: 'placeholder-required',
    });
  }

  return {
    assets,
    missingSlots,
    complete: assets.length === expectedCount,
  };
}

function buildFacebookPostPayload({ postText, graphicsDir, expectedGraphicCount = DEFAULT_GRAPHIC_COUNT, metadata = {} }) {
  const resolved = resolveGraphicAssets(graphicsDir, expectedGraphicCount);

  return {
    channel: 'facebook',
    mode: resolved.complete ? 'ready-to-publish' : 'awaiting-designer-assets',
    postText,
    attachments: [...resolved.assets, ...resolved.missingSlots],
    attachmentPolicy: {
      expectedCount: expectedGraphicCount,
      requiresExactCount: true,
      generationMode: 'manual-designer-supplied',
      notes: 'This pipeline does not generate images. Designers must supply 3 branded graphics in the configured directory before publishing.',
    },
    metadata: {
      ...metadata,
      graphicsDir,
      readyGraphicCount: resolved.assets.length,
      missingGraphicCount: resolved.missingSlots.length,
      builtAt: new Date().toISOString(),
    },
  };
}

async function dispatchFacebookPost(payload, { webhookUrl, webhookToken, logger = console } = {}) {
  if (!webhookUrl) {
    logger.log('[social] FACEBOOK_SOCIAL_WEBHOOK_URL not set, scaffolded payload prepared only');
    return {
      ok: false,
      dispatched: false,
      reason: 'missing-webhook-url',
      payload,
    };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (webhookToken) headers.Authorization = `Bearer ${webhookToken}`;

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const rawBody = await response.text();
  let body = rawBody;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    body = rawBody;
  }

  if (!response.ok) {
    const error = new Error(`Webhook dispatch failed with ${response.status}`);
    error.responseBody = body;
    throw error;
  }

  return {
    ok: true,
    dispatched: true,
    body,
  };
}

async function runFacebookSocialPostJob({
  state,
  saveState,
  sendTelegram,
  logger = console,
  now = new Date(),
  postText,
}) {
  const enabled = parseBoolean(process.env.FACEBOOK_SOCIAL_CRON_ENABLED);
  if (!enabled) {
    return { skipped: true, reason: 'disabled' };
  }

  const dateKey = getStateKey(now);
  state.lastSocialPostRuns = state.lastSocialPostRuns || {};
  if (state.lastSocialPostRuns[dateKey]) {
    return { skipped: true, reason: 'already-ran-today' };
  }

  const graphicsDir = process.env.FACEBOOK_SOCIAL_GRAPHICS_DIR || DEFAULT_GRAPHICS_DIR;
  const expectedGraphicCount = Number(process.env.FACEBOOK_SOCIAL_GRAPHIC_COUNT || DEFAULT_GRAPHIC_COUNT);
  const payload = buildFacebookPostPayload({
    postText,
    graphicsDir,
    expectedGraphicCount,
    metadata: {
      schedule: process.env.FACEBOOK_SOCIAL_CRON_TIME || DEFAULT_SCHEDULE,
      runner: 'peter-heartbeat',
    },
  });

  const dispatchResult = await dispatchFacebookPost(payload, {
    webhookUrl: process.env.FACEBOOK_SOCIAL_WEBHOOK_URL,
    webhookToken: process.env.FACEBOOK_SOCIAL_WEBHOOK_TOKEN,
    logger,
  });

  state.lastSocialPostRuns[dateKey] = {
    ranAt: now.toISOString(),
    dispatched: dispatchResult.dispatched,
    mode: payload.mode,
    readyGraphicCount: payload.metadata.readyGraphicCount,
  };
  saveState(state);

  if (typeof sendTelegram === 'function') {
    const attachmentLines = payload.attachments.map((attachment) => `• Graphic ${attachment.slot}: ${attachment.fileName} (${attachment.source})`);
    await sendTelegram(
      [
        '📣 <b>Facebook social post pipeline ran</b>',
        '',
        `Mode: ${payload.mode}`,
        `Graphics expected: ${payload.attachmentPolicy.expectedCount}`,
        `Graphics ready: ${payload.metadata.readyGraphicCount}`,
        ...attachmentLines,
      ].join('\n')
    );
  }

  return {
    skipped: false,
    payload,
    dispatchResult,
  };
}

function scheduleDailyFacebookSocialJob({ stateLoader, saveState, sendTelegram, logger = console }) {
  const schedule = process.env.FACEBOOK_SOCIAL_CRON_TIME || DEFAULT_SCHEDULE;
  const [hoursRaw, minutesRaw] = schedule.split(':');
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);

  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    logger.error(`[social] Invalid FACEBOOK_SOCIAL_CRON_TIME: ${schedule}`);
    return;
  }

  const scheduleNextRun = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hours, minutes, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delay = next.getTime() - now.getTime();
    logger.log(`[social] Facebook social job scheduled in ${Math.round(delay / 60000)} minutes (at ${next.toISOString()})`);

    setTimeout(async () => {
      try {
        const state = stateLoader();
        await runFacebookSocialPostJob({
          state,
          saveState,
          sendTelegram,
          logger,
          now: new Date(),
          postText: process.env.FACEBOOK_SOCIAL_POST_TEXT || 'STR Clinic social post placeholder copy. Replace or source externally before publishing.',
        });
      } catch (error) {
        logger.error('[social] Facebook social job failed:', error.message);
      } finally {
        scheduleNextRun();
      }
    }, delay);
  };

  scheduleNextRun();
}

module.exports = {
  DEFAULT_GRAPHICS_DIR,
  DEFAULT_GRAPHIC_COUNT,
  buildFacebookPostPayload,
  resolveGraphicAssets,
  runFacebookSocialPostJob,
  scheduleDailyFacebookSocialJob,
};
