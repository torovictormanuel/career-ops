#!/usr/bin/env node
/**
 * whatsapp-bot.mjs — WhatsApp bot for career-ops notifications + apply confirm
 *
 * What it does:
 *   1. Connects to WhatsApp using your personal number (scan QR once)
 *   2. Sends you a message for each high-score offer
 *   3. Listens for your reply: "1" = prepare application, "2" = skip
 *   4. On "1": opens browser, fills form, sends screenshot
 *   5. On "ENVIAR": submits the application
 *
 * Usage:
 *   node whatsapp-bot.mjs          → start bot (scan QR first time)
 *   node whatsapp-bot.mjs --setup  → force QR re-scan
 *
 * HTTP API (called by batch-auto.mjs):
 *   POST http://localhost:3099/notify
 *   Body: { "to": "<your number>@c.us", "offers": [...] }
 */

import { createRequire }    from 'module';
import { createServer }      from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname }     from 'path';
import { fileURLToPath }     from 'url';
import { spawnSync, spawn }  from 'child_process';

// Load .env
const __envDir = dirname(fileURLToPath(import.meta.url));
const __envPath = join(__envDir, '.env');
if (existsSync(__envPath)) {
  for (const line of readFileSync(__envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();  // .env always wins over inherited env
  }
}

const require    = createRequire(import.meta.url);
const __dirname  = dirname(fileURLToPath(import.meta.url));
const BASE       = __dirname;

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_PORT   = parseInt(process.env.WA_BOT_PORT ?? '3099');
const MY_NUMBER  = process.env.WA_MY_NUMBER;          // e.g. "5491153371839"
const SESSION_DIR = join(BASE, 'data', 'whatsapp-session');
const CHROMIUM   = 'C:\\Users\\victo\\AppData\\Local\\ms-playwright\\chromium-1217\\chrome-win64\\chrome.exe';

if (!MY_NUMBER) {
  console.error('ERROR: Set WA_MY_NUMBER in .env (your number without + or spaces, e.g. 5491153371839)');
  process.exit(1);
}

const MY_JID = `${MY_NUMBER}@c.us`;

// ── State: pending offers waiting for reply ───────────────────────────────────
// Map of offer key → offer object (kept in memory)
const pendingOffers = new Map(); // key → { company, role, score, url, reportFile }

// ── WA connection state ───────────────────────────────────────────────────────
let waConnected = false;
let httpServerStarted = false;

// ── WhatsApp client ───────────────────────────────────────────────────────────
if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });

const client = new Client({
  authStrategy : new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer    : {
    executablePath : CHROMIUM,
    headless       : true,
    args           : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  },
});

client.on('qr', (qr) => {
  console.log('\n━━━ ESCANEA ESTE QR CON WHATSAPP ━━━━━━━━━━━━━━━━━━━━');
  qrcode.generate(qr, { small: true });
  console.log('Abrí WhatsApp → Dispositivos vinculados → Vincular un dispositivo');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});

// Helper: send a message and track its ID so the bot ignores it
async function send(text) {
  const m = await client.sendMessage(MY_JID, text);
  botSentIds.add(m.id._serialized);
  return m;
}

client.on('ready', () => {
  waConnected = true;
  console.log(`✅ WhatsApp bot listo. Enviando mensajes a ${MY_NUMBER}`);
  if (!httpServerStarted) {
    httpServerStarted = true;
    startHttpServer();
  } else {
    console.log('🔄 WhatsApp reconectado — HTTP server ya activo.');
  }
});

client.on('auth_failure', (msg) => {
  console.error('❌ WhatsApp auth failed:', msg);
  process.exit(1);
});

client.on('disconnected', (reason) => {
  waConnected = false;
  console.log('WhatsApp desconectado:', reason);
  console.log('Reiniciando en 10 segundos...');
  setTimeout(() => client.initialize(), 10000);
});

// Track message IDs sent by the bot so we don't react to our own messages
const botSentIds = new Set();

// ── Incoming message handler ──────────────────────────────────────────────────
client.on('message_create', async (msg) => {
  // In self-chat, both sent and received have fromMe=true.
  // Ignore messages the bot itself sent (tracked by ID).
  if (botSentIds.has(msg.id._serialized)) return;
  // Only handle messages in the self-chat
  if (msg.from !== MY_JID && msg.to !== MY_JID) return;

  const body = msg.body.trim().toUpperCase();
  console.log(`📨 Mensaje recibido: "${msg.body}"`);

  if (body === '1' || body === 'SI' || body === 'S') {
    // Find the most recent pending offer
    const keys = [...pendingOffers.keys()];
    if (keys.length === 0) {
      await send('⚠️ No hay ofertas pendientes de confirmación.');
      return;
    }
    const key   = keys[keys.length - 1];
    const offer = pendingOffers.get(key);
    pendingOffers.delete(key);

    await send(`⏳ Preparando postulación para *${offer.company}*...\nEsto puede tomar 1-2 minutos.`);
    await prepareApplication(offer);

  } else if (body === '2' || body === 'NO' || body === 'N') {
    const keys = [...pendingOffers.keys()];
    if (keys.length > 0) {
      const key   = keys[keys.length - 1];
      const offer = pendingOffers.get(key);
      pendingOffers.delete(key);
      await send(`⏭️ Salteando *${offer.company}* | ${offer.role}`);
    }

  } else if (body === 'ENVIAR' || body === 'SUBMIT' || body === 'OK') {
    // Final confirmation to submit
    const submitFile = join(BASE, 'data', '.pending-submit.json');
    if (!existsSync(submitFile)) {
      await send('⚠️ No hay formulario listo para enviar.');
      return;
    }
    const pending = JSON.parse(readFileSync(submitFile, 'utf8'));
    await send(`🚀 Enviando postulación a *${pending.company}*...`);
    await submitApplication(pending);

  } else if (body === 'STATUS' || body === 'ESTADO') {
    const count = pendingOffers.size;
    await send(count > 0
      ? `📋 ${count} oferta(s) esperando confirmación:\n${[...pendingOffers.values()].map(o => `• ${o.company} | ${o.role} (${o.score}/5)`).join('\n')}`
      : '✅ No hay ofertas pendientes.'
    );

  } else if (body === 'HELP' || body === 'AYUDA' || body === '?') {
    await send(
      `*Career-Ops Bot*\n\n` +
      `*1* o *SI* → Preparar postulación\n` +
      `*2* o *NO* → Saltear oferta\n` +
      `*ENVIAR* → Confirmar envío del formulario\n` +
      `*STATUS* → Ver ofertas pendientes\n` +
      `*AYUDA* → Este menú`
    );
  }
});

// ── Prepare application (fill form) ──────────────────────────────────────────
async function prepareApplication(offer) {
  try {
    const prompt =
      `Open the browser and navigate to this job application URL: ${offer.url}\n` +
      `Fill out the application form with the candidate's information from cv.md and config/profile.yml.\n` +
      `SALARY: If the form asks for salary expectations in pesos (pretensión salarial / remuneración pretendida), ` +
      `enter: 1600000 in the minimum field and 2000000 in the maximum field. ` +
      `If it is a single text field, type: 1.600.000 a 2.000.000 (Brutos).\n` +
      `Do NOT click Submit yet.\n` +
      `Take a screenshot with Playwright and save it to data/apply-screenshot.png\n` +
      `Then output a JSON: {"status":"ready","screenshot":"data/apply-screenshot.png","url":"${offer.url}","company":"${offer.company}","role":"${offer.role}"}\n` +
      `If the form cannot be accessed, requires login, or the URL is invalid, output: {"status":"error","message":"<reason>"}`;

    const result = await runAsync('claude', ['--print'], { input: prompt, timeout: 120000 });
    const output = result.stdout ?? '';
    const jsonMatch = output.match(/\{[\s\S]*?"status"[\s\S]*?\}/);

    if (jsonMatch) {
      const res = JSON.parse(jsonMatch[0]);
      if (res.status === 'ready') {
        // Save pending submit state
        writeFileSync(join(BASE, 'data', '.pending-submit.json'), JSON.stringify({
          company: offer.company, role: offer.role, url: offer.url,
        }), 'utf8');

        // Send screenshot if exists
        const screenshotPath = join(BASE, 'data', 'apply-screenshot.png');
        let msgText = `✅ *Formulario listo para ${offer.company}*\n\n` +
                      `Revisá el formulario en tu PC (ya está abierto).\n\n` +
                      `Respondé *ENVIAR* para confirmar el envío\n` +
                      `o *NO* para cancelar.`;

        if (existsSync(screenshotPath)) {
          const { MessageMedia } = require('whatsapp-web.js');
          const media = MessageMedia.fromFilePath(screenshotPath);
          await client.sendMessage(MY_JID, media, { caption: msgText });
        } else {
          await client.sendMessage(MY_JID, msgText);
        }

      } else {
        // ── Error con URL incluida para postulación manual ──
        await client.sendMessage(MY_JID,
          `⚠️ No pude acceder al formulario de *${offer.company}*.\n\n` +
          `Motivo: ${res.message ?? 'Error desconocido'}\n\n` +
          `🔗 Postulá manualmente:\n${offer.url}`
        );
      }
    } else {
      await client.sendMessage(MY_JID,
        `⚠️ No pude preparar el formulario de *${offer.company}* automáticamente.\n\n` +
        `🔗 Postulá manualmente:\n${offer.url}`
      );
    }

  } catch (err) {
    console.error('prepareApplication error:', err.message);
    await client.sendMessage(MY_JID,
      `❌ Error al preparar postulación para *${offer.company}*: ${err.message}\n\n` +
      `🔗 Postulá manualmente:\n${offer.url}`
    );
  }
}

// ── Submit application ────────────────────────────────────────────────────────
async function submitApplication(pending) {
  try {
    const prompt =
      `The job application form for ${pending.company} at ${pending.url} is already filled and open in the browser.\n` +
      `Click the Submit/Apply button to send the application.\n` +
      `Then output JSON: {"status":"submitted","company":"${pending.company}","role":"${pending.role}"}\n` +
      `If submit fails: {"status":"error","message":"<reason>"}`;

    const result = await runAsync('claude', ['--print'], { input: prompt, timeout: 60000 });
    const output     = result.stdout ?? '';
    const jsonMatch  = output.match(/\{[\s\S]*?"status"[\s\S]*?\}/);
    const submitFile = join(BASE, 'data', '.pending-submit.json');
    try { if (existsSync(submitFile)) require('fs').unlinkSync(submitFile); } catch {}

    if (jsonMatch) {
      const res = JSON.parse(jsonMatch[0]);
      if (res.status === 'submitted') {
        // ── Confirmación de postulación exitosa ──
        await client.sendMessage(MY_JID,
          `✅✅ *¡POSTULACIÓN ENVIADA CON ÉXITO!* ✅✅\n\n` +
          `🏢 *Empresa:* ${pending.company}\n` +
          `💼 *Puesto:* ${pending.role}\n` +
          `🔗 *URL:* ${pending.url}\n\n` +
          `📧 Revisá tu correo para la confirmación de recepción.\n` +
          `📋 La oferta fue marcada como *Applied* en tu tracker.`
        );
      } else {
        await client.sendMessage(MY_JID,
          `⚠️ No pude enviar la postulación a *${pending.company}*.\n\n` +
          `Motivo: ${res.message ?? 'Error desconocido'}\n\n` +
          `🔗 Intentá manualmente:\n${pending.url}`
        );
      }
    } else {
      await client.sendMessage(MY_JID,
        `⚠️ Resultado incierto para *${pending.company}*.\n\n` +
        `🔗 Verificá manualmente:\n${pending.url}`
      );
    }

  } catch (err) {
    await client.sendMessage(MY_JID,
      `❌ Error al enviar postulación a *${pending.company ?? 'empresa'}*: ${err.message}\n\n` +
      `🔗 Intentá manualmente:\n${pending.url ?? '(URL no disponible)'}`
    );
  }
}

// ── Async process runner (non-blocking, supports stdin + timeout) ─────────────
function runAsync(cmd, args, opts = {}) {
  const { input, timeout: timeoutMs, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const chunks = { stdout: [], stderr: [] };
    const proc = spawn(cmd, args, { cwd: BASE, shell: true, ...spawnOpts });
    proc.stdout?.on('data', d => chunks.stdout.push(d));
    proc.stderr?.on('data', d => chunks.stderr.push(d));
    proc.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({
        status: code,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
      });
    });
    proc.on('error', err => { if (timer) clearTimeout(timer); reject(err); });
    if (input != null) { proc.stdin?.write(input); proc.stdin?.end(); }
    let timer;
    if (timeoutMs) timer = setTimeout(() => { proc.kill(); reject(new Error(`Timeout after ${timeoutMs}ms`)); }, timeoutMs);
  });
}

// ── Run full scan + evaluate pipeline ────────────────────────────────────────
async function runScanAndEvaluate() {
  await send('🔍 *Career-Ops*: Iniciando búsqueda de vacantes...');

  const scanResult = await runAsync('node', ['scan.mjs']);

  if (scanResult.status !== 0) {
    await send(`⚠️ Error en scan:\n${scanResult.stderr.slice(0, 300)}`);
    return;
  }

  const newAdded = scanResult.stdout.match(/New offers added:\s*(\d+)/);
  const addedCount = newAdded ? parseInt(newAdded[1]) : '?';

  // Scan job boards (LinkedIn, Computrabajo, ZonaJobs) — non-fatal: failure doesn't abort pipeline
  const boardsResult = await runAsync('node', ['scan-boards.mjs']);
  const boardsAdded = boardsResult.stdout.match(/New offers added:\s*(\d+)/);
  const boardsCount = boardsAdded ? parseInt(boardsAdded[1]) : 0;
  if (boardsResult.status !== 0) {
    console.error('scan-boards error (non-fatal):', boardsResult.stderr.slice(0, 200));
  }

  const totalAdded = (typeof addedCount === 'number' ? addedCount : 0) + boardsCount;
  await send(`✅ Scan completado — ${totalAdded} nueva(s) vacante(s) añadidas al pipeline.\n⏳ Evaluando...`);

  const batchResult = await runAsync('node', ['batch-auto.mjs']);

  if (batchResult.status !== 0) {
    await send(`⚠️ Error en evaluación:\n${batchResult.stderr.slice(0, 300)}`);
    return;
  }

  const out = batchResult.stdout;
  const noOffers = out.includes('0 high-score offers') || out.includes('Nothing to evaluate') || out.includes('nothing to evaluate');
  if (noOffers) {
    await send('📭 Búsqueda completada. No hay nuevas vacantes que cumplan el score mínimo ahora.');
  }
  // If there ARE offers, batch-auto.mjs already calls /notify which sends WA messages
}

// ── HTTP server (receives triggers from batch-auto.mjs and n8n) ──────────────
function startHttpServer() {
  const server = createServer(async (req, res) => {
    // n8n / external trigger: run the full scan + evaluate + notify flow
    if (req.method === 'POST' && req.url === '/run-scan') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Scan iniciado' }));
      runScanAndEvaluate().catch(err => {
        console.error('run-scan error:', err.message);
        send(`❌ Error en pipeline: ${err.message}`).catch(() => {});
      });
      return;
    }

    // Health check for n8n to verify the bot is alive
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: waConnected, status: waConnected ? 'connected' : 'disconnected', pending: pendingOffers.size }));
      return;
    }

    // Status-only notification (no qualifying offers)
    if (req.method === 'POST' && req.url === '/notify-status') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { message } = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          if (waConnected && message) {
            const m = await client.sendMessage(MY_JID, message);
            botSentIds.add(m.id._serialized);
          }
        } catch (err) {
          res.writeHead(400); res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/notify') {
      res.writeHead(404); res.end(); return;
    }

    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { offers } = JSON.parse(body);   // [{ company, role, score, url, reportFile }]

        if (!waConnected) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'WhatsApp disconnected' }));
          console.error('⚠️  /notify rejected: WhatsApp not connected');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: offers.length }));

        for (const offer of offers) {
          const key = `${offer.company}-${offer.role}`.toLowerCase().replace(/\s+/g, '-');
          pendingOffers.set(key, offer);

          const scoreBar = '⭐'.repeat(Math.round(offer.score)) + '☆'.repeat(5 - Math.round(offer.score));
          const msgText =
            `🎯 *Nueva oferta compatible*\n\n` +
            `🏢 *${offer.company}*\n` +
            `💼 ${offer.role}\n` +
            `${scoreBar} *${offer.score}/5*\n` +
            (offer.location ? `📍 ${offer.location}\n` : '') +
            `\n${offer.one_liner ?? ''}\n\n` +
            `🔗 ${offer.url}\n\n` +
            `Respondé:\n*1* → Que Claude prepare la postulación\n*2* → Saltear`;

          const sent = await client.sendMessage(MY_JID, msgText);
          botSentIds.add(sent.id._serialized);
          // Small delay between multiple offers
          await new Promise(r => setTimeout(r, 1500));
        }

      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
  });

  server.listen(BOT_PORT, '127.0.0.1', () => {
    console.log(`🌐 HTTP endpoint: http://127.0.0.1:${BOT_PORT}/notify`);
    console.log(`\nBot listo. Mensajes de ofertas llegarán a tu WhatsApp.`);
    console.log(`Desde tu teléfono podés responder: 1=aplicar, 2=saltear, ENVIAR=confirmar, STATUS=ver pendientes\n`);
  });
}

// ── Auto-restart on uncaught errors (Puppeteer context destruction, etc.) ─────
let restartTimer = null;

function scheduleRestart(reason, delayMs = 15000) {
  if (restartTimer) return; // already scheduled
  console.error(`[bot] Error: ${reason}`);
  console.error(`[bot] Reiniciando en ${delayMs / 1000} seg...`);
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    try { await client.destroy(); } catch {}
    try { client.initialize(); } catch (e) { scheduleRestart(e.message); }
  }, delayMs);
}

process.on('uncaughtException', (err) => {
  // ProtocolError from Puppeteer during WhatsApp Web navigation — safe to retry
  if (err.message?.includes('Protocol error') || err.message?.includes('Execution context')) {
    scheduleRestart(err.message);
  } else {
    console.error('[bot] uncaughtException:', err.message);
    scheduleRestart(err.message, 20000);
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  if (msg.includes('Protocol error') || msg.includes('Execution context') || msg.includes('Target closed')) {
    scheduleRestart(msg);
  } else {
    console.error('[bot] unhandledRejection:', msg);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
console.log('Iniciando WhatsApp bot...');
try {
  client.initialize();
} catch (e) {
  scheduleRestart(e.message);
}
