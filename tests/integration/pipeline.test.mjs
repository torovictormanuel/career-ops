/**
 * pipeline.test.mjs — Integration Tests para el Pipeline Completo
 *
 * Prueba la integración de Orchestrator + CronParser con todos los agentes
 * inyectados como stubs controlados. Sin I/O real, sin APIs, sin archivos.
 *
 * Correr: node --test tests/integration/pipeline.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

import { Orchestrator }            from '../../orchestrator.mjs';
import { CronParser, CronRunner }  from '../../cron.mjs';
import { ErrorHandlerAgent }       from '../../agents/error-handler/error-handler-agent.mjs';
import { DeadLetterQueue }         from '../../agents/error-handler/dead-letter-queue.mjs';

// ── Setup ─────────────────────────────────────────────────────────────────────

const TMP_DIR = 'tests/tmp-integration';
before(() => mkdirSync(TMP_DIR, { recursive: true }));
after(()  => { if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true }); });

// ── Stub factories ────────────────────────────────────────────────────────────

const SCORED_OFFER = {
  url:                  'https://example.com/job/1',
  title:                'Data Analyst',
  company:              'Nubank',
  location:             'Remote',
  score:                4.2,
  apply_recommendation: true,
  tags:                 ['power-bi', 'sql'],
  priority_score:       0.82,
  priority_factors:     { score_norm: 0.8, rating_norm: 0.5, recency_score: 1.0 },
  tracker_num:          1,
};

function makeAgents(overrides = {}) {
  const calls = { discovery: 0, analysis: 0, application: 0, notification: 0 };

  const notifierLog = [];

  const agents = {
    discoveryAgent: {
      run: async () => { calls.discovery++; return { offers: [{ url: SCORED_OFFER.url, company: 'Nubank', title: 'Data Analyst' }] }; },
    },
    analysisAgent: {
      run: async () => { calls.analysis++; return { scored: [SCORED_OFFER], stats: { received: 1, scored: 1, errors: 0 } }; },
    },
    applicationAgent: {
      run: async () => { calls.application++; return { queued: [SCORED_OFFER], coverLetters: {}, stats: { queued: 1 } }; },
    },
    notifier: {
      notifyOffers:  async (offers, runId) => { calls.notification++; notifierLog.push({ type: 'offers', count: offers.length }); return { type: 'offers', runId, stats: { sent: offers.length } }; },
      dailyDigest:   async (offers, stats, runId) => { notifierLog.push({ type: 'digest' }); return { type: 'digest', runId, stats: {} }; },
      weeklyReport:  async (metrics, runId)  => { notifierLog.push({ type: 'weekly' }); return { type: 'weekly', runId, stats: {} }; },
      alertError:    async (err, ctx)        => { notifierLog.push({ type: 'alert', err: err.message }); },
    },
    tracker: {
      readEntries:   () => [],
      readMetrics:   () => ({ total: 5, byStatus: { Sent: 3 }, avgScore: 4.0, topCompanies: [], scoreDistribution: {} }),
    },
    errorHandler: new ErrorHandlerAgent({
      dlq:          new DeadLetterQueue({ filePath: `${TMP_DIR}/dlq-int.json` }),
      notifyOnFatal: false,
      retryConfig:  { maxAttempts: 1, delaysMs: [0] },
    }),
    ...overrides,
  };

  return { agents, calls, notifierLog };
}

// ── Tests: Orchestrator ───────────────────────────────────────────────────────

describe('Orchestrator — full pipeline', () => {
  test('pipeline completo ejecuta todos los pasos en orden', async () => {
    const { agents, calls } = makeAgents();
    const orch = new Orchestrator({ agents });

    const result = await orch.run('test-full');

    assert.equal(result.runId, 'test-full');
    assert.equal(calls.discovery,   1, 'Discovery debe ejecutarse 1 vez');
    assert.equal(calls.analysis,    1, 'Analysis debe ejecutarse 1 vez');
    assert.equal(calls.application, 1, 'Application debe ejecutarse 1 vez');
    assert.equal(calls.notification, 1, 'Notification debe ejecutarse 1 vez');
    assert.equal(result.errors.length, 0, 'no debe haber errores');
  });

  test('retorna OrchestratorResult con las secciones correctas', async () => {
    const { agents } = makeAgents();
    const orch = new Orchestrator({ agents });
    const r = await orch.run('test-result');

    assert.ok(r.runId,         'debe tener runId');
    assert.ok(r.mode,          'debe tener mode');
    assert.ok(r.durationMs >= 0, 'debe tener durationMs');
    assert.ok(r.discovery,     'debe tener resultado de discovery');
    assert.ok(r.analysis,      'debe tener resultado de analysis');
    assert.ok(r.application,   'debe tener resultado de application');
    assert.ok(r.notification,  'debe tener resultado de notification');
  });

  test('mode dry-run incluye "dry-run" en el modo', async () => {
    const { agents } = makeAgents();
    const orch = new Orchestrator({ agents, dryRun: true });
    const r = await orch.run('test-dryrun');
    assert.ok(r.mode.includes('dry-run'), `modo debe incluir dry-run, fue: ${r.mode}`);
  });

  test('skipDiscovery omite Discovery y continúa', async () => {
    const { agents, calls } = makeAgents();
    // Override: no offers from discovery since it's skipped — analysis gets empty
    const { agents: freshAgents, calls: freshCalls } = makeAgents({
      analysisAgent: {
        run: async () => { freshCalls.analysis++; return { scored: [], stats: { received: 0 } }; },
      },
    });
    const orch = new Orchestrator({ agents: freshAgents, skipDiscovery: true });
    const r = await orch.run('test-skip-discovery');
    assert.equal(freshCalls.discovery, 0, 'Discovery no debe ejecutarse');
    assert.equal(r.errors.length, 0);
  });

  test('weeklyReport envía solo el reporte semanal', async () => {
    const { agents, notifierLog } = makeAgents();
    const orch = new Orchestrator({ agents, weeklyReport: true });
    await orch.run('test-weekly');

    const weeklyCall = notifierLog.find(l => l.type === 'weekly');
    assert.ok(weeklyCall, 'debe enviar un weekly report');
    assert.equal(notifierLog.filter(l => l.type !== 'weekly').length, 0, 'solo debe enviar el weekly report');
  });

  test('digestOnly envía solo el digest', async () => {
    const { agents, notifierLog } = makeAgents();
    const orch = new Orchestrator({ agents, digestOnly: true });
    await orch.run('test-digest');

    const digestCall = notifierLog.find(l => l.type === 'digest');
    assert.ok(digestCall, 'debe enviar un digest');
    assert.equal(notifierLog.filter(l => l.type === 'offers').length, 0, 'no debe enviar ofertas individuales');
  });

  test('error en Discovery no detiene el pipeline', async () => {
    const { agents } = makeAgents({
      discoveryAgent: { run: async () => { throw Object.assign(new Error('Network down'), { code: 'ECONNREFUSED' }); } },
    });
    const orch = new Orchestrator({ agents });
    const r = await orch.run('test-discovery-error');

    assert.ok(r.errors.some(e => e.step === 'discovery'), 'debe registrar el error de Discovery');
    // Pipeline sigue (sin ofertas que procesar)
    assert.equal(r.errors.length, 1, 'solo 1 error');
  });

  test('sin ofertas tras Analysis no ejecuta Application', async () => {
    const { agents, calls } = makeAgents({
      analysisAgent: { run: async () => { calls.analysis++; return { scored: [], stats: {} }; } },
    });
    const orch = new Orchestrator({ agents });
    await orch.run('test-empty-analysis');

    assert.equal(calls.application, 0, 'Application no debe ejecutarse sin ofertas');
  });
});

// ── Tests: CronParser ─────────────────────────────────────────────────────────

describe('CronParser — matches()', () => {
  const parser = new CronParser();

  function date(h, m, dow = 1) {
    // Jan 4 2026 is Sunday (dow=0), so 4+dow gives the correct weekday
    const d = new Date(2026, 0, 4 + dow);
    d.setHours(h, m, 0, 0);
    return d;
  }

  test('"0 8 * * 1-5" coincide lunes 08:00', () => {
    assert.equal(parser.matches('0 8 * * 1-5', date(8, 0, 1)), true);
  });

  test('"0 8 * * 1-5" no coincide sábado 08:00', () => {
    assert.equal(parser.matches('0 8 * * 1-5', date(8, 0, 6)), false);
  });

  test('"0 8 * * 1-5" no coincide lunes 09:00', () => {
    assert.equal(parser.matches('0 8 * * 1-5', date(9, 0, 1)), false);
  });

  test('"0 9 * * 1" coincide lunes 09:00', () => {
    assert.equal(parser.matches('0 9 * * 1', date(9, 0, 1)), true);
  });

  test('"0 9 * * 1" no coincide martes 09:00', () => {
    assert.equal(parser.matches('0 9 * * 1', date(9, 0, 2)), false);
  });

  test('"* * * * *" coincide siempre', () => {
    assert.equal(parser.matches('* * * * *', new Date()), true);
  });

  test('expresión inválida retorna false', () => {
    assert.equal(parser.matches('invalid', new Date()), false);
    assert.equal(parser.matches('',        new Date()), false);
    assert.equal(parser.matches(null,      new Date()), false);
  });

  test('"0 18 * * 1-5" coincide viernes 18:00', () => {
    assert.equal(parser.matches('0 18 * * 1-5', date(18, 0, 5)), true);
  });

  test('"0 13 * * 1-5" no coincide a las 13:01', () => {
    assert.equal(parser.matches('0 13 * * 1-5', date(13, 1, 3)), false);
  });
});

// ── Tests: CronRunner ─────────────────────────────────────────────────────────

describe('CronRunner — _tick()', () => {
  function makeRunner(orchResult = null) {
    const runs = [];
    const orch = {
      run: async (id) => { runs.push(id); return { durationMs: 1, errors: [] }; },
    };
    const runner = new CronRunner({
      orchestrator: orch,
      parser: new CronParser(),
    });
    return { runner, runs };
  }

  test('dispara cuando el cron coincide con la hora actual', async () => {
    const { runner, runs } = makeRunner();
    const now = new Date(2026, 0, 5);   // lunes
    now.setHours(8, 0, 0, 0);

    const config = { orchestrator: { cron_schedule: ['0 8 * * 1-5'], digest_cron: null, weekly_report_cron: null } };
    await runner._tick(now, config);

    assert.equal(runs.length, 1, 'debe disparar 1 vez');
  });

  test('no dispara dos veces en el mismo minuto', async () => {
    const { runner, runs } = makeRunner();
    const now = new Date(2026, 0, 5);
    now.setHours(8, 0, 0, 0);

    const config = { orchestrator: { cron_schedule: ['0 8 * * 1-5'], digest_cron: null, weekly_report_cron: null } };
    await runner._tick(now, config);
    await runner._tick(now, config);   // mismo minuto

    assert.equal(runs.length, 1, 'debe disparar solo 1 vez por minuto');
  });

  test('weekly report cron tiene prioridad', async () => {
    const { runner, runs } = makeRunner();
    const now = new Date(2026, 0, 5);   // lunes
    now.setHours(9, 0, 0, 0);

    const config = {
      orchestrator: {
        cron_schedule:      ['0 9 * * 1-5'],
        digest_cron:        null,
        weekly_report_cron: '0 9 * * 1',
      },
    };
    await runner._tick(now, config);
    assert.equal(runs.length, 1, 'debe ejecutar el weekly report');
  });

  test('no dispara si ningun cron coincide', async () => {
    const { runner, runs } = makeRunner();
    const now = new Date(2026, 0, 10);   // sábado
    now.setHours(8, 0, 0, 0);

    const config = { orchestrator: { cron_schedule: ['0 8 * * 1-5'], digest_cron: null, weekly_report_cron: null } };
    await runner._tick(now, config);
    assert.equal(runs.length, 0, 'no debe disparar en sábado');
  });
});
