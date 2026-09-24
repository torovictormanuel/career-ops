#!/usr/bin/env node
/**
 * cron.mjs — Cron Runner (career-ops v2.0)
 *
 * Ejecuta el Orchestrator en los horarios definidos en config.yml.
 * Sin dependencias externas: usa un loop cada minuto y parsea cron básico.
 *
 * Cron soportado (subconjunto):
 *   "MIN HOUR DOM MON DOW"
 *   Valores numéricos, "*", y rangos "a-b" para DOW.
 *   Ejemplos:
 *     "0 8 * * 1-5"   → Lun-Vie a las 08:00
 *     "0 9 * * 1"     → Lunes a las 09:00
 *
 * Uso:
 *   node cron.mjs                  # iniciar el runner
 *   node cron.mjs --dry-run        # simular sin I/O real
 *   node cron.mjs --once           # ejecutar una vez ahora y salir
 *   CTRL+C para detener
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath }            from 'node:url';
import path                         from 'node:path';
import yaml                         from 'js-yaml';

import { Orchestrator } from './orchestrator.mjs';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config', 'config.yml');

// ── CronParser ────────────────────────────────────────────────────────────────

export class CronParser {
  /**
   * Check if a cron expression matches the given Date.
   * Supports: numbers, "*", and "a-b" ranges (in DOW field).
   *
   * @param {string} expr   Cron expression "MIN HOUR DOM MON DOW"
   * @param {Date}   [date] Defaults to now
   * @returns {boolean}
   */
  matches(expr, date = new Date()) {
    if (!expr || typeof expr !== 'string') return false;
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return false;

    const [minE, hourE, domE, monE, dowE] = parts;

    return (
      this._matchField(minE,  date.getMinutes())    &&
      this._matchField(hourE, date.getHours())      &&
      this._matchField(domE,  date.getDate())       &&
      this._matchField(monE,  date.getMonth() + 1) &&
      this._matchField(dowE,  date.getDay())
    );
  }

  _matchField(expr, value) {
    if (expr === '*') return true;

    // Range: "1-5"
    const rangeMatch = expr.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10);
      const hi = parseInt(rangeMatch[2], 10);
      return value >= lo && value <= hi;
    }

    // List: "1,3,5"
    if (expr.includes(',')) {
      return expr.split(',').some(v => parseInt(v.trim(), 10) === value);
    }

    // Single value
    return parseInt(expr, 10) === value;
  }
}

// ── CronRunner ────────────────────────────────────────────────────────────────

export class CronRunner {
  /**
   * @param {object} [options]
   * @param {boolean} [options.dryRun=false]
   * @param {boolean} [options.once=false]   Run once immediately and exit
   * @param {object}  [options.orchestrator] Injected Orchestrator (for tests)
   * @param {object}  [options.parser]       Injected CronParser (for tests)
   */
  constructor(options = {}) {
    this.dryRun        = options.dryRun        ?? false;
    this.once          = options.once          ?? false;
    this._orch         = options.orchestrator  ?? null;
    this._parser       = options.parser        ?? new CronParser();
    this._config       = null;
    this._running      = false;
    this._lastFiredMin = -1;   // prevent double-fire in same minute
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Start the cron loop (polls every 15 seconds).
   */
  async start() {
    const config = this._loadConfig();

    if (this.once) {
      console.log('[Cron] --once: ejecutando pipeline ahora...');
      await this._runPipeline('manual-once');
      return;
    }

    this._running = true;
    console.log('[Cron] Iniciado. Schedules:');
    this._printSchedules(config);
    console.log('[Cron] Esperando próximo horario... (CTRL+C para detener)\n');

    // Poll every 15s — fine enough for minute-level cron
    const interval = setInterval(async () => {
      if (!this._running) { clearInterval(interval); return; }
      await this._tick(new Date(), config);
    }, 15_000);

    // Handle graceful shutdown
    process.on('SIGINT',  () => this.stop(interval));
    process.on('SIGTERM', () => this.stop(interval));
  }

  stop(interval) {
    this._running = false;
    if (interval) clearInterval(interval);
    console.log('\n[Cron] Detenido.');
    process.exit(0);
  }

  /**
   * Check current time against schedules and fire if matches.
   * (Exported for testing)
   *
   * @param {Date}   now
   * @param {object} config
   */
  async _tick(now, config) {
    // Deduplicate: only fire once per minute
    const minuteKey = now.getHours() * 60 + now.getMinutes();
    if (minuteKey === this._lastFiredMin) return;

    const schedules     = config?.orchestrator?.cron_schedule     ?? [];
    const digestCron    = config?.orchestrator?.digest_cron        ?? null;
    const weeklyCron    = config?.orchestrator?.weekly_report_cron ?? null;

    let fired = false;

    // Check weekly report first (Monday morning) — if it fires, skip regular schedule
    if (weeklyCron && this._parser.matches(weeklyCron, now)) {
      this._lastFiredMin = minuteKey;  // set before await to prevent re-fire during run
      console.log(`[Cron] ${now.toISOString()} — disparando weekly report`);
      await this._runPipeline('weekly', { weeklyReport: true });
      return;
    }

    // Check regular schedules
    for (const schedule of schedules) {
      if (this._parser.matches(schedule, now)) {
        this._lastFiredMin = minuteKey;  // set before await to prevent re-fire during run
        const isDigest = digestCron && this._parser.matches(digestCron, now);

        if (isDigest) {
          console.log(`[Cron] ${now.toISOString()} — disparando digest diario`);
          await this._runPipeline('digest', { digestOnly: false });
        } else {
          console.log(`[Cron] ${now.toISOString()} — disparando pipeline`);
          await this._runPipeline('scheduled');
        }
        break;
      }
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  async _runPipeline(label, orchOptions = {}) {
    const orch = this._orch ?? new Orchestrator({
      dryRun: this.dryRun,
      ...orchOptions,
    });

    try {
      const result = await orch.run(`${label}-${Date.now().toString(36)}`);
      console.log(`[Cron] Pipeline '${label}' completado en ${result.durationMs}ms`);
      if (result.errors.length > 0) {
        console.warn(`[Cron] Errores: ${result.errors.length}`);
      }
    } catch (err) {
      console.error(`[Cron] Error fatal en '${label}':`, err.message);
    }
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

  _printSchedules(config) {
    const schedules  = config?.orchestrator?.cron_schedule     ?? [];
    const digestCron = config?.orchestrator?.digest_cron        ?? null;
    const weeklyCron = config?.orchestrator?.weekly_report_cron ?? null;

    for (const s of schedules) {
      const isDigest = s === digestCron ? ' ← digest diario' : '';
      console.log(`  ${s}${isDigest}`);
    }
    if (weeklyCron) console.log(`  ${weeklyCron} ← weekly report`);
    if (this.dryRun) console.log('  [DRY-RUN activo]');
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args   = process.argv.slice(2);
  const runner = new CronRunner({
    dryRun: args.includes('--dry-run'),
    once:   args.includes('--once'),
  });
  runner.start();
}
