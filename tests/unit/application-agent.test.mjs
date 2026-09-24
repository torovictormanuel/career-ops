/**
 * application-agent.test.mjs — Tests unitarios para Application Agent
 *
 * Cubre: PrioritizationEngine, ApplicationTracker, CoverLetterGenerator, ApplicationAgent
 * Todos los tests son in-memory — sin llamadas reales a API ni archivos en producción.
 *
 * Correr: node --test tests/unit/application-agent.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { PrioritizationEngine }  from '../../agents/application/prioritization-engine.mjs';
import { ApplicationTracker }    from '../../agents/application/tracker.mjs';
import { CoverLetterGenerator, CoverLetterError } from '../../agents/application/cover-letter-generator.mjs';
import { ApplicationAgent }      from '../../agents/application/application-agent.mjs';

// ── Setup ─────────────────────────────────────────────────────────────────────

const TMP_DIR         = 'tests/tmp-application';
const TMP_TRACKER     = `${TMP_DIR}/applications.md`;
const TMP_TSV_DIR     = `${TMP_DIR}/tracker-additions`;
const TMP_OUTPUT_DIR  = `${TMP_DIR}/cover-letters`;

before(() => { mkdirSync(TMP_DIR, { recursive: true }); });
after(()  => { if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true }); });

// ── Factories ─────────────────────────────────────────────────────────────────

function makeOffer(overrides = {}) {
  return {
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
      stack_match:     'alto',
      seniority_match: 'alineado',
      modality_match:  'remoto',
      salary_signal:   'en-rango',
    },
    scored_at:    new Date().toISOString(),
    model:        'claude-opus-4-5',
    company_info: { glassdoor_rating: 4.5, name: 'Nubank' },
    ...overrides,
  };
}

function freshTracker() {
  return new ApplicationTracker({ trackerPath: TMP_TRACKER, tsvDir: TMP_TSV_DIR });
}

// ── Tests: PrioritizationEngine ───────────────────────────────────────────────

describe('PrioritizationEngine — prioritize()', () => {
  const engine = new PrioritizationEngine({ weights: { score: 0.7, company_rating: 0.2, recency: 0.1 } });

  test('retorna array vacío para input vacío', () => {
    assert.deepEqual(engine.prioritize([]), []);
  });

  test('agrega priority_score a cada oferta', () => {
    const result = engine.prioritize([makeOffer()]);
    assert.equal(result.length, 1);
    assert.ok('priority_score' in result[0], 'debe tener priority_score');
    assert.ok(result[0].priority_score >= 0 && result[0].priority_score <= 1, 'priority_score debe ser 0–1');
  });

  test('agrega priority_factors con desglose', () => {
    const result = engine.prioritize([makeOffer()]);
    const factors = result[0].priority_factors;
    assert.ok('score_norm'    in factors, 'score_norm faltante');
    assert.ok('rating_norm'   in factors, 'rating_norm faltante');
    assert.ok('recency_score' in factors, 'recency_score faltante');
  });

  test('ordena de mayor a menor priority_score', () => {
    const low    = makeOffer({ url: 'https://a.com', score: 2.0, company_info: null });
    const high   = makeOffer({ url: 'https://b.com', score: 4.8 });
    const result = engine.prioritize([low, high]);
    assert.ok(result[0].priority_score >= result[1].priority_score, 'debe ordenar desc');
    assert.equal(result[0].url, 'https://b.com', 'alta puntuación va primero');
  });

  test('oferta reciente tiene mayor recency_score que oferta antigua', () => {
    const recent = makeOffer({ url: 'https://r.com', date_found: new Date().toISOString() });
    const old    = makeOffer({ url: 'https://o.com', date_found: '2020-01-01T00:00:00.000Z' });

    const [rResult] = engine.prioritize([recent]);
    const [oResult] = engine.prioritize([old]);

    assert.ok(
      rResult.priority_factors.recency_score > oResult.priority_factors.recency_score,
      'oferta reciente debe tener mayor recency_score'
    );
  });

  test('rating_norm = 0.5 cuando glassdoor_rating es null', () => {
    const offer  = makeOffer({ company_info: { glassdoor_rating: null } });
    const result = engine.prioritize([offer]);
    assert.equal(result[0].priority_factors.rating_norm, 0.5);
  });

  test('top(offers, N) retorna sólo N offers', () => {
    const offers = Array.from({ length: 10 }, (_, i) =>
      makeOffer({ url: `https://example.com/job/${i}`, score: 1 + i * 0.4 })
    );
    const result = engine.top(offers, 3);
    assert.equal(result.length, 3);
  });

  test('score 1.0 → score_norm=0, score 5.0 → score_norm=1', () => {
    const eng = new PrioritizationEngine({ weights: { score: 1, company_rating: 0, recency: 0 } });
    const min = eng.prioritize([makeOffer({ score: 1.0, company_info: null })])[0];
    const max = eng.prioritize([makeOffer({ score: 5.0, company_info: null })])[0];
    assert.ok(min.priority_factors.score_norm === 0,   'score 1.0 → norm 0');
    assert.ok(max.priority_factors.score_norm === 1,   'score 5.0 → norm 1');
  });
});

// ── Tests: ApplicationTracker (write) ────────────────────────────────────────

describe('ApplicationTracker — queueOffer()', () => {
  test('crea tracker si no existe', () => {
    const tracker = freshTracker();
    const offer   = makeOffer({ url: 'https://new.com/job/1', company: 'TestCo' });
    const { num } = tracker.queueOffer(offer);
    assert.equal(num, 1);
    assert.ok(existsSync(TMP_TRACKER), 'applications.md debe crearse');
  });

  test('genera número secuencial correcto', () => {
    const tracker = new ApplicationTracker({
      trackerPath: `${TMP_DIR}/seq-tracker.md`,
      tsvDir:      `${TMP_DIR}/seq-tsv`,
    });
    const o1 = tracker.queueOffer(makeOffer({ url: 'https://a.com/1', company: 'Co1' }));
    const o2 = tracker.queueOffer(makeOffer({ url: 'https://a.com/2', company: 'Co2' }));
    assert.equal(o1.num, 1);
    assert.equal(o2.num, 2);
  });

  test('escribe TSV en batch/tracker-additions/', () => {
    const tracker = freshTracker();
    const { tsvPath } = tracker.queueOffer(makeOffer({ url: 'https://tsv.com/1', company: 'TsvCo' }));
    assert.ok(existsSync(tsvPath), 'archivo TSV debe crearse');
    const content = readFileSync(tsvPath, 'utf8').trim();
    const cols    = content.split('\t');
    assert.equal(cols.length, 9, 'TSV debe tener 9 columnas');
    assert.equal(cols[2], 'TsvCo', 'columna company debe ser TsvCo');
  });

  test('dryRun=true no escribe ningún archivo', () => {
    const tmpDryDir  = `${TMP_DIR}/dry-tracker`;
    const tracker    = new ApplicationTracker({ trackerPath: `${tmpDryDir}/apps.md`, tsvDir: `${tmpDryDir}/tsv`, dryRun: true });
    tracker.queueOffer(makeOffer({ url: 'https://dry.com/1' }));
    assert.ok(!existsSync(tmpDryDir), 'dryRun no debe crear archivos');
  });

  test('queueBatch encola múltiples ofertas', () => {
    const tracker = new ApplicationTracker({
      trackerPath: `${TMP_DIR}/batch-tracker.md`,
      tsvDir:      `${TMP_DIR}/batch-tsv`,
    });
    const offers  = Array.from({ length: 3 }, (_, i) =>
      makeOffer({ url: `https://batch.com/${i}`, company: `BatchCo${i}` })
    );
    const results = tracker.queueBatch(offers);
    assert.equal(results.length, 3);
    assert.equal(results[0].num, 1);
    assert.equal(results[2].num, 3);
  });
});

// ── Tests: ApplicationTracker (read) ────────────────────────────────────────

describe('ApplicationTracker — readEntries() / readMetrics()', () => {
  test('readEntries retorna array vacío si tracker no existe', () => {
    const tracker = new ApplicationTracker({ trackerPath: `${TMP_DIR}/nonexistent.md`, tsvDir: TMP_TSV_DIR });
    assert.deepEqual(tracker.readEntries(), []);
  });

  test('readMetrics retorna métricas vacías si no hay entradas', () => {
    const tracker = new ApplicationTracker({ trackerPath: `${TMP_DIR}/empty.md`, tsvDir: TMP_TSV_DIR });
    writeFileSync(`${TMP_DIR}/empty.md`, '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
    const metrics = tracker.readMetrics();
    assert.equal(metrics.total, 0);
  });

  test('readEntries parsea entradas correctamente', () => {
    const trackerPath = `${TMP_DIR}/parseable.md`;
    const content = [
      '# Applications Tracker',
      '',
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|------|---------|------|-------|--------|-----|--------|-------|',
      '| 1 | 2026-05-24 | Nubank | Data Analyst | 4.2/5 | QUEUED | ❌ |  | Good match |',
      '| 2 | 2026-05-24 | Globant | BI Developer | 3.8/5 | QUEUED | ❌ |  | Stack match |',
      '',
    ].join('\n');
    writeFileSync(trackerPath, content);

    const tracker  = new ApplicationTracker({ trackerPath, tsvDir: TMP_TSV_DIR });
    const entries  = tracker.readEntries();
    assert.equal(entries.length,    2);
    assert.equal(entries[0].company, 'Nubank');
    assert.equal(entries[0].score,   4.2);
    assert.equal(entries[0].status,  'QUEUED');
    assert.equal(entries[1].company, 'Globant');
  });

  test('readMetrics calcula avgScore correctamente', () => {
    const trackerPath = `${TMP_DIR}/metrics-tracker.md`;
    const content = [
      '# Applications Tracker',
      '',
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|------|---------|------|-------|--------|-----|--------|-------|',
      '| 1 | 2026-05-24 | CoA | Analyst | 4.0/5 | QUEUED | ❌ |  |  |',
      '| 2 | 2026-05-24 | CoB | Developer | 3.0/5 | QUEUED | ❌ |  |  |',
    ].join('\n');
    writeFileSync(trackerPath, content);

    const tracker = new ApplicationTracker({ trackerPath, tsvDir: TMP_TSV_DIR });
    const metrics = tracker.readMetrics();
    assert.equal(metrics.total,    2);
    assert.equal(metrics.avgScore, 3.5);
  });

  test('findEntry retorna null si no existe', () => {
    const tracker = new ApplicationTracker({ trackerPath: TMP_TRACKER, tsvDir: TMP_TSV_DIR });
    const found   = tracker.findEntry('NonExistentCo', 'Some Role');
    assert.equal(found, null);
  });
});

// ── Tests: CoverLetterGenerator ──────────────────────────────────────────────

const VALID_CL_RESPONSE = JSON.stringify({
  subject_line: 'Candidatura Data Analyst — Nubank',
  cover_letter: 'Nubank está redefiniendo la banca en LATAM, y ese movimiento necesita datos.\n\nCon experiencia en Power BI y SQL, construí dashboards KPI...\n\nEspero poder conversar sobre cómo puedo aportar.',
  language:     'es',
  word_count:   42,
});

function makeMockClient(responses) {
  let i = 0;
  return {
    messages: {
      create: async () => {
        const text = responses[i] ?? responses[responses.length - 1];
        i++;
        return { content: [{ text }] };
      },
    },
  };
}

describe('CoverLetterGenerator — generate()', () => {
  test('retorna CoverLetterResult válido', async () => {
    const gen    = new CoverLetterGenerator({
      _client:        makeMockClient([VALID_CL_RESPONSE]),
      promptTemplate: 'prompts/cover-letter/system-prompt.md',
      profilePath:    'config/victor_profile.md',
      saveToFile:     false,
    });
    const offer  = { url: 'https://nubank.com/jobs/1', title: 'Data Analyst', company: 'Nubank', location: 'Remote' };
    const result = await gen.generate(offer, 'Sample JD text for Nubank position.');

    assert.equal(result.language,        'es');
    assert.equal(result.company,         'Nubank');
    assert.ok(result.subject_line.length > 0, 'subject_line no debe estar vacío');
    assert.ok(result.cover_letter.length > 0, 'cover_letter no debe estar vacío');
    assert.ok(result.word_count > 0,          'word_count debe ser > 0');
  });

  test('extrae JSON de markdown fence', async () => {
    const fenced = `Aquí está la carta:\n\`\`\`json\n${VALID_CL_RESPONSE}\n\`\`\``;
    const gen    = new CoverLetterGenerator({
      _client:        makeMockClient([fenced]),
      promptTemplate: 'prompts/cover-letter/system-prompt.md',
      profilePath:    'config/victor_profile.md',
      saveToFile:     false,
    });
    const result = await gen.generate({ url: '', title: '', company: 'Nubank', location: '' }, 'JD');
    assert.equal(result.language, 'es');
  });

  test('lanza CoverLetterError si la API falla', async () => {
    const gen = new CoverLetterGenerator({
      _client: { messages: { create: async () => { throw new Error('Network error'); } } },
      promptTemplate: 'prompts/cover-letter/system-prompt.md',
      profilePath:    'config/victor_profile.md',
      saveToFile:     false,
    });
    await assert.rejects(
      () => gen.generate({ url: 'https://x.com', title: '', company: 'X', location: '' }, 'JD'),
      (err) => {
        assert.ok(err instanceof CoverLetterError);
        assert.equal(err.code, 'API_ERROR');
        return true;
      }
    );
  });

  test('guarda carta a disco cuando saveToFile=true', async () => {
    const gen = new CoverLetterGenerator({
      _client:        makeMockClient([VALID_CL_RESPONSE]),
      promptTemplate: 'prompts/cover-letter/system-prompt.md',
      profilePath:    'config/victor_profile.md',
      saveToFile:     true,
      outputDir:      TMP_OUTPUT_DIR,
    });
    const offer  = { url: 'https://nubank.com/jobs/save-test', title: 'Data Analyst', company: 'SaveTest', location: 'Remote' };
    const result = await gen.generate(offer, 'JD text');
    assert.ok(result.saved_path,            'debe retornar saved_path');
    assert.ok(existsSync(result.saved_path),'archivo debe existir en disco');
  });

  test('_validateSchema rechaza language inválido', () => {
    const gen = new CoverLetterGenerator({ _client: makeMockClient([]), saveToFile: false });
    const err = gen._validateSchema({ subject_line: 'x', cover_letter: 'y', language: 'pt', word_count: 50 });
    assert.ok(err, 'debe retornar error para language "pt"');
    assert.ok(err.includes('language'));
  });
});

// ── Tests: ApplicationAgent ───────────────────────────────────────────────────

describe('ApplicationAgent — run()', () => {
  function makeDummyAgent(options = {}) {
    const tracker = new ApplicationTracker({
      trackerPath: `${TMP_DIR}/agent-tracker-${Date.now()}.md`,
      tsvDir:      `${TMP_DIR}/agent-tsv-${Date.now()}`,
    });
    return new ApplicationAgent({
      scoreThreshold:     3.5,
      skipCoverLetter:    true,
      skipDuplicateCheck: true,
      dryRun:             false,
      tracker,
      ...options,
    });
  }

  test('filtra ofertas bajo el umbral', async () => {
    const agent  = makeDummyAgent();
    const offers = [
      makeOffer({ url: 'https://a.com', score: 4.5, apply_recommendation: true }),
      makeOffer({ url: 'https://b.com', score: 2.0, apply_recommendation: false }),
    ];
    const { queued, stats } = await agent.run(offers, 'test');
    assert.equal(queued.length,        1, 'solo debe encolar la oferta con score >= 3.5');
    assert.equal(stats.belowThreshold, 1, 'debe contar 1 bajo umbral');
  });

  test('filtra apply_recommendation=false cuando requireRecommendation=true', async () => {
    const agent  = makeDummyAgent({ requireRecommendation: true });
    const offers = [
      makeOffer({ url: 'https://a.com', score: 4.0, apply_recommendation: true }),
      makeOffer({ url: 'https://b.com', score: 4.0, apply_recommendation: false }),
    ];
    const { queued, stats } = await agent.run(offers, 'test');
    assert.equal(queued.length,       1);
    assert.equal(stats.notRecommended, 1);
  });

  test('batch vacío retorna stats en cero', async () => {
    const agent  = makeDummyAgent();
    const { queued, stats } = await agent.run([], 'test');
    assert.equal(queued.length,  0);
    assert.equal(stats.queued,   0);
    assert.equal(stats.received, 0);
  });

  test('agrega tracker_num a cada oferta encolada', async () => {
    const agent  = makeDummyAgent();
    const offers = [makeOffer({ url: 'https://num.com', score: 4.0 })];
    const { queued } = await agent.run(offers, 'test');
    assert.ok('tracker_num' in queued[0], 'debe tener tracker_num');
    assert.ok(queued[0].tracker_num >= 1, 'tracker_num debe ser >= 1');
  });

  test('dryRun=true encola sin escribir archivos en producción', async () => {
    const dryTracker = path.join(TMP_DIR, 'dry-agent-tracker.md');
    const agent      = makeDummyAgent({ dryRun: true });
    // Override tracker with dryRun version
    agent._tracker   = new ApplicationTracker({
      trackerPath: dryTracker,
      tsvDir:      `${TMP_DIR}/dry-tsv`,
      dryRun:      true,
    });
    await agent.run([makeOffer({ url: 'https://dry-agent.com', score: 4.0 })], 'test');
    assert.ok(!existsSync(dryTracker), 'dryRun no debe crear tracker');
  });

  test('ofertas son ordenadas por priority_score', async () => {
    const agent  = makeDummyAgent();
    const offers = [
      makeOffer({ url: 'https://low.com',  score: 3.6, company: 'LowCo'  }),
      makeOffer({ url: 'https://high.com', score: 4.9, company: 'HighCo' }),
      makeOffer({ url: 'https://mid.com',  score: 4.2, company: 'MidCo'  }),
    ];
    const { queued } = await agent.run(offers, 'test');
    assert.equal(queued.length, 3);
    // Should be in descending priority order
    assert.ok(
      queued[0].priority_score >= queued[1].priority_score &&
      queued[1].priority_score >= queued[2].priority_score,
      'debe estar ordenado por priority_score desc'
    );
  });
});

console.log('✅ application-agent.test.mjs: todos los tests definidos');
