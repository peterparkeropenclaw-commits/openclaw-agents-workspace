'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3305;

// Load from env — set OPENAI_API_KEY in your shell environment or a .env file.
// The key that was previously hardcoded here has been rotated and removed.
try { require('dotenv').config({ override: false }); } catch {}
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY env var not set. Set it in your environment or a .env file.');
  process.exit(1);
}

async function generateImage(prompt) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size: '1024x1024'
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error?.message || 'Image generation failed');
  }

  const image = data.data[0];

  // If URL exists → return directly
  if (image.url) {
    return image.url;
  }

  // If base64 → save to file
  if (image.b64_json) {
    const buffer = Buffer.from(image.b64_json, 'base64');

    const filename = `image-${Date.now()}.png`;
    const dir = path.join(__dirname, 'images');
    const filePath = path.join(dir, filename);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, buffer);

    return `http://localhost:${PORT}/images/${filename}`;
  }

  throw new Error('No image returned');
}

const server = http.createServer((req, res) => {

  // 🔥 Serve saved images
  if (req.method === 'GET' && req.url.startsWith('/images/')) {
    const filePath = path.join(__dirname, req.url);

    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // 🔥 Generate image
  if (req.method === 'POST' && req.url === '/generate') {
    let body = '';

    req.on('data', chunk => body += chunk);

    req.on('end', async () => {
      try {
        const { prompt } = JSON.parse(body);

        if (!prompt) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'prompt required' }));
        }

        const imageUrl = await generateImage(prompt);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, image: imageUrl }));

      } catch (err) {
        console.error('[image-gen] Error:', err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[image-gen] running on port ${PORT}`);
});
