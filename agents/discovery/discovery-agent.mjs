#!/usr/bin/env node
/**
 * discovery-agent.mjs — Discovery Agent (career-ops v2.0)
 *
 * Entry point del agente de descubrimiento de ofertas.
 * Orquesta scrapers → feed aggregator → dedup engine.
 *
 * Responsabilidad única: devolver ofertas NUEVAS (no vistas) del día.
 * NO evalúa, NO puntúa, NO notifica.
 *
 * Uso programático:
 *   import { DiscoveryAgent } from './agents/discovery/discovery-agent.mjs';
 *   const agent = new DiscoveryAgent();
 *   const { newOffers, stats } = await agent.run(runId);
 *
 * Uso CLI (testing):
 *   node agents/discovery/discovery-agent.mjs [--dry-run] [--company Nubank]
 */

import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';

import { makeHttpCtx } from '../../providers/_http.mjs';
import { BaseScraperAdapter } from './scraper-interface.mjs';
import { FeedAggregator } from './feed-aggregator.mjs';
import { CircuitBreaker } from './circuit-breaker.mjs';
import { DedupEngine } from '../data-manager/dedup-engine.mjs';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const ROOT        = path.resolve(__dirname, '../..');
const PORTALS_PATH   = path.join(ROOT, 'portals.yml');
const PROVIDERS_DIR  = path.join(ROOT, 'providers');

// ── DiscoveryAgent ────────────────────────────────────────────────────────────

export class DiscoveryAgent {
  /**
   * @param {object} options
   * @param {string}  [options.portalsPath]    - Path a portals.yml
   * @param {boolean} [options.dryRun]         - No escribe en dedup-index
   * @param {string}  [options.filterCompany]  - Escanear solo esta empresa
   * @param {number}  [options.concurrency]    - Scrapers en paralelo (default: 5)
   */
  constructor(options = {}) {
    this.portalsPath   = options.portalsPath   ?? PORTALS_PATH;
    this.dryRun        = options.dryRun        ?? (process.env.CAREER_OPS_DRY_RUN === 'true');
    this.filterCompany = options.filterCompany ?? null;
    this.concurrency   = options.concurrency   ?? 5;

    this.aggregator = new FeedAggregator();
    this.breaker    = new CircuitBreaker();
    this.dedup      = new DedupEngine();
    this.httpCtx    = makeHttpCtx();

    this._providers = null; // lazy load
  }

  // ── Providers ───────────────────────────────────────────────────────────────

  async _loadProviders() {
    if (this._providers) return this._providers;
    this._providers = new Map();

    if (!existsSync(PROVIDERS_DIR)) return this._providers;

    const files = (await import('node:fs')).readdirSync(PROVIDERS_DIR)
      .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
      .sort();

    for (const file of files) {
      try {
        const mod = await import(pathToFileURL(path.join(PROVIDERS_DIR, file)).href);
        const p   = mod.default;
        if (p?.id && typeof p.fetch === 'function') {
          this._providers.set(p.id, p);
        }
      } catch (err) {
        console.warn(`[Discovery] Provider ${file} no cargado: ${err.message}`);
      }
    }

    return this._providers;
  }

  _resolveProvider(entry, providers) {
    // Explicit overrides take priority over URL auto-detection
    if (entry.provider)    return providers.get(entry.provider)    ?? null;
    if (entry.scan_method) return providers.get(entry.scan_method) ?? null;
    for (const p of providers.values()) {
      try { if (p.detect?.(entry)) return p; } catch { /* skip */ }
    }
    return null;
  }

  // ── Ejecución ────────────────────────────────────────────────────────────────

  /**
   * Ejecuta el Discovery Agent completo.
   *
   * @param {string} [runId] - ID de ejecución para trazabilidad
   * @returns {Promise<DiscoveryResult>}
   */
  async run(runId = randomUUID()) {
    const startTime = Date.now();
    console.log(`\n🔍 [Discovery] run_id=${runId} | dry_run=${this.dryRun}`);

    // 1. Cargar configuración
    const portalsConfig = yaml.load(readFileSync(this.portalsPath, 'utf-8'));
    const companies     = (portalsConfig.tracked_companies ?? []).filter(c => {
      if (!c.enabled) return false;
      if (this.filterCompany) return c.name.toLowerCase().includes(this.filterCompany.toLowerCase());
      return true;
    });

    const providers = await this._loadProviders();
    console.log(`   Portales habilitados : ${companies.length}`);
    console.log(`   Providers cargados   : ${providers.size}\n`);

    // 2. Scraping con concurrencia limitada + Circuit Breaker
    this.aggregator.reset();
    await this._scrapeAll(companies, providers, runId);

    // 3. Feed Aggregator → batch normalizado
    const { offers: rawOffers, stats: feedStats } = this.aggregator.aggregate();
    console.log(`\n📊 Feed Aggregator:`);
    console.log(`   Portales OK / Error / Skipped : ${feedStats.portalsSuccess} / ${feedStats.portalsError} / ${feedStats.portalsSkipped}`);
    console.log(`   Ofertas brutas (pre-dedup)     : ${feedStats.rawOffersTotal}`);
    console.log(`   Duplicados intra-batch         : ${feedStats.intraBatchDuplicates}`);

    // 4. Dedup Engine → solo ofertas nuevas
    const { newOffers, duplicates } = this.dedup.filterNew(rawOffers);
    console.log(`   Duplicados históricos          : ${duplicates}`);
    console.log(`   ✅ Ofertas NUEVAS              : ${newOffers.length}\n`);

    // 5. Registrar en dedup-index (saltar en dry-run)
    if (!this.dryRun) {
      for (const offer of newOffers) {
        this.dedup.markSeen(offer.url, {
          source_portal: offer.source_portal,
          company:       offer.company,
          title:         offer.title,
          status:        'added',
        });
      }
    }

    const duration = Date.now() - startTime;
    const result = {
      run_id:     runId,
      timestamp:  new Date().toISOString(),
      duration_ms: duration,
      new_offers:  newOffers,
      stats: {
        ...feedStats,
        new_offers:         newOffers.length,
        duplicates_total:   duplicates + feedStats.intraBatchDuplicates,
        circuit_breaker:    this.breaker.summary(),
      },
    };

    console.log(`⏱️  Discovery completado en ${duration}ms`);
    return result;
  }

  // ── Concurrencia ─────────────────────────────────────────────────────────────

  async _scrapeAll(companies, providers, runId) {
    const queue   = [...companies];
    const workers = Math.min(this.concurrency, queue.length);

    const worker = async () => {
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry) break;

        const portalId = entry.provider ?? entry.name.toLowerCase().replace(/\s+/g, '-');

        // Circuit Breaker check
        const { allowed, state, reason } = this.breaker.canRequest(portalId);
        if (!allowed) {
          console.log(`  ⛔ ${entry.name.padEnd(30)} SKIPPED — ${reason}`);
          this.aggregator.addResult({ offers: [], duration: 0, portal: portalId, status: 'skipped' });
          continue;
        }

        // Resolver provider
        const provider = this._resolveProvider(entry, providers);
        if (!provider) {
          this.aggregator.addResult({ offers: [], duration: 0, portal: portalId, status: 'skipped', error: 'no provider' });
          continue;
        }

        // Scraping con Circuit Breaker integrado
        const adapter = new BaseScraperAdapter(provider, this.httpCtx);
        const result  = await adapter.scrape(entry);

        if (result.status === 'ok') {
          this.breaker.onSuccess(portalId);
          const icon = state === 'HALF_OPEN' ? '🟡' : '✅';
          console.log(`  ${icon} ${entry.name.padEnd(30)} ${result.offers.length} ofertas (${result.duration}ms)`);
        } else {
          this.breaker.onFailure(portalId, result.error);
          console.log(`  ❌ ${entry.name.padEnd(30)} ERROR — ${result.error}`);
        }

        this.aggregator.addResult(result);
      }
    };

    // Lanzar N workers en paralelo
    await Promise.all(Array.from({ length: workers }, worker));
  }
}

/**
 * @typedef {object} DiscoveryResult
 * @property {string}   run_id
 * @property {string}   timestamp
 * @property {number}   duration_ms
 * @property {import('./scraper-interface.mjs').NormalizedOffer[]} new_offers
 * @property {object}   stats
 */

// ── CLI ───────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const dryRun  = process.argv.includes('--dry-run');
  const compIdx = process.argv.indexOf('--company');
  const company = compIdx !== -1 ? process.argv[compIdx + 1] : null;

  const agent = new DiscoveryAgent({ dryRun, filterCompany: company });
  const result = await agent.run();

  if (dryRun) {
    console.log('\n[DRY RUN] Ofertas nuevas encontradas:');
    result.new_offers.slice(0, 10).forEach(o =>
      console.log(`  • [${o.source_portal}] ${o.company} — ${o.title}`)
    );
    if (result.new_offers.length > 10) {
      console.log(`  ... y ${result.new_offers.length - 10} más`);
    }
  }
}
