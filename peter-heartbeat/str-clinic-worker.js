'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { createStrClinicOrchestrator } = require('./str-clinic-orchestrator');

const MISSION_CONTROL_BOT_TOKEN = process.env.MISSION_CONTROL_BOT_TOKEN;
const MISSION_CONTROL_CHAT_ID = process.env.MISSION_CONTROL_CHAT_ID || '-5085897499';
const STR_CLINIC_BOT_TOKEN = process.env.STR_CLINIC_BOT_TOKEN;

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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

    console.warn('[telegram] HTML send failed, retrying as plain text:', data.description);
    const plain = stripHtml(message);
    const res2 = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: plain }),
    });
    const data2 = await res2.json();
    if (!data2.ok) console.error('[telegram] plain text send also failed:', data2.description);
    return data2.ok;
  } catch (err) {
    console.error('[telegram] error:', err.message);
    return false;
  }
}

const strClinicOrchestrator = createStrClinicOrchestrator({
  botToken: STR_CLINIC_BOT_TOKEN,
  cdrAuthToken: process.env.TRIGGER_AUTH_TOKEN || process.env.CDR_AUTH_TOKEN || '',
  cdrWebhookUrl: 'http://localhost:3104/task',
  freeAuditScript: path.join(process.env.HOME, 'workspace/str-clinic-free-audit-generator/generate-free-audit.js'),
  paidAuditScript: path.join(process.env.HOME, 'workspace/str-clinic-pdf-generator/generate-report.js'),
  googleCreds: path.join(process.env.HOME, 'workspace/full-take-outreach/credentials.json'),
  freeDriveFolder: '1nMysoqPplQT1S1C4f_Gjj75u_PSVEgpr',
  paidDriveFolder: '12RlJRy_U9lD0mPfH4WVcEYrwdXcSpWar',
  sendTelegram,
  escapeHtml,
});

async function runStrClinicWorker() {
  try {
    await strClinicOrchestrator.pollUpdates();
  } catch (err) {
    console.error('[strclinic-listener] poll error:', err.message);
  }
}

if (!MISSION_CONTROL_BOT_TOKEN) {
  console.error('[strclinic-listener] FATAL: MISSION_CONTROL_BOT_TOKEN not set');
}
if (!STR_CLINIC_BOT_TOKEN) {
  console.warn('[strclinic-listener] WARNING: STR_CLINIC_BOT_TOKEN not set, worker will idle');
}

runStrClinicWorker();
setInterval(runStrClinicWorker, 10 * 1000);

console.log(`[strclinic-listener] Started. Polling every 10s: ${STR_CLINIC_BOT_TOKEN ? 'active' : 'DISABLED (set STR_CLINIC_BOT_TOKEN)'}.`);
