/**
 * scraper-interface.test.mjs — Tests unitarios para BaseScraperAdapter y ScraperV2
 *
 * Usa solo fixtures locales — sin llamadas reales a internet.
 * Correr: node --test tests/unit/scraper-interface.test.mjs
 */

import { readFileSync } from 'node:fs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BaseScraperAdapter, ScraperV2, assertNormalizedOffer } from '../../agents/discovery/scraper-interface.mjs';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const greenhouseSample = JSON.parse(readFileSync('tests/fixtures/greenhouse-sample.json', 'utf-8'));
const leverSample      = JSON.parse(readFileSync('tests/fixtures/lever-sample.json', 'utf-8'));
const ashbySample      = JSON.parse(readFileSync('tests/fixtures/ashby-sample.json', 'utf-8'));

// ── Mock providers ────────────────────────────────────────────────────────────

function makeGreenhouseMock() {
  return {
    id: 'greenhouse',
    detect: () => ({ url: 'mock' }),
    fetch: async (_entry, _ctx) => {
      const jobs = greenhouseSample.jobs;
      return jobs.filter(j => j.absolute_url).map(j => ({
        title:    j.title,
        url:      j.absolute_url,
        company:  'Test Company',
        location: j.location?.name ?? '',
      }));
    },
  };
}

function makeLeverMock() {
  return {
    id: 'lever',
    detect: () => ({ url: 'mock' }),
    fetch: async (_entry, _ctx) => {
      return leverSample
        .filter(j => j.hostedUrl)
        .map(j => ({
          title:    j.text,
          url:      j.hostedUrl,
          company:  'Test Company',
          location: j.categories?.location ?? '',
        }));
    },
  };
}

function makeErrorMock() {
  return {
    id: 'error-provider',
    detect: () => null,
    fetch: async () => { throw new Error('Simulated scraper failure'); },
  };
}

const mockCtx = { fetchJson: async () => {}, fetchText: async () => '' };
const mockEntry = { name: 'Test Company', careers_url: 'https://example.com' };

// ── Tests: assertNormalizedOffer ──────────────────────────────────────────────

describe('assertNormalizedOffer', () => {
  test('acepta oferta válida completa', () => {
    const offer = {
      url: 'https://example.com/job/1',
      title: 'Data Analyst',
      company: 'ACME',
      location: 'Remote',
      date_found: new Date().toISOString(),
      source_portal: 'greenhouse',
    };
    assert.doesNotThrow(() => assertNormalizedOffer(offer));
  });

  test('rechaza oferta sin url', () => {
    assert.throws(
      () => assertNormalizedOffer({ title: 'X', company: 'Y', location: '', date_found: '', source_portal: 'gh' }),
      /campo requerido faltante.*url/i
    );
  });

  test('rechaza URL no-HTTP', () => {
    assert.throws(
      () => assertNormalizedOffer({ url: 'ftp://bad.com', title: 'X', company: 'Y', location: '', date_found: '', source_portal: 'gh' }),
      /url.*http/i
    );
  });

  test('rechaza oferta con campo null', () => {
    assert.throws(
      () => assertNormalizedOffer({ url: 'https://x.com', title: null, company: 'Y', location: '', date_found: '', source_portal: 'gh' }),
      /campo requerido faltante.*title/i
    );
  });
});

// ── Tests: BaseScraperAdapter ─────────────────────────────────────────────────

describe('BaseScraperAdapter', () => {
  test('normaliza correctamente la salida de Greenhouse', async () => {
    const adapter = new BaseScraperAdapter(makeGreenhouseMock(), mockCtx);
    const result  = await adapter.scrape(mockEntry);

    assert.equal(result.status, 'ok');
    assert.equal(result.portal, 'greenhouse');
    assert.ok(result.offers.length > 0, 'debe retornar al menos 1 oferta');
    assert.ok(typeof result.duration === 'number', 'duration debe ser número');

    // Verificar estructura de cada oferta
    for (const offer of result.offers) {
      assert.ok(offer.url.startsWith('https://'), `URL inválida: ${offer.url}`);
      assert.ok(offer.title,        'title no puede estar vacío');
      assert.ok(offer.company,      'company no puede estar vacío');
      assert.equal(offer.source_portal, 'greenhouse');
      assert.ok(offer.date_found,   'date_found debe estar presente');
    }
  });

  test('normaliza correctamente la salida de Lever', async () => {
    const adapter = new BaseScraperAdapter(makeLeverMock(), mockCtx);
    const result  = await adapter.scrape(mockEntry);

    assert.equal(result.status, 'ok');
    // leverSample tiene 2 con hostedUrl válido y 1 sin URL (filtrado)
    assert.equal(result.offers.length, 2, 'debe filtrar job sin URL');
  });

  test('retorna status error cuando el provider falla', async () => {
    const adapter = new BaseScraperAdapter(makeErrorMock(), mockCtx);
    const result  = await adapter.scrape(mockEntry);

    assert.equal(result.status, 'error');
    assert.ok(result.error.includes('Simulated'), 'debe propagar el mensaje de error');
    assert.equal(result.offers.length, 0);
  });

  test('rechaza provider sin método fetch()', () => {
    assert.throws(
      () => new BaseScraperAdapter({ id: 'bad' }, mockCtx),
      /requiere un provider con método fetch/
    );
  });

  test('location es string vacío cuando no disponible (nunca null)', async () => {
    const noLocationProvider = {
      id: 'no-location',
      detect: () => null,
      fetch: async () => [{ title: 'Dev', url: 'https://x.com/job/1', company: 'Co' }],
    };
    const adapter = new BaseScraperAdapter(noLocationProvider, mockCtx);
    const result  = await adapter.scrape(mockEntry);
    assert.equal(result.offers[0].location, '', 'location debe ser string vacío, no undefined/null');
  });
});

// ── Tests: ScraperV2 (abstracto) ──────────────────────────────────────────────

describe('ScraperV2', () => {
  test('lanza error si fetch() no está implementado', async () => {
    const scraper = new ScraperV2('abstract-test');
    const result  = await scraper.scrape(mockEntry);
    assert.equal(result.status, 'error');
    assert.ok(result.error.includes('no implementado'));
  });

  test('subclase con fetch() implementado funciona correctamente', async () => {
    class MiScraper extends ScraperV2 {
      async fetch(_entry) {
        return [{ url: 'https://example.com/job/99', title: 'Test Job', company: 'ACME', location: 'Remote' }];
      }
    }
    const scraper = new MiScraper('mi-scraper');
    const result  = await scraper.scrape(mockEntry);
    assert.equal(result.status, 'ok');
    assert.equal(result.offers[0].source_portal, 'mi-scraper');
    assert.ok(result.offers[0].date_found);
  });
});

console.log('✅ scraper-interface.test.mjs: todos los tests definidos');
