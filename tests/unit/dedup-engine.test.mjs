/**
 * dedup-engine.test.mjs — Tests unitarios para DedupEngine
 *
 * Usa archivos temporales en memoria para no tocar los datos de producción.
 * Correr: node --test tests/unit/dedup-engine.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { DedupEngine, normalizeUrl, hashUrl } from '../../agents/data-manager/dedup-engine.mjs';

// ── Setup: directorio temp para tests ────────────────────────────────────────

const TMP_DIR   = 'tests/tmp-dedup';
const TMP_INDEX = `${TMP_DIR}/dedup-index.json`;

before(() => { mkdirSync(TMP_DIR, { recursive: true }); });
after(()  => { if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true }); });

function freshEngine() {
  return new DedupEngine({
    indexPath:        TMP_INDEX,
    scanHistoryPath:  'tests/fixtures/no-such-file.tsv',   // no existe → OK
    pipelinePath:     'tests/fixtures/no-such-file.md',
    applicationsPath: 'tests/fixtures/no-such-file.md',
    ttlDays: 90,
  });
}

// ── Tests: normalizeUrl ───────────────────────────────────────────────────────

describe('normalizeUrl', () => {
  test('elimina parámetros UTM', () => {
    const url    = 'https://example.com/job/1?utm_source=linkedin&utm_medium=social';
    const result = normalizeUrl(url);
    assert.ok(!result.includes('utm_'), 'debe eliminar UTM params');
    assert.ok(result.includes('/job/1'), 'debe conservar el path');
  });

  test('normaliza hostname a minúsculas', () => {
    const result = normalizeUrl('https://GREENHOUSE.IO/jobs/123');
    assert.ok(result.includes('greenhouse.io'), 'hostname debe ser lowercase');
  });

  test('elimina trailing slash del path', () => {
    const result = normalizeUrl('https://example.com/jobs/');
    assert.ok(!result.endsWith('/'), 'no debe terminar en /');
  });

  test('URLs inválidas se devuelven sin modificar', () => {
    const bad = 'not-a-url';
    assert.equal(normalizeUrl(bad), bad);
  });
});

// ── Tests: hashUrl ────────────────────────────────────────────────────────────

describe('hashUrl', () => {
  test('produce hash de 12 caracteres', () => {
    const h = hashUrl('https://example.com/job/1');
    assert.equal(h.length, 12);
  });

  test('misma URL → mismo hash', () => {
    const url = 'https://boards.greenhouse.io/nubank/jobs/123';
    assert.equal(hashUrl(url), hashUrl(url));
  });

  test('URLs distintas → hashes distintos', () => {
    const h1 = hashUrl('https://example.com/job/1');
    const h2 = hashUrl('https://example.com/job/2');
    assert.notEqual(h1, h2);
  });

  test('URL con y sin UTM → mismo hash (normalización)', () => {
    const base = 'https://example.com/job/42';
    const utm  = 'https://example.com/job/42?utm_source=test';
    assert.equal(hashUrl(base), hashUrl(utm));
  });
});

// ── Tests: isSeen / markSeen ──────────────────────────────────────────────────

describe('DedupEngine — isSeen / markSeen', () => {
  test('URL nueva → not seen', () => {
    const engine = freshEngine();
    const result = engine.isSeen('https://example.com/jobs/new-job-1');
    assert.equal(result.seen, false);
  });

  test('URL marcada → seen en próxima consulta', () => {
    const engine = freshEngine();
    const url    = 'https://example.com/jobs/marked-1';
    engine.markSeen(url, { source_portal: 'test', company: 'ACME', title: 'Dev', status: 'added' });
    const result = engine.isSeen(url);
    assert.equal(result.seen, true);
    assert.equal(result.source, 'dedup-index');
  });

  test('isSeen es case-insensitive en hostname', () => {
    const engine   = freshEngine();
    const urlLower = 'https://example.com/jobs/case-test';
    const urlUpper = 'https://EXAMPLE.COM/jobs/case-test';
    engine.markSeen(urlLower, { source_portal: 'test', status: 'added' });
    assert.equal(engine.isSeen(urlUpper).seen, true, 'debe encontrar la URL uppercase como duplicada');
  });

  test('URL con UTMs es reconocida como seen', () => {
    const engine  = freshEngine();
    const baseUrl = 'https://example.com/jobs/utm-test';
    engine.markSeen(baseUrl, { source_portal: 'test', status: 'added' });
    const withUtm = baseUrl + '?utm_source=linkedin&utm_campaign=test';
    assert.equal(engine.isSeen(withUtm).seen, true, 'UTM no debe crear una nueva entrada');
  });
});

// ── Tests: filterNew ──────────────────────────────────────────────────────────

describe('DedupEngine — filterNew', () => {
  test('filtra correctamente un batch mixto', () => {
    const engine = freshEngine();
    const seen1  = 'https://example.com/jobs/seen-a';
    const seen2  = 'https://example.com/jobs/seen-b';

    // Pre-marcar 2 URLs
    engine.markSeen(seen1, { status: 'added', source_portal: 'test' });
    engine.markSeen(seen2, { status: 'added', source_portal: 'test' });

    const batch = [
      { url: seen1,                          title: 'Seen A', company: 'Co', location: '' },
      { url: seen2,                          title: 'Seen B', company: 'Co', location: '' },
      { url: 'https://example.com/jobs/new', title: 'New Job', company: 'Co', location: '' },
    ];

    const { newOffers, duplicates } = engine.filterNew(batch);
    assert.equal(newOffers.length,  1, 'debe retornar solo 1 oferta nueva');
    assert.equal(duplicates,        2, 'debe reportar 2 duplicados');
    assert.equal(newOffers[0].url, 'https://example.com/jobs/new');
  });

  test('batch vacío retorna 0 nuevas, 0 duplicados', () => {
    const engine = freshEngine();
    const { newOffers, duplicates } = engine.filterNew([]);
    assert.equal(newOffers.length, 0);
    assert.equal(duplicates,       0);
  });

  test('batch 100% nuevo retorna todo', () => {
    const engine = freshEngine();
    const batch  = Array.from({ length: 5 }, (_, i) => ({
      url: `https://example.com/jobs/fresh-${i}`,
      title: `Job ${i}`, company: 'Co', location: '',
    }));
    const { newOffers, duplicates } = engine.filterNew(batch);
    assert.equal(newOffers.length, 5);
    assert.equal(duplicates,       0);
  });
});

// ── Tests: stats ─────────────────────────────────────────────────────────────

describe('DedupEngine — stats', () => {
  test('stats refleja entradas por portal', () => {
    // Índice aislado propio para no verse afectado por tests anteriores
    const engine = new DedupEngine({
      indexPath:        `${TMP_DIR}/stats-isolated.json`,
      scanHistoryPath:  'tests/fixtures/no-such-file.tsv',
      pipelinePath:     'tests/fixtures/no-such-file.md',
      applicationsPath: 'tests/fixtures/no-such-file.md',
      ttlDays: 90,
    });
    engine.markSeen('https://gh.io/job/1', { source_portal: 'greenhouse', status: 'added' });
    engine.markSeen('https://gh.io/job/2', { source_portal: 'greenhouse', status: 'scored' });
    engine.markSeen('https://lv.co/job/1', { source_portal: 'lever',      status: 'added' });

    const stats = engine.stats();
    assert.equal(stats.total,                     3);
    assert.equal(stats.byPortal['greenhouse'],     2);
    assert.equal(stats.byPortal['lever'],          1);
    assert.equal(stats.byStatus['added'],          2);
    assert.equal(stats.byStatus['scored'],         1);
  });
});

console.log('✅ dedup-engine.test.mjs: todos los tests definidos');
