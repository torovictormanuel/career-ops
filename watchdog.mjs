#!/usr/bin/env node
/**
 * watchdog.mjs — Disparo de respaldo para career-ops
 *
 * Corre como tarea de Windows Task Scheduler cada 30 minutos.
 * Si el bot de WhatsApp está vivo: dispara el scan.
 * Si está caído: registra el scan perdido en data/missed-scans.log
 *
 * Uso: node watchdog.mjs
 *
 * Registrar en Task Scheduler:
 *   Programa: node
 *   Argumentos: "C:\Users\victo\OneDrive\Escritorio\Automatizacion de Busquedas\career-ops\watchdog.mjs"
 *   Disparar: cada 30 minutos, Lun-Vie 8:00-19:00
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const BOT_PORT   = process.env.WA_BOT_PORT ?? '3099';
const LOG_DIR    = join(__dirname, 'logs');
const LOG_PATH   = join(LOG_DIR, 'watchdog.log');
const MISSED_LOG = join(__dirname, 'data', 'missed-scans.log');

function appendLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const existing = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8') : '';
    const lines = existing.split('\n').filter(Boolean);
    lines.push(line);
    // Mantener solo las últimas 500 líneas
    writeFileSync(LOG_PATH, lines.slice(-500).join('\n') + '\n', 'utf8');
  } catch { /* non-fatal */ }
}

async function checkHealth() {
  try {
    const res = await fetch(`http://127.0.0.1:${BOT_PORT}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: data.ok === true, waStatus: data.status ?? 'unknown' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function triggerScan() {
  try {
    const res = await fetch(`http://127.0.0.1:${BOT_PORT}/run-scan`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  appendLog('Watchdog iniciado');

  const health = await checkHealth();

  if (!health.ok) {
    const reason = health.reason ?? health.waStatus ?? 'sin respuesta';
    appendLog(`BOT NO DISPONIBLE (${reason}) — scan no disparado`);

    // Registrar scan perdido para auditoría
    try {
      mkdirSync(join(__dirname, 'data'), { recursive: true });
      const entry = `${new Date().toISOString()} | bot_down | ${reason}\n`;
      const prev = existsSync(MISSED_LOG) ? readFileSync(MISSED_LOG, 'utf8') : '';
      writeFileSync(MISSED_LOG, prev + entry, 'utf8');
    } catch { /* non-fatal */ }

    process.exit(1);
  }

  appendLog(`Bot activo (WA: ${health.waStatus}) — disparando scan`);

  const triggered = await triggerScan();
  if (triggered) {
    appendLog('Scan disparado correctamente');
  } else {
    appendLog('Fallo al disparar scan — el bot puede haberse caído en ese momento');
    process.exit(1);
  }
}

main().catch(err => {
  appendLog(`Error fatal: ${err.message}`);
  process.exit(1);
});
