#!/usr/bin/env node
/**
 * dead-letter-queue.mjs — Dead Letter Queue (career-ops v2.0)
 *
 * Persiste items que fallaron definitivamente (tras agotar reintentos o
 * por ser FATAL) para revisión manual o reintento posterior.
 *
 * Formato de cada entry en data/dead-letter.json:
 *   {
 *     id:          string   (uuid-like: {timestamp}-{random})
 *     type:        string   (contexto: 'discovery' | 'analysis' | 'application' | ...)
 *     item:        any      (el payload que falló, ej: { url } o ScoredOffer)
 *     error:       { message, code, category }
 *     context:     string   (info adicional: runId, agent, step)
 *     enqueuedAt:  number   (timestamp ms)
 *     attempts:    number   (cuántas veces se intentó)
 *     status:      'pending' | 'retried' | 'resolved' | 'ignored'
 *   }
 *
 * Uso:
 *   import { DeadLetterQueue } from './agents/error-handler/dead-letter-queue.mjs';
 *   const dlq = new DeadLetterQueue();
 *   dlq.enqueue({ url: 'https://...' }, error, { type: 'analysis', attempts: 3 });
 *   const pending = dlq.peek();
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '../..');

const DEFAULT_PATH    = path.join(ROOT, 'data', 'dead-letter.json');
const DEFAULT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;   // 30 days

// ── DeadLetterQueue ───────────────────────────────────────────────────────────

export class DeadLetterQueue {
  /**
   * @param {object} [options]
   * @param {string}  [options.filePath]    Override DLQ file path
   * @param {number}  [options.maxAgeMs]   Max age before purge (default 30d)
   * @param {boolean} [options.dryRun]     Don't write to disk
   */
  constructor(options = {}) {
    this.filePath  = options.filePath  ?? DEFAULT_PATH;
    this.maxAgeMs  = options.maxAgeMs  ?? DEFAULT_MAX_AGE;
    this.dryRun    = options.dryRun    ?? false;
    this._entries  = null;   // lazy-loaded
  }

  // ── Write API ─────────────────────────────────────────────────────────────────

  /**
   * Add a failed item to the DLQ.
   *
   * @param {any}    item      The payload that failed (offer URL, offer object, etc.)
   * @param {Error}  error     The error that caused the failure
   * @param {object} [meta]
   * @param {string}  [meta.type]      Agent/context type ('analysis', 'discovery', ...)
   * @param {string}  [meta.context]   Human-readable context
   * @param {number}  [meta.attempts]  How many times it was tried
   * @param {string}  [meta.category]  Classified error category
   * @returns {DlqEntry}
   */
  enqueue(item, error, meta = {}) {
    const entries = this._load();

    const entry = {
      id:         this._generateId(),
      type:       meta.type     ?? 'unknown',
      item:       this._sanitize(item),
      error: {
        message:  error?.message ?? String(error),
        code:     error?.code    ?? null,
        category: meta.category  ?? null,
      },
      context:    meta.context   ?? '',
      enqueuedAt: Date.now(),
      attempts:   meta.attempts  ?? 1,
      status:     'pending',
    };

    entries.push(entry);
    this._entries = entries;
    this._persist();

    console.log(`[DeadLetterQueue] Enqueued: ${entry.type} — ${entry.id} (${entry.error.message.slice(0, 60)})`);
    return entry;
  }

  /**
   * Update the status of a DLQ entry.
   *
   * @param {string} id
   * @param {'retried'|'resolved'|'ignored'} status
   * @returns {boolean}  true if found and updated
   */
  updateStatus(id, status) {
    const entries = this._load();
    const entry   = entries.find(e => e.id === id);
    if (!entry) return false;

    entry.status    = status;
    entry.updatedAt = Date.now();
    this._persist();
    return true;
  }

  // ── Read API ──────────────────────────────────────────────────────────────────

  /**
   * List DLQ entries, optionally filtered by status.
   *
   * @param {object} [filters]
   * @param {'pending'|'retried'|'resolved'|'ignored'} [filters.status]
   * @param {string}  [filters.type]
   * @returns {DlqEntry[]}
   */
  peek(filters = {}) {
    const entries = this._load();
    return entries.filter(e => {
      if (filters.status && e.status !== filters.status) return false;
      if (filters.type   && e.type   !== filters.type)   return false;
      return true;
    });
  }

  /**
   * Count entries by status.
   *
   * @returns {{ pending: number, retried: number, resolved: number, ignored: number, total: number }}
   */
  stats() {
    const entries = this._load();
    const counts  = { pending: 0, retried: 0, resolved: 0, ignored: 0, total: entries.length };
    for (const e of entries) {
      if (e.status in counts) counts[e.status]++;
    }
    return counts;
  }

  /**
   * Remove entries older than maxAgeMs (default 30d).
   *
   * @returns {number}  Number of entries removed
   */
  purge() {
    const entries = this._load();
    const cutoff  = Date.now() - this.maxAgeMs;
    const before  = entries.length;
    this._entries = entries.filter(e => e.enqueuedAt > cutoff);
    this._persist();
    return before - this._entries.length;
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _load() {
    if (this._entries) return this._entries;

    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf8');
        this._entries = JSON.parse(raw);
        if (!Array.isArray(this._entries)) this._entries = [];
      }
    } catch {
      this._entries = [];
    }
    this._entries = this._entries ?? [];
    return this._entries;
  }

  _persist() {
    if (this.dryRun) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this._entries, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[DeadLetterQueue] No se pudo persistir: ${err.message}`);
    }
  }

  _generateId() {
    const ts  = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 7);
    return `${ts}-${rnd}`;
  }

  _sanitize(item) {
    // Avoid storing huge objects — keep only key fields
    if (!item || typeof item !== 'object') return item;
    const { url, title, company, score, source_portal } = item;
    return { url, title, company, score, source_portal };
  }
}

// ── JSDoc types ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} DlqEntry
 * @property {string} id
 * @property {string} type
 * @property {any}    item
 * @property {{ message: string, code: string|null, category: string|null }} error
 * @property {string} context
 * @property {number} enqueuedAt
 * @property {number} attempts
 * @property {'pending'|'retried'|'resolved'|'ignored'} status
 */

// ── Default singleton ──────────────────────────────────────────────────────────

export const deadLetterQueue = new DeadLetterQueue();
