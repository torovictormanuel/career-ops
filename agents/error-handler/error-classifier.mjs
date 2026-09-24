#!/usr/bin/env node
/**
 * error-classifier.mjs — Error Classifier (career-ops v2.0)
 *
 * Clasifica errores en categorías para decidir si se deben reintentar,
 * encolar en DLQ o notificar como críticos.
 *
 * Categorías:
 *   RATE_LIMIT  → 429, "rate limit", "too many requests" — esperar y reintentar
 *   NETWORK     → ECONNREFUSED, ENOTFOUND, ETIMEDOUT, fetch failed — reintentar
 *   TIMEOUT     → AbortError, timeout — reintentar
 *   SERVER_ERR  → 5xx — reintentar
 *   AUTH        → 401, 403 — FATAL (configuración incorrecta)
 *   NOT_FOUND   → 404 — SKIP (no reintentar, no DLQ)
 *   CONFIG      → CONFIG_ERROR — FATAL
 *   VALIDATION  → schema/parsing errors — SKIP (datos malos)
 *   FATAL       → errores desconocidos graves — DLQ + notificar
 *   UNKNOWN     → no clasificado — reintentar 1 vez
 *
 * Uso:
 *   import { ErrorClassifier } from './agents/error-handler/error-classifier.mjs';
 *   const cls = new ErrorClassifier();
 *   const { category, retryable, fatal } = cls.classify(error);
 */

// ── Category constants ─────────────────────────────────────────────────────────

export const CATEGORY = {
  RATE_LIMIT:  'RATE_LIMIT',
  NETWORK:     'NETWORK',
  TIMEOUT:     'TIMEOUT',
  SERVER_ERR:  'SERVER_ERR',
  AUTH:        'AUTH',
  NOT_FOUND:   'NOT_FOUND',
  CONFIG:      'CONFIG',
  VALIDATION:  'VALIDATION',
  FATAL:       'FATAL',
  UNKNOWN:     'UNKNOWN',
};

/** Per-category behaviour */
const CATEGORY_META = {
  RATE_LIMIT: { retryable: true,  fatal: false, enqueueDlq: false, notify: false },
  NETWORK:    { retryable: true,  fatal: false, enqueueDlq: false, notify: false },
  TIMEOUT:    { retryable: true,  fatal: false, enqueueDlq: false, notify: false },
  SERVER_ERR: { retryable: true,  fatal: false, enqueueDlq: false, notify: false },
  AUTH:       { retryable: false, fatal: true,  enqueueDlq: true,  notify: true  },
  NOT_FOUND:  { retryable: false, fatal: false, enqueueDlq: false, notify: false },
  CONFIG:     { retryable: false, fatal: true,  enqueueDlq: true,  notify: true  },
  VALIDATION: { retryable: false, fatal: false, enqueueDlq: false, notify: false },
  FATAL:      { retryable: false, fatal: true,  enqueueDlq: true,  notify: true  },
  UNKNOWN:    { retryable: true,  fatal: false, enqueueDlq: false, notify: false },
};

// ── ErrorClassifier ───────────────────────────────────────────────────────────

export class ErrorClassifier {
  /**
   * Classify an error and return its category + behaviour flags.
   *
   * @param {Error|object} error
   * @returns {ClassifiedError}
   */
  classify(error) {
    const category = this._detectCategory(error);
    const meta     = CATEGORY_META[category] ?? CATEGORY_META.UNKNOWN;

    return {
      category,
      ...meta,
      message:  error?.message ?? String(error),
      code:     error?.code    ?? null,
      httpStatus: error?.status ?? error?.httpStatus ?? null,
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _detectCategory(err) {
    if (!err) return CATEGORY.UNKNOWN;

    const msg    = (err.message ?? '').toLowerCase();
    const code   = (err.code   ?? '').toLowerCase();
    const status = err.status ?? err.httpStatus ?? err.statusCode ?? null;
    const name   = (err.name   ?? '').toLowerCase();

    // By error code from our agents
    if (code === 'config_error')      return CATEGORY.CONFIG;
    if (code === 'api_error')         return CATEGORY.SERVER_ERR;
    if (code === 'score_error' ||
        code === 'generation_error')  return CATEGORY.VALIDATION;
    if (code === 'skip_404')          return CATEGORY.NOT_FOUND;
    if (code === 'http_error') {
      if (status) return this._fromHttpStatus(status);
    }

    // By HTTP status
    if (status) return this._fromHttpStatus(status);

    // By error name
    if (name === 'aborterror')       return CATEGORY.TIMEOUT;
    if (name === 'typeerror' && msg.includes('fetch')) return CATEGORY.NETWORK;

    // By message patterns
    if (msg.includes('rate limit') ||
        msg.includes('too many requests') ||
        msg.includes('quota'))       return CATEGORY.RATE_LIMIT;

    if (msg.includes('timeout') ||
        msg.includes('timed out'))   return CATEGORY.TIMEOUT;

    if (msg.includes('econnrefused') ||
        msg.includes('enotfound') ||
        msg.includes('econnreset') ||
        msg.includes('network') ||
        msg.includes('fetch failed')) return CATEGORY.NETWORK;

    if (msg.includes('unauthorized') ||
        msg.includes('forbidden') ||
        msg.includes('api key'))     return CATEGORY.AUTH;

    if (msg.includes('not found') ||
        msg.includes('404'))         return CATEGORY.NOT_FOUND;

    if (msg.includes('invalid json') ||
        msg.includes('parse error') ||
        msg.includes('schema'))      return CATEGORY.VALIDATION;

    // By Node.js syscall codes
    if (code === 'econnrefused' ||
        code === 'enotfound' ||
        code === 'econnreset' ||
        code === 'etimedout')        return CATEGORY.NETWORK;

    return CATEGORY.UNKNOWN;
  }

  _fromHttpStatus(status) {
    const s = Number(status);
    if (s === 429)              return CATEGORY.RATE_LIMIT;
    if (s === 401 || s === 403) return CATEGORY.AUTH;
    if (s === 404)              return CATEGORY.NOT_FOUND;
    if (s >= 500 && s < 600)   return CATEGORY.SERVER_ERR;
    return CATEGORY.UNKNOWN;
  }
}

// ── JSDoc types ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ClassifiedError
 * @property {string}  category     - One of CATEGORY.*
 * @property {boolean} retryable    - Should be retried
 * @property {boolean} fatal        - Requires human attention
 * @property {boolean} enqueueDlq   - Should go to Dead Letter Queue
 * @property {boolean} notify       - Should trigger WhatsApp alert
 * @property {string}  message
 * @property {string|null} code
 * @property {number|null} httpStatus
 */

// ── Default singleton ──────────────────────────────────────────────────────────

export const errorClassifier = new ErrorClassifier();
