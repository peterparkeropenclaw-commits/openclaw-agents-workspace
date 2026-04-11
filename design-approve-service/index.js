'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3401;
const BASE_DIR = "/Users/robotmac/Desktop/optilyst-designs";
const GEN_DIR = path.join(BASE_DIR, "generated");
const APPROVED_DIR = path.join(BASE_DIR, "approved");

[GEN_DIR, APPROVED_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

function latestGeneratedBase() {
  const files = fs.readdirSync(GEN_DIR)
    .filter(f => /^design-\d+(-v\d+)?\.png$/i.test(f))
    .sort()
    .reverse();
  if (!files.length) return null;
  return files[0].replace(/\.png$/i, '');
}

function approveDesign(filename) {
  const clean = String(filename || '').trim();
  const base = clean
    ? clean.replace(/\.png$/i, '').replace(/\.json$/i, '')
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

  let meta = {
    id: base,
    status: 'approved',
    approvedAt: new Date().toISOString(),
    approvedPath: dstPng
  };

  if (fs.existsSync(srcJson)) {
    try {
      meta = JSON.parse(fs.readFileSync(srcJson, 'utf8'));
    } catch (_) {}
  }

  meta.status = 'approved';
  meta.approvedAt = new Date().toISOString();
  meta.approvedPath = dstPng;

  fs.writeFileSync(dstJson, JSON.stringify(meta, null, 2));

  return {
    ok: true,
    designId: base,
    approvedImage: dstPng,
    approvedMeta: dstJson
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'design-approve-service', port: PORT }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/approve') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const result = approveDesign(parsed.filename || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[design-approve] running on port ${PORT}`);
});
