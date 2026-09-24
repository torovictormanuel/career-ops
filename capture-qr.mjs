#!/usr/bin/env node
// Captura el QR de WhatsApp y lo guarda como PNG en data/qr.png
import { createRequire } from 'module';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const require    = createRequire(import.meta.url);
const __dirname  = dirname(fileURLToPath(import.meta.url));
const BASE       = __dirname;

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const SESSION_DIR = join(BASE, 'data', 'whatsapp-session');
const CHROMIUM    = 'C:\\Users\\victo\\AppData\\Local\\ms-playwright\\chromium-1217\\chrome-win64\\chrome.exe';

if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  },
});

let qrSaved = false;

client.on('qr', async (qr) => {
  if (qrSaved) return;
  qrSaved = true;
  const outPath = join(BASE, 'data', 'qr.png');
  await QRCode.toFile(outPath, qr, { width: 600, margin: 2 });
  console.log(`QR_SAVED:${outPath}`);
  // Open in Windows Photos so the user sees it large enough to scan
  spawnSync('cmd', ['/c', 'start', '', outPath], { shell: false });
});

client.on('ready', () => {
  console.log('ALREADY_AUTHENTICATED');
  process.exit(0);
});

client.on('auth_failure', () => {
  console.log('AUTH_FAILURE');
  process.exit(1);
});

client.initialize();

// Timeout: 120s
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 120000);
