'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function createStrClinicOrchestrator({
  botToken,
  cdrAuthToken,
  cdrWebhookUrl,
  freeAuditScript,
  paidAuditScript,
  googleCreds,
  freeDriveFolder,
  paidDriveFolder,
  sendTelegram,
  escapeHtml,
}) {
  const recentAudits = new Map(); // url+type → timestamp
  let strClinicOffset = 0;

  function buildFreeAuditInput(airbnbUrl) {
    return {
      listing_url:                  airbnbUrl,
      property_name:                'Your property',
      location:                     airbnbUrl.includes('airbnb.co.uk') ? 'UK' : 'Unknown',
      date:                         new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }),
      currency_code:                airbnbUrl.includes('airbnb.co.uk') ? 'GBP' : 'USD',
      overall_score:                47,
      score_narrative:              'Audit in progress — score will be personalised by Brandon.',
      monthly_revenue_gap_estimate: airbnbUrl.includes('airbnb.co.uk') ? '£180–£320/month' : '$200–$380/month',
      top_3_issues: [
        { issue: 'Personalised audit pending', description: 'Brandon will review and update these findings.', revenue_impact: 'Est. impact: TBD' },
      ],
      current_title: 'Retrieving from listing...',
      rewritten_title: 'Personalised title to be added by Brandon',
      title_rationale: 'To be added by Brandon.',
      opportunity_summary: 'Full opportunity analysis to follow.',
    };
  }

  function buildPaidAuditInput(airbnbUrl) {
    return {
      listing_url: airbnbUrl,
      airbnb_url: airbnbUrl,
      _scrape_url: airbnbUrl,
    };
  }

  function isDuplicate(url, type) {
    const key = `${type}:${url}`;
    const last = recentAudits.get(key);
    if (last && Date.now() - last < 10 * 60 * 1000) return true;
    recentAudits.set(key, Date.now());
    return false;
  }

  async function notifyCDR(taskId, brief) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (cdrAuthToken) headers.Authorization = `Bearer ${cdrAuthToken}`;
      const res = await fetch(cdrWebhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ task_id: taskId, brief, priority: 'high', from: 'str-clinic-listener' }),
      });
      if (!res.ok) console.error('[cdr-webhook] POST failed:', res.status, await res.text());
      else console.log('[cdr-webhook] notified:', taskId);
    } catch (err) {
      console.error('[cdr-webhook] error:', err.message);
    }
  }

  function runGenerator(scriptPath, inputJsonPath) {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [scriptPath, '--input', inputJsonPath], {
        cwd: path.dirname(scriptPath),
        env: {
          ...process.env,
          GOOGLE_APPLICATION_CREDENTIALS: googleCreds,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      let settled = false;
      let stdoutBuffer = '';
      let stderrBuffer = '';

      const finish = (err, value = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { fs.unlinkSync(inputJsonPath); } catch {}
        if (err) reject(err);
        else resolve(value);
      };

      const flushBuffered = (buffer, logger) => {
        const lines = buffer.split(/\r?\n|\r/g);
        const remainder = lines.pop() || '';
        lines.filter((line) => line.trim()).forEach((line) => logger('[generator]', line));
        return remainder;
      };

      if (proc.stdout) {
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', (chunk) => {
          output += chunk;
          stdoutBuffer = flushBuffered(stdoutBuffer + chunk, console.log);
        });
      } else {
        console.error('[generator] stdout stream unavailable');
      }

      if (proc.stderr) {
        proc.stderr.setEncoding('utf8');
        proc.stderr.on('data', (chunk) => {
          output += chunk;
          stderrBuffer = flushBuffered(stderrBuffer + chunk, console.error);
        });
      } else {
        console.error('[generator] stderr stream unavailable');
      }

      proc.on('spawn', () => {
        console.log(`[generator] Spawned PID ${proc.pid} for ${path.basename(scriptPath)}`);
      });

      proc.on('error', (err) => {
        finish(new Error(`Generator process error: ${err.message}`));
      });

      proc.on('close', (code, signal) => {
        stdoutBuffer = flushBuffered(stdoutBuffer, console.log);
        stderrBuffer = flushBuffered(stderrBuffer, console.error);
        if (stdoutBuffer.trim()) console.log('[generator]', stdoutBuffer.trim());
        if (stderrBuffer.trim()) console.error('[generator]', stderrBuffer.trim());
        console.log(`[generator] Process exited with code ${code}${signal ? ` (signal ${signal})` : ''}`);
        if (code !== 0) {
          finish(new Error(`Generator exited ${code}: ${output.slice(-2000)}`));
          return;
        }
        const match = output.match(/https:\/\/drive\.google\.com\/[^\s]+/);
        const qaErrors = [...output.matchAll(/^QA_ERROR: (.+)$/gm)].map((matchItem) => matchItem[1]);
        const localPdfPath = output.match(/^Local PDF at:\s+(.+)$/m)?.[1] || null;
        const telemetryPath = output.match(/^Run telemetry saved:\s+(.+)$/m)?.[1] || null;

        let telemetry = null;
        if (telemetryPath && fs.existsSync(telemetryPath)) {
          try {
            telemetry = JSON.parse(fs.readFileSync(telemetryPath, 'utf8'));
          } catch (err) {
            console.warn('[audit] failed to read generator telemetry:', err.message);
          }
        }

        finish(null, {
          driveLink: match ? match[0] : null,
          qaErrors,
          localPdfPath,
          telemetry,
        });
      });

      const timeout = setTimeout(() => {
        proc.kill();
        finish(new Error('Generator timeout (5min)'));
      }, 300_000);
    });
  }

  function buildAuditRunningMessage(typeLabel, airbnbUrl, fromUsername, taskId) {
    return `📋 <b>STR Clinic ${escapeHtml(typeLabel)}</b>\n\nURL: ${escapeHtml(airbnbUrl)}\nRequested by: ${escapeHtml(fromUsername)}\nTask: ${escapeHtml(taskId)}\n\nGenerator running...`;
  }

  function buildAuditReadyMessage(typeLabel, airbnbUrl, taskId, driveLink, qaErrors) {
    let msg = `✅ <b>STR Clinic ${escapeHtml(typeLabel)} ready</b>\n\nURL: ${escapeHtml(airbnbUrl)}\nTask: ${escapeHtml(taskId)}`;
    if (qaErrors.length > 0) {
      msg += `\n\n⚠️ QA flagged ${qaErrors.length} issue${qaErrors.length !== 1 ? 's' : ''} , review before sending to customer\n${qaErrors.map((error) => `• ${escapeHtml(error)}`).join('\n')}`;
    }
    msg += `\n\nDrive: ${escapeHtml(driveLink)}`;
    return msg;
  }

  function buildAuditGeneratedLocallyMessage(typeLabel, airbnbUrl, taskId, qaErrors, localPdfPath) {
    let msg = `⚠️ <b>STR Clinic ${escapeHtml(typeLabel)} generated locally</b>\n\nURL: ${escapeHtml(airbnbUrl)}\nTask: ${escapeHtml(taskId)}\n\nUpload skipped because QA failed.`;
    msg += `\n${qaErrors.map((error) => `• ${escapeHtml(error)}`).join('\n')}`;
    if (localPdfPath) msg += `\n\nLocal PDF: <code>${escapeHtml(localPdfPath)}</code>`;
    return msg;
  }

  function buildAuditGeneratedWithoutLinkMessage(typeLabel, airbnbUrl, taskId, localPdfPath, folder) {
    let msg = `⚠️ <b>STR Clinic ${escapeHtml(typeLabel)} generated</b>\n\nURL: ${escapeHtml(airbnbUrl)}\nTask: ${escapeHtml(taskId)}\n\nDrive upload did not produce a link.`;
    if (localPdfPath) msg += `\nLocal PDF: <code>${escapeHtml(localPdfPath)}</code>`;
    msg += `\n\nCheck Drive folder: ${escapeHtml(`https://drive.google.com/drive/folders/${folder}`)}`;
    return msg;
  }

  function buildAuditFailedMessage(typeLabel, airbnbUrl, taskId, err) {
    return `❌ <b>STR Clinic ${escapeHtml(typeLabel)} failed</b>\n\nURL: ${escapeHtml(airbnbUrl)}\nTask: ${escapeHtml(taskId)}\n\nError: ${escapeHtml(err.message.slice(0, 200))}`;
  }

  function buildMissingUrlMessage(auditType, from, text) {
    return `⚠️ STR Clinic: "${escapeHtml(auditType)}" keyword received from ${escapeHtml(from)} but no Airbnb URL found in message.\n\nMessage: ${escapeHtml(text.slice(0, 200))}`;
  }

  function getAuditMetadata(type) {
    return {
      typeLabel: type === 'free' ? 'Free Audit' : 'Paid Report',
      script: type === 'free' ? freeAuditScript : paidAuditScript,
      folder: type === 'free' ? freeDriveFolder : paidDriveFolder,
    };
  }

  async function triggerAudit(airbnbUrl, type, fromUsername) {
    const taskId = `STR-${type.toUpperCase()}-${Date.now()}`;
    const { typeLabel, script, folder } = getAuditMetadata(type);

    console.log(`[audit] ${typeLabel} triggered by ${fromUsername} for ${airbnbUrl}`);

    const cdrBrief = `${typeLabel} requested via STR Clinic listener bot.\n\nURL: ${airbnbUrl}\nRequested by: ${fromUsername}\nTask ID: ${taskId}\n\nGenerator running — will report Drive link to Mission Control when complete.`;
    notifyCDR(taskId, cdrBrief).catch(() => {});

    await sendTelegram(buildAuditRunningMessage(typeLabel, airbnbUrl, fromUsername, taskId));

    const inputData = type === 'free' ? buildFreeAuditInput(airbnbUrl) : buildPaidAuditInput(airbnbUrl);
    const tmpInput = `/tmp/str-audit-${taskId}.json`;
    fs.writeFileSync(tmpInput, JSON.stringify(inputData, null, 2));

    try {
      const { driveLink, qaErrors, localPdfPath, telemetry } = await runGenerator(script, tmpInput);
      const pdfUploadAttempted = Boolean(telemetry?.uploads?.pdf?.attempted);
      const htmlUploadAttempted = Boolean(telemetry?.uploads?.html?.attempted);
      const uploadAttempted = pdfUploadAttempted || htmlUploadAttempted;

      if (driveLink) {
        console.log(`[audit] ${typeLabel} complete: ${driveLink}`);
        await sendTelegram(buildAuditReadyMessage(typeLabel, airbnbUrl, taskId, driveLink, qaErrors));
      } else if (qaErrors.length > 0 && !uploadAttempted) {
        console.warn(`[audit] ${typeLabel} generated locally but upload was skipped after QA failure`);
        await sendTelegram(buildAuditGeneratedLocallyMessage(typeLabel, airbnbUrl, taskId, qaErrors, localPdfPath));
      } else {
        console.warn(`[audit] ${typeLabel} complete but no Drive link captured`);
        await sendTelegram(buildAuditGeneratedWithoutLinkMessage(typeLabel, airbnbUrl, taskId, localPdfPath, folder));
      }
    } catch (err) {
      console.error(`[audit] ${typeLabel} failed:`, err.message);
      await sendTelegram(buildAuditFailedMessage(typeLabel, airbnbUrl, taskId, err));
    }
  }

  async function fetchUpdates() {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/getUpdates?offset=${strClinicOffset}&timeout=0`
    );
    return res.json();
  }

  function parseAuditRequest(message) {
    const text = (message.text || '').trim();
    const from = message.from?.username || message.from?.first_name || 'unknown';
    const lower = text.toLowerCase();
    const urlMatch = text.match(/https?:\/\/(?:www\.)?airbnb\.[a-z.]+\/rooms\/[^\s]+/i);
    const isFreeAudit = /free\s+audit/i.test(lower);
    const isPaidAudit = /paid\s+audit/i.test(lower);

    return { text, from, urlMatch, isFreeAudit, isPaidAudit };
  }

  async function pollUpdates() {
    if (!botToken) return;

    let data;
    try {
      data = await fetchUpdates();
      if (!data.ok) {
        console.error('[str-clinic-listener] getUpdates failed:', data.description);
        return;
      }
    } catch (err) {
      console.error('[str-clinic-listener] error:', err.message);
      return;
    }

    for (const update of data.result) {
      strClinicOffset = update.update_id + 1;
      const msg = update.message;
      if (!msg) continue;

      const { text, from, urlMatch, isFreeAudit, isPaidAudit } = parseAuditRequest(msg);

      if ((isFreeAudit || isPaidAudit) && urlMatch) {
        const airbnbUrl = urlMatch[0].replace(/[<>]/g, '').split('?')[0];
        const type = isPaidAudit ? 'paid' : 'free';

        if (isDuplicate(airbnbUrl, type)) {
          console.log(`[str-clinic-listener] Duplicate ${type} audit request ignored: ${airbnbUrl}`);
          continue;
        }

        triggerAudit(airbnbUrl, type, from).catch((err) => {
          console.error('[str-clinic-listener] triggerAudit error:', err.message);
        });
      } else if (isFreeAudit || isPaidAudit) {
        const auditType = isPaidAudit ? 'paid audit' : 'free audit';
        console.log(`[str-clinic-listener] ${auditType} keyword from ${from} but no Airbnb URL found`);
        await sendTelegram(buildMissingUrlMessage(auditType, from, text)).catch(() => {});
      }
    }
  }

  return {
    pollUpdates,
    triggerAudit,
    buildFreeAuditInput,
    buildPaidAuditInput,
  };
}

module.exports = { createStrClinicOrchestrator };
