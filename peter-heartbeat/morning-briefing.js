'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const TELEGRAM_TOKEN = process.env.MISSION_CONTROL_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || process.env.PETER_TELEGRAM_TOKEN;
// TODO: Wire this to the Mission Control group ID if MISSION_CONTROL_CHAT_ID/TELEGRAM_GROUP_ID is absent.
const TELEGRAM_CHAT_ID = process.env.MISSION_CONTROL_CHAT_ID || process.env.TELEGRAM_GROUP_ID || process.env.BRANDON_CHAT_ID || '5821364140';
const MAX_MESSAGE_LENGTH = 3000;

const TOPICS = [
  'Airbnb host platform update 2026',
  'short term rental optimization tools 2026',
  'OpenClaw AI agent updates',
  'Claude AI model update 2026',
  'ChatGPT model update 2026',
  'GLM AI model 2026',
  'Airbnb host tips trending UK 2026',
];

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

async function isFirecrawlAvailable() {
  if (String(process.env.FIRECRAWL_DISABLED || '').toLowerCase() === 'true') return false;
  try {
    await execFileAsync('firecrawl', ['--version'], { timeout: 10_000 });
    return true;
  } catch (error) {
    console.error('[morning-briefing] firecrawl unavailable:', error.message);
    return false;
  }
}

function normalizeSearchPayload(stdout) {
  const parsed = JSON.parse(stdout);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.data)) return parsed.data;
  if (Array.isArray(parsed.results)) return parsed.results;
  if (parsed.data && Array.isArray(parsed.data.results)) return parsed.data.results;
  return [];
}

async function searchTopic(topic) {
  const args = ['search', topic, '--limit', '3', '--sources', 'news,web', '--tbs', 'qdr:w', '--country', 'GB', '--json'];
  try {
    const { stdout } = await execFileAsync('firecrawl', args, { timeout: 75_000, maxBuffer: 1024 * 1024 });
    return normalizeSearchPayload(stdout).slice(0, 3).map((item) => ({
      title: compact(item.title || item.name || item.url || 'Untitled result', 90),
      summary: compact(item.description || item.snippet || item.markdown || item.content || 'No summary available.', 150),
      url: item.url || item.link || '',
    })).filter((item) => item.url || item.title);
  } catch (error) {
    console.error(`[morning-briefing] search failed for ${topic}:`, error.message);
    return [];
  }
}

async function collectNews() {
  const available = await isFirecrawlAvailable();
  if (!available) return { disabled: true, results: [] };

  const results = [];
  for (const topic of TOPICS) {
    const items = await searchTopic(topic);
    results.push({ topic, items });
  }
  return { disabled: false, results };
}

function buildBrief({ news, date = new Date() }) {
  const lines = [
    `🌅 <b>Morning Intel Briefing</b>`,
    `<i>${escapeHtml(getUkDateParts(date))} · 07:30 UK</i>`,
    '',
  ];

  if (news.disabled) {
    lines.push('🗞 <b>News scan</b>');
    lines.push('Firecrawl search is currently disabled or unavailable, so news sections were skipped.');
    lines.push('');
  } else {
    lines.push('🗞 <b>News scan</b>');
    for (const { topic, items } of news.results) {
      lines.push(`\n<b>${escapeHtml(topic)}</b>`);
      if (!items.length) {
        lines.push('• No strong recent result found.');
        continue;
      }
      for (const item of items.slice(0, 3)) {
        const title = escapeHtml(item.title);
        const summary = escapeHtml(item.summary);
        const url = escapeHtml(item.url);
        lines.push(`• <b>${title}</b> — ${summary}${url ? `\n  ${url}` : ''}`);
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
  TOPICS,
  FEATURE_RECOMMENDATIONS,
  buildBrief,
  collectNews,
  getFeatureRecommendation,
  runMorningIntelBriefing,
};
