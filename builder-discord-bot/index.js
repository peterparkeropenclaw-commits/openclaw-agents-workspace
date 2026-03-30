require("dotenv").config({
  path: "/Users/robotmac/workspace/builder-discord-bot/.env",
});

const { Client, GatewayIntentBits } = require("discord.js");
const { execFile } = require("child_process");
const http = require("http");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BRANDON_USERNAME = process.env.BRANDON_USERNAME || "peterparkeropenclaw";

if (!BOT_TOKEN) { console.error("[builder-bot] Missing BOT_TOKEN"); process.exit(1); }
if (!CHANNEL_ID) { console.error("[builder-bot] Missing CHANNEL_ID"); process.exit(1); }

const OPENCLAW_BIN = "/opt/homebrew/bin/openclaw";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

let isBusy = false;

function parseOpenClawOutput(raw) {
  if (!raw || typeof raw !== "string") return "";
  const cleaned = raw
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  const marker = "◇";
  const idx = cleaned.lastIndexOf(marker);
  return (idx >= 0 ? cleaned.slice(idx + marker.length) : cleaned).trim();
}

function splitMessage(text, maxLen = 1900) {
  const chunks = [];
  let t = String(text || "");
  while (t.length > maxLen) {
    let split = t.lastIndexOf("\n", maxLen);
    if (split <= 0) split = maxLen;
    chunks.push(t.slice(0, split));
    t = t.slice(split).trimStart();
  }
  if (t) chunks.push(t);
  return chunks;
}

// ITEM 6: Discord send is best-effort only — never blocks or masks execution failure.
// Execution success/failure is determined by runOpenClaw(), not by Discord delivery.
async function tryPostToDiscord(text) {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (channel) {
      for (const chunk of splitMessage(text)) {
        if (chunk.trim()) await channel.send(chunk);
      }
    }
  } catch (e) {
    // Discord is best-effort for output mirroring only.
    // Never propagate this error — execution already succeeded.
    console.warn("[builder-bot] Discord post failed (non-fatal):", e.message);
  }
}

// ITEM 4 + 5: runOpenClaw is the sole execution gate.
// /dispatch may only return ok:true after this resolves with non-empty output.
// builder_dispatched in CP must only be set after a confirmed ok:true from /dispatch.
function runOpenClaw(prompt) {
  return new Promise((resolve, reject) => {
    console.log("[builder-bot] Spawning openclaw agent for builder task");
    execFile(
      OPENCLAW_BIN,
      ["agent", "--agent", "builder", "--message", prompt],
      { maxBuffer: 4 * 1024 * 1024, timeout: 30 * 60 * 1000 },
      (error, stdout, stderr) => {
        const stdoutText = (stdout || "").toString();
        const stderrText = (stderr || "").toString();
        const parsed = parseOpenClawOutput(stdoutText);

        if (error && !stdoutText) {
          console.error("[builder-bot] exec error:", error.message);
          console.error("[builder-bot] stderr:", stderrText);
          return reject(new Error(`exec error: ${error.message}`));
        }

        if (!parsed || !parsed.trim()) {
          console.error("[builder-bot] empty parsed output");
          console.error("[builder-bot] stdout:", stdoutText);
          console.error("[builder-bot] stderr:", stderrText);
          return reject(new Error("builder returned empty output"));
        }

        console.log("[builder-bot] openclaw agent completed — output length:", parsed.length);
        resolve(parsed);
      }
    );
  });
}

client.once("clientReady", () => {
  console.log(`[builder-bot] Online as ${client.user?.tag}`);
  console.log(`[builder-bot] Listening in channel ${CHANNEL_ID}`);
});

client.on("error", (err) => console.error("[builder-bot] client error:", err));
client.on("warn", (msg) => console.warn("[builder-bot] warn:", msg));
process.on("unhandledRejection", (err) => console.error("[builder-bot] unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("[builder-bot] uncaught exception:", err));

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channel?.id !== CHANNEL_ID) return;
    if (message.author.username !== BRANDON_USERNAME) return;
    const userMessage = message.content?.trim();
    if (!userMessage) return;

    console.log(`[builder-bot] Message: ${userMessage}`);

    if (isBusy) {
      await message.reply("Builder is already working. Please wait.");
      return;
    }

    isBusy = true;
    let thinkingMsg;
    try {
      thinkingMsg = await message.reply("🛠️ Builder is on it...");
      const prompt = `[${message.author.username}]: ${userMessage}`;
      const reply = await runOpenClaw(prompt);
      const chunks = splitMessage(reply);
      await thinkingMsg.edit(chunks[0] || "Builder returned no response.");
      for (let i = 1; i < chunks.length; i++) {
        await message.channel.send(chunks[i]);
      }
    } finally {
      isBusy = false;
    }
  } catch (err) {
    console.error("[builder-bot] handler failure:", err);
    try { await message.reply("Builder encountered an error. Please try again."); } catch (_) {}
    isBusy = false;
  }
});

(async () => {
  try {
    console.log("[builder-bot] Starting login");
    await client.login(BOT_TOKEN);
  } catch (err) {
    // ITEM 6: Discord login failure is logged but does NOT prevent the HTTP server from
    // starting. Execution via /dispatch uses openclaw CLI directly — it does not depend
    // on the Discord connection. Discord is output-mirroring only.
    console.error("[builder-bot] Discord login failed (non-fatal for HTTP execution):", err.message);
  }
})();

const deliverServer = http.createServer((req, res) => {
  // ── /health ────────────────────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, agent: "builder" }));
    return;
  }

  // ── /dispatch ──────────────────────────────────────────────────────────────
  // ITEM 4 + 5: The ONLY production execution path. Calls openclaw agent LLM directly.
  // Returns ok:true only after runOpenClaw() resolves with non-empty output.
  // This is the execution receipt — no ok:true without actual LLM pickup.
  if (req.method === "POST" && req.url === "/dispatch") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const { content } = JSON.parse(body);
        if (!content) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "content required" }));
          return;
        }

        const prompt = `[peter]: ${content}`;
        console.log("[builder-bot] /dispatch received — running LLM");

        // ITEM 5: Execution receipt — reply is only set after confirmed LLM output.
        const reply = await runOpenClaw(prompt);

        // ITEM 6: Discord post is best-effort only — never blocks or hides execution result.
        await tryPostToDiscord(reply);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, agent: "builder", received: true, output_length: reply.length }));
      } catch (e) {
        console.error("[builder-bot] dispatch error:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        // ITEM 6: Return explicit error — never ok:true on failure.
        res.end(JSON.stringify({ ok: false, agent: "builder", error: e.message }));
      }
    });
    return;
  }

  // ── /deliver — DEPRECATED ─────────────────────────────────────────────────
  // ITEM 1 + 2: /deliver is removed from all production paths.
  // It never called the LLM. It was a dumb Discord pipe that silently returned
  // ok:true even when no agent work happened (Discord ENOTFOUND = silent false success).
  // Any caller still hitting /deliver is using the wrong path and must be fixed.
  if (req.method === "POST" && req.url === "/deliver") {
    console.error("[builder-bot] /deliver called — DEPRECATED. Caller must use /dispatch.");
    res.writeHead(410, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      error: "DEPRECATED: /deliver does not trigger LLM execution. Use POST /dispatch instead.",
      action_required: "Update caller to use /dispatch for all Builder task execution."
    }));
    return;
  }

  res.writeHead(404);
  res.end();
});

deliverServer.listen(3201, () => console.log("[builder-bot] HTTP server on port 3201"));
