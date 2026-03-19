const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });
const { Client, GatewayIntentBits } = require('discord.js');
const http = require('http');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const CHANNEL_ID = process.env.CHANNEL_ID;
const BRANDON_USERNAME = process.env.BRANDON_USERNAME;
const BOT_TOKEN = process.env.BOT_TOKEN;
const PETER_ALLOWED_CHANNEL = '1482399843627438131';
const GATEWAY_HOST = process.env.OPENCLAW_GATEWAY_HOST || '127.0.0.1';
const GATEWAY_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT || 18789);
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;

function isAllowedChannel(channelId) {
  if (channelId !== PETER_ALLOWED_CHANNEL) {
    console.log(`[Peter] Silently dropping message to unauthorised channel: ${channelId}`);
    return false;
  }
  return true;
}

function askPeter(userMessage, callback) {
  // Use OpenClaw Gateway sessions_send directly — avoids CLI hanging issue
  const body = JSON.stringify({
    sessionKey: 'agent:main:discord:channel:1482399843627438131',
    message: userMessage,
    timeoutSeconds: 120,
  });

  const options = {
    hostname: GATEWAY_HOST,
    port: GATEWAY_PORT,
    path: '/sessions/send',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...(GATEWAY_TOKEN ? { 'Authorization': `Bearer ${GATEWAY_TOKEN}` } : {}),
    },
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        // Gateway returns { reply: "..." } or { message: "..." }
        const reply = parsed.reply || parsed.message || parsed.text || data;
        callback(reply, null);
      } catch (e) {
        callback(data || null, null);
      }
    });
  });

  req.on('error', (err) => callback(null, err.message));
  req.setTimeout(130000, () => { req.destroy(); callback(null, 'Request timed out'); });
  req.write(body);
  req.end();
}

function splitMessage(text, maxLen = 1900) {
  const chunks = [];
  let t = String(text || '');
  while (t.length > maxLen) {
    let split = t.lastIndexOf('\n', maxLen);
    if (split === -1) split = maxLen;
    chunks.push(t.slice(0, split));
    t = t.slice(split).trimStart();
  }
  chunks.push(t);
  return chunks.filter(Boolean);
}

async function sendDiscordChunks(channel, text) {
  const chunks = splitMessage(text, 1900);
  for (const chunk of chunks) await channel.send(chunk);
}

async function sendToChannel(message) {
  if (!isAllowedChannel(CHANNEL_ID)) return;

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await sendDiscordChunks(channel, message);
  } catch (err) {
    console.error('sendToChannel error:', err.message);
  }
}

client.once('clientReady', async () => {
  console.log('Peter bot online as ' + client.user.tag);
  console.log('Listening in #peter channel: ' + CHANNEL_ID);
  console.log('Model dispatch: OpenClaw Gateway /tools/invoke -> sessions_send');
  await sendToChannel('Peter online — ready for strategic discussion 🧠');
});

client.on('messageCreate', async (message) => {
  if (message.channelId !== PETER_ALLOWED_CHANNEL) return;
  if (!isAllowedChannel(message.channelId)) return;
  if (message.channelId !== CHANNEL_ID) return;
  if (message.author.bot) return;
  if (message.author.username !== BRANDON_USERNAME) return;

  const userMsg = message.content.trim();
  if (!userMsg) return;

  console.log(`[${message.author.username}] ${userMsg}`);

  await message.channel.sendTyping();

  askPeter(`[Discord #peter] ${message.author.username}: ${userMsg}`, async (reply, err) => {
    if (!isAllowedChannel(message.channelId)) return;

    if (err || !reply) {
      if (isAllowedChannel(message.channelId)) { await message.channel.send('❌ Peter error: ' + (err || 'empty response')); }
      return;
    }

    if (isAllowedChannel(message.channelId)) {
      await sendDiscordChunks(message.channel, reply);
    }
  });
});

if (!BOT_TOKEN || !/^\S+\.\S+\.\S+$/.test(BOT_TOKEN)) {
  console.error('Peter bot misconfigured: BOT_TOKEN missing/invalid format in peter-discord-bot/.env');
  process.exit(1);
}

client.login(BOT_TOKEN);
