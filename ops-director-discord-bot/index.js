function splitMessage(text, maxLen = 1900) {
  const chunks = [];
  let t = text;
  while (t.length > maxLen) {
    let split = t.lastIndexOf('\n', maxLen);
    if (split === -1) split = maxLen;
    chunks.push(t.slice(0, split));
    t = t.slice(split).trimStart();
  }
  chunks.push(t);
  return chunks;
}

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

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
  missionControl: process.env.CHANNEL_ID,
  competitors: '1482436579933814836', // hardcoded
  marketIntel: '1482436579933814836', // hardcoded
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

  sendToChannel('ops', '🔄 **Dispatching to ' + agentName + '** via HTTP endpoint');

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

function askOpsDirector(userMessage, callback) {
  const body = JSON.stringify({
    tool: 'sessions_send',
    args: {
      sessionKey: 'agent:ops:discord:channel:' + process.env.CHANNEL_ID,
      message: userMessage,
      timeoutSeconds: 120
    }
  });

  const options = {
    hostname: '127.0.0.1',
    port: 18789,
    path: '/tools/invoke',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  const req = require('http').request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        const reply = parsed.result || parsed.output || parsed.message || JSON.stringify(parsed);
        callback(reply, null);
      } catch (e) {
        callback(data.trim() || null, null);
      }
    });
  });

  req.on('error', (err) => { callback(null, err.message); });
  req.setTimeout(130000, () => { req.destroy(); callback(null, 'Request timed out'); });
  req.write(body);
  req.end();
}

client.once('clientReady', () => {
  console.log('Ops Director bot online as ' + client.user.tag);
  console.log('Model: github-copilot/gpt-4.1 via OpenClaw CLI (free tier)');
  console.log('Channel routing: Researcher/Deep Researcher → #research | Analyst/Commercial Director → #leads | Community Manager → #approvals');
  sendToChannel('missionControl', '🦞 **Ops Director online** — OpenAI GPT-5.4, all channels active.');
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
        const chunks1 = splitMessage(content);
        for (const chunk of chunks1) await sendToChannel(channelKey, chunk);
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
        if (agentId === 'Coder' && channelKey === 'coder') {
          console.log('[auto-qa] Coder delivery detected — triggering QA review');
          const qaPayload = JSON.stringify({ task: 'Review latest Coder output posted in #coder. Check the feature branch, build status and preview URL mentioned. Post APPROVED or REJECTED.', channelKey: 'coder', channelId: process.env.CODER_CHANNEL });
          const qaReq = require('http').request({ hostname: 'localhost', port: 3107, path: '/deliver', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(qaPayload) } }, () => console.log('[auto-qa] QA Agent triggered'));
          qaReq.write(qaPayload);
          qaReq.end();
        }
        const msgChunks = splitMessage('📥 **' + agentId + ' output:**\n' + content);
        for (const chunk of msgChunks) await sendToChannel(channelKey, chunk);
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
