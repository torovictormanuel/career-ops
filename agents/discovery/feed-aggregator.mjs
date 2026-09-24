/**
 * feed-aggregator.mjs — Feed Aggregator (career-ops v2.0)
 *
 * Responsabilidad: consolidar los resultados de todos los scrapers
 * en un array normalizado único, listo para el Dedup Engine.
 *
 * NO evalúa calidad, NO filtra por score, NO llama al LLM.
 * Solo: merge + normalización de campos + estadísticas de ejecución.
 */

import { normalizeUrl } from '../data-manager/dedup-engine.mjs';

// ── FeedAggregator ────────────────────────────────────────────────────────────

export class FeedAggregator {
  constructor() {
    this._results = []; // ScraperResult[] acumulados en esta ejecución
  }

  /**
   * Agrega el resultado de un scraper al feed.
   * @param {import('./scraper-interface.mjs').ScraperResult} result
   */
  addResult(result) {
    this._results.push(result);
  }

  /**
   * Consolida todos los resultados acumulados en un array de ofertas únicas.
   * La deduplicación aquí es solo por URL dentro del batch actual
   * (la dedup histórica la hace el DedupEngine).
   *
   * @returns {{
   *   offers: import('./scraper-interface.mjs').NormalizedOffer[],
   *   stats:  FeedStats
   * }}
   */
  aggregate() {
    const seenUrls  = new Set();
    const allOffers = [];
    const stats     = this._buildStats();

    for (const result of this._results) {
      if (result.status !== 'ok') continue;

      for (const offer of result.offers) {
        // Dedup intra-batch por URL normalizada
        const normalized = normalizeUrl(offer.url);
        if (seenUrls.has(normalized)) {
          stats.intraBatchDuplicates++;
          continue;
        }
        seenUrls.add(normalized);

        // Sanitizar campos: nunca null, siempre string
        allOffers.push({
          url:           normalized,
          title:         sanitize(offer.title),
          company:       sanitize(offer.company),
          location:      sanitize(offer.location),
          date_found:    offer.date_found ?? new Date().toISOString(),
          source_portal: sanitize(offer.source_portal),
        });
      }
    }

    stats.totalOffers = allOffers.length;

    return { offers: allOffers, stats };
  }

  /**
   * Resetea el acumulador para la próxima ejecución.
   */
  reset() {
    this._results = [];
  }

  // ── Privado ─────────────────────────────────────────────────────────────────

  _buildStats() {
    const stats = {
      portalsScanned:       0,
      portalsSuccess:       0,
      portalsError:         0,
      portalsSkipped:       0,   // circuit breaker OPEN
      rawOffersTotal:       0,
      intraBatchDuplicates: 0,
      totalOffers:          0,   // después de dedup intra-batch
      byPortal:             {},
      errors:               [],
      totalDurationMs:      0,
    };

    for (const result of this._results) {
      stats.portalsScanned++;
      stats.totalDurationMs += result.duration ?? 0;

      if (result.status === 'skipped') {
        stats.portalsSkipped++;
        stats.byPortal[result.portal] = { status: 'skipped', offers: 0 };
      } else if (result.status === 'error') {
        stats.portalsError++;
        stats.errors.push({ portal: result.portal, error: result.error });
        stats.byPortal[result.portal] = { status: 'error', offers: 0, error: result.error };
      } else {
        stats.portalsSuccess++;
        const count = result.offers?.length ?? 0;
        stats.rawOffersTotal += count;
        stats.byPortal[result.portal] = { status: 'ok', offers: count, duration: result.duration };
      }
    }

    return stats;
  }
}

/**
 * @typedef {object} FeedStats
 * @property {number}   portalsScanned
 * @property {number}   portalsSuccess
 * @property {number}   portalsError
 * @property {number}   portalsSkipped
 * @property {number}   rawOffersTotal
 * @property {number}   intraBatchDuplicates
 * @property {number}   totalOffers
 * @property {object}   byPortal
 * @property {Array}    errors
 * @property {number}   totalDurationMs
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Sanitiza un valor a string no-null.
 * @param {*} v
 * @returns {string}
 */
function sanitize(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}
