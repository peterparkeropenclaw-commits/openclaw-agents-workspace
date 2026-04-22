'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });
const { execFile } = require('child_process');
const { promisify } = require('util');
const fetch = global.fetch;
const { chromium } = require('/Users/robotmac/workspace/str-clinic-pdf-generator/node_modules/playwright');

const execFileAsync = promisify(execFile);
const OUTPUT_ROOT = path.join(__dirname, 'output', 'facebook-daily-cron');
const FONT_ASSETS = {
  inter400: path.join(__dirname, 'assets', 'fonts', 'Inter-400.ttf'),
  inter600: path.join(__dirname, 'assets', 'fonts', 'Inter-600.ttf'),
  inter700: path.join(__dirname, 'assets', 'fonts', 'Inter-700.ttf'),
  playfair700: path.join(__dirname, 'assets', 'fonts', 'PlayfairDisplay-700.ttf'),
};
const CATEGORY_LABELS = [
  'LISTING POSITIONING',
  'PRICING STRATEGY',
  'PHOTO SEQUENCING',
  'GUEST EXPERIENCE',
  'REVIEW STRATEGY',
  'SEASONAL TACTICS',
  'MARKET SIGNALS',
  'COMPETITOR INTELLIGENCE',
  'CONVERSION FRICTION',
  'HOST DECISION-MAKING',
];
const DEFAULT_TAGS = ['MARGIN', 'POSITIONING', 'RATE'];

function londonDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const pick = (t) => parts.find((p) => p.type === t)?.value;
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  return { year, month, day, isoDate: `${year}-${month}-${day}` };
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }
function escapeHtml(s) { return String(s || '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])); }

async function tryCdrGeneration() {
  const url = process.env.CDR_WEBHOOK_URL || 'http://localhost:3104/task';
  const taskId = `FB-POSTS-${Date.now()}`;
  const resultPath = `/tmp/${taskId}.json`;
  const brief = `Generate exactly 10 unique Facebook posts for STR Clinic.
Audience: UK Airbnb and short-term rental hosts, 1-3 properties, age 30-55.
Niche: Airbnb listing optimisation in the UK.
Tone: Educational, authority-building, Facebook-native but LinkedIn-substance. Direct, host-to-host, UK English. No generic boost your bookings language. No emoji spam. Insight-led, specific, commercially sharp.
Pillars: listing optimisation, pricing strategy, guest experience, photography tips, seasonal tactics, competitor positioning, review strategy, STR market insights, conversion friction, host decision-making.
Format: Return strict JSON only with key posts, where posts is an array of 10 objects. Each object must include: topic, hook, paragraphs (array of 3 to 5 short paragraphs), close, hashtags (array of 3 to 5), categoryLabel, headline, emphasis, sideTags (array of 2 to 3), bodyCopy.
Dedupe: vary topics across the 10 posts, no repeated pillar.
Write result to: ${resultPath}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.TRIGGER_AUTH_TOKEN || ''}`,
      },
      body: JSON.stringify({ task_id: taskId, brief, priority: 'high', from: 'facebook-daily-cron' }),
    });
    if (!res.ok) throw new Error(`CDR webhook returned ${res.status}`);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (fs.existsSync(resultPath)) {
        const raw = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        fs.unlinkSync(resultPath);
        return raw.posts || raw;
      }
    }
    throw new Error('CDR result timed out');
  } catch (error) {
    return null;
  }
}

function localFallbackPosts() {
  return [
    {
      topic: 'Pricing discipline versus panic discounting',
      hook: 'When bookings soften, most hosts adjust the nightly rate before they examine the listing argument.',
      paragraphs: [
        'That feels rational, but it often treats a positioning problem like a pricing problem.',
        'If the page does not feel clear, confident and worth trusting, a lower price just makes the same weak proposition cheaper.',
        'The better first move is usually to check whether the title, photos and promise are doing enough heavy lifting.'
      ],
      close: 'Rate should support a strong offer, not rescue a vague one.',
      hashtags: ['#AirbnbHost', '#UKHosts', '#PricingStrategy', '#ShortTermRental'],
      categoryLabel: 'PRICING BUILDS MARGIN',
      headline: 'Discounting usually starts after weak positioning trust',
      emphasis: 'trust',
      sideTags: ['MARGIN', 'POSITIONING', 'RATE'],
      bodyCopy: 'A soft calendar does not automatically mean the answer is a cheaper night. Stronger positioning usually protects rate before price cuts do.'
    },
    {
      topic: 'Photo order shapes guest confidence',
      hook: 'A strong cover image gets the click, but the next few photos decide whether trust keeps building.',
      paragraphs: [
        'Guests are not reviewing your gallery like a host. They are scanning for reassurance.',
        'If the image sequence delays clarity on layout, quality or cleanliness, even good photos can underperform.',
        'The best galleries move quickly from attraction into certainty.'
      ],
      close: 'Photo quality matters. Photo order converts.',
      hashtags: ['#AirbnbPhotos', '#UKAirbnb', '#ListingOptimisation', '#STRTips'],
      categoryLabel: 'PHOTO ORDER BUILDS TRUST',
      headline: 'Your best photos still fail without a clear sequence trust',
      emphasis: 'trust',
      sideTags: ['SEQUENCE', 'CLARITY', 'CONFIDENCE'],
      bodyCopy: 'The first few frames should sell the stay and remove uncertainty fast. If the page feels harder to understand with every swipe, conversion leaks.'
    },
    {
      topic: 'Occupancy is not the whole scorecard',
      hook: 'A full calendar can still hide a commercial problem if margin had to do too much work to get there.',
      paragraphs: [
        'There is a difference between filling nights because the offer is strong and filling nights because the price felt too easy to accept.',
        'Both create occupancy. Only one tends to build a healthier business.',
        'That is why busy does not always mean well-positioned.'
      ],
      close: 'The better question is whether your occupancy came from strength or concession.',
      hashtags: ['#RevenueStrategy', '#AirbnbBusiness', '#UKHosts', '#HolidayLets'],
      categoryLabel: 'OCCUPANCY HIDES LEAKAGE',
      headline: 'A full calendar can still weaken your margin positioning',
      emphasis: 'positioning',
      sideTags: ['MARGIN', 'OCCUPANCY', 'POSITIONING'],
      bodyCopy: 'Healthy occupancy matters most when the listing earns it cleanly. If the diary is full for the wrong reasons, the business still leaks.'
    },
    {
      topic: 'Generic titles flatten differentiation',
      hook: 'If your listing title sounds like every other option in the search results, guests assume the stay is interchangeable too.',
      paragraphs: [
        'Many hosts use titles to label the property rather than position it.',
        'That produces safe but forgettable wording that fails to give the right guest a reason to care.',
        'A clearer title sharpens value before the page even loads.'
      ],
      close: 'The goal is not more adjectives. It is a clearer promise.',
      hashtags: ['#AirbnbListing', '#UKHosts', '#STRMarketing', '#HostAdvice'],
      categoryLabel: 'TITLE CLARITY SELLS',
      headline: 'Generic listing titles make good stays feel interchangeable fast',
      emphasis: 'fast',
      sideTags: ['TITLE', 'DISTINCTION', 'SEARCH'],
      bodyCopy: 'Search results are crowded. A sharper title helps the right guest understand what is different before they click.'
    },
    {
      topic: 'Reviews should reinforce the promise',
      hook: 'Great reviews do more than signal quality. They confirm whether your listing promise feels believable.',
      paragraphs: [
        'When guest feedback consistently reflects the same strengths your page claims, conversion gets easier.',
        'When the reviews feel generic or unrelated to the listing message, trust does not compound properly.',
        'The best operators use reviews as evidence, not decoration.'
      ],
      close: 'Reviews work hardest when they validate a clear position.',
      hashtags: ['#AirbnbReviews', '#ShortTermRental', '#UKHosts', '#HostStrategy'],
      categoryLabel: 'REVIEWS CONFIRM PROMISE',
      headline: 'Reviews convert better when they reinforce your core promise proof',
      emphasis: 'proof',
      sideTags: ['PROOF', 'TRUST', 'REPUTATION'],
      bodyCopy: 'Guest feedback should strengthen the story your listing already tells. That alignment is what builds confidence quickly.'
    },
    {
      topic: 'Friction costs more than hosts think',
      hook: 'Small pieces of listing friction rarely look dramatic on their own, but together they quietly suppress conversion.',
      paragraphs: [
        'Confusing room order, vague amenities, awkward copy and weak image hierarchy all add cognitive effort.',
        'Guests rarely announce that friction. They simply leave.',
        'That is why conversion gains often come from simplifying, not adding more.'
      ],
      close: 'The easiest listing to trust usually wins more often.',
      hashtags: ['#Conversion', '#AirbnbTips', '#UKHosts', '#ListingStrategy'],
      categoryLabel: 'FRICTION LOWERS TRUST',
      headline: 'Most conversion drops start with avoidable listing friction first',
      emphasis: 'first',
      sideTags: ['FRICTION', 'CLARITY', 'TRUST'],
      bodyCopy: 'Guests reward pages that feel easy to process. Simplifying the decision path usually improves performance faster than adding more detail.'
    },
    {
      topic: 'Seasonal demand needs narrative adjustment',
      hook: 'As demand patterns shift through the year, the listing should adapt its emphasis rather than repeat the same pitch in every season.',
      paragraphs: [
        'What matters to a spring city-break guest may not match what matters to an autumn family booking.',
        'The strongest listings keep the core positioning, but adjust emphasis around timing, context and guest intent.',
        'Seasonality is not just a pricing conversation.'
      ],
      close: 'Commercially sharp hosts adapt the argument, not just the rate.',
      hashtags: ['#SeasonalStrategy', '#AirbnbUK', '#HostAdvice', '#STRMarket'],
      categoryLabel: 'SEASONAL CONTEXT MATTERS',
      headline: 'Seasonal demand changes what your listing needs to signal now',
      emphasis: 'now',
      sideTags: ['SEASONALITY', 'DEMAND', 'CONTEXT'],
      bodyCopy: 'The message that converts in one season can underperform in another. Good operators adapt emphasis while keeping the brand signal intact.'
    },
    {
      topic: 'Competitor sets are often chosen badly',
      hook: 'Many hosts compare themselves to every nearby listing instead of the smaller group a guest would genuinely weigh them against.',
      paragraphs: [
        'That usually leads to poor pricing decisions and weak self-assessment.',
        'A better competitor set reflects who you are really trying to beat on clarity, trust and perceived value.',
        'Better comparisons lead to better decisions.'
      ],
      close: 'Benchmark the listings that shape the guest decision, not just the map view.',
      hashtags: ['#CompetitorAnalysis', '#AirbnbStrategy', '#UKHosts', '#RevenueManagement'],
      categoryLabel: 'COMPETITOR SETS MATTER',
      headline: 'Bad comparisons usually produce weaker pricing decisions later',
      emphasis: 'later',
      sideTags: ['COMPETITION', 'BENCHMARK', 'RATE'],
      bodyCopy: 'The wrong comp set creates noisy decisions. Stronger operators compare against the listings that truly compete for the same guest.'
    },
    {
      topic: 'Guest experience begins before arrival',
      hook: 'Guest experience is often treated as an operational topic, but the booking decision is already shaping that experience.',
      paragraphs: [
        'If the page feels polished, consistent and easy to trust, the guest arrives with a stronger baseline impression.',
        'If the listing feels vague or over-promised, operational excellence has to work harder later.',
        'Experience starts in the sales layer.'
      ],
      close: 'The pre-arrival impression is part of the stay whether hosts manage it or not.',
      hashtags: ['#GuestExperience', '#AirbnbHost', '#UKHolidayLets', '#BrandTrust'],
      categoryLabel: 'EXPERIENCE STARTS EARLY',
      headline: 'Guest experience starts before check-in with confidence first',
      emphasis: 'first',
      sideTags: ['EXPERIENCE', 'TRUST', 'EXPECTATION'],
      bodyCopy: 'The listing sets the tone before the guest arrives. Strong presentation reduces doubt and improves how the stay is received later.'
    },
    {
      topic: 'Host decisions should follow evidence',
      hook: 'Too many listing changes are driven by anxiety rather than evidence, which creates motion without much improvement.',
      paragraphs: [
        'Small edits feel productive, but they are not always commercially useful.',
        'The stronger habit is to diagnose the real constraint first, then make fewer changes with more intent.',
        'Discipline usually outperforms constant tinkering.'
      ],
      close: 'Better hosting decisions come from cleaner diagnosis.',
      hashtags: ['#HostStrategy', '#AirbnbAdvice', '#DecisionMaking', '#STRGrowth'],
      categoryLabel: 'DIAGNOSIS PRECEDES ACTION',
      headline: 'Better listing decisions start with cleaner diagnosis first',
      emphasis: 'first',
      sideTags: ['DIAGNOSIS', 'DISCIPLINE', 'DECISIONS'],
      bodyCopy: 'Commercially useful changes start with understanding the actual bottleneck. Evidence-led decisions usually outperform reactive edits.'
    }
  ];
}

async function openAiGeneration() {
  const prompt = `Generate exactly 10 unique Facebook posts for STR Clinic as strict JSON.
Return ONLY JSON with shape {"posts":[...] }.
Each post object must include:
- topic
- hook
- paragraphs (array of 3 to 5 short paragraphs)
- close
- hashtags (array of 3 to 5 relevant hashtags)
- categoryLabel (short ALL CAPS label)
- headline (2 to 4 lines worth of copy, keep under 12 words total)
- emphasis (one amber-worthy word or short phrase from the headline)
- sideTags (array of 2 to 3 ALL CAPS single or two-word tags)
- bodyCopy (2 sentences max)
Constraints:
- Audience: UK Airbnb and short-term rental hosts, 1-3 properties, age 30-55
- Niche: Airbnb listing optimisation in the UK
- Tone: Educational, authority-building, Facebook-native but LinkedIn-substance. Direct, host-to-host, UK English. No generic boost your bookings language. No emoji spam. Insight-led, specific, commercially sharp.
- Pillars across the 10 must be unique and should cover listing optimisation, pricing strategy, guest experience, photography tips, seasonal tactics, competitor positioning, review strategy, STR market insights, conversion friction, host decision-making.
- Each post body should be hook line, then 3 to 5 short paragraphs, then a natural close, then hashtags.
- Editorial statement, not ad copy.
- UK English.
- No repeated topics.
- Make the 10 topics genuinely distinct and useful.`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-5.4-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a sharp social strategist for STR Clinic. Output valid JSON only.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  const parsed = JSON.parse(content);
  return parsed.posts;
}

function cleanSingleNounTag(tag) {
  return String(tag || '')
    .toUpperCase()
    .replace(/[^A-Z ]+/g, ' ')
    .trim()
    .split(/\s+/)[0] || null;
}

function enforceHeadlineEndingEmphasis(headline, emphasis) {
  const cleanHeadline = String(headline || '').replace(/\s+/g, ' ').trim();
  const cleanEmphasis = String(emphasis || '').replace(/\s+/g, ' ').trim().split(' ')[0] || '';
  if (!cleanHeadline) return { headline: '', emphasis: cleanEmphasis };
  if (!cleanEmphasis) {
    const lastWord = cleanHeadline.split(' ').pop();
    return { headline: cleanHeadline, emphasis: lastWord };
  }
  const escaped = cleanEmphasis.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const without = cleanHeadline.replace(new RegExp(escaped, 'ig'), '').replace(/\s+/g, ' ').trim().replace(/[,:;.-]+$/,'');
  return { headline: `${without} ${cleanEmphasis}`.trim(), emphasis: cleanEmphasis };
}

function normalisePosts(posts) {
  if (!Array.isArray(posts) || posts.length < 10) throw new Error('Need 10 posts');
  return posts.slice(0, 10).map((post, index) => {
    const enforced = enforceHeadlineEndingEmphasis(post.headline || post.topic || `Post ${index + 1}`, post.emphasis || '');
    const sideTags = (Array.isArray(post.sideTags) ? post.sideTags : [])
      .map(cleanSingleNounTag)
      .filter(Boolean)
      .slice(0, 3);
    while (sideTags.length < 3) sideTags.push(DEFAULT_TAGS[sideTags.length]);
    return {
      index: index + 1,
      topic: post.topic || `Topic ${index + 1}`,
      hook: post.hook || '',
      paragraphs: Array.isArray(post.paragraphs) ? post.paragraphs.slice(0, 5) : [],
      close: post.close || '',
      hashtags: Array.isArray(post.hashtags) ? post.hashtags.slice(0, 5) : [],
      categoryLabel: String(post.categoryLabel || CATEGORY_LABELS[index] || 'STRATEGY').toUpperCase().replace(/[^A-Z0-9 ]+/g, '').trim(),
      headline: enforced.headline,
      emphasis: String(enforced.emphasis || '').split(' ')[0] || '',
      sideTags,
      bodyCopy: ((String(post.bodyCopy || '').match(/^.*[.!?]/s)?.[0] ?? String(post.bodyCopy || ''))
        .split(/(?<=[.!?])\s+/)
        .slice(0, 2)
        .join(' ')
        .trim()),
    };
  });
}

function deckFor(posts, date) {
  const lines = [`# Facebook posts ${date}`, ''];
  for (const post of posts) {
    lines.push(`## Post ${post.index}`);
    lines.push(`Creative: post-${String(post.index).padStart(2, '0')}.png`);
    lines.push(`Topic: ${post.topic}`);
    lines.push('');
    lines.push(post.hook);
    lines.push('');
    for (const p of post.paragraphs) lines.push(p, '');
    lines.push(post.close, '');
    lines.push(post.hashtags.join(' '), '', '---', '');
  }
  return lines.join('\n');
}

function splitHeadline(headline, emphasis) {
  const text = String(headline || '').replace(/\s+/g, ' ').trim();
  const word = String(emphasis || '').trim();
  if (!word) return escapeHtml(text);
  const idx = text.toLowerCase().lastIndexOf(word.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  return `${escapeHtml(text.slice(0, idx))}<em class="accent">${escapeHtml(text.slice(idx, idx + word.length))}</em>${escapeHtml(text.slice(idx + word.length))}`;
}

function fontDataUri(fontPath) {
  return `data:font/ttf;base64,${fs.readFileSync(fontPath).toString('base64')}`;
}

function headlineFontSize(headline = '') {
  const len = String(headline || '').replace(/\s+/g, ' ').trim().length;
  if (len <= 35) return 96;
  if (len <= 50) return 82;
  if (len <= 65) return 68;
  return 58;
}

function graphicHtml({ headline, emphasis, label, bodyCopy, sideTags }) {
  const cleanHeadline = String(headline || '').replace(/\s+/g, ' ').trim();
  const cleanLabel = String(label || '').trim();
  const cleanBodyCopy = String(bodyCopy || '').replace(/\s+/g, ' ').trim();
  const cleanSideTags = (Array.isArray(sideTags) ? sideTags : []).slice(0, 3).map((tag) => escapeHtml(String(tag || '').trim())).join('<br>');
  const headlineSize = headlineFontSize(cleanHeadline);
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><style>
    @font-face{font-family:'Inter';font-style:normal;font-weight:400;font-display:block;src:url(${fontDataUri(FONT_ASSETS.inter400)}) format('truetype')}
    @font-face{font-family:'Inter';font-style:normal;font-weight:600;font-display:block;src:url(${fontDataUri(FONT_ASSETS.inter600)}) format('truetype')}
    @font-face{font-family:'Inter';font-style:normal;font-weight:700;font-display:block;src:url(${fontDataUri(FONT_ASSETS.inter700)}) format('truetype')}
    @font-face{font-family:'Playfair Display';font-style:normal;font-weight:700;font-display:block;src:url(${fontDataUri(FONT_ASSETS.playfair700)}) format('truetype')}
    :root { --navy:#0A1628; --navy2:#132238; --cream:#F5F0E8; --amber:#C9964A; --line-dark:rgba(255,255,255,.14); --muted:rgba(245,240,232,.5); --body:rgba(249,248,246,.82); }
    * { box-sizing:border-box; }
    html, body { margin:0; width:1080px; height:1080px; overflow:hidden; background:#0b1320; font-family:Inter, system-ui, sans-serif; }
    .post { width:1080px; height:1080px; position:relative; overflow:hidden; color:var(--cream); background:radial-gradient(circle at top right, rgba(201,150,74,.10), transparent 30%), radial-gradient(circle at bottom left, rgba(255,255,255,.04), transparent 34%), linear-gradient(180deg, var(--navy), var(--navy2) 100%); }
    .post:after { content:""; position:absolute; inset:0; opacity:.10; mix-blend-mode:soft-light; pointer-events:none; background-image:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="2" stitchTiles="stitch"/></filter><rect width="200" height="200" filter="url(%23n)" opacity="0.12"/></svg>'); }
    .frame { position:absolute; inset:56px; border:1px solid var(--line-dark); }
    .card-inner { position:absolute; inset:56px; display:flex; flex-direction:column; padding:56px; height:calc(100% - 112px); overflow:hidden; }
    .brand { display:flex; flex-direction:column; align-items:flex-start; gap:4px; }
    .wordmark { display:flex; flex-direction:row; align-items:baseline; gap:8px; }
    .str { font-family:'Playfair Display', serif; font-weight:700; font-size:48px; color:#F5F0E8; line-height:1; }
    .clinic { font-family:'Inter', sans-serif; font-weight:600; font-size:13px; color:#C9964A; letter-spacing:.4em; text-transform:uppercase; line-height:1; align-self:center; }
    .subline { font-family:'Inter', sans-serif; font-weight:400; font-size:10px; color:rgba(245,240,232,.5); letter-spacing:.34em; text-transform:uppercase; }
    .eyebrow { margin-top:44px; font-size:12px; letter-spacing:.22em; text-transform:uppercase; font-weight:700; color:var(--amber); }
    .content-row { display:flex; flex-direction:row; flex:1; gap:24px; overflow:hidden; margin-top:54px; }
    .headline-col { flex:1; overflow:hidden; min-width:0; max-width:75%; display:flex; flex-direction:column; }
    .headline { font-family:'Playfair Display', serif; font-weight:700; letter-spacing:-.038em; line-height:.95; font-size:${headlineSize}px; overflow:hidden; word-break:break-word; overflow-wrap:anywhere; padding-right:12px; max-width:100%; }
    .accent { color:var(--amber); font-style:italic; }
    .body { margin-top:auto; width:100%; max-width:732px; font-size:29px; line-height:1.42; color:var(--body); display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3; overflow:hidden; }
    .side-col { width:90px; flex-shrink:0; display:flex; flex-direction:column; justify-content:flex-end; gap:12px; }
    .rule { width:1px; flex:1; align-self:flex-end; background:var(--line-dark); min-height:260px; }
    .aside { font-size:18px; line-height:1.8; letter-spacing:.18em; text-transform:uppercase; color:var(--amber); }
    .meta { margin-top:24px; font-size:12px; letter-spacing:.16em; text-transform:uppercase; color:rgba(249,248,246,.48); }
  </style></head><body><section class="post"><div class="frame"></div><div class="card-inner"><div class="brand"><div class="wordmark"><span class="str">STR</span><span class="clinic">CLINIC</span></div><div class="subline">LISTING INTELLIGENCE</div></div><div class="eyebrow">${escapeHtml(cleanLabel)}</div><div class="content-row"><div class="headline-col"><div class="headline">${splitHeadline(cleanHeadline, emphasis)}</div><div class="body">${escapeHtml(cleanBodyCopy)}</div></div><div class="side-col"><div class="rule"></div><div class="aside">${cleanSideTags}</div></div></div><div class="meta">STR Clinic</div></div></section></body></html>`;
}

async function renderGraphics(posts, outDir) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 3 });
  try {
    for (const post of posts) {
      const page = await context.newPage();
      await page.setContent(graphicHtml(post), { waitUntil: 'networkidle' });
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      await page.waitForTimeout(1000);
      await page.screenshot({
        path: path.join(outDir, `post-${String(post.index).padStart(2, '0')}.png`),
        clip: { x: 0, y: 0, width: 1080, height: 1080 },
        type: 'png'
      });
      await page.close();
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

async function gogJson(args) {
  const { stdout } = await execFileAsync('gog', ['-j', '--results-only', ...args], { maxBuffer: 20 * 1024 * 1024 });
  return stdout ? JSON.parse(stdout) : null;
}

async function ensureDriveFolder(name, parentId) {
  const query = [`name = '${String(name).replace(/'/g, "\\'")}'`, "mimeType = 'application/vnd.google-apps.folder'", 'trashed = false', `'${parentId}' in parents`].join(' and ');
  const existing = await gogJson(['drive', 'ls', '--parent', parentId, '--query', query, '--max', '5']);
  if (Array.isArray(existing) && existing[0]) return existing[0];
  return gogJson(['drive', 'mkdir', name, '--parent', parentId]);
}

async function uploadFile(localPath, parentId, name) {
  return gogJson(['drive', 'upload', localPath, '--parent', parentId, '--name', name]);
}

async function shareAnyoneReader(fileId) {
  try { await gogJson(['drive', 'share', fileId, '--to', 'anyone', '--role', 'reader']); } catch (_) {}
}

async function uploadPack(packDir, date) {
  const rootId = process.env.SOCIAL_DRIVE_FOLDER_ID || process.env.REPORTS_DRIVE_FOLDER_ID || process.env.DRIVE_FOLDER_ID;
  if (!rootId) throw new Error('No drive folder id configured');
  const folder = await ensureDriveFolder(`STR Clinic Facebook — ${date}`, rootId);
  // Delete any stale files in the folder before uploading fresh batch
  try {
    const existingFiles = await gogJson(['drive', 'ls', '--parent', folder.id, '--max', '100']);
    for (const f of (Array.isArray(existingFiles) ? existingFiles : [])) {
      if (f.id && f.mimeType !== 'application/vnd.google-apps.folder') {
        await gogJson(['drive', 'rm', f.id]).catch(() => {});
      }
    }
  } catch (_) {}
  for (const name of fs.readdirSync(packDir).sort()) {
    const full = path.join(packDir, name);
    if (fs.statSync(full).isFile()) await uploadFile(full, folder.id, name);
  }
  await shareAnyoneReader(folder.id);
  return `https://drive.google.com/drive/folders/${folder.id}`;
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.PETER_TELEGRAM_TOKEN;
  const chatId = process.env.BRANDON_CHAT_ID || '5821364140';
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram failed: ${data.description}`);
  return data;
}

async function run({ manual = false } = {}) {
  const { isoDate } = londonDateParts(new Date());
  const packDir = path.join(OUTPUT_ROOT, isoDate);
  ensureDir(packDir);

  let posts = await tryCdrGeneration();
  let source = 'cdr';
  if (!Array.isArray(posts) || posts.length < 10) {
    try {
      posts = await openAiGeneration();
      source = 'openai-fallback';
    } catch (_) {
      posts = null;
    }
  }
  if (!Array.isArray(posts) || posts.length < 10) {
    posts = localFallbackPosts();
    source = 'local-fallback';
  }
  posts = normalisePosts(posts);
  if (process.env.FACEBOOK_DAILY_LIMIT) posts = posts.slice(0, Number(process.env.FACEBOOK_DAILY_LIMIT) || 1);

  const deckName = `facebook-posts-${isoDate}.md`;
  fs.writeFileSync(path.join(packDir, deckName), deckFor(posts, isoDate));
  fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify({ date: isoDate, source, count: posts.length, posts }, null, 2));
  await renderGraphics(posts, packDir);

  const driveUrl = await uploadPack(packDir, isoDate);
  const topicLines = posts.map((post) => `• ${post.topic}`);
  const telegramMessage = `📅 Facebook content ready — ${isoDate}\n\n10 posts + creatives uploaded to Drive:\n${driveUrl}\n\nTopics covered:\n${topicLines.join('\n')}\n\nReady to review and schedule.`;
  const telegram = await sendTelegram(telegramMessage);

  return { date: isoDate, packDir, driveUrl, telegramOk: telegram.ok, source, posts };
}

if (require.main === module) {
  run({ manual: process.argv.includes('--run-now') })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.stack || error.message); process.exit(1); });
}

module.exports = { run, graphicHtml, normalisePosts, localFallbackPosts, renderGraphics };
