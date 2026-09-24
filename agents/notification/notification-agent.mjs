#!/usr/bin/env node
/**
 * notification-agent.mjs — Notification Agent (career-ops v2.0)
 *
 * Recibe resultados del Application Agent y los comunica por WhatsApp.
 * Responsabilidades:
 *   1. Filtrar ofertas aptas para notificación (score >= threshold)
 *   2. Deduplicar vs. historial de notificaciones ya enviadas
 *   3. Formatear mensajes (oferta individual o digest)
 *   4. Enviar vía WhatsAppSender (n8n webhook)
 *   5. Registrar en data/notifications-sent.json
 *
 * Tipos de notificación:
 *   - notifyOffers(offers)    → envía top N ofertas como mensajes individuales
 *   - dailyDigest(offers, stats) → envía un solo mensaje resumen del día
 *   - weeklyReport(metrics)   → envía reporte semanal de métricas
 *   - alertError(err, ctx)    → alerta de error crítico
 *
 * Uso:
 *   import { NotificationAgent } from './agents/notification/notification-agent.mjs';
 *   const agent = new NotificationAgent({ dryRun: true });
 *   await agent.notifyOffers(prioritizedOffers);
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { MessageFormatter } from './message-formatter.mjs';
import { WhatsAppSender }   from './whatsapp-sender.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '../..');

// ── Constants ──────────────────────────────────────────────────────────────────

const SENT_LOG_PATH  = path.join(ROOT, 'data', 'notifications-sent.json');
const SENT_LOG_TTL   = 7 * 24 * 60 * 60 * 1000;   // 7 days

// ── NotificationAgent ─────────────────────────────────────────────────────────

export class NotificationAgent {
  /**
   * @param {object} [options]
   * @param {number}  [options.scoreThreshold=3.5]  Min score to notify
   * @param {number}  [options.maxOffersPerRun=5]   Max individual offer messages per run
   * @param {boolean} [options.dryRun=false]        No actual sends
   * @param {string}  [options.sentLogPath]         Override sent log path
   * @param {object}  [options.formatter]           Injected MessageFormatter
   * @param {object}  [options.sender]              Injected WhatsAppSender
   */
  constructor(options = {}) {
    this.scoreThreshold  = options.scoreThreshold  ?? 3.5;
    this.maxOffersPerRun = options.maxOffersPerRun ?? 5;
    this.dryRun          = options.dryRun          ?? false;
    this.sentLogPath     = options.sentLogPath     ?? SENT_LOG_PATH;

    this._formatter = options.formatter ?? new MessageFormatter();
    this._sender    = options.sender    ?? new WhatsAppSender({ dryRun: this.dryRun });

    this._sentLog   = null;   // lazy-loaded
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Notify top qualifying offers (individual messages).
   *
   * @param {PrioritizedOffer[]} offers   Already sorted by priority
   * @param {string} [runId]
   * @returns {Promise<NotificationResult>}
   */
  async notifyOffers(offers, runId = 'notify') {
    const startTime = Date.now();
    const stats     = { received: offers.length, alreadySent: 0, sent: 0, errors: 0, skipped: 0 };

    const eligible = offers.filter(o => {
      if ((o.score ?? 0) < this.scoreThreshold) { stats.skipped++; return false; }
      if (this._alreadySent(o.url)) { stats.alreadySent++; return false; }
      return true;
    });

    console.log(`[${runId}] NotificationAgent: ${eligible.length} elegibles para notificar (de ${offers.length})`);

    const toSend = eligible.slice(0, this.maxOffersPerRun);

    for (const offer of toSend) {
      const message = this._formatter.formatOffer(offer);
      const result  = await this._sender.send(message);

      if (result.sent) {
        this._markSent(offer.url);
        stats.sent++;
        console.log(`[${runId}]   ✓ Notificada: ${offer.company} — ${offer.title}`);
      } else {
        stats.errors++;
        console.warn(`[${runId}]   ✗ Error al enviar: ${offer.company} — ${result.error}`);
      }
    }

    this._persistSentLog();

    return {
      type:  'offers',
      runId,
      stats: { ...stats, durationMs: Date.now() - startTime },
    };
  }

  /**
   * Send a daily digest message (single summary).
   *
   * @param {ScoredOffer[]} topOffers   Offers above threshold, sorted
   * @param {object} analysisStats      AnalysisResult.stats
   * @param {string} [runId]
   * @returns {Promise<NotificationResult>}
   */
  async dailyDigest(topOffers, analysisStats = {}, runId = 'digest') {
    const startTime = Date.now();
    console.log(`[${runId}] NotificationAgent: enviando daily digest (${topOffers.length} ofertas)`);

    const message = this._formatter.formatDigest(topOffers, analysisStats);
    const result  = await this._sender.send(message);

    const stats = {
      type:      'digest',
      offersInDigest: topOffers.length,
      sent:      result.sent,
      error:     result.error ?? null,
      durationMs: Date.now() - startTime,
    };

    console.log(`[${runId}] Digest ${result.sent ? 'enviado ✓' : 'FALLÓ ✗'}`);
    return { type: 'digest', runId, stats };
  }

  /**
   * Send the weekly metrics report.
   *
   * @param {TrackerMetrics} metrics   From ApplicationTracker.readMetrics()
   * @param {string} [runId]
   * @returns {Promise<NotificationResult>}
   */
  async weeklyReport(metrics, runId = 'weekly') {
    const startTime = Date.now();
    console.log(`[${runId}] NotificationAgent: enviando weekly report`);

    const message = this._formatter.formatWeeklyReport(metrics);
    const result  = await this._sender.send(message);

    console.log(`[${runId}] Weekly report ${result.sent ? 'enviado ✓' : 'FALLÓ ✗'}`);
    return {
      type:  'weekly',
      runId,
      stats: { sent: result.sent, error: result.error ?? null, durationMs: Date.now() - startTime },
    };
  }

  /**
   * Send a critical error alert.
   *
   * @param {Error} err
   * @param {string} [context]
   * @returns {Promise<NotificationResult>}
   */
  async alertError(err, context = '') {
    const message = this._formatter.formatError(err, context);
    const result  = await this._sender.send(message);
    return {
      type:  'error_alert',
      stats: { sent: result.sent, error: result.error ?? null },
    };
  }

  // ── Sent log (dedup) ──────────────────────────────────────────────────────────

  _alreadySent(url) {
    if (!url) return false;
    const log = this._loadSentLog();
    const entry = log[url];
    if (!entry) return false;

    // Expire entries older than TTL
    if (Date.now() - entry.sentAt > SENT_LOG_TTL) {
      delete log[url];
      return false;
    }
    return true;
  }

  _markSent(url) {
    if (!url) return;
    const log = this._loadSentLog();
    log[url] = { sentAt: Date.now() };
    this._sentLog = log;
  }

  _loadSentLog() {
    if (this._sentLog) return this._sentLog;

    try {
      if (existsSync(this.sentLogPath)) {
        this._sentLog = JSON.parse(readFileSync(this.sentLogPath, 'utf8'));
      }
    } catch {
      // Corrupt file → start fresh
    }
    this._sentLog = this._sentLog ?? {};
    return this._sentLog;
  }

  _persistSentLog() {
    if (this.dryRun || !this._sentLog) return;

    // Prune expired entries before saving
    const now = Date.now();
    for (const [url, entry] of Object.entries(this._sentLog)) {
      if (now - entry.sentAt > SENT_LOG_TTL) delete this._sentLog[url];
    }

    try {
      const dir = path.dirname(this.sentLogPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.sentLogPath, JSON.stringify(this._sentLog, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[NotificationAgent] No se pudo guardar sent log: ${err.message}`);
    }
  }
}

// ── JSDoc types ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} NotificationResult
 * @property {'offers'|'digest'|'weekly'|'error_alert'} type
 * @property {string} [runId]
 * @property {object} stats
 */

// ── CLI entry point ───────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const mode   = args.find(a => !a.startsWith('--')) ?? 'offers';

  const agent = new NotificationAgent({ dryRun });

  const testOffer = {
    url:                  'https://example.com/jobs/1',
    title:                'Data Analyst',
    company:              'Nubank',
    location:             'Remote - LATAM',
    score:                4.2,
    apply_recommendation: true,
    tags:                 ['power-bi', 'sql', 'remote', 'fintech'],
    company_info:         { glassdoor_rating: 4.5 },
    priority_score:       0.82,
  };

  if (mode === 'digest') {
    agent.dailyDigest([testOffer], { received: 10, scored: 3, errors: 0 }, 'cli-test')
      .then(r => console.log(JSON.stringify(r, null, 2)));
  } else if (mode === 'weekly') {
    agent.weeklyReport({ total: 12, byStatus: { Evaluated: 8, Sent: 3, Interview: 1 }, avgScore: 4.1, topCompanies: [{ company: 'Nubank', count: 2 }], scoreDistribution: { '3.0-4.0': 4, '4.0-5.0': 8 } }, 'cli-test')
      .then(r => console.log(JSON.stringify(r, null, 2)));
  } else {
    agent.notifyOffers([testOffer], 'cli-test')
      .then(r => console.log(JSON.stringify(r, null, 2)));
  }
}

// ── Default singleton ──────────────────────────────────────────────────────────

export const notificationAgent = new NotificationAgent();
