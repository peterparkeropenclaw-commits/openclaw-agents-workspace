'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { spawn } = require('child_process');
const fs = require('fs');

const TOKEN = process.env.STR_CLINIC_BOT_TOKEN;
const CHAT_ID = String(process.env.BRANDON_CHAT_ID);
const REPORT_SCRIPT = path.join(process.env.HOME, 'workspace/str-clinic-pdf-generator/generate-report.js');
const LIVE_JSON = path.join(process.env.HOME, 'workspace/str-clinic-pdf-generator/live-report.json');

let lastUpdateId = 0;
let processing = false;

async function sendTelegram(message, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, text: message }),
      });
      const data = await res.json();
      if (data.ok) return;
      console.error('[telegram] failed:', data.description);
    } catch (err) {
      console.error(`[telegram] attempt ${i + 1} error:`, err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

function runGenerator(jsonPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [REPORT_SCRIPT, '--input', jsonPath], {
      cwd: path.dirname(REPORT_SCRIPT),
      env: { ...process.env },
      shell: false,
    });
    let output = '';
    proc.stdout.on('data', d => { output += d; process.stdout.write(d); });
    proc.stderr.on('data', d => { output += d; process.stderr.write(d); });
    proc.on('close', code => {
      if (code === 0) resolve(output);
      else reject(new Error(`Generator failed — check /tmp/listener.log`));
    });
  });
}

// Watch for live-report.json written by CDR-FORMATTER
let lastMtime = null;
async function watchLiveJson() {
  try {
    if (!fs.existsSync(LIVE_JSON)) return;
    const stat = fs.statSync(LIVE_JSON);
    if (lastMtime && stat.mtimeMs === lastMtime) return;
    lastMtime = stat.mtimeMs;

    if (processing) return;
    processing = true;

    console.log('[listener] live-report.json detected — running generator');
    fs.unlinkSync(LIVE_JSON); // delete immediately to prevent re-trigger
    await sendTelegram('CDR pipeline complete — generating PDF now...');

    try {
      const output = await runGenerator(LIVE_JSON);
      const driveMatch = output.match(/https:\/\/drive\.google\.com\/[^\s]+/);
      const fileMatch = output.match(/PDF saved: ([^\n]+)/);
      const driveLink = driveMatch ? driveMatch[0] : null;
      const fileName = fileMatch ? path.basename(fileMatch[1].trim()) : 'unknown';

      if (driveLink) {
        await sendTelegram(`STR Clinic report ready\nFile: ${fileName}\nDrive: ${driveLink}`);
      } else {
        await sendTelegram(`PDF generated but Drive upload failed\nFile: ${fileName}`);
      }
    } catch (err) {
      console.error('[pipeline] error:', err.message);
      await sendTelegram(`PDF generation failed: ${err.message.slice(0, 200)}`);
    } finally {
      processing = false;
    }
  } catch (err) {
    console.error('[watcher] error:', err.message);
  }
}

// Also watch for direct Telegram triggers for acknowledgement
async function poll() {
  if (processing) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=3`
    );
    const data = await res.json();
    if (!data.ok || !data.result.length) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || String(msg.chat.id) !== CHAT_ID) continue;

      const text = (msg.text || '').trim();
      const isPaidAudit = /paid audit/i.test(text);
      const urlMatch = text.match(/https:\/\/www\.airbnb\.[^\s]+\/rooms\/[^\s]+/i);

      if (!isPaidAudit || !urlMatch) continue;

      await sendTelegram(`Paid Audit received — Peter is running the full CDR pipeline for:\n${urlMatch[0]}`);
    }
  } catch (err) {
    console.error('[listener] poll error:', err.message);
  }
}

console.log('[listener] STR Clinic listener started — watching for CDR output and Telegram triggers.');
setInterval(poll, 3000);
setInterval(watchLiveJson, 5000);
poll();
