require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { exec } = require('child_process');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const CHANNEL_ID = process.env.CHANNEL_ID;
const BRANDON_USERNAME = process.env.BRANDON_USERNAME;
const PETER_ALLOWED_CHANNEL = '1482399843627438131';

function isAllowedChannel(channelId) {
  if (channelId !== PETER_ALLOWED_CHANNEL) {
    console.log(`[Peter] Silently dropping message to unauthorised channel: ${channelId}`);
    return false;
  }
  return true;
}

// Route message to Peter (main agent) via OpenClaw CLI
// Uses github-copilot/claude-sonnet-4.6 — free tier, no token expiry
function askPeter(userMessage, callback) {
  const safeMessage = userMessage.replace(/"/g, '\\"').replace(/\n/g, ' ');
  const cmd = '/opt/homebrew/bin/openclaw agent --agent main --message "' + safeMessage + '"';

  exec(cmd, { timeout: 180000 }, (error, stdout, stderr) => {
    if (error) {
      callback(null, error.message);
      return;
    }
    const response = (stdout || stderr || '').trim();
    callback(response, null);
  });
}

async function sendToChannel(message) {
  if (!isAllowedChannel(CHANNEL_ID)) return;

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    const chunks = message.match(/[\s\S]{1,1900}/g) || [message];
    for (const chunk of chunks) await channel.send(chunk);
  } catch (err) {
    console.error('sendToChannel error:', err.message);
  }
}

client.once('clientReady', async () => {
  console.log('Peter bot online as ' + client.user.tag);
  console.log('Listening in #peter channel: ' + CHANNEL_ID);
  console.log('Model: github-copilot/claude-sonnet-4.6 via OpenClaw CLI (free tier)');
  await sendToChannel('Peter online — ready for strategic discussion 🧠');
});

client.on('messageCreate', async (message) => {
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
      await message.channel.send('❌ Peter error: ' + (err || 'empty response'));
      return;
    }

    const chunks = reply.match(/[\s\S]{1,1900}/g) || [reply];
    for (const chunk of chunks) await message.channel.send(chunk);
  });
});

client.login(process.env.BOT_TOKEN);
