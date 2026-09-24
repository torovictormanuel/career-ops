#!/usr/bin/env node
/**
 * prioritization-engine.mjs — Prioritization Engine (career-ops v2.0)
 *
 * Toma una lista de ScoredOffer[] y las ordena por un score compuesto que
 * combina: score del LLM, rating de la empresa y antigüedad de la oferta.
 *
 * Fórmula (configurable en config.yml → pipeline.prioritization_weights):
 *   priority = score_norm × w_score
 *            + company_rating_norm × w_company
 *            + recency_score × w_recency
 *
 * Donde:
 *   score_norm           = (llm_score - 1) / 4.0         [normalizado 0–1]
 *   company_rating_norm  = glassdoor_rating / 5.0        [0 si no hay datos]
 *   recency_score        = función de antigüedad (ver _recencyScore)
 *
 * Uso:
 *   import { PrioritizationEngine } from './agents/application/prioritization-engine.mjs';
 *   const engine = new PrioritizationEngine();
 *   const sorted = engine.prioritize(scoredOffers);
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '../..');

// ── Defaults ───────────────────────────────────────────────────────────────────

const DEFAULT_WEIGHTS = {
  score:          0.70,
  company_rating: 0.20,
  recency:        0.10,
};

/** Recency tiers: [maxAgeMs, score] — checked in order, first match wins */
const RECENCY_TIERS = [
  [1  * 24 * 60 * 60 * 1000, 1.0],   // < 1 day  → 1.0
  [3  * 24 * 60 * 60 * 1000, 0.8],   // < 3 days → 0.8
  [7  * 24 * 60 * 60 * 1000, 0.5],   // < 7 days → 0.5
  [14 * 24 * 60 * 60 * 1000, 0.3],   // < 14 days → 0.3
  [Infinity,                  0.1],   // older    → 0.1
];

// ── PrioritizationEngine ──────────────────────────────────────────────────────

export class PrioritizationEngine {
  /**
   * @param {object} [options]
   * @param {object} [options.weights]  Override { score, company_rating, recency }
   * @param {string} [options.configPath]  Path to config.yml (auto-loads weights)
   */
  constructor(options = {}) {
    if (options.weights) {
      this.weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    } else {
      this.weights = this._loadWeightsFromConfig(
        options.configPath ?? path.join(ROOT, 'config', 'config.yml')
      );
    }

    this._validateWeights(this.weights);
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Prioritize and sort a list of scored offers.
   *
   * @param {ScoredOffer[]} offers
   * @returns {PrioritizedOffer[]}  Same offers, enriched with priority_score, sorted desc
   */
  prioritize(offers) {
    if (!offers || offers.length === 0) return [];

    return offers
      .map(offer => ({
        ...offer,
        priority_score:  this._computePriority(offer),
        priority_factors: this._computeFactors(offer),
      }))
      .sort((a, b) => b.priority_score - a.priority_score);
  }

  /**
   * Return only the top N offers after prioritization.
   *
   * @param {ScoredOffer[]} offers
   * @param {number} n
   * @returns {PrioritizedOffer[]}
   */
  top(offers, n) {
    return this.prioritize(offers).slice(0, n);
  }

  // ── Private: scoring ─────────────────────────────────────────────────────────

  _computePriority(offer) {
    const w = this.weights;

    const scoreNorm   = this._normalizeScore(offer.score ?? 1);
    const ratingNorm  = this._normalizeRating(offer.company_info?.glassdoor_rating ?? null);
    const recency     = this._recencyScore(offer.date_found ?? offer.scored_at ?? null);

    return (
      scoreNorm  * w.score          +
      ratingNorm * w.company_rating +
      recency    * w.recency
    );
  }

  _computeFactors(offer) {
    return {
      score_norm:    +(this._normalizeScore(offer.score ?? 1).toFixed(3)),
      rating_norm:   +(this._normalizeRating(offer.company_info?.glassdoor_rating ?? null).toFixed(3)),
      recency_score: +(this._recencyScore(offer.date_found ?? offer.scored_at ?? null).toFixed(3)),
    };
  }

  /** Map LLM score [1.0–5.0] → [0.0–1.0] */
  _normalizeScore(score) {
    const clamped = Math.min(5.0, Math.max(1.0, score));
    return (clamped - 1.0) / 4.0;
  }

  /** Map Glassdoor rating [0–5] → [0.0–1.0]; null → 0.5 (neutral, no penalty) */
  _normalizeRating(rating) {
    if (rating === null || rating === undefined) return 0.5;
    return Math.min(1.0, Math.max(0.0, rating / 5.0));
  }

  /** Map age of offer → recency score [0.0–1.0] */
  _recencyScore(dateStr) {
    if (!dateStr) return 0.5;  // unknown age → neutral

    let date;
    try {
      date = new Date(dateStr);
      if (isNaN(date.getTime())) return 0.5;
    } catch {
      return 0.5;
    }

    const ageMs = Date.now() - date.getTime();

    for (const [maxAgeMs, score] of RECENCY_TIERS) {
      if (ageMs < maxAgeMs) return score;
    }
    return 0.1;  // fallback (shouldn't reach here due to Infinity tier)
  }

  // ── Private: config loading ──────────────────────────────────────────────────

  _loadWeightsFromConfig(configPath) {
    try {
      const raw    = readFileSync(configPath, 'utf8');
      const config = yaml.load(raw);
      const w      = config?.pipeline?.prioritization_weights;

      if (w?.score !== undefined) {
        return {
          score:          w.score          ?? DEFAULT_WEIGHTS.score,
          company_rating: w.company_rating ?? DEFAULT_WEIGHTS.company_rating,
          recency:        w.recency        ?? DEFAULT_WEIGHTS.recency,
        };
      }
    } catch {
      // Config not found or parse error → use defaults
    }
    return { ...DEFAULT_WEIGHTS };
  }

  _validateWeights(weights) {
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    if (Math.abs(total - 1.0) > 0.01) {
      console.warn(`[PrioritizationEngine] Weights sum to ${total.toFixed(3)}, expected 1.0 — using as-is`);
    }
  }
}

// ── JSDoc types ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} PrioritizedOffer
 * @extends ScoredOffer
 * @property {number} priority_score      - Composite priority score [0.0–1.0]
 * @property {object} priority_factors    - Debug: { score_norm, rating_norm, recency_score }
 */

// ── Default singleton ──────────────────────────────────────────────────────────

export const prioritizationEngine = new PrioritizationEngine();
