'use strict';

/**
 * Morning Researcher — gathers trending topics from STR/host communities
 * to seed daily Facebook post generation with current, relevant content.
 *
 * Sources:
 *   1. Reddit JSON API — r/airbnb, r/airbnb_hosts, r/ShortTermRentals, r/vrbo
 *   2. Airbnb Community Centre (via Firecrawl if available)
 *   3. BiggerPockets STR forum (via Firecrawl if available)
 *
 * On any failure: logs the error and returns an empty/partial brief.
 * Never throws.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const RESEARCH_DIR = path.join(__dirname, '..', 'data', 'research');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function londonIsoDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const pick = (t) => parts.find((p) => p.type === t)?.value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function log(msg) { console.log(`[RESEARCH] ${msg}`); }
function logErr(msg, err) { console.error(`[RESEARCH] ${msg}`, err?.message || err || ''); }

// ---------- Reddit JSON API ----------

const REDDIT_SUBREDDITS = [
  'airbnb',
  'airbnb_hosts',
  'ShortTermRentals',
  'vrbo',
];

async function fetchRedditTop(subreddit, timeWindow = 'day', limit = 10) {
  const url = `https://www.reddit.com/r/${subreddit}/top.json?t=${timeWindow}&limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'STRClinicResearcher/1.0 (morning-researcher; +https://strclinic.com)',
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Reddit ${subreddit} returned ${res.status}`);
  const data = await res.json();
  const posts = data?.data?.children || [];
  return posts.map((c) => ({
    title: c.data.title || '',
    score: c.data.score || 0,
    numComments: c.data.num_comments || 0,
    url: `https://www.reddit.com${c.data.permalink}`,
    selftext: (c.data.selftext || '').slice(0, 300),
    subreddit: c.data.subreddit,
    upvoteRatio: c.data.upvote_ratio || 0,
  }));
}

async function scrapeAllReddit() {
  const results = [];
  for (const sub of REDDIT_SUBREDDITS) {
    try {
      const posts = await fetchRedditTop(sub, 'day', 15);
      // If last 24h is thin, supplement with week
      if (posts.length < 5) {
        const weekPosts = await fetchRedditTop(sub, 'week', 10);
        results.push(...weekPosts);
      } else {
        results.push(...posts);
      }
      log(`Reddit r/${sub} — ${posts.length} posts`);
    } catch (err) {
      logErr(`Reddit r/${sub} failed`, err);
    }
  }
  return results;
}

// ---------- Firecrawl scraping (optional enrichment) ----------

async function tryFirecrawlScrape(url) {
  if (process.env.FIRECRAWL_DISABLED === 'true') {
    log(`Firecrawl disabled by FIRECRAWL_DISABLED=true; skipping ${url}`);
    return null;
  }

  try {
    const { stdout, stderr } = await execFileAsync('firecrawl', [
      'scrape', '--url', url, '--format', 'markdown',
    ], { timeout: 30000, maxBuffer: 512 * 1024 });
    if (stderr && stderr.toLowerCase().includes('error')) {
      logErr(`Firecrawl stderr for ${url}`, stderr);
      return null;
    }
    return stdout || null;
  } catch (err) {
    logErr(`Firecrawl scrape failed for ${url}`, err);
    return null;
  }
}

async function scrapeAirbnbCommunity() {
  const content = await tryFirecrawlScrape('https://community.withairbnb.com/t5/Community-Center/ct-p/community-center');
  if (!content) return [];
  // Extract thread titles from markdown (lines with links or headings)
  const lines = content.split('\n').filter((l) => l.trim().length > 20 && l.trim().length < 200);
  const topics = lines
    .filter((l) => /host|guest|listing|booking|review|pricing|policy|regulation|rule|tip|advice|problem|issue|support/i.test(l))
    .slice(0, 10)
    .map((l) => l.replace(/[#*[\]()>]/g, '').replace(/https?:\/\/\S+/g, '').trim())
    .filter((l) => l.length > 10);
  log(`Airbnb Community — ${topics.length} topics extracted`);
  return topics;
}

async function scrapeBiggerPockets() {
  const content = await tryFirecrawlScrape('https://www.biggerpockets.com/forums/21-short-term-and-vacation-rental-investing');
  if (!content) return [];
  const lines = content.split('\n').filter((l) => l.trim().length > 20 && l.trim().length < 200);
  const topics = lines
    .filter((l) => /host|rental|airbnb|vrbo|listing|income|revenue|permit|regulation|occupancy|pricing|guest/i.test(l))
    .slice(0, 10)
    .map((l) => l.replace(/[#*[\]()>]/g, '').replace(/https?:\/\/\S+/g, '').trim())
    .filter((l) => l.length > 10);
  log(`BiggerPockets — ${topics.length} topics extracted`);
  return topics;
}

// ---------- Synthesis ----------

const STR_PAIN_KEYWORDS = [
  'fee', 'fees', 'commission', 'pricing', 'price', 'rate', 'discount',
  'review', 'rating', 'star', 'complaint', 'damage', 'deposit', 'guest',
  'booking', 'cancel', 'refund', 'support', 'airbnb', 'superhost',
  'regulation', 'permit', 'law', 'ban', 'license', 'tax',
  'occupancy', 'calendar', 'photo', 'listing', 'title', 'description',
  'amenity', 'cleaning', 'cleaner', 'check-in', 'checkout', 'keybox',
  'wifi', 'noise', 'neighbour', 'complaint', 'insurance',
  'income', 'profit', 'revenue', 'expense', 'mortgage',
  'competition', 'market', 'supply', 'demand', 'seasonal',
];

function scorePost(post) {
  const text = (post.title + ' ' + post.selftext).toLowerCase();
  const keywordHits = STR_PAIN_KEYWORDS.filter((k) => text.includes(k)).length;
  return (post.score || 0) + (post.numComments || 0) * 3 + keywordHits * 50;
}

function extractTopics(redditPosts, airbnbTopics, bpTopics) {
  // Score and sort Reddit posts
  const scored = redditPosts
    .filter((p) => p.title && p.title.length > 10)
    .sort((a, b) => scorePost(b) - scorePost(a));

  const trendingTopics = [];
  const hostPainPoints = [];
  const viralAngles = [];
  const seen = new Set();

  for (const post of scored) {
    const title = post.title.trim();
    const key = title.toLowerCase().slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);

    // High engagement = viral angle
    if ((post.score > 200 || post.numComments > 50) && viralAngles.length < 3) {
      viralAngles.push(`${title} (${post.score} upvotes, r/${post.subreddit})`);
    }

    // Pain keywords = pain point
    const text = (post.title + ' ' + post.selftext).toLowerCase();
    const painHits = ['problem', 'issue', 'help', 'advice', 'frustrated', 'unfair', 'scam', 'charged', 'banned', 'suspended', 'cancel', 'damage', 'complaint', 'regulation', 'law', 'losing'].filter((k) => text.includes(k));
    if (painHits.length > 0 && hostPainPoints.length < 5) {
      hostPainPoints.push(title);
    } else if (trendingTopics.length < 8) {
      trendingTopics.push(title);
    }

    if (trendingTopics.length >= 8 && hostPainPoints.length >= 5 && viralAngles.length >= 3) break;
  }

  // Supplement with community topics
  for (const t of [...airbnbTopics, ...bpTopics]) {
    if (trendingTopics.length < 10 && !seen.has(t.toLowerCase().slice(0, 40))) {
      trendingTopics.push(t);
      seen.add(t.toLowerCase().slice(0, 40));
    }
  }

  return { trendingTopics, hostPainPoints, viralAngles };
}

function deriveSeasonalContext() {
  const now = new Date();
  const month = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', month: 'long' }).format(now);
  const monthNum = now.getMonth() + 1; // 1-indexed
  if (monthNum >= 3 && monthNum <= 5) return `Early ${month} — spring demand building, Easter holiday bookings, key period for listing refresh before summer peak.`;
  if (monthNum >= 6 && monthNum <= 8) return `${month} — peak summer season, high demand, competitive pricing environment, guest expectations elevated.`;
  if (monthNum >= 9 && monthNum <= 10) return `${month} — post-peak shoulder season, focus on occupancy maintenance and review accumulation before winter.`;
  if (monthNum >= 11 || monthNum === 1) return `${month} — low season, focus on positioning improvements, pricing strategy, and preparation for spring.`;
  return `${month} — transitional period, strategic listing improvements and pricing reviews recommended.`;
}

function deriveSuggestedAngles(trendingTopics, hostPainPoints, viralAngles) {
  const angles = [];

  // Pull from pain points first (most useful for content)
  for (const pain of hostPainPoints.slice(0, 3)) {
    angles.push(`Address host concern: "${pain.slice(0, 80)}"`);
  }

  // Then viral threads
  for (const viral of viralAngles.slice(0, 2)) {
    angles.push(`React to trending thread: ${viral.split('(')[0].trim().slice(0, 80)}`);
  }

  // Fill with evergreen angles if short
  const evergreen = [
    'Why most UK Airbnb hosts are leaving money on the table with their title',
    'The photo sequence mistake that kills conversion before guests read a word',
    'How to protect your nightly rate when the market softens',
    'What your reviews are really telling potential guests about your listing',
    'The difference between busy and profitable as an STR host',
  ];
  for (const e of evergreen) {
    if (angles.length >= 6) break;
    angles.push(e);
  }

  return angles.slice(0, 6);
}

// ---------- Main entry ----------

async function runMorningResearch() {
  const date = londonIsoDate();
  log(`Starting morning research for ${date}`);

  let redditPosts = [];
  let airbnbTopics = [];
  let bpTopics = [];

  // Scrape Reddit (primary source — uses public JSON API, no auth)
  try {
    redditPosts = await scrapeAllReddit();
    log(`Reddit total: ${redditPosts.length} posts across ${REDDIT_SUBREDDITS.length} subreddits`);
  } catch (err) {
    logErr('Reddit scraping failed', err);
  }

  // Optional: Firecrawl enrichment
  try {
    airbnbTopics = await scrapeAirbnbCommunity();
  } catch (err) {
    logErr('Airbnb Community scraping failed', err);
  }

  try {
    bpTopics = await scrapeBiggerPockets();
  } catch (err) {
    logErr('BiggerPockets scraping failed', err);
  }

  const { trendingTopics, hostPainPoints, viralAngles } = extractTopics(redditPosts, airbnbTopics, bpTopics);
  const seasonalContext = deriveSeasonalContext();
  const suggestedPostAngles = deriveSuggestedAngles(trendingTopics, hostPainPoints, viralAngles);

  const researchBrief = {
    date,
    trendingTopics,
    hostPainPoints,
    viralAngles,
    seasonalContext,
    suggestedPostAngles,
    _meta: {
      redditPostsScraped: redditPosts.length,
      airbnbTopicsFound: airbnbTopics.length,
      bpTopicsFound: bpTopics.length,
      totalTopics: trendingTopics.length + hostPainPoints.length,
    },
  };

  // Save to data/research/YYYY-MM-DD.json
  ensureDir(RESEARCH_DIR);
  const outPath = path.join(RESEARCH_DIR, `${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify(researchBrief, null, 2));

  const total = trendingTopics.length + hostPainPoints.length;
  log(`Morning research complete — ${total} topics found, saved to ${outPath}`);

  return researchBrief;
}

module.exports = { runMorningResearch };
