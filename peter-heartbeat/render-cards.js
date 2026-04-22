'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('/Users/robotmac/workspace/str-clinic-pdf-generator/node_modules/puppeteer');
const { normalisePosts, localFallbackPosts } = require('/Users/robotmac/workspace/peter-heartbeat/facebook-daily-cron.js');

const FONT_DIR = '/Users/robotmac/workspace/peter-heartbeat/assets/fonts';
const OUT_DIR = '/tmp/cards-output';
const DATE = '2026-04-22';
const SRC_MANIFEST = `/Users/robotmac/workspace/peter-heartbeat/output/facebook-daily-cron/${DATE}/manifest.json`;
const SRC_MD = `/Users/robotmac/workspace/peter-heartbeat/output/facebook-daily-cron/${DATE}/facebook-posts-${DATE}.md`;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function escapeHtml(s) { return String(s || '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])); }
function fontDataUri(name) { return `data:font/ttf;base64,${fs.readFileSync(path.join(FONT_DIR, name)).toString('base64')}`; }
function cleanSentenceBoundary(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^.*?[.!?](?=\s|$)/gs);
  if (!m || !m.length) return t;
  return m.join(' ').trim();
}
function bodyFromPost(post) {
  if (post.bodyCopy) {
    const bounded = cleanSentenceBoundary(post.bodyCopy);
    const split = bounded.split(/(?<=[.!?])\s+/).slice(0, 3).join(' ').trim();
    return split || bounded;
  }
  const pieces = [];
  if (post.hook) pieces.push(post.hook.trim());
  for (const p of (post.paragraphs || [])) {
    pieces.push(String(p).trim());
    if (pieces.length >= 3) break;
  }
  return cleanSentenceBoundary(pieces.join(' '));
}
function inferLabel(topic, i) {
  const map = [
    'AMENITY PROOF', 'PHOTO SEQUENCE', 'SHOULDER SEASON', 'TITLE CLARITY', 'REVIEW PROOF',
    'CONVERSION FRICTION', 'SEASONAL SIGNALS', 'COMPETITOR SETS', 'GUEST EXPERIENCE', 'HOST DECISIONS'
  ];
  return map[i] || String(topic || 'STRATEGY').toUpperCase();
}
function inferSideTags(topic, emphasis, i) {
  const presets = [
    ['VALUE','PROOF','CLARITY'], ['PHOTOS','ORDER','TRUST'], ['DEMAND','SIGNAL','STRENGTH'],
    ['TITLE','SEARCH','DISTINCTION'], ['REVIEWS','PROOF','TRUST'], ['FRICTION','CLARITY','TRUST'],
    ['SEASONAL','DEMAND','CONTEXT'], ['COMPS','BENCHMARK','RATE'], ['GUEST','TRUST','EXPECTATION'], ['EVIDENCE','FOCUS','DECISIONS']
  ];
  return presets[i] || [String(emphasis || 'VALUE').toUpperCase(), 'STR', 'CLINIC'];
}
function headlineFontSize(headline = '') {
  const len = String(headline || '').replace(/\s+/g, ' ').trim().length;
  if (len > 60) return 76;
  if (len > 45) return 88;
  return 100;
}
function splitHeadline(headline, emphasis) {
  const text = String(headline || '').trim();
  const word = String(emphasis || '').trim().split(/\s+/).pop() || text.split(/\s+/).pop() || '';
  if (!word) return escapeHtml(text);
  const idx = text.toLowerCase().lastIndexOf(word.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  return `${escapeHtml(text.slice(0, idx))}<em class="accent">${escapeHtml(text.slice(idx, idx + word.length))}</em>${escapeHtml(text.slice(idx + word.length))}`;
}
function htmlFor(post) {
  const headline = String(post.headline || '').replace(/\s+/g, ' ').trim();
  const emphasis = String(post.emphasis || '').trim().split(/\s+/).pop() || headline.split(/\s+/).pop() || '';
  const label = String(post.label || post.categoryLabel || '').toUpperCase();
  const sideTags = (post.sideTags || []).slice(0, 3).map((t) => String(t).toUpperCase().split(/\s+/).pop());
  const bodyCopy = bodyFromPost(post);
  const headlineSize = headlineFontSize(headline);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
  @font-face{font-family:'Inter';font-style:normal;font-weight:400;font-display:block;src:url(${fontDataUri('Inter-400.ttf')}) format('truetype')}
  @font-face{font-family:'Inter';font-style:normal;font-weight:600;font-display:block;src:url(${fontDataUri('Inter-600.ttf')}) format('truetype')}
  @font-face{font-family:'Inter';font-style:normal;font-weight:700;font-display:block;src:url(${fontDataUri('Inter-700.ttf')}) format('truetype')}
  @font-face{font-family:'Playfair Display';font-style:normal;font-weight:700;font-display:block;src:url(${fontDataUri('PlayfairDisplay-700.ttf')}) format('truetype')}
  :root{--navy:#0A1628;--navy2:#132238;--cream:#F9F8F6;--amber:#C4832E;--line:rgba(255,255,255,.14);--muted:rgba(249,248,246,.62);--body:rgba(249,248,246,.80)}
  *{box-sizing:border-box} html,body{margin:0;padding:0;width:1080px;height:1080px;overflow:hidden} body{background:#0b1320}
  .post{width:1080px;height:1080px;position:relative;overflow:hidden;color:var(--cream);font-family:Inter,system-ui,sans-serif;background:radial-gradient(circle at top right, rgba(196,131,46,.10), transparent 30%),radial-gradient(circle at bottom left, rgba(255,255,255,.04), transparent 34%),linear-gradient(180deg, var(--navy), var(--navy2) 100%)}
  .post:after{content:"";position:absolute;inset:0;opacity:.10;mix-blend-mode:soft-light;pointer-events:none;background-image:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="2" stitchTiles="stitch"/></filter><rect width="200" height="200" filter="url(%23n)" opacity="0.12"/></svg>')}
  .frame{position:absolute;inset:56px;border:1px solid rgba(255,255,255,0.14)}
  .brand{position:absolute;left:78px;top:72px;z-index:2}.wordmark{display:flex;align-items:flex-end;gap:12px;line-height:.92}.str{font-family:'Playfair Display',serif;font-size:54px;font-weight:700}.clinic{font-size:14px;letter-spacing:.4em;text-transform:uppercase;color:var(--amber);font-weight:600;padding-bottom:8px}.sub{margin-top:7px;font-size:10px;letter-spacing:.34em;text-transform:uppercase;color:rgba(249,248,246,.62)}
  .eyebrow{position:absolute;left:78px;top:180px;z-index:2;font-size:12px;letter-spacing:.22em;text-transform:uppercase;font-weight:700;color:var(--amber)}
  .headline{position:absolute;left:78px;top:270px;right:300px;z-index:2;font-family:'Playfair Display',serif;font-weight:700;letter-spacing:-.038em;line-height:.95;font-size:${headlineSize}px}
  .headline .accent,.accent{color:var(--amber);font-style:italic}
  .rule{position:absolute;right:236px;top:248px;width:1px;height:574px;z-index:2;background:rgba(249,248,246,.14)}
  .aside{position:absolute;right:92px;top:660px;z-index:2;width:138px;font-size:18px;line-height:1.8;letter-spacing:.2em;text-transform:uppercase;color:var(--amber);font-weight:700}
  .body{position:absolute;left:78px;top:736px;width:732px;z-index:2;font-size:27px;line-height:1.45;color:rgba(249,248,246,.80);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  .meta{position:absolute;left:78px;bottom:82px;z-index:2;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:rgba(249,248,246,.48)}
  </style></head><body><section class="post"><div class="frame"></div><div class="brand"><div class="wordmark"><div class="str">STR</div><div class="clinic">CLINIC</div></div><div class="sub">LISTING INTELLIGENCE</div></div><div class="eyebrow">${escapeHtml(label)}</div><div class="headline">${splitHeadline(headline, emphasis)}</div><div class="rule"></div><div class="aside">${sideTags.map(escapeHtml).join('<br>')}</div><div class="body">${escapeHtml(bodyCopy)}</div><div class="meta">STR CLINIC</div></section></body></html>`;
}
function loadPosts() {
  if (fs.existsSync(SRC_MANIFEST)) {
    const manifest = JSON.parse(fs.readFileSync(SRC_MANIFEST, 'utf8'));
    if (Array.isArray(manifest.posts) && manifest.posts.length >= 10) return normalisePosts(manifest.posts);
  }
  if (fs.existsSync(SRC_MD)) {
    throw new Error(`Found markdown deck but parser path not implemented: ${SRC_MD}`);
  }
  return normalisePosts(localFallbackPosts()).map((p, i) => ({
    ...p,
    label: inferLabel(p.topic, i),
    emphasis: String(p.emphasis || '').split(/\s+/).pop(),
    bodyCopy: bodyFromPost(p),
    sideTags: inferSideTags(p.topic, p.emphasis, i)
  }));
}
function buildCopyDoc(posts) {
  const pretty = '22 April 2026';
  const lines = [`# STR Clinic — Facebook Posts — ${pretty}`, '', '---', ''];
  for (const post of posts) {
    lines.push(`## Post ${post.index} — ${post.label}`);
    lines.push(`**Creative file:** post-${String(post.index).padStart(2, '0')}.png`, '');
    lines.push(post.bodyCopy, '');
    lines.push((post.hashtags || []).join(' '), '', '---', '');
  }
  return lines.join('\n');
}
async function render(posts, limit) {
  ensureDir(OUT_DIR);
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    for (const post of posts.slice(0, limit || posts.length)) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 3 });
      await page.setContent(htmlFor(post), { waitUntil: 'networkidle0' });
      await page.evaluate(() => document.fonts.ready);
      await new Promise((r) => setTimeout(r, 1000));
      const outputPath = path.join(OUT_DIR, `post-${String(post.index).padStart(2, '0')}.png`);
      await page.screenshot({ path: outputPath, clip: { x: 0, y: 0, width: 1080, height: 1080 }, type: 'png' });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
async function main() {
  const posts = loadPosts();
  const oneOnly = process.argv.includes('--one');
  await render(posts, oneOnly ? 1 : posts.length);
  fs.writeFileSync(path.join(OUT_DIR, 'STR-Clinic-Posts-2026-04-22.md'), buildCopyDoc(posts));
  console.log(JSON.stringify({ ok: true, count: oneOnly ? 1 : posts.length, outDir: OUT_DIR }, null, 2));
}
main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
