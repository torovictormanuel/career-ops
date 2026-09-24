#!/usr/bin/env node
/**
 * error-handler-agent.mjs — Error Handler Agent (career-ops v2.0)
 *
 * Orquesta el manejo de errores en todos los agentes del pipeline:
 *   1. Clasifica el error (ErrorClassifier)
 *   2. Decide si reintentar (basado en config.yml y categoría)
 *   3. Si se agotan los reintentos y es fatal → encola en DLQ
 *   4. Si es crítico → envía alerta WhatsApp vía NotificationAgent
 *
 * Uso principal — envolver una función con retry completo:
 *   const result = await errorHandler.withRetry(
 *     () => analysisAgent.run(offers),
 *     { context: 'AnalysisAgent', type: 'analysis', item: { offerCount: offers.length } }
 *   );
 *
 * Uso simple — sólo clasificar y loguear:
 *   errorHandler.handle(err, { context: 'Discovery', type: 'discovery' });
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';

import { ErrorClassifier, CATEGORY } from './error-classifier.mjs';
import { DeadLetterQueue }           from './dead-letter-queue.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '../..');

// ── Defaults (overridden by config.yml) ───────────────────────────────────────

const DEFAULT_RETRY = {
  maxAttempts: 3,
  delaysMs:    [30_000, 120_000, 600_000],   // 30s · 2min · 10min
};

// ── ErrorHandlerAgent ─────────────────────────────────────────────────────────

export class ErrorHandlerAgent {
  /**
   * @param {object} [options]
   * @param {object}  [options.retryConfig]         Override { maxAttempts, delaysMs }
   * @param {boolean} [options.dryRun]
   * @param {boolean} [options.notifyOnFatal=true]  Send WA alert for fatal errors
   * @param {string}  [options.configPath]
   * @param {object}  [options.classifier]          Injected ErrorClassifier
   * @param {object}  [options.dlq]                 Injected DeadLetterQueue
   * @param {object}  [options.notifier]            Injected NotificationAgent (lazy)
   */
  constructor(options = {}) {
    this.dryRun         = options.dryRun          ?? false;
    this.notifyOnFatal  = options.notifyOnFatal    ?? true;
    this._configPath    = options.configPath       ?? path.join(ROOT, 'config', 'config.yml');
    this._retryOverride = options.retryConfig      ?? null;
    this._notifier      = options.notifier         ?? null;   // lazy

    this._classifier = options.classifier ?? new ErrorClassifier();
    this._dlq        = options.dlq        ?? new DeadLetterQueue({ dryRun: this.dryRun });

    this._retryConfig = null;  // lazy-loaded from config
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Wrap an async function with retry + DLQ + notification.
   *
   * @template T
   * @param {() => Promise<T>} fn         The function to execute
   * @param {object} [meta]
   * @param {string}  [meta.context]      Human-readable context ('AnalysisAgent')
   * @param {string}  [meta.type]         DLQ type ('analysis', 'discovery', ...)
   * @param {any}     [meta.item]         Payload (for DLQ)
   * @param {number}  [meta.maxAttempts]  Override retry count for this call
   * @returns {Promise<{ ok: true, result: T } | { ok: false, error: ClassifiedError, dlqId?: string }>}
   */
  async withRetry(fn, meta = {}) {
    const cfg        = this._loadRetryConfig();
    const maxAttempts = meta.maxAttempts ?? cfg.maxAttempts;
    const delays      = cfg.delaysMs;

    let lastError = null;
    let attempts  = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      try {
        const result = await fn();
        if (attempt > 1) {
          console.log(`[ErrorHandler] OK en intento ${attempt}: ${meta.context ?? ''}`);
        }
        return { ok: true, result };
      } catch (err) {
        lastError = err;
        const classified = this._classifier.classify(err);

        console.warn(
          `[ErrorHandler] Attempt ${attempt}/${maxAttempts} failed` +
          ` [${classified.category}]: ${err.message?.slice(0, 80)}`
        );

        // Non-retryable → break immediately
        if (!classified.retryable) {
          console.warn(`[ErrorHandler] Error no reintentable (${classified.category}) — abortando`);
          break;
        }

        // Wait before next attempt (skip after last attempt)
        if (attempt < maxAttempts) {
          const delay = delays[attempt - 1] ?? delays[delays.length - 1] ?? 5000;
          console.log(`[ErrorHandler] Esperando ${delay}ms antes de reintentar...`);
          await this._sleep(delay);
        }
      }
    }

    // All attempts exhausted or non-retryable
    return this._handleFinalFailure(lastError, meta, attempts);
  }

  /**
   * Classify and handle a single error (no retry — use when you already caught).
   *
   * @param {Error} error
   * @param {object} [meta]
   * @returns {ClassifiedError}
   */
  handle(error, meta = {}) {
    const classified = this._classifier.classify(error);

    console.warn(
      `[ErrorHandler] ${classified.category}: ${error.message?.slice(0, 100)}` +
      (meta.context ? ` (${meta.context})` : '')
    );

    if (classified.enqueueDlq && meta.item !== undefined) {
      this._dlq.enqueue(meta.item, error, {
        type:     meta.type     ?? 'unknown',
        context:  meta.context  ?? '',
        attempts: meta.attempts ?? 1,
        category: classified.category,
      });
    }

    if (classified.notify && this.notifyOnFatal) {
      this._sendAlert(error, meta.context ?? '').catch(() => {});
    }

    return classified;
  }

  /**
   * Expose DLQ stats for monitoring.
   *
   * @returns {{ pending, retried, resolved, ignored, total }}
   */
  dlqStats() {
    return this._dlq.stats();
  }

  /**
   * Expose pending DLQ entries.
   *
   * @returns {DlqEntry[]}
   */
  dlqPending() {
    return this._dlq.peek({ status: 'pending' });
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  async _handleFinalFailure(error, meta, attempts) {
    const classified = this._classifier.classify(error);
    let dlqId;

    if (classified.enqueueDlq || classified.fatal) {
      const entry = this._dlq.enqueue(meta.item ?? null, error, {
        type:     meta.type    ?? 'unknown',
        context:  meta.context ?? '',
        attempts,
        category: classified.category,
      });
      dlqId = entry.id;
    }

    if (classified.notify && this.notifyOnFatal) {
      await this._sendAlert(error, meta.context ?? '');
    }

    return { ok: false, error: classified, dlqId };
  }

  async _sendAlert(error, context) {
    if (this.dryRun) {
      console.log(`[ErrorHandler] [DRY-RUN] Alerta WA: ${error.message}`);
      return;
    }

    try {
      const notifier = await this._getNotifier();
      await notifier.alertError(error, context);
    } catch (notifyErr) {
      console.warn(`[ErrorHandler] No se pudo enviar alerta WA: ${notifyErr.message}`);
    }
  }

  async _getNotifier() {
    if (this._notifier) return this._notifier;
    // Lazy import to avoid circular dependency
    const { NotificationAgent } = await import('../notification/notification-agent.mjs');
    this._notifier = new NotificationAgent({ dryRun: this.dryRun });
    return this._notifier;
  }

  _loadRetryConfig() {
    if (this._retryConfig) return this._retryConfig;
    if (this._retryOverride) {
      this._retryConfig = { ...DEFAULT_RETRY, ...this._retryOverride };
      return this._retryConfig;
    }

    try {
      if (existsSync(this._configPath)) {
        const raw  = readFileSync(this._configPath, 'utf8');
        const cfg  = yaml.load(raw);
        const r    = cfg?.error_handler?.retry;
        if (r?.max_attempts) {
          this._retryConfig = {
            maxAttempts: r.max_attempts,
            delaysMs:    r.delays_ms ?? DEFAULT_RETRY.delaysMs,
          };
          return this._retryConfig;
        }
      }
    } catch {
      // Fall through to defaults
    }

    this._retryConfig = { ...DEFAULT_RETRY };
    return this._retryConfig;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── Default singleton ──────────────────────────────────────────────────────────

export const errorHandlerAgent = new ErrorHandlerAgent();
