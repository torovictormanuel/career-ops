#!/usr/bin/env node
/**
 * whatsapp-sender.mjs — WhatsApp Sender via n8n Webhook (career-ops v2.0)
 *
 * Envía mensajes de WhatsApp usando el webhook de n8n existente (v1.x).
 * El webhook recibe { message, phone? } y lo despacha al bot de WhatsApp.
 *
 * Config (en orden de prioridad):
 *   1. options.webhookUrl (inyectado por tests o constructor)
 *   2. WHATSAPP_WEBHOOK_URL env var
 *   3. config.yml → notification.whatsapp.webhook_url
 *
 * Rate limiting: mínimo 1.1s entre mensajes (WhatsApp rechaza rafagas).
 * Retry: hasta 3 intentos con backoff exponencial.
 *
 * Uso:
 *   import { WhatsAppSender } from './agents/notification/whatsapp-sender.mjs';
 *   const sender = new WhatsAppSender();
 *   await sender.send('Mensaje de prueba');
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '../..');

// ── Defaults ───────────────────────────────────────────────────────────────────

const DEFAULTS = {
  maxRetries:      3,
  retryDelaysMs:   [2000, 8000, 30000],
  minIntervalMs:   1100,   // WhatsApp rate limit: ~1 msg/sec
  timeoutMs:       10000,
  configPath:      path.join(ROOT, 'config', 'config.yml'),
};

// ── WhatsAppSender ────────────────────────────────────────────────────────────

export class WhatsAppSender {
  /**
   * @param {object} [options]
   * @param {string}   [options.webhookUrl]    Override webhook URL
   * @param {number}   [options.maxRetries]
   * @param {number[]} [options.retryDelaysMs]
   * @param {number}   [options.minIntervalMs]
   * @param {number}   [options.timeoutMs]
   * @param {boolean}  [options.dryRun]        Log only, don't send
   * @param {Function} [options._fetch]        Injected fetch (for tests)
   */
  constructor(options = {}) {
    this.webhookUrl    = options.webhookUrl    ?? null;  // lazy-resolved on first send
    this.maxRetries    = options.maxRetries    ?? DEFAULTS.maxRetries;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULTS.retryDelaysMs;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULTS.minIntervalMs;
    this.timeoutMs     = options.timeoutMs     ?? DEFAULTS.timeoutMs;
    this.dryRun        = options.dryRun        ?? false;
    this._fetchFn      = options._fetch        ?? null;

    this._lastSentAt   = 0;
    this._configCache  = null;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Send a WhatsApp message.
   *
   * @param {string} message   Text to send
   * @param {string} [phone]   Override destination phone (default: from config)
   * @returns {Promise<SendResult>}
   */
  async send(message, phone = null) {
    if (!message?.trim()) {
      return { sent: false, error: 'Empty message', attempts: 0 };
    }

    const url = this._resolveWebhookUrl();

    if (this.dryRun) {
      console.log(`[WhatsAppSender] [DRY-RUN] Mensaje (${message.length} chars):\n${message.slice(0, 200)}${message.length > 200 ? '…' : ''}`);
      return { sent: true, dryRun: true, attempts: 0 };
    }

    if (!url) {
      const err = new SenderError('No se configuró WHATSAPP_WEBHOOK_URL', 'CONFIG_ERROR');
      console.warn('[WhatsAppSender]', err.message);
      return { sent: false, error: err.message, attempts: 0 };
    }

    await this._rateLimit();

    let lastError = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this._post(url, { message, phone });
        this._lastSentAt = Date.now();
        console.log(`[WhatsAppSender] Mensaje enviado (attempt ${attempt}, ${message.length} chars)`);
        return { sent: true, status: result.status, attempts: attempt };
      } catch (err) {
        lastError = err;
        console.warn(`[WhatsAppSender] Attempt ${attempt} failed: ${err.message}`);

        if (attempt < this.maxRetries) {
          const delay = this.retryDelaysMs[attempt - 1] ?? 5000;
          await this._sleep(delay);
        }
      }
    }

    return {
      sent:     false,
      error:    lastError?.message ?? 'Unknown error',
      attempts: this.maxRetries,
    };
  }

  /**
   * Send multiple messages with rate limiting between each.
   *
   * @param {string[]} messages
   * @param {string}   [phone]
   * @returns {Promise<SendResult[]>}
   */
  async sendAll(messages, phone = null) {
    const results = [];
    for (const msg of messages) {
      results.push(await this.send(msg, phone));
    }
    return results;
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  async _post(url, body) {
    const fetchFn = this._fetchFn ?? fetch;

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetchFn(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });

      if (!response.ok) {
        throw new SenderError(
          `HTTP ${response.status} from webhook`,
          'HTTP_ERROR'
        );
      }

      return { status: response.status };
    } finally {
      clearTimeout(timer);
    }
  }

  async _rateLimit() {
    const elapsed = Date.now() - this._lastSentAt;
    if (elapsed < this.minIntervalMs) {
      await this._sleep(this.minIntervalMs - elapsed);
    }
  }

  _resolveWebhookUrl() {
    if (this.webhookUrl) return this.webhookUrl;

    // 1. Env var
    if (process.env.WHATSAPP_WEBHOOK_URL) {
      this.webhookUrl = process.env.WHATSAPP_WEBHOOK_URL;
      return this.webhookUrl;
    }

    // 2. config.yml
    try {
      if (!this._configCache && existsSync(DEFAULTS.configPath)) {
        const raw = readFileSync(DEFAULTS.configPath, 'utf8');
        this._configCache = yaml.load(raw);
      }
      const url = this._configCache?.notification?.whatsapp?.webhook_url;
      if (url) {
        this.webhookUrl = url;
        return url;
      }
    } catch {
      // Config not found or parse error — return null
    }

    return null;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── SenderError ───────────────────────────────────────────────────────────────

export class SenderError extends Error {
  constructor(message, code = 'SEND_ERROR') {
    super(message);
    this.name = 'SenderError';
    this.code = code;
  }
}

/**
 * @typedef {object} SendResult
 * @property {boolean} sent
 * @property {boolean} [dryRun]
 * @property {number}  [status]    HTTP status
 * @property {string}  [error]
 * @property {number}  attempts
 */

// ── Default singleton ──────────────────────────────────────────────────────────

export const whatsappSender = new WhatsAppSender();
