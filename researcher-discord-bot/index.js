require('dotenv').config({ path: __dirname + '/.env' });
const { Client, GatewayIntentBits } = require('discord.js');
const http = require('http');
const { exec } = require('child_process');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const DEFAULT_CHANNEL_ID = process.env.RESEARCH_CHANNEL || process.env.CHANNEL_ID;
const DIRECT_CHANNEL_ID = process.env.RESEARCH_CHANNEL || process.env.CHANNEL_ID;
const AGENT_NAME = process.env.AGENT_NAME;
const AGENT_ID = process.env.AGENT_ID;
const PORT = parseInt(process.env.PORT);
const OPS_DELIVER_URL = 'http://localhost:3001/deliver';

client.once('ready', () => {
  console.log(`[${AGENT_NAME}] Bot ready as ${client.user.tag}`);
});

function splitMessage(text, maxLen = 1900) {
  const chunks = [];
  while (text.length > maxLen) {
    let split = text.lastIndexOf('\n', maxLen);
    if (split === -1) split = maxLen;
    chunks.push(text.slice(0, split));
    text = text.slice(split).trimStart();
  }
  chunks.push(text);
  return chunks;
}

async function deliverToChannel({ task, output, agentName, channelId }) {
  const targetChannelId = channelId || DEFAULT_CHANNEL_ID;
  if (!targetChannelId) throw new Error("No target channel configured");
  const channel = await client.channels.fetch(targetChannelId);
  const chunks = splitMessage(output);
  for (let i = 0; i < chunks.length; i++) {
    const label = chunks.length > 1
      ? `**${agentName || AGENT_NAME} — ${task}** (part ${i+1}/${chunks.length})`
      : `**${agentName || AGENT_NAME} — ${task}**`;
    await channel.send(`${label}\n\n${chunks[i]}`);
  }
}

function postToOps(channelKey, content) {
  const payload = JSON.stringify({ channelKey, agentId: AGENT_NAME, content });
  const req = http.request(OPS_DELIVER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  }, res => {
    console.log(`[${AGENT_NAME}] Delivered to ops-director → #${channelKey} (${res.statusCode})`);
  });
  req.on('error', err => console.error(`[${AGENT_NAME}] Failed to deliver to ops-director:`, err.message));
  req.write(payload);
  req.end();
}

const server = http.createServer(async (req, res) => {

  // /post — Discord relay (agents post output via this)
  if (req.method === 'POST' && req.url === '/post') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { task, output, agentName, channelId } = JSON.parse(body);
        await deliverToChannel({ task, output, agentName, channelId });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error(err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // /deliver — Ops Director dispatches tasks here via HTTP (replaces CLI dispatch)
  if (req.method === 'POST' && req.url === '/deliver') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { task, channelKey } = JSON.parse(body);
        if (!task) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'task required' }));
          return;
        }
        res.writeHead(202);
        res.end(JSON.stringify({ accepted: true, agent: AGENT_NAME }));

        console.log(`[${AGENT_NAME}] /deliver received task: ${task.slice(0, 80)}...`);
        postToOps(channelKey || 'missionControl', `🔄 **${AGENT_NAME}** received task — processing...`);

        const safeTask = task.replace(/"/g, '\\"').replace(/`/g, '\\`');
        exec(`/opt/homebrew/bin/openclaw agent --agent ${AGENT_ID} --message "${safeTask}"`,
          { timeout: 300000 },
          (error, stdout, stderr) => {
            if (error) {
              console.error(`[${AGENT_NAME}] exec error:`, error.message);
              postToOps('alerts', `❌ **${AGENT_NAME} failed:**\n${error.message}`);
              return;
            }
            const output = (stdout || stderr || 'No response').trim();
            console.log(`[${AGENT_NAME}] Task complete. Output length: ${output.length}`);
            deliverToChannel({ task, output, agentName: AGENT_NAME, channelId: DIRECT_CHANNEL_ID })
              .catch(err => {
                console.error(`[${AGENT_NAME}] Failed to send output to channel:`, err.message);
                postToOps('alerts', `❌ **${AGENT_NAME} failed to send output:**\n${err.message}`);
              });
          }
        );
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`[${AGENT_NAME}] HTTP server on port ${PORT}`));
client.login(process.env.DISCORD_TOKEN);
