/**
 * dedup-engine.mjs — Deduplication Engine (career-ops v2.0)
 *
 * Responsabilidad única: determinar si una URL ya fue procesada.
 * NO evalúa, NO scrapea, NO notifica.
 *
 * Estrategia de lookup (por orden de precedencia):
 *   1. dedup-index.json  → lookup O(1) por hash de URL normalizada
 *   2. scan-history.tsv  → backward compat con v1.x
 *   3. pipeline.md       → ofertas pendientes en cola
 *   4. applications.md   → ofertas ya aplicadas
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Configuración ────────────────────────────────────────────────────────────

const DEFAULT_PATHS = {
  dedupIndex:   'data/dedup-index.json',
  scanHistory:  'data/scan-history.tsv',
  pipeline:     'data/pipeline.md',
  applications: 'data/applications.md',
};

// Tiempo de vida: URLs se "olvidan" pasado este tiempo (para re-escanear archivos)
const DEFAULT_TTL_DAYS = 90;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normaliza una URL eliminando parámetros UTM y trailing slashes
 * para evitar duplicados por variaciones de tracking.
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url.trim());
    // Eliminar parámetros de tracking comunes
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'source'].forEach(p => {
      u.searchParams.delete(p);
    });
    // Normalizar: lowercase hostname, sin trailing slash en pathname
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, '')}${u.search}`;
  } catch {
    return url.trim(); // Si no es URL válida, devolver tal cual
  }
}

/**
 * Genera un hash SHA-256 corto (12 chars) de la URL normalizada.
 * @param {string} url
 * @returns {string}
 */
function hashUrl(url) {
  return createHash('sha256').update(normalizeUrl(url)).digest('hex').slice(0, 12);
}

// ── DedupEngine ───────────────────────────────────────────────────────────────

export class DedupEngine {
  /**
   * @param {object} options
   * @param {string} [options.indexPath]        - Path al dedup-index.json
   * @param {string} [options.scanHistoryPath]  - Path al scan-history.tsv (backward compat)
   * @param {string} [options.pipelinePath]     - Path al pipeline.md
   * @param {string} [options.applicationsPath] - Path al applications.md
   * @param {number} [options.ttlDays]          - TTL en días para entradas del índice
   */
  constructor(options = {}) {
    this.paths = {
      dedupIndex:   resolve(options.indexPath        ?? DEFAULT_PATHS.dedupIndex),
      scanHistory:  resolve(options.scanHistoryPath  ?? DEFAULT_PATHS.scanHistory),
      pipeline:     resolve(options.pipelinePath     ?? DEFAULT_PATHS.pipeline),
      applications: resolve(options.applicationsPath ?? DEFAULT_PATHS.applications),
    };
    this.ttlDays = options.ttlDays ?? DEFAULT_TTL_DAYS;
    this._index = null; // lazy load
  }

  // ── Índice JSON ─────────────────────────────────────────────────────────────

  /**
   * Carga el índice JSON en memoria (lazy, solo la primera vez).
   * @returns {{ _meta: object, entries: object }}
   */
  _loadIndex() {
    if (this._index) return this._index;

    if (!existsSync(this.paths.dedupIndex)) {
      this._index = {
        _meta: {
          schema_version: '2.0.0',
          created_at: new Date().toISOString(),
          total_entries: 0,
        },
        entries: {},
      };
    } else {
      try {
        this._index = JSON.parse(readFileSync(this.paths.dedupIndex, 'utf-8'));
      } catch {
        console.warn('[DedupEngine] dedup-index.json corrupto — iniciando índice vacío');
        this._index = { _meta: { schema_version: '2.0.0', total_entries: 0 }, entries: {} };
      }
    }
    return this._index;
  }

  /**
   * Persiste el índice en disco.
   */
  _saveIndex() {
    if (!this._index) return;
    this._index._meta.total_entries = Object.keys(this._index.entries).length;
    this._index._meta.last_updated = new Date().toISOString();
    writeFileSync(this.paths.dedupIndex, JSON.stringify(this._index, null, 2), 'utf-8');
  }

  // ── API pública ─────────────────────────────────────────────────────────────

  /**
   * ¿Ya se procesó esta URL?
   * Busca en: índice JSON → scan-history.tsv → pipeline.md → applications.md
   *
   * @param {string} url
   * @returns {{ seen: boolean, source?: string, date?: string, status?: string }}
   */
  isSeen(url) {
    const hash = hashUrl(url);
    const index = this._loadIndex();

    // 1. Buscar en índice JSON (más rápido)
    if (index.entries[hash]) {
      const entry = index.entries[hash];
      // Verificar TTL
      if (this.ttlDays > 0) {
        const daysSinceSeen = (Date.now() - new Date(entry.date_seen).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceSeen > this.ttlDays) {
          return { seen: false }; // Expirado → procesar de nuevo
        }
      }
      return { seen: true, source: 'dedup-index', date: entry.date_seen, status: entry.status };
    }

    // 2. Backward compat: scan-history.tsv
    if (existsSync(this.paths.scanHistory)) {
      const normalUrl = normalizeUrl(url);
      const lines = readFileSync(this.paths.scanHistory, 'utf-8').split('\n');
      for (const line of lines.slice(1)) {
        const cols = line.split('\t');
        if (cols[0] && normalizeUrl(cols[0]) === normalUrl) {
          return { seen: true, source: 'scan-history.tsv', date: cols[1], status: cols[5] ?? 'added' };
        }
      }
    }

    // 3. pipeline.md
    if (existsSync(this.paths.pipeline)) {
      const text = readFileSync(this.paths.pipeline, 'utf-8');
      const normalUrl = normalizeUrl(url);
      for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
        if (normalizeUrl(match[1]) === normalUrl) {
          return { seen: true, source: 'pipeline.md', status: 'pending' };
        }
      }
    }

    // 4. applications.md
    if (existsSync(this.paths.applications)) {
      const text = readFileSync(this.paths.applications, 'utf-8');
      const normalUrl = normalizeUrl(url);
      for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
        if (normalizeUrl(match[0]) === normalUrl) {
          return { seen: true, source: 'applications.md', status: 'applied' };
        }
      }
    }

    return { seen: false };
  }

  /**
   * Registra una URL como procesada en el índice JSON.
   *
   * @param {string} url
   * @param {object} meta - Metadata adicional
   * @param {string} [meta.source_portal]  - Portal de origen (linkedin, getonboard, etc.)
   * @param {string} [meta.company]        - Nombre de la empresa
   * @param {string} [meta.title]          - Título del rol
   * @param {string} [meta.status]         - Estado: 'added' | 'skip_no_jd' | 'scored' | 'notified' | 'applied'
   */
  markSeen(url, meta = {}) {
    const hash = hashUrl(url);
    const index = this._loadIndex();

    index.entries[hash] = {
      url_hash: hash,
      url: normalizeUrl(url),
      source_portal: meta.source_portal ?? 'unknown',
      company: meta.company ?? null,
      title: meta.title ?? null,
      date_seen: new Date().toISOString(),
      status: meta.status ?? 'added',
    };

    this._saveIndex();
  }

  /**
   * Filtra un batch de URLs devolviendo solo las nuevas (no vistas).
   *
   * @param {Array<{ url: string, [key: string]: any }>} offers
   * @returns {{ newOffers: Array, duplicates: number }}
   */
  filterNew(offers) {
    const newOffers = [];
    let duplicates = 0;

    for (const offer of offers) {
      const result = this.isSeen(offer.url);
      if (result.seen) {
        duplicates++;
      } else {
        newOffers.push(offer);
      }
    }

    return { newOffers, duplicates };
  }

  /**
   * Estadísticas del índice.
   * @returns {{ total: number, byPortal: object, byStatus: object }}
   */
  stats() {
    const index = this._loadIndex();
    const entries = Object.values(index.entries);
    const byPortal = {};
    const byStatus = {};

    for (const entry of entries) {
      byPortal[entry.source_portal] = (byPortal[entry.source_portal] ?? 0) + 1;
      byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
    }

    return { total: entries.length, byPortal, byStatus };
  }
}

// ── Export singleton por defecto ──────────────────────────────────────────────
export const dedup = new DedupEngine();

// ── Helpers exportados ────────────────────────────────────────────────────────
export { normalizeUrl, hashUrl };
