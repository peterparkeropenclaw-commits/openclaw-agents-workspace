'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { hasUsableArtifact, loadBestMorningIntelArtifact, runMorningIntelResearch } = require('./lib/morning-intel-researcher');

const TELEGRAM_TOKEN = process.env.MISSION_CONTROL_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || process.env.PETER_TELEGRAM_TOKEN;
// TODO: Wire this to the Mission Control group ID if MISSION_CONTROL_CHAT_ID/TELEGRAM_GROUP_ID is absent.
const TELEGRAM_CHAT_ID = process.env.MISSION_CONTROL_CHAT_ID || process.env.TELEGRAM_GROUP_ID || process.env.BRANDON_CHAT_ID || '5821364140';
const MAX_MESSAGE_LENGTH = 3000;

const FEATURE_RECOMMENDATIONS = [
  "Add a 'Guest Origin Map' section showing where bookings typically come from for this property type and region",
  "Add a 'Peak Weekend Premium' calculator showing optimal Friday vs Monday pricing differential",
  "Add a 'Review Sentiment Trend' showing whether review tone has improved/declined over last 12 months",
  "Add a 'Title A/B Test Suggestion' with two tested title variants and expected CTR difference",
  "Add a 'Cancellation Risk Score' based on booking window and price point",
  "Add a 'Local Event Calendar Overlay' showing demand spikes from nearby events",
  "Add a 'Competitor New Listings Alert' showing new competition entered the market",
  "Add a 'Minimum Stay Optimisation' section with recommended min-stay rules per season",
  "Add a 'Photo Quality Score' using AI to grade lighting, composition and staging",
  "Add a 'Description Readability Score' with Flesch-Kincaid grade and suggested rewrites",
  "Add a 'Instant Book vs Request Analysis' recommendation based on occupancy pattern",
  "Add a 'Smart Pricing Dependency Check' flagging if host is over-relying on Airbnb Smart Pricing",
  "Add a 'Guest Repeat Potential Score' based on property type and review language",
  "Add a 'Platform Diversification Opportunity' scoring Vrbo/Booking.com gap for this listing type",
  "Add a 'Superhost Gap Analysis' showing exactly what metrics need to improve to reach/maintain Superhost",
  "Add a 'Seasonal Photo Swap Recommendation' showing which hero image performs best by season",
  "Add a 'Check-in Experience Score' based on review mentions of arrival, keys, instructions",
  "Add a 'Amenity ROI Ranking' showing which amenities drive the most review mentions and booking uplift",
  "Add a 'Pricing Confidence Score' showing how reliable the pricing recommendation is based on comp data quality",
  "Add a 'Title Character Optimisation' showing whether title is using full 50-char Airbnb allowance effectively",
];

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatSource(item) {
  let source = item?.source;
  if (!source && item?.url) {
    try {
      source = new URL(String(item.url)).hostname.replace(/^www\./, '');
    } catch (_) {
      source = '';
    }
  }
  return source ? ` (${escapeHtml(compact(source, 45))})` : '';
}

function stripHtml(text) {
  return String(text || '').replace(/<[^>]+>/g, '');
}

function compact(text, max = 180) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function getUkDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  return formatter.format(date);
}

function getFeatureRecommendation(date = new Date()) {
  const ukParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const ukDate = new Date(Date.UTC(Number(ukParts.year), Number(ukParts.month) - 1, Number(ukParts.day)));
  const dayOfWeekIndex = ukDate.getUTCDay(); // Sunday=0, Monday=1, etc.
  const weekIndex = Math.floor((ukDate - new Date(Date.UTC(ukDate.getUTCFullYear(), 0, 1))) / (7 * 86400000));
  return FEATURE_RECOMMENDATIONS[((weekIndex * 7) + dayOfWeekIndex) % FEATURE_RECOMMENDATIONS.length];
}

async function collectNews({ date = new Date(), refresh = true } = {}) {
  if (refresh) {
    try {
      const { artifact, outPath } = await runMorningIntelResearch({ date });
      if (hasUsableArtifact(artifact)) return { unavailable: false, fresh: true, artifact, artifactPath: outPath };
    } catch (error) {
      console.error('[morning-briefing] direct research failed:', error.message);
    }
  }

  const loaded = loadBestMorningIntelArtifact({ date });
  if (loaded && hasUsableArtifact(loaded.artifact)) {
    return { unavailable: false, fresh: loaded.fresh, artifact: loaded.artifact, artifactPath: loaded.path };
  }

  return { unavailable: true, reason: 'No usable local Morning Intel artifact is available.' };
}

function buildBrief({ news, date = new Date() }) {
  const lines = [
    `🌅 <b>Morning Intel Briefing</b>`,
    `<i>${escapeHtml(getUkDateParts(date))} · 07:30 UK</i>`,
    '',
  ];

  lines.push('🗞 <b>Agent-led web research</b>');
  if (news.unavailable) {
    lines.push(`Morning Intel is unavailable: ${escapeHtml(news.reason || 'no usable local research artifact was found')}`);
    lines.push('');
  } else {
    if (!news.fresh) lines.push('<i>Using best available saved research artifact because fresh research was unavailable.</i>');

    const takeaways = Array.isArray(news.artifact.takeaways) ? news.artifact.takeaways.slice(0, 3) : [];
    if (takeaways.length) {
      lines.push('<b>Top signals</b>');
      for (const takeaway of takeaways) lines.push(`• ${escapeHtml(compact(takeaway, 180))}`);
    }

    let renderedResearchItems = 0;
    const seenResearchKeys = new Set();
    for (const section of (news.artifact.sections || []).slice(0, 3)) {
      const items = Array.isArray(section.items) ? section.items : [];
      const renderedItems = [];
      for (const item of items) {
        const key = (item.url || item.title || '').toLowerCase().replace(/\W+/g, ' ').slice(0, 80);
        if (key && seenResearchKeys.has(key)) continue;
        if (key) seenResearchKeys.add(key);
        renderedItems.push(item);
        if (renderedItems.length >= 2) break;
      }
      if (!renderedItems.length) continue;
      lines.push(`\n<b>${escapeHtml(section.title || section.id || 'Research section')}</b>`);
      for (const item of renderedItems) {
        const title = escapeHtml(compact(item.title || 'Untitled signal', 95));
        const summary = escapeHtml(compact(item.summary || item.source || 'No summary available.', 150));
        lines.push(`• <b>${title}</b> — ${summary}${formatSource(item)}`);
        renderedResearchItems += 1;
      }
    }

    if (!takeaways.length && renderedResearchItems === 0) lines.push('No strong web/news items were available in the saved artifact.');

    const communitySignals = Array.isArray(news.artifact.communitySignals) ? news.artifact.communitySignals.slice(0, 2) : [];
    if (communitySignals.length) {
      lines.push('\n<b>Host community signals</b>');
      for (const item of communitySignals) {
        const title = escapeHtml(compact(item.title || 'Untitled community signal', 95));
        const summary = escapeHtml(compact(item.summary || item.source || 'No summary available.', 130));
        lines.push(`• <b>${title}</b> — ${summary}${formatSource(item)}`);
      }
    }
    lines.push('');
  }

  lines.push('💡 <b>Daily Report Feature Recommendation</b>');
  lines.push(escapeHtml(getFeatureRecommendation(date)));

  let message = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (message.length > MAX_MESSAGE_LENGTH) {
    message = `${message.slice(0, MAX_MESSAGE_LENGTH - 80).trim()}\n\n…trimmed to stay under Telegram limit.`;
  }
  return message;
}

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN) {
    console.error('[morning-briefing] Telegram token missing');
    return false;
  }

  const payload = { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true };
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (data.ok) return true;

  console.warn('[morning-briefing] HTML send failed, retrying plain text:', data.description);
  const plain = stripHtml(message);
  const retry = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: plain, disable_web_page_preview: true }),
  });
  const retryData = await retry.json();
  if (!retryData.ok) console.error('[morning-briefing] Telegram send failed:', retryData.description);
  return retryData.ok;
}

async function runMorningIntelBriefing({ dryRun = false } = {}) {
  const news = await collectNews();
  const message = buildBrief({ news });
  if (dryRun) return { ok: true, message, sent: false };
  const sent = await sendTelegram(message);
  return { ok: sent, message, sent };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  runMorningIntelBriefing({ dryRun })
    .then((result) => {
      if (dryRun) console.log(result.message);
      else console.log(`[morning-briefing] sent=${result.sent}`);
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error('[morning-briefing] fatal:', error.message);
      process.exit(1);
    });
}

module.exports = {
  FEATURE_RECOMMENDATIONS,
  buildBrief,
  collectNews,
  getFeatureRecommendation,
  runMorningIntelBriefing,
};
