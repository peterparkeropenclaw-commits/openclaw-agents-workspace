const fs = require('fs');
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { exec } = require('child_process');

// Agent HTTP dispatch endpoints — NEVER use openclaw CLI for agent dispatch
const AGENT_ENDPOINTS = {
  'researcher': 'http://localhost:3102/deliver',
  'analyst': 'http://localhost:3104/deliver',
  'commercial director': 'http://localhost:3105/deliver',
  'community manager': 'http://localhost:3103/deliver',
  'coder': 'http://localhost:3101/deliver',
  'coder-writer': 'http://localhost:3101/deliver',
  'coder writer': 'http://localhost:3101/deliver',
  'designer': 'http://localhost:3106/deliver',
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const CHANNELS = {
  ops: process.env.CHANNEL_ID,
  peter: process.env.PETER_CHANNEL,
  coder: process.env.CODER_CHANNEL,
  leads: process.env.LEADS_CHANNEL,
  research: process.env.RESEARCH_CHANNEL,
  approvals: process.env.APPROVALS_CHANNEL,
  missionControl: process.env.MISSION_CONTROL_CHANNEL,
  alerts: process.env.ALERTS_CHANNEL,
  competitors: '1482473947814694973', // hardcoded
  marketIntel: '1482474140207419412', // hardcoded
  socialDrafts: '1482474058301047076' // hardcoded
};

const AGENT_MAP = {
  'researcher': 'researcher',
  'analyst': 'analyst',
  'deep researcher': 'deep-researcher',
  'designer': 'designer',
  'commercial director': 'commercial-director',
  'community manager': 'community-manager',
  'coder writer': 'coder-writer',
  'coder qa': 'coder-qa',
  'peter': 'main',
  'ops': 'ops'
};

// Raw research → #research
// Deep research / market intel → #market-intel
// Qualified scored leads → #leads
// Community Manager drafts → #approvals
// Competitor findings → #competitors
// Social drafts → #social-drafts
const AGENT_CHANNELS = {
  'researcher': 'research',
  'analyst': 'leads',
  'deep researcher': 'marketIntel',
  'designer': 'socialDrafts',
  'commercial director': 'leads',
  'community manager': 'approvals',
  'coder writer': 'coder',
  'coder qa': 'coder',
  'peter': 'peter',
  'ops': 'ops',
  'competitor findings': 'competitors',
  'social drafts': 'socialDrafts'
};

async function sendToChannel(channelKey, message) {
  try {
    const channelId = CHANNELS[channelKey];
    if (!channelId) {
      console.error(`[sendToChannel] ERROR: channelKey "${channelKey}" has no mapped ID. Check CHANNELS object and .env vars.`);
      return;
    }
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      console.error(`[sendToChannel] ERROR: Could not fetch channel ${channelId} (key: ${channelKey})`);
      return;
    }
    const chunks = message.match(/([\s\S]{1,1900})/g) || [message];
    for (const chunk of chunks) await channel.send(chunk);
    console.log(`[sendToChannel] SUCCESS: Sent to #${channelKey} (${channelId})`);
  } catch (err) {
    console.error(`[sendToChannel] FAILED for channel key "${channelKey}": ${err.message}`);
  }
}

function dispatchToAgent(agentName, task) {
  // Split multi-agent fields (e.g. "Researcher + Analyst" or "Researcher → Analyst")
  const agentParts = agentName.split(/\s*[\+→]\s*/).map(a => a.trim()).filter(Boolean);
  if (agentParts.length > 1) {
    agentParts.forEach(part => dispatchToAgent(part, task));
    return;
  }

  const agentKey = agentName.toLowerCase().trim();
  const channelKey = AGENT_CHANNELS[agentKey] || 'ops';
  const endpoint = AGENT_ENDPOINTS[agentKey];

  if (!endpoint) {
    sendToChannel('alerts', '⚠️ Unknown agent or no endpoint: "' + agentName + '" — dispatch failed.');
    return;
  }

  sendToChannel('missionControl', '🔄 **Dispatching to ' + agentName + '** via HTTP endpoint');

  const channelId = CHANNELS[channelKey] || CHANNELS["missionControl"];
  const payload = JSON.stringify({ task, channelKey, channelId });
  const url = new URL(endpoint);
  const reqOptions = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  };

  const req = http.request(reqOptions, res => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      if (res.statusCode === 202) {
        console.log('[dispatch] ' + agentName + ' accepted task (202)');
      } else {
        sendToChannel('alerts', '⚠️ **' + agentName + ' endpoint returned ' + res.statusCode + ':** ' + data);
      }
    });
  });

  req.on('error', err => {
    sendToChannel('alerts', '❌ **HTTP dispatch failed — ' + agentName + ' (' + endpoint + '):**\n' + err.message);
  });

  req.write(payload);
  req.end();
}

// Parse ALL dispatch blocks — supports parallel dispatch
function parseAllDispatches(response) {
  const regex = /DISPATCH>>\nAGENT:\s*(.+)\nTASK:\s*([\s\S]+?)<<END/g;
  const dispatches = [];
  let match;
  while ((match = regex.exec(response)) !== null) {
    dispatches.push({ agent: match[1].trim(), task: match[2].trim() });
  }
  return dispatches;
}

// Route ALL Ops Director conversation through OpenClaw CLI
// Uses github-copilot/gpt-4.1 — free, no token expiry issues
function askOpsDirector(userMessage, callback) {
  const tmpFile = '/tmp/ops-message-' + Date.now() + '.txt';
  fs.writeFileSync(tmpFile, userMessage);
  const cmd = '/opt/homebrew/bin/openclaw agent --agent ops --message "$(cat ' + tmpFile + ')"';

  exec(cmd, { timeout: 120000 }, (error, stdout, stderr) => {
    if (error) {
      callback(null, error.message);
      return;
    }
    const response = (stdout || stderr || '').trim();
    callback(response, null);
  });
}

client.once('clientReady', () => {
  console.log('Ops Director bot online as ' + client.user.tag);
  console.log('Model: github-copilot/gpt-4.1 via OpenClaw CLI (free tier)');
  console.log('Channel routing: Researcher/Deep Researcher → #research | Analyst/Commercial Director → #leads | Community Manager → #approvals');
  sendToChannel('missionControl', '🦞 **Ops Director online** — GitHub Copilot GPT-5-mini, all channels active.');
});

client.on('messageCreate', async (message) => {
  if (message.channelId !== process.env.CHANNEL_ID) return;
  if (message.author.bot) return;
  if (message.author.username !== process.env.BRANDON_USERNAME) return;

  const userMsg = message.content.trim();
  if (!userMsg) return;

  console.log(`[${message.author.username}] ${userMsg}`);

  await message.channel.sendTyping();

  askOpsDirector(`[${message.author.username}]: ${userMsg}`, async (reply, err) => {
    if (err || !reply) {
      await message.channel.send('❌ Ops Director error: ' + (err || 'empty response'));
      sendToChannel('alerts', '❌ **Ops Director CLI error:** ' + (err || 'empty response'));
      return;
    }

    // Strip dispatch blocks from visible reply
    const visibleReply = reply.replace(/DISPATCH>>[\s\S]*?<<END/g, '').trim();
    if (visibleReply) {
      const chunks = visibleReply.match(/([\s\S]{1,1900})/g) || [visibleReply];
      for (const chunk of chunks) await message.channel.send(chunk);
    }

    // Fire ALL dispatch blocks simultaneously
    const dispatches = parseAllDispatches(reply);
    dispatches.forEach(d => dispatchToAgent(d.agent, d.task));
  });
});

// Minimal HTTP server for health checks and test-channel endpoint
const http = require('http');
const httpServer = http.createServer((req, res) => {

  // DELIVERY ENDPOINT — agents POST here on task completion
  if (req.method === 'POST' && req.url === '/deliver') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { channelKey, content, agentId } = JSON.parse(body);
        if (!channelKey || !content) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'channelKey and content required' }));
          return;
        }
        console.log('[deliver] Received output from agent:', agentId, '→ channel:', channelKey);
        await sendToChannel(channelKey, content);
        // missionControl echo removed
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/deliver') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const { channelKey, agentId, content } = payload;
        if (!channelKey || !content) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'channelKey and content required' }));
          return;
        }
        console.log('[deliver] ' + agentId + ' → #' + channelKey);
        await sendToChannel(channelKey, '📥 **' + agentId + ' output:**\n' + content);
        // missionControl echo removed
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('[deliver] error:', e.message);
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/test-channel') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { channelId, message } = JSON.parse(body);
        if (!channelId || !message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'channelId and message required' }));
          return;
        }
        try {
          const channel = await client.channels.fetch(channelId);
          await channel.send(message);
          console.log(`[test-channel] SUCCESS: Sent to channelId ${channelId}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, channelId }));
        } catch (err) {
          console.error(`[test-channel] FAILED for channelId ${channelId}: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ops-director-bot online' }));
  }
});
httpServer.listen(3001, () => {
  console.log('[HTTP] Test server listening on port 3001');
});

client.login(process.env.BOT_TOKEN);
