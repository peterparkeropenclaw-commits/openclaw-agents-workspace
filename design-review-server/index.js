'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3400;
const BASE_DIR = "/Users/robotmac/Desktop/optilyst-designs";
const REF_DIR = path.join(BASE_DIR, "references");
const GEN_DIR = path.join(BASE_DIR, "generated");
const APPROVED_DIR = path.join(BASE_DIR, "approved");
const APPROVE_TOKEN = process.env.DESIGN_REVIEW_APPROVE_TOKEN || "change-me-now";

[BASE_DIR, REF_DIR, GEN_DIR, APPROVED_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj, null, 2));
}

function listImages(dir) {
  return fs.readdirSync(dir)
    .filter(name => /\.(png|jpg|jpeg|webp)$/i.test(name))
    .sort()
    .reverse();
}

function htmlList(title, folder, files, canApprove = false) {
  const items = files.map(name => {
    const enc = encodeURIComponent(name);
    const approve = canApprove
      ? `<div><a href="/approve/${enc}?token=${encodeURIComponent(APPROVE_TOKEN)}">Approve</a></div>`
      : '';
    return `
      <div style="border:1px solid #ddd;border-radius:12px;padding:12px;margin:12px 0;background:#fff;">
        <div style="font-weight:600;margin-bottom:8px;">${name}</div>
        <div style="margin:8px 0;">
          <img src="/files/${folder}/${enc}" style="max-width:320px;max-height:320px;border:1px solid #ddd;border-radius:8px;" />
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          <a href="/files/${folder}/${enc}" target="_blank">Open</a>
          <a href="/files/${folder}/${enc}" download>Download</a>
          <a href="/meta/${folder}/${enc}">Metadata</a>
        </div>
        ${approve}
      </div>
    `;
  }).join('\n') || '<div style="color:#777;">No files yet.</div>';

  return `<h2>${title}</h2>${items}`;
}

function renderHome() {
  const refs = listImages(REF_DIR);
  const gen = listImages(GEN_DIR);
  const approved = listImages(APPROVED_DIR);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Optilyst Design Review</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="font-family:Arial,sans-serif;max-width:1100px;margin:0 auto;padding:24px;background:#f6f7fb;">
  <h1>Optilyst Design Review</h1>
  <div style="margin-bottom:16px;">
    <a href="/api/health">Health JSON</a> |
    <a href="/api/list">List JSON</a> |
    <a href="/approve-latest?token=${encodeURIComponent(APPROVE_TOKEN)}">Approve Latest Design</a>
  </div>
  ${htmlList('Approved', 'approved', approved, false)}
  ${htmlList('Generated', 'generated', gen, true)}
  ${htmlList('References', 'references', refs, false)}
</body>
</html>`;
}

function latestGeneratedBase() {
  const files = listImages(GEN_DIR);
  if (!files.length) return null;
  return files[0].replace(/\.(png|jpg|jpeg|webp)$/i, '');
}

function approveDesign(filename) {
  const base = filename
    ? String(filename).replace(/\.(png|jpg|jpeg|webp|json)$/i, '')
    : latestGeneratedBase();

  if (!base) throw new Error('no generated design found');

  const srcPng = path.join(GEN_DIR, `${base}.png`);
  const srcJson = path.join(GEN_DIR, `${base}.json`);
  const dstPng = path.join(APPROVED_DIR, `${base}.png`);
  const dstJson = path.join(APPROVED_DIR, `${base}.json`);

  if (!fs.existsSync(srcPng)) {
    throw new Error(`generated file not found: ${base}.png`);
  }

  fs.copyFileSync(srcPng, dstPng);

  let meta = { id: base, status: 'approved', approvedPath: dstPng, approvedAt: new Date().toISOString() };
  if (fs.existsSync(srcJson)) {
    try { meta = JSON.parse(fs.readFileSync(srcJson, 'utf8')); } catch (_) {}
  }
  meta.status = 'approved';
  meta.approvedPath = dstPng;
  meta.approvedAt = new Date().toISOString();
  fs.writeFileSync(dstJson, JSON.stringify(meta, null, 2));
}

function resolveFolder(folder) {
  if (folder === 'references') return REF_DIR;
  if (folder === 'generated') return GEN_DIR;
  if (folder === 'approved') return APPROVED_DIR;
  return null;
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');

  const ext = path.extname(filePath).toLowerCase();
  const type =
    ext === '.png' ? 'image/png' :
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
    ext === '.webp' ? 'image/webp' :
    ext === '.json' ? 'application/json; charset=utf-8' :
    'application/octet-stream';

  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, 'text/html; charset=utf-8', renderHome());
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'design-review-server', port: PORT, baseDir: BASE_DIR });
  }

  if (req.method === 'GET' && url.pathname === '/api/list') {
    return sendJson(res, 200, {
      ok: true,
      references: listImages(REF_DIR),
      generated: listImages(GEN_DIR),
      approved: listImages(APPROVED_DIR)
    });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
    const parts = url.pathname.split('/').filter(Boolean);
    const folder = parts[1];
    const name = decodeURIComponent(parts.slice(2).join('/'));
    const dir = resolveFolder(folder);
    if (!dir) return sendJson(res, 404, { error: 'unknown folder' });
    return serveFile(res, path.join(dir, name));
  }

  if (req.method === 'GET' && url.pathname.startsWith('/meta/')) {
    const parts = url.pathname.split('/').filter(Boolean);
    const folder = parts[1];
    const raw = decodeURIComponent(parts.slice(2).join('/'));
    const dir = resolveFolder(folder);
    if (!dir) return sendJson(res, 404, { error: 'unknown folder' });
    const base = raw.replace(/\.(png|jpg|jpeg|webp)$/i, '');
    return serveFile(res, path.join(dir, `${base}.json`));
  }

  if (req.method === 'GET' && url.pathname.startsWith('/approve/')) {
    const token = url.searchParams.get('token') || '';
    if (token !== APPROVE_TOKEN) return sendJson(res, 403, { error: 'invalid token' });

    const name = decodeURIComponent(url.pathname.replace('/approve/', ''));
    try {
      approveDesign(name);
      res.writeHead(302, { Location: '/' });
      res.end();
    } catch (e) {
      sendJson(res, 500, { error: e.message || String(e) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/approve-latest') {
    const token = url.searchParams.get('token') || '';
    if (token !== APPROVE_TOKEN) return sendJson(res, 403, { error: 'invalid token' });

    try {
      approveDesign('');
      res.writeHead(302, { Location: '/' });
      res.end();
    } catch (e) {
      sendJson(res, 500, { error: e.message || String(e) });
    }
    return;
  }

  send(res, 404, 'text/plain; charset=utf-8', `Not found: ${url.pathname}`);
});

server.listen(PORT, () => {
  console.log('[design-review] full server running on port 3400');
});
