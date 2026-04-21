'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { uploadExistingFacebookPack } = require('./social-post-pipeline');

const MISSION_CONTROL_BOT_TOKEN = process.env.MISSION_CONTROL_BOT_TOKEN;
const MISSION_CONTROL_CHAT_ID = process.env.MISSION_CONTROL_CHAT_ID || '-5085897499';

function stripHtml(text) {
  return String(text || '').replace(/<[^>]+>/g, '');
}

async function sendTelegram(message, { token = MISSION_CONTROL_BOT_TOKEN, chatId = MISSION_CONTROL_CHAT_ID } = {}) {
  if (!token) {
    console.error('[telegram] MISSION_CONTROL_BOT_TOKEN not set');
    return false;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(message || ''), parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (data.ok) return true;

    const res2 = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: stripHtml(message) }),
    });
    const data2 = await res2.json();
    return data2.ok;
  } catch (error) {
    console.error('[telegram] error:', error.message);
    return false;
  }
}

const dateKey = process.argv[2];

uploadExistingFacebookPack({ dateKey, sendTelegram, logger: console })
  .then(({ pack }) => {
    console.log(JSON.stringify({ status: 'ok', dateKey: pack.dateKey, driveFolderUrl: pack.drive.folderUrl, packDir: pack.packDir }, null, 2));
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
