#!/usr/bin/env node
/**
 * application-agent.mjs — Application Agent (career-ops v2.0)
 *
 * Recibe ScoredOffer[] del Analysis Agent y:
 *   1. Filtra por score_threshold_apply y apply_recommendation
 *   2. Verifica que la empresa+rol no esté ya en el tracker (no duplicar)
 *   3. Prioriza usando PrioritizationEngine (score × 0.7 + rating × 0.2 + recency × 0.1)
 *   4. Para las top N: genera carta de presentación (CoverLetterGenerator)
 *   5. Registra en tracker (TSV → batch/tracker-additions/)
 *   6. Retorna ApplicationResult con resumen completo
 *
 * Principios:
 *   - NEVER auto-submits: genera la carta y la encola, el usuario revisa
 *   - Quality over quantity: solo ofrece con apply_recommendation=true
 *   - Dry-run: no llama a Claude ni escribe archivos si dryRun=true
 *
 * Uso programático:
 *   import { ApplicationAgent } from './agents/application/application-agent.mjs';
 *   const agent = new ApplicationAgent({ scoreThreshold: 3.5 });
 *   const result = await agent.run(scoredOffers, runId);
 *
 * Uso CLI:
 *   node agents/application/application-agent.mjs --dry-run
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { PrioritizationEngine } from './prioritization-engine.mjs';
import { ApplicationTracker }   from './tracker.mjs';
import { CoverLetterGenerator } from './cover-letter-generator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '../..');

// ── ApplicationAgent ──────────────────────────────────────────────────────────

export class ApplicationAgent {
  /**
   * @param {object} [options]
   * @param {number}  [options.scoreThreshold=3.5]    Min score to enqueue
   * @param {boolean} [options.requireRecommendation=true]  Filter by apply_recommendation
   * @param {number}  [options.coverLetterTopN=5]     Generate cover letters for top N offers
   * @param {boolean} [options.skipCoverLetter=false] Skip cover letter generation
   * @param {boolean} [options.skipDuplicateCheck=false] Skip tracker duplicate check
   * @param {boolean} [options.dryRun=false]          No API calls, no file writes
   * @param {object}  [options.prioritizationEngine]
   * @param {object}  [options.tracker]
   * @param {object}  [options.coverLetterGenerator]
   */
  constructor(options = {}) {
    this.scoreThreshold        = options.scoreThreshold        ?? 3.5;
    this.requireRecommendation = options.requireRecommendation ?? true;
    this.coverLetterTopN       = options.coverLetterTopN       ?? 5;
    this.skipCoverLetter       = options.skipCoverLetter       ?? false;
    this.skipDuplicateCheck    = options.skipDuplicateCheck    ?? false;
    this.dryRun                = options.dryRun                ?? false;

    this._prioritizer = options.prioritizationEngine ?? new PrioritizationEngine();
    this._tracker     = options.tracker              ?? new ApplicationTracker({ dryRun: this.dryRun });
    this._generator   = options.coverLetterGenerator ?? new CoverLetterGenerator({ saveToFile: !this.dryRun });
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Run the Application Agent pipeline on a batch of scored offers.
   *
   * @param {ScoredOffer[]} scoredOffers  Output from AnalysisAgent
   * @param {string} [runId]
   * @returns {Promise<ApplicationResult>}
   */
  async run(scoredOffers, runId = 'application') {
    const startTime = Date.now();
    const stats     = this._emptyStats(scoredOffers.length);

    console.log(`[${runId}] ApplicationAgent: procesando ${scoredOffers.length} ofertas puntuadas`);

    // ── Step 1: Filter by threshold & recommendation ──────────────────────────
    const eligible = scoredOffers.filter(o => {
      if (o.score < this.scoreThreshold) { stats.belowThreshold++; return false; }
      if (this.requireRecommendation && !o.apply_recommendation) { stats.notRecommended++; return false; }
      return true;
    });

    console.log(`[${runId}] Elegibles (score >= ${this.scoreThreshold}): ${eligible.length}`);

    if (eligible.length === 0) {
      return this._buildResult([], [], stats, startTime);
    }

    // ── Step 2: Deduplicate against tracker ───────────────────────────────────
    let toQueue = eligible;

    if (!this.skipDuplicateCheck) {
      toQueue = eligible.filter(offer => {
        const existing = this._tracker.findEntry(offer.company, offer.title);
        if (existing) {
          console.log(`[${runId}]   SKIP (ya en tracker): ${offer.company} — ${offer.title}`);
          stats.alreadyTracked++;
          return false;
        }
        return true;
      });
    }

    // ── Step 3: Prioritize ────────────────────────────────────────────────────
    const prioritized = this._prioritizer.prioritize(toQueue);

    console.log(`[${runId}] Priorizadas para encolar: ${prioritized.length}`);

    // ── Step 4: Generate cover letters for top N ──────────────────────────────
    const coverLetters = {};

    if (!this.skipCoverLetter && prioritized.length > 0) {
      const topOffers = prioritized.slice(0, this.coverLetterTopN);
      console.log(`[${runId}] Generando cartas para top ${topOffers.length} ofertas...`);

      for (const offer of topOffers) {
        if (this.dryRun) {
          coverLetters[offer.url] = this._dummyCoverLetter(offer);
          console.log(`[${runId}]   [DRY-RUN] carta: ${offer.company}`);
        } else {
          try {
            const jdText = offer._jdText ?? '';  // JD text may be attached by Analysis Agent
            const result = await this._generator.generate(offer, jdText);
            coverLetters[offer.url] = result;
            console.log(`[${runId}]   carta: ${offer.company} (${result.word_count} palabras, ${result.language})`);
            stats.coverLettersGenerated++;
          } catch (err) {
            console.warn(`[${runId}]   COVER_LETTER_ERROR: ${offer.company} — ${err.message}`);
            stats.coverLetterErrors++;
          }
        }
      }
    }

    // ── Step 5: Write to tracker ──────────────────────────────────────────────
    const queued = [];

    for (const offer of prioritized) {
      try {
        const { num, tsvPath } = this._tracker.queueOffer(offer, {
          status: 'QUEUED',
          notes:  offer.justification?.slice(0, 80) ?? '',
        });
        queued.push({ ...offer, tracker_num: num, tsv_path: tsvPath });
        stats.queued++;
        console.log(`[${runId}]   [#${num}] encolada: ${offer.company} — score=${offer.score}`);
      } catch (err) {
        console.warn(`[${runId}]   TRACKER_ERROR: ${offer.company} — ${err.message}`);
        stats.trackerErrors++;
      }
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    stats.durationMs = Date.now() - startTime;

    console.log(`\n[${runId}] ApplicationAgent completado en ${stats.durationMs}ms`);
    console.log(`  Recibidas:        ${stats.received}`);
    console.log(`  Bajo umbral:      ${stats.belowThreshold}`);
    console.log(`  Sin recomendación:${stats.notRecommended}`);
    console.log(`  Ya en tracker:    ${stats.alreadyTracked}`);
    console.log(`  Encoladas:        ${stats.queued}`);
    console.log(`  Cartas generadas: ${stats.coverLettersGenerated}`);
    if (this.dryRun) console.log(`  [DRY-RUN activo — no se escribieron archivos]`);

    return this._buildResult(queued, coverLetters, stats, startTime);
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _dummyCoverLetter(offer) {
    return {
      url:          offer.url,
      company:      offer.company,
      title:        offer.title,
      subject_line: `[DRY-RUN] Candidatura — ${offer.title} @ ${offer.company}`,
      cover_letter: '[DRY-RUN] Cover letter generation skipped.',
      language:     'es',
      word_count:   0,
      generated_at: new Date().toISOString(),
      model:        'dry-run',
      saved_path:   null,
    };
  }

  _emptyStats(receivedCount) {
    return {
      received:              receivedCount,
      belowThreshold:        0,
      notRecommended:        0,
      alreadyTracked:        0,
      queued:                0,
      coverLettersGenerated: 0,
      coverLetterErrors:     0,
      trackerErrors:         0,
      durationMs:            0,
    };
  }

  _buildResult(queued, coverLetters, stats, startTime) {
    return {
      queued,
      coverLetters,
      stats: { ...stats, durationMs: Date.now() - startTime },
    };
  }
}

// ── JSDoc types ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ApplicationResult
 * @property {Array}  queued        - PrioritizedOffer[] with tracker_num added
 * @property {object} coverLetters  - { [url]: CoverLetterResult }
 * @property {object} stats
 */

// ── CLI entry point ───────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  // Test with dummy scored offers
  const testOffers = [
    {
      url:                  'https://example.com/jobs/1',
      title:                'Data Analyst',
      company:              'Nubank',
      location:             'Remote',
      date_found:           new Date().toISOString(),
      source_portal:        'greenhouse',
      score:                4.2,
      justification:        'Excelente match de stack. Power BI + SQL requerido.',
      tags:                 ['power-bi', 'sql', 'remote', 'fintech'],
      apply_recommendation: true,
      score_factors: {
        stack_match: 'alto', seniority_match: 'alineado',
        modality_match: 'remoto', salary_signal: 'en-rango',
      },
      scored_at: new Date().toISOString(),
      model:     'claude-opus-4-5',
    },
  ];

  const agent = new ApplicationAgent({ dryRun, skipCoverLetter: true });
  agent.run(testOffers, 'cli-test').then(({ queued, stats }) => {
    console.log('\n── Resultado ──');
    console.log(JSON.stringify({ stats, count: queued.length }, null, 2));
  }).catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
