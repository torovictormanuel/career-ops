#!/usr/bin/env node
/**
 * orchestrator.mjs — Main Pipeline Orchestrator (career-ops v2.0)
 *
 * Conecta todos los agentes en el pipeline completo:
 *   Discovery → Analysis → Application → Notification
 *
 * Cada paso está envuelto por ErrorHandlerAgent (retry + DLQ + alertas WA).
 *
 * Uso CLI:
 *   node orchestrator.mjs                  # run completo
 *   node orchestrator.mjs --dry-run        # sin I/O real
 *   node orchestrator.mjs --skip-discovery # solo Analysis + Application
 *   node orchestrator.mjs --digest-only    # solo enviar digest con tracker actual
 *   node orchestrator.mjs --weekly-report  # solo reporte semanal
 *
 * Uso programático:
 *   import { Orchestrator } from './orchestrator.mjs';
 *   const orch = new Orchestrator({ dryRun: true });
 *   const result = await orch.run();
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath }            from 'node:url';
import path                         from 'node:path';
import yaml                         from 'js-yaml';

// Load .env if present (no dotenv dependency — manual parse)
try {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
} catch { /* best effort */ }

import { ErrorHandlerAgent }  from './agents/error-handler/error-handler-agent.mjs';
import { NotificationAgent }  from './agents/notification/notification-agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config', 'config.yml');

// ── Orchestrator ──────────────────────────────────────────────────────────────

export class Orchestrator {
  /**
   * @param {object} [options]
   * @param {boolean} [options.dryRun=false]
   * @param {boolean} [options.skipDiscovery=false]   Start from Analysis with existing offers
   * @param {boolean} [options.skipApplication=false]  Skip Application + Notification
   * @param {boolean} [options.digestOnly=false]       Only send daily digest
   * @param {boolean} [options.weeklyReport=false]     Only send weekly report
   * @param {object}  [options.agents]                 Injected agents (for tests)
   *   { discoveryAgent, analysisAgent, applicationAgent, notificationAgent, errorHandler, tracker }
   */
  constructor(options = {}) {
    this.dryRun          = options.dryRun          ?? false;
    this.skipDiscovery   = options.skipDiscovery   ?? false;
    this.skipApplication = options.skipApplication ?? false;
    this.digestOnly      = options.digestOnly      ?? false;
    this.weeklyReport    = options.weeklyReport     ?? false;

    this._agents = options.agents ?? null;   // injected for tests
    this._config = null;   // lazy
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Execute the full pipeline.
   *
   * @param {string} [runId]
   * @returns {Promise<OrchestratorResult>}
   */
  async run(runId = this._generateRunId()) {
    const startTime = Date.now();
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`[${runId}] career-ops v2.0 — Pipeline iniciado`);
    console.log(`[${runId}] Modo: ${this._modeSummary()}`);
    console.log(`${'═'.repeat(60)}\n`);

    const agents = await this._resolveAgents(runId);
    const result = {
      runId,
      mode:         this._modeSummary(),
      discovery:    null,
      analysis:     null,
      application:  null,
      notification: null,
      errors:       [],
      durationMs:   0,
    };

    try {
      // ── Mode: Weekly Report ─────────────────────────────────────────────────
      if (this.weeklyReport) {
        const metrics = agents.tracker.readMetrics();
        result.notification = await agents.notifier.weeklyReport(metrics, runId);
        return this._finish(result, startTime);
      }

      // ── Mode: Digest Only ───────────────────────────────────────────────────
      if (this.digestOnly) {
        const entries = agents.tracker.readEntries();
        const topToday = entries
          .filter(e => e.status === 'QUEUED' || e.status === 'NOTIFIED')
          .slice(0, 10);
        result.notification = await agents.notifier.dailyDigest(topToday, {}, runId);
        return this._finish(result, startTime);
      }

      // ── Step 1: Discovery ───────────────────────────────────────────────────
      let normalizedOffers = [];

      if (!this.skipDiscovery) {
        console.log(`[${runId}] ── Paso 1: Discovery`);
        const discoveryResult = await agents.errorHandler.withRetry(
          () => agents.discoveryAgent.run(runId),
          { context: 'DiscoveryAgent', type: 'discovery' }
        );

        if (discoveryResult.ok) {
          const allOffers  = discoveryResult.result?.new_offers ?? discoveryResult.result?.offers ?? [];
          const maxOffers  = this._loadConfig()?.pipeline?.max_offers_per_run ?? 50;
          normalizedOffers = allOffers.slice(0, maxOffers);
          result.discovery = discoveryResult.result;
          const capNote = allOffers.length > maxOffers ? ` (cap ${maxOffers}/${allOffers.length})` : '';
          console.log(`[${runId}] Discovery: ${normalizedOffers.length} ofertas${capNote}`);
        } else {
          console.warn(`[${runId}] Discovery falló: ${discoveryResult.error.message}`);
          result.errors.push({ step: 'discovery', ...discoveryResult.error });
          // Continue with 0 offers — pipeline still runs notification
        }
      } else {
        console.log(`[${runId}] ── Paso 1: Discovery (SKIPPED)`);
      }

      // ── Step 2: Analysis ────────────────────────────────────────────────────
      let scoredOffers = [];
      let analysisStats = {};

      if (normalizedOffers.length > 0) {
        console.log(`\n[${runId}] ── Paso 2: Analysis (${normalizedOffers.length} ofertas)`);
        const analysisResult = await agents.errorHandler.withRetry(
          () => agents.analysisAgent.run(normalizedOffers, runId),
          { context: 'AnalysisAgent', type: 'analysis' }
        );

        if (analysisResult.ok) {
          scoredOffers  = analysisResult.result?.scored ?? [];
          analysisStats = analysisResult.result?.stats  ?? {};
          result.analysis = analysisResult.result;
          console.log(`[${runId}] Analysis: ${scoredOffers.length} ofertas puntuadas`);
        } else {
          console.warn(`[${runId}] Analysis falló: ${analysisResult.error.message}`);
          result.errors.push({ step: 'analysis', ...analysisResult.error });
        }
      } else {
        console.log(`\n[${runId}] ── Paso 2: Analysis (SKIP — sin ofertas)`);
      }

      // ── Step 3: Application ─────────────────────────────────────────────────
      if (!this.skipApplication && scoredOffers.length > 0) {
        console.log(`\n[${runId}] ── Paso 3: Application (${scoredOffers.length} oferta/s puntuadas)`);
        const appResult = await agents.errorHandler.withRetry(
          () => agents.applicationAgent.run(scoredOffers, runId),
          { context: 'ApplicationAgent', type: 'application' }
        );

        if (appResult.ok) {
          result.application = appResult.result;
          console.log(`[${runId}] Application: ${appResult.result?.stats?.queued ?? 0} encoladas`);
        } else {
          console.warn(`[${runId}] Application falló: ${appResult.error.message}`);
          result.errors.push({ step: 'application', ...appResult.error });
        }
      } else {
        console.log(`\n[${runId}] ── Paso 3: Application (SKIP)`);
      }

      // ── Step 4: Notification ────────────────────────────────────────────────
      console.log(`\n[${runId}] ── Paso 4: Notification`);
      const queuedOffers = result.application?.queued ?? [];

      if (queuedOffers.length > 0) {
        const notifResult = await agents.notifier.notifyOffers(queuedOffers, runId);
        result.notification = notifResult;
      } else {
        console.log(`[${runId}] Notification: sin ofertas para notificar`);
      }

    } catch (fatalErr) {
      console.error(`[${runId}] ERROR FATAL no controlado:`, fatalErr);
      result.errors.push({ step: 'orchestrator', message: fatalErr.message });
      try {
        await agents.notifier.alertError(fatalErr, `Orchestrator ${runId}`);
      } catch { /* best effort */ }
    }

    return this._finish(result, startTime);
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  async _resolveAgents(runId) {
    if (this._agents) return this._agents;

    // Lazy import real agents (avoids loading everything on import)
    const [
      { DiscoveryAgent },
      { AnalysisAgent },
      { ApplicationAgent },
      { ApplicationTracker },
    ] = await Promise.all([
      import('./agents/discovery/discovery-agent.mjs').catch(() => ({ DiscoveryAgent: null })),
      import('./agents/analysis/analysis-agent.mjs').catch(() => ({ AnalysisAgent: null })),
      import('./agents/application/application-agent.mjs').catch(() => ({ ApplicationAgent: null })),
      import('./agents/application/tracker.mjs').catch(() => ({ ApplicationTracker: null })),
    ]);

    const config  = this._loadConfig();
    const dryRun  = this.dryRun;

    const errorHandler = new ErrorHandlerAgent({
      dryRun,
      retryConfig: {
        maxAttempts: config?.error_handler?.retry?.max_attempts ?? 3,
        delaysMs:    config?.error_handler?.retry?.delays_ms    ?? [5000, 15000, 60000],
      },
    });

    const notifier = new NotificationAgent({ dryRun });
    const tracker  = ApplicationTracker ? new ApplicationTracker({ dryRun }) : { readEntries: () => [], readMetrics: () => ({ total: 0 }) };

    return {
      discoveryAgent:   DiscoveryAgent   ? new DiscoveryAgent({ dryRun })   : this._stubAgent('discovery',   { offers: [] }),
      analysisAgent:    AnalysisAgent    ? new AnalysisAgent({ dryRun })    : this._stubAgent('analysis',    { scored: [], stats: {} }),
      applicationAgent: ApplicationAgent ? new ApplicationAgent({ dryRun }) : this._stubAgent('application', { queued: [], coverLetters: {}, stats: {} }),
      notifier,
      tracker,
      errorHandler,
    };
  }

  _stubAgent(name, result) {
    return { run: async () => { console.warn(`[Orchestrator] ${name} agent no disponible — usando stub`); return result; } };
  }

  _finish(result, startTime) {
    result.durationMs = Date.now() - startTime;

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[${result.runId}] Pipeline completado en ${result.durationMs}ms`);
    if (result.errors.length > 0) {
      console.warn(`[${result.runId}] Errores: ${result.errors.length}`);
      result.errors.forEach(e => console.warn(`  ✗ [${e.step}] ${e.message ?? e.category}`));
    }
    console.log(`${'─'.repeat(60)}\n`);

    return result;
  }

  _modeSummary() {
    if (this.weeklyReport)    return 'weekly-report';
    if (this.digestOnly)      return 'digest-only';
    if (this.dryRun)          return 'dry-run';
    if (this.skipDiscovery)   return 'skip-discovery';
    if (this.skipApplication) return 'analysis-only';
    return 'full';
  }

  _loadConfig() {
    if (this._config) return this._config;
    try {
      if (existsSync(CONFIG_PATH)) {
        this._config = yaml.load(readFileSync(CONFIG_PATH, 'utf8'));
      }
    } catch { /* use defaults */ }
    return this._config ?? {};
  }

  _generateRunId() {
    const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const rnd = Math.random().toString(36).slice(2, 6);
    return `run-${ts}-${rnd}`;
  }
}

/**
 * @typedef {object} OrchestratorResult
 * @property {string} runId
 * @property {string} mode
 * @property {object|null} discovery
 * @property {object|null} analysis
 * @property {object|null} application
 * @property {object|null} notification
 * @property {Array}  errors
 * @property {number} durationMs
 */

// ── CLI ───────────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);

  const orch = new Orchestrator({
    dryRun:          args.includes('--dry-run'),
    skipDiscovery:   args.includes('--skip-discovery'),
    skipApplication: args.includes('--skip-application'),
    digestOnly:      args.includes('--digest-only'),
    weeklyReport:    args.includes('--weekly-report'),
  });

  orch.run().then(result => {
    console.log('\n── Resultado final ──');
    console.log(JSON.stringify({
      runId:       result.runId,
      mode:        result.mode,
      durationMs:  result.durationMs,
      errors:      result.errors.length,
      queued:      result.application?.stats?.queued ?? 0,
      notified:    result.notification?.stats?.sent  ?? 0,
    }, null, 2));
    process.exit(result.errors.length > 0 ? 1 : 0);
  }).catch(err => {
    console.error('Error fatal:', err);
    process.exit(1);
  });
}
