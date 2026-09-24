#!/usr/bin/env node
/**
 * analysis-agent.mjs — Analysis Agent (career-ops v2.0)
 *
 * Orquesta el pipeline completo de análisis de ofertas laborales:
 *
 *   NormalizedOffer[]
 *     → [1] Pre-Filter (rule-based, < 5ms, zero cost)
 *     → [2] JD Extractor (fetch HTML, clean text)
 *     → [3] LLM Scorer (Claude API, JSON validated)
 *     → [4] Company Enricher (cache-first, optional)
 *     → ScoredOffer[]
 *
 * Principios de diseño:
 *   - Concurrencia controlada (default: 3 offers en paralelo, respeta rate limits)
 *   - Fail-per-offer: un error en una oferta no detiene el batch
 *   - Dry-run: no llama a la API de Claude si dryRun=true
 *   - Logging estructurado: stats al final + errores clasificados
 *
 * Uso programático:
 *   import { AnalysisAgent } from './agents/analysis/analysis-agent.mjs';
 *   const agent = new AnalysisAgent();
 *   const { scored, stats } = await agent.run(newOffers, runId);
 *
 * Uso CLI (testing):
 *   node agents/analysis/analysis-agent.mjs --dry-run
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { JdExtractor }      from './jd-extractor.mjs';
import { PreFilter }        from './pre-filter.mjs';
import { LlmScorer }        from './llm-scorer.mjs';
import { CompanyEnricher }  from './company-enricher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '../..');

// ── AnalysisAgent ──────────────────────────────────────────────────────────────

export class AnalysisAgent {
  /**
   * @param {object} [options]
   * @param {boolean} [options.dryRun=false]       Skip LLM API calls
   * @param {number}  [options.concurrency=3]      Parallel offers to process
   * @param {boolean} [options.skipEnrich=false]   Skip company enrichment (faster)
   * @param {number}  [options.scoreThreshold]     Min score to include in output
   * @param {object}  [options.jdExtractor]        JdExtractor instance override
   * @param {object}  [options.preFilter]          PreFilter instance override
   * @param {object}  [options.llmScorer]          LlmScorer instance override
   * @param {object}  [options.companyEnricher]    CompanyEnricher instance override
   */
  constructor(options = {}) {
    this.dryRun         = options.dryRun         ?? false;
    this.concurrency    = options.concurrency     ?? 3;
    this.skipEnrich     = options.skipEnrich      ?? false;
    this.scoreThreshold = options.scoreThreshold  ?? 0;  // 0 = include all

    this._jdExtractor     = options.jdExtractor     ?? new JdExtractor();
    this._preFilter       = options.preFilter       ?? new PreFilter();
    this._llmScorer       = options.llmScorer       ?? new LlmScorer();
    this._companyEnricher = options.companyEnricher ?? new CompanyEnricher();
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Run the full analysis pipeline on a batch of normalized offers.
   *
   * @param {NormalizedOffer[]} offers
   * @param {string} [runId]  Run identifier for logging
   * @returns {Promise<AnalysisResult>}
   */
  async run(offers, runId = 'analysis') {
    const startTime = Date.now();
    const stats     = this._emptyStats(offers.length);

    console.log(`[${runId}] AnalysisAgent: procesando ${offers.length} ofertas (concurrency=${this.concurrency}, dryRun=${this.dryRun})`);

    // ── Step 1: Pre-Filter (synchronous, < 5ms per offer) ──────────────────────
    const { passed: toScore, rejected: preFiltered } = this._preFilter.evaluateBatch(
      offers.map(o => ({ ...o, jd: '' }))  // Pre-filter operates on metadata only
    );

    stats.preFiltered = preFiltered.length;
    stats.toScore     = toScore.length;

    if (preFiltered.length > 0) {
      console.log(`[${runId}] Pre-Filter descartó ${preFiltered.length} ofertas:`);
      const byRule = {};
      for (const { rule } of preFiltered) {
        byRule[rule] = (byRule[rule] ?? 0) + 1;
      }
      for (const [rule, count] of Object.entries(byRule)) {
        console.log(`  - ${rule}: ${count}`);
      }
    }

    if (toScore.length === 0) {
      console.log(`[${runId}] No quedan ofertas para puntuar.`);
      return this._buildResult([], stats, startTime, preFiltered);
    }

    // ── Steps 2–4: JD Extract → LLM Score → Company Enrich (concurrent) ──────

    // Map toScore back to original offers (pre-filter gets metadata-only copies)
    const offersByUrl = new Map(offers.map(o => [o.url, o]));
    const passedOffers = toScore.map(o => offersByUrl.get(o.url) ?? o);

    const scored  = [];
    const errors  = [];

    await this._runConcurrent(passedOffers, async (offer) => {
      try {
        const result = await this._analyzeOffer(offer, runId);

        if (result.status === 'scored') {
          if (result.offer.score >= this.scoreThreshold) {
            scored.push(result.offer);
          }
          stats.scored++;
        } else {
          stats[result.status] = (stats[result.status] ?? 0) + 1;
          errors.push({ url: offer.url, status: result.status, note: result.note });
        }
      } catch (err) {
        stats.errors++;
        errors.push({ url: offer.url, status: 'UNEXPECTED_ERROR', note: err.message });
        console.error(`[${runId}] Error inesperado en ${offer.url}: ${err.message}`);
      }
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    stats.aboveThreshold = scored.length;
    stats.durationMs     = Date.now() - startTime;

    // ── Summary log ────────────────────────────────────────────────────────────
    console.log(`\n[${runId}] AnalysisAgent completado en ${stats.durationMs}ms`);
    console.log(`  Recibidas:     ${stats.received}`);
    console.log(`  Pre-filtradas: ${stats.preFiltered}`);
    console.log(`  A puntuar:     ${stats.toScore}`);
    console.log(`  Puntuadas:     ${stats.scored}`);
    console.log(`  Sobre umbral:  ${stats.aboveThreshold} (score >= ${this.scoreThreshold})`);
    console.log(`  SKIP_404:      ${stats.SKIP_404 ?? 0}`);
    console.log(`  SKIP_NO_JD:    ${stats.SKIP_NO_JD ?? 0}`);
    console.log(`  SKIP_LOGIN:    ${stats.SKIP_LOGIN_WALL ?? 0}`);
    console.log(`  Errores:       ${stats.errors}`);

    return this._buildResult(scored, stats, startTime, preFiltered, errors);
  }

  // ── Private: per-offer pipeline ──────────────────────────────────────────────

  async _analyzeOffer(offer, runId) {
    // ── Step 2: JD Extraction ─────────────────────────────────────────────────
    const jdResult = await this._jdExtractor.extract(offer.url);

    if (jdResult.status !== 'ok') {
      console.log(`[${runId}]   SKIP ${jdResult.status}: ${offer.url} (${jdResult.note})`);
      return { status: jdResult.status, note: jdResult.note };
    }

    // ── Pre-Filter on JD content (second pass with JD text) ───────────────────
    const contentFilter = this._preFilter.evaluate({
      title:    offer.title,
      jd:       jdResult.text,
      location: offer.location,
      company:  offer.company,
    });

    if (!contentFilter.pass) {
      console.log(`[${runId}]   SKIP pre-filter (JD): ${offer.url} — ${contentFilter.reason}`);
      return { status: 'SKIP_PRE_FILTER', note: contentFilter.reason };
    }

    // ── Step 3: LLM Scoring ───────────────────────────────────────────────────
    let scoredOffer;

    if (this.dryRun) {
      // Dry-run: return a dummy score without calling the API
      scoredOffer = this._dummyScoredOffer(offer);
      console.log(`[${runId}]   [DRY-RUN] ${offer.company} — ${offer.title}`);
    } else {
      try {
        scoredOffer = await this._llmScorer.score(offer, jdResult.text);
        console.log(`[${runId}]   score=${scoredOffer.score} ${offer.company} — ${offer.title}`);
      } catch (err) {
        console.warn(`[${runId}]   SCORE_ERROR: ${offer.url} — ${err.message}`);
        return { status: 'SCORE_ERROR', note: err.message };
      }
    }

    // ── Step 4: Company Enrichment (optional, fail-open) ─────────────────────
    if (!this.skipEnrich) {
      try {
        const companyInfo = await this._companyEnricher.enrich(offer.company, offer.url);
        scoredOffer.company_info = companyInfo;
      } catch {
        scoredOffer.company_info = null;  // fail-open
      }
    }

    return { status: 'scored', offer: scoredOffer };
  }

  // ── Private: concurrency pool ────────────────────────────────────────────────

  async _runConcurrent(items, fn) {
    const queue   = [...items];
    const workers = Array.from({ length: Math.min(this.concurrency, items.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item) await fn(item);
      }
    });
    await Promise.all(workers);
  }

  // ── Private: helpers ─────────────────────────────────────────────────────────

  _dummyScoredOffer(offer) {
    return {
      url:           offer.url,
      title:         offer.title,
      company:       offer.company,
      location:      offer.location,
      date_found:    offer.date_found,
      source_portal: offer.source_portal,

      score:                0,
      justification:        '[DRY-RUN] LLM call skipped',
      tags:                 ['dry-run'],
      apply_recommendation: false,
      score_factors: {
        stack_match:      'no-especificado',
        seniority_match:  'no-especificado',
        modality_match:   'no-especificado',
        salary_signal:    'no-especificado',
      },
      scored_at: new Date().toISOString(),
      model:     'dry-run',
    };
  }

  _emptyStats(receivedCount) {
    return {
      received:        receivedCount,
      preFiltered:     0,
      toScore:         0,
      scored:          0,
      aboveThreshold:  0,
      errors:          0,
      durationMs:      0,
    };
  }

  _buildResult(scored, stats, startTime, preFiltered = [], errors = []) {
    return {
      scored,
      stats: { ...stats, durationMs: Date.now() - startTime },
      preFiltered,
      errors,
    };
  }
}

// ── JSDoc types ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} NormalizedOffer
 * @property {string} url
 * @property {string} title
 * @property {string} company
 * @property {string} location
 * @property {string} date_found
 * @property {string} source_portal
 */

/**
 * @typedef {object} AnalysisResult
 * @property {ScoredOffer[]} scored       - All scored offers (sorted by score desc)
 * @property {object}        stats        - Processing statistics
 * @property {Array}         preFiltered  - Offers rejected by pre-filter
 * @property {Array}         errors       - Offers that errored during analysis
 */

// ── CLI entry point ───────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args    = process.argv.slice(2);
  const dryRun  = args.includes('--dry-run');

  // Test with a couple of dummy offers
  const testOffers = [
    {
      url:           'local:tests/fixtures/sample-jd.txt',
      title:         'Data Analyst',
      company:       'TestCo',
      location:      'Remote',
      date_found:    new Date().toISOString(),
      source_portal: 'test',
    },
  ];

  const agent = new AnalysisAgent({ dryRun, skipEnrich: true });
  agent.run(testOffers, 'cli-test').then(({ scored, stats }) => {
    console.log('\n── Resultado ──');
    console.log(JSON.stringify({ stats, count: scored.length }, null, 2));
    if (scored.length > 0) {
      console.log('\nTop offer:', JSON.stringify(scored[0], null, 2));
    }
  }).catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
