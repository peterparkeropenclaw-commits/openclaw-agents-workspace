'use strict';

/**
 * Morning Intel Researcher
 *
 * Direct-web, no-Firecrawl research step for the 07:30 Morning Intel Briefing.
 * Uses public RSS/JSON endpoints with fetch, synthesizes a local JSON artifact,
 * and never calls paid third-party scraping/research tools.
 */

const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = path.join(__dirname, '..', 'data', 'morning-intel');
const USER_AGENT = 'MorningIntelBriefing/1.0 (+direct-web-research; public-rss-json)';

const RESEARCH_TOPICS = [
  {
    id: 'str-platform',
    title: 'Short-term rental platform and host updates',
    queries: [
      'Airbnb host update short term rental',
      'short term rental host regulation UK',
      'Airbnb host pricing review cancellation',
    ],
  },
  {
    id: 'str-operator',
    title: 'STR operator opportunities and risks',
    queries: [
      'short term rental pricing occupancy host tools',
      'Airbnb host tips revenue management',
      'vacation rental market supply demand hosts',
    ],
  },
  {
    id: 'ai-agents',
    title: 'AI agents and automation updates',
    queries: [
      'AI agents OpenAI Anthropic Google update',
      'ChatGPT Claude AI model update agents',
      'AI automation tools small business update',
    ],
  },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function londonIsoDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function decodeXml(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(text, max = 220) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function extractTag(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return decodeXml(match?.[1] || '');
}

function sourceName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return 'source';
  }
}

async function fetchText(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, application/json, text/html' },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:7d`)}&hl=en-GB&gl=GB&ceid=GB:en`;
  const xml = await fetchText(url);
  const itemBlocks = [...xml.matchAll(/<item[\s\S]*?<\/item>/gi)].map((match) => match[0]);
  return itemBlocks.slice(0, 5).map((item) => {
    const title = extractTag(item, 'title');
    const link = extractTag(item, 'link');
    const pubDate = extractTag(item, 'pubDate');
    const description = extractTag(item, 'description');
    return {
      title: compact(title.replace(/ - [^-]+$/, ''), 110),
      summary: compact(description || title, 180),
      url: link,
      publishedAt: pubDate,
      source: sourceName(link),
    };
  }).filter((item) => item.title && item.url);
}

async function fetchRedditSignals() {
  const subreddits = ['airbnb_hosts', 'ShortTermRentals', 'AirBnB'];
  const signals = [];
  for (const sub of subreddits) {
    try {
      const url = `https://www.reddit.com/r/${sub}/top.json?t=day&limit=8`;
      const text = await fetchText(url, 15_000);
      const data = JSON.parse(text);
      for (const child of data?.data?.children || []) {
        const post = child.data || {};
        if (!post.title) continue;
        signals.push({
          title: compact(post.title, 110),
          summary: compact(post.selftext || `${post.score || 0} upvotes, ${post.num_comments || 0} comments in r/${post.subreddit}`, 180),
          url: `https://www.reddit.com${post.permalink}`,
          source: `r/${post.subreddit}`,
          score: (post.score || 0) + (post.num_comments || 0) * 3,
        });
      }
    } catch (error) {
      console.error(`[morning-intel-research] reddit r/${sub} failed:`, error.message);
    }
  }
  return signals.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 6);
}

function rankItems(items) {
  const keywords = /airbnb|host|rental|pricing|occupancy|regulation|booking|review|agent|openai|anthropic|claude|chatgpt|model|automation|tools/i;
  const seen = new Set();
  return items
    .map((item) => ({ ...item, relevance: keywords.test(`${item.title} ${item.summary}`) ? 2 : 0 }))
    .filter((item) => {
      const key = item.title.toLowerCase().replace(/\W+/g, ' ').slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
    .slice(0, 4);
}

function synthesizeTakeaways(sections, redditSignals) {
  const takeaways = [];
  const strItems = sections.flatMap((section) => section.items).filter((item) => /airbnb|rental|host|booking|regulation|occupancy|pricing/i.test(`${item.title} ${item.summary}`));
  const aiItems = sections.flatMap((section) => section.items).filter((item) => /ai|agent|openai|anthropic|claude|chatgpt|model|automation/i.test(`${item.title} ${item.summary}`));

  if (strItems.length) takeaways.push(`STR market watch: ${strItems[0].title}`);
  if (redditSignals.length) takeaways.push(`Host community signal: ${redditSignals[0].title}`);
  if (aiItems.length) takeaways.push(`AI/automation watch: ${aiItems[0].title}`);
  return takeaways.slice(0, 4);
}

function countArtifactItems(artifact) {
  const sectionItems = Array.isArray(artifact?.sections)
    ? artifact.sections.reduce((sum, section) => sum + (Array.isArray(section.items) ? section.items.length : 0), 0)
    : 0;
  const communityItems = Array.isArray(artifact?.communitySignals) ? artifact.communitySignals.length : 0;
  const takeawayItems = Array.isArray(artifact?.takeaways) ? artifact.takeaways.length : 0;
  return sectionItems + communityItems + takeawayItems;
}

function hasUsableArtifact(artifact) {
  return countArtifactItems(artifact) > 0;
}

async function runMorningIntelResearch({ date = new Date() } = {}) {
  const isoDate = londonIsoDate(date);
  const sections = [];

  for (const topic of RESEARCH_TOPICS) {
    const found = [];
    for (const query of topic.queries) {
      try {
        found.push(...await fetchGoogleNews(query));
      } catch (error) {
        console.error(`[morning-intel-research] news query failed (${query}):`, error.message);
      }
    }
    sections.push({ id: topic.id, title: topic.title, items: rankItems(found) });
  }

  const redditSignals = await fetchRedditSignals();
  const artifact = {
    date: isoDate,
    generatedAt: new Date().toISOString(),
    method: 'agent-led direct web research using public RSS/JSON endpoints; no Firecrawl or paid scraper',
    takeaways: synthesizeTakeaways(sections, redditSignals),
    sections,
    communitySignals: redditSignals.slice(0, 4),
    _meta: {
      source: 'lib/morning-intel-researcher.js',
      firecrawl: false,
      topicCount: RESEARCH_TOPICS.length,
      itemCount: sections.reduce((sum, section) => sum + section.items.length, 0) + redditSignals.length,
    },
  };

  ensureDir(ARTIFACT_DIR);
  const outPath = path.join(ARTIFACT_DIR, `${isoDate}.json`);
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  return { artifact, outPath };
}

function loadBestMorningIntelArtifact({ date = new Date() } = {}) {
  const isoDate = londonIsoDate(date);
  const preferred = path.join(ARTIFACT_DIR, `${isoDate}.json`);
  const candidates = [];
  if (fs.existsSync(preferred)) candidates.push(preferred);
  if (fs.existsSync(ARTIFACT_DIR)) {
    for (const name of fs.readdirSync(ARTIFACT_DIR).filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).sort().reverse()) {
      const full = path.join(ARTIFACT_DIR, name);
      if (!candidates.includes(full)) candidates.push(full);
    }
  }

  for (const file of candidates) {
    try {
      const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (hasUsableArtifact(artifact)) return { artifact, path: file, fresh: artifact.date === isoDate };
    } catch (error) {
      console.error(`[morning-intel-research] failed to load artifact ${file}:`, error.message);
    }
  }
  return null;
}

module.exports = {
  ARTIFACT_DIR,
  RESEARCH_TOPICS,
  countArtifactItems,
  hasUsableArtifact,
  loadBestMorningIntelArtifact,
  londonIsoDate,
  runMorningIntelResearch,
};
