'use strict';

const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { Client, GatewayIntentBits } = require('discord.js');
const { execFile } = require('child_process');
const http = require('http');

const LISTEN_CHANNEL = process.env.CHANNEL_ID || '1482328089244729487';
const BRANDON_USERNAME = process.env.BRANDON_USERNAME || 'peterparkeropenclaw';
const BOT_TOKEN = process.env.BOT_TOKEN;
const TIMEOUT_MS = 120000;
const PETER_ESCALATION_URL = process.env.PETER_ESCALATION_URL || 'http://localhost:3301/escalate';

const CHANNELS = {
  ops:                   process.env.CHANNEL_ID,
  peter:                 process.env.PETER_CHANNEL,
  approvals:             process.env.APPROVALS_CHANNEL,
  alerts:                process.env.ALERTS_CHANNEL,
  builder:               process.env.BUILDER_CHANNEL,
  reviewer:              process.env.REVIEWER_CHANNEL,
  'commercial-director': process.env.CD_CHANNEL,
  designer:              process.env.DESIGNER_CHANNEL,
};

const AGENT_ENDPOINTS = {
  'builder':             'http://localhost:3201/dispatch',
  'reviewer':            'http://localhost:3202/dispatch',
  'commercial director': 'http://localhost:3203/dispatch',
  'commercial-director': 'http://localhost:3203/dispatch',
  'designer':            'http://localhost:3204/dispatch',
};

const AGENT_CHANNELS = {
  'builder':             'builder',
  'reviewer':            'reviewer',
  'commercial director': 'commercial-director',
  'commercial-director': 'commercial-director',
  'designer':            'designer',
};

function parseOpenClawOutput(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '');
  const marker = '◇';
  const idx = s.lastIndexOf(marker);
  if (idx !== -1) s = s.slice(idx + marker.length);
  return s.trim();
}

function splitMessage(text, maxLen = 1900) {
  const chunks = [];
  let t = String(text || '');
  while (t.length > maxLen) {
    let split = t.lastIndexOf('\n', maxLen);
    if (split <= 0) split = maxLen;
    chunks.push(t.slice(0, split));
    t = t.slice(split).trimStart();
  }
  if (t) chunks.push(t);
  return chunks;
}

async function sendDiscordChunks(channel, text) {
  for (const chunk of splitMessage(text)) {
    if (chunk.trim()) await channel.send(chunk);
  }
}

async function sendToChannel(channelKey, message) {
  try {
    const channelId = CHANNELS[channelKey];
    if (!channelId) { console.error(`[sendToChannel] No ID for "${channelKey}"`); return; }
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel) { console.error(`[sendToChannel] Cannot fetch ${channelId}`); return; }
    await sendDiscordChunks(channel, message);
    console.log(`[sendToChannel] ✓ #${channelKey}`);
  } catch (err) {
    console.error(`[sendToChannel] Error for "${channelKey}": ${err.message}`);
  }
}

function parseAllDispatches(response) {
  const regex = /DISPATCH>>\nAGENT:\s*(.+)\nTASK:\s*([\s\S]+?)<<END/g;
  const dispatches = [];
  let match;
  while ((match = regex.exec(response)) !== null) {
    dispatches.push({ agent: match[1].trim(), task: match[2].trim() });
  }
  return dispatches;
}

function httpPostJson(rawUrl, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function generateTaskId(agentName) {
  return `${agentName.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function shouldEscalateToPeter(agentKey) {
  return agentKey === 'builder' || agentKey === 'reviewer';
}

async function escalateToPeter({ taskId, sourceAgent, failure, task }) {
  try {
    const response = await httpPostJson(PETER_ESCALATION_URL, {
      taskId,
      sourceAgent,
      failure,
      task,
    });

    if (response.statusCode !== 200) {
      await sendToChannel(
        'alerts',
        `❌ **Peter escalation failed**\nTask ID: \`${taskId}\`\nSource: **${sourceAgent}**\nFailure: ${failure}\nBridge response: ${response.statusCode}\n${response.body || ''}`
      );
      return;
    }

    console.log(`[ops-director] Escalated ${taskId} to Peter`);
  } catch (err) {
    await sendToChannel(
      'alerts',
      `❌ **Peter escalation transport error**\nTask ID: \`${taskId}\`\nSource: **${sourceAgent}**\nFailure: ${failure}\nError: ${err.message}`
    );
  }
}

async function dispatchToAgent(agentName, task) {
  const agentKey = agentName.toLowerCase().trim();
  const channelKey = AGENT_CHANNELS[agentKey] || 'ops';
  const endpoint = AGENT_ENDPOINTS[agentKey];
  const taskId = generateTaskId(agentKey);

  if (!endpoint) {
    await sendToChannel('alerts', `⚠️ Unknown agent: "${agentName}" — dispatch failed.`);
    return;
  }

  const channelId = CHANNELS[channelKey] || CHANNELS['ops'];
  const payload = { taskId, content: task, channelKey, channelId };
  const responseTextHeader = `Task ID: \`${taskId}\`\nAgent: **${agentName}**`;

  try {
    const response = await httpPostJson(endpoint, payload);

    if (response.statusCode === 200 || response.statusCode === 202) {
      console.log(`[dispatch] ${agentName} accepted (HTTP ${response.statusCode}) taskId=${taskId}`);
      return;
    }

    await sendToChannel(
      'alerts',
      `⚠️ **${agentName} endpoint ${response.statusCode}**\n${responseTextHeader}\n${response.body || ''}`
    );

    if (shouldEscalateToPeter(agentKey)) {
      await escalateToPeter({
        taskId,
        sourceAgent: agentName,
        failure: `dispatch failed with HTTP ${response.statusCode}`,
        task,
      });
    }
  } catch (err) {
    await sendToChannel(
      'alerts',
      `❌ **Dispatch failed — ${agentName}**\n${responseTextHeader}\nError: ${err.message}`
    );

    if (shouldEscalateToPeter(agentKey)) {
      await escalateToPeter({
        taskId,
        sourceAgent: agentName,
        failure: `dispatch transport error: ${err.message}`,
        task,
      });
    }
  }
}


async function approveDesignerWork(filename) {
  return await httpPostJson('http://localhost:3204/approve', { filename });
}

function callOpenClaw(prompt) {
  return new Promise((resolve) => {
    execFile(
      '/opt/homebrew/bin/openclaw',
      ['agent', '--agent', 'ops', '--message', prompt],
      { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed || error.code === null) {
            console.error('[ops-director-bot] CLI timed out');
            resolve('');
            return;
          }
          console.error('[ops-director-bot] CLI error:', error.message);
        }
        resolve((stdout || stderr || '').toString());
      }
    );
  });
}

async function runOpsTask({ taskId, content, source }) {
  const receivedAt = new Date().toISOString();
  const result = {
    taskId,
    status: 'failed',
    source,
    raw_response: '',
    spec_summary: '',
    dispatch_target: null,
    dispatch_payload: null,
    parsed_actions: [],
    error: null,
    received_at: receivedAt,
    completed_at: receivedAt,
  };

  try {
    if (!content || !String(content).trim()) {
      throw new Error('content is required');
    }
    if (source !== 'discord' && (!taskId || !String(taskId).trim())) {
      throw new Error('taskId is required');
    }

    console.log(`[ops-task] received taskId=${taskId || 'null'} source=${source || 'unknown'}`);

    const raw = await callOpenClaw(String(content).trim());
    result.raw_response = raw;
    console.log(`[ops-task] reasoning_completed raw_length=${raw.length}`);

    const parsedOutput = parseOpenClawOutput(raw);
    const dispatches = parseAllDispatches(parsedOutput);
    const specSummary = parsedOutput.replace(/DISPATCH>>[\s\S]*?<<END/g, '').trim();

    result.spec_summary = specSummary;
    result.parsed_actions = dispatches.map(d => ({ agent: d.agent, task: d.task }));
    result.dispatch_target = dispatches[0] ? dispatches[0].agent : null;
    result.dispatch_payload = dispatches[0] ? dispatches[0].task : null;

    console.log(`[ops-task] spec_generated dispatches=${dispatches.length}`);

    for (const dispatch of dispatches) {
      await dispatchToAgent(dispatch.agent, dispatch.task);
      console.log(`[ops-task] dispatch_completed agent=${dispatch.agent}`);
    }

    result.status = dispatches.length > 0 ? 'agent_dispatched' : 'spec_generated';
    result.completed_at = new Date().toISOString();
    return result;
  } catch (err) {
    result.status = 'failed';
    result.error = err.message;
    result.completed_at = new Date().toISOString();
    return result;
  }
}

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

discordClient.once('clientReady', async () => {
  console.log(`Ops Director bot online as ${discordClient.user.tag}`);
  console.log(`Listening in channel ${LISTEN_CHANNEL}`);
  await sendToChannel('ops', '🦞 **Ops Director online** — ready.');
});

let busy = false;

discordClient.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (message.channelId !== LISTEN_CHANNEL) return;
  if (message.author.username !== BRANDON_USERNAME) return;
  if (!message.content?.trim()) return;
  const approveMatch = message.content.trim().match(/^APPROVE DESIGN\s+(.+)$/i);
  if (approveMatch) {
    try {
      const filename = approveMatch[1].trim();
      const response = await approveDesignerWork(filename);
      if (response.statusCode === 200) {
        await message.reply(`Approved designer work: ${filename}`);
      } else {
        await message.reply(`Designer approval failed for ${filename}: ${response.body}`);
      }
    } catch (err) {
      await message.reply(`Designer approval error: ${err.message}`);
    }
    return;
  }

  if (busy) {
    await message.reply('Ops Director is already processing — please wait.');
    return;
  }

  busy = true;
  try {
    await message.channel.sendTyping();
    const prompt = `[${message.author.username}]: ${message.content.trim()}`;
    console.log(`[${message.author.username}] ${message.content.trim()}`);

    const result = await runOpsTask({ taskId: null, content: prompt, source: 'discord' });

    if (!result.spec_summary) {
      console.error('[ops-director-bot] empty reply. Raw length:', result.raw_response.length);
      await message.reply('Ops Director returned no response — please try again.');
      return;
    }

    const chunks = splitMessage(result.spec_summary);
    for (const chunk of chunks) {
      if (chunk.trim()) await message.reply(chunk);
    }
  } catch (err) {
    console.error('[ops-director-bot] handler error:', err);
    await message.reply('Ops Director encountered an error — please try again.');
  } finally {
    busy = false;
  }
});

const httpServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/deliver') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { channelKey, agentId, content } = JSON.parse(body);
        if (!channelKey || !content) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'channelKey and content required' }));
          return;
        }
        console.log(`[deliver] ${agentId} → #${channelKey}`);
        await sendToChannel(channelKey, `📥 **${agentId || 'Agent'} output:**\n${content}`);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('[deliver] error:', e.message);
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/task') {
    const authHeader = req.headers.authorization || '';
    const expectedToken = process.env.OPS_INTERNAL_TOKEN;
    if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { taskId, content } = JSON.parse(body);
        if (!taskId || !content) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'taskId and content required' }));
          return;
        }

        console.log(`[http-task] received taskId=${taskId}`);
        const result = await runOpsTask({ taskId, content, source: 'http' });
        console.log(`[http-task] completed taskId=${taskId} status=${result.status}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error('[http-task] error:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agent: 'ops-director' }));
    return;
  }

  res.writeHead(200);
  res.end(JSON.stringify({ status: 'ops-director-bot online' }));
});

httpServer.listen(3001, () => console.log('[HTTP] Ops Director HTTP server on port 3001'));

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN missing — exiting');
  process.exit(1);
}

discordClient.login(BOT_TOKEN);
