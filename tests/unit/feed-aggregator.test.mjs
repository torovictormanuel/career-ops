/**
 * feed-aggregator.test.mjs — Tests unitarios para FeedAggregator
 *
 * Correr: node --test tests/unit/feed-aggregator.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FeedAggregator } from '../../agents/discovery/feed-aggregator.mjs';

// ── Factories ─────────────────────────────────────────────────────────────────

function makeOkResult(portal, offers) {
  return { status: 'ok', portal, offers, duration: 100 };
}

function makeErrorResult(portal, error) {
  return { status: 'error', portal, offers: [], duration: 50, error };
}

function makeSkippedResult(portal) {
  return { status: 'skipped', portal, offers: [], duration: 0 };
}

function makeOffer(url, portal = 'test') {
  return {
    url,
    title:         'Data Analyst',
    company:       'ACME Corp',
    location:      'Remote',
    date_found:    new Date().toISOString(),
    source_portal: portal,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FeedAggregator — aggregate()', () => {
  test('retorna array vacío cuando no hay resultados', () => {
    const agg = new FeedAggregator();
    const { offers, stats } = agg.aggregate();
    assert.equal(offers.length, 0);
    assert.equal(stats.totalOffers, 0);
  });

  test('consolida resultados de múltiples portales', () => {
    const agg = new FeedAggregator();
    agg.addResult(makeOkResult('greenhouse', [
      makeOffer('https://gh.io/job/1', 'greenhouse'),
      makeOffer('https://gh.io/job/2', 'greenhouse'),
    ]));
    agg.addResult(makeOkResult('lever', [
      makeOffer('https://lever.co/job/1', 'lever'),
    ]));

    const { offers, stats } = agg.aggregate();
    assert.equal(offers.length,        3);
    assert.equal(stats.portalsSuccess, 2);
    assert.equal(stats.totalOffers,    3);
  });

  test('deduplica URLs duplicadas intra-batch', () => {
    const agg = new FeedAggregator();
    agg.addResult(makeOkResult('portal-a', [
      makeOffer('https://example.com/job/shared'),
      makeOffer('https://example.com/job/unique-a'),
    ]));
    agg.addResult(makeOkResult('portal-b', [
      makeOffer('https://example.com/job/shared'), // duplicado
      makeOffer('https://example.com/job/unique-b'),
    ]));

    const { offers, stats } = agg.aggregate();
    assert.equal(offers.length,               3, 'debe retornar 3 (1 dedup eliminado)');
    assert.equal(stats.intraBatchDuplicates,   1, 'debe reportar 1 duplicado intra-batch');
  });

  test('normaliza URLs (elimina UTMs) antes de deduplicar', () => {
    const agg = new FeedAggregator();
    agg.addResult(makeOkResult('p1', [makeOffer('https://example.com/job/1')]));
    agg.addResult(makeOkResult('p2', [makeOffer('https://example.com/job/1?utm_source=test')]));

    const { offers } = agg.aggregate();
    assert.equal(offers.length, 1, 'URL con UTM debe ser reconocida como duplicada');
  });

  test('excluye resultados con status error de las ofertas', () => {
    const agg = new FeedAggregator();
    agg.addResult(makeOkResult('ok-portal', [makeOffer('https://example.com/job/1')]));
    agg.addResult(makeErrorResult('bad-portal', 'HTTP 403'));

    const { offers, stats } = agg.aggregate();
    assert.equal(offers.length,       1, 'solo debe incluir ofertas del portal OK');
    assert.equal(stats.portalsError,  1, 'debe contar el portal con error');
    assert.equal(stats.portalsSuccess, 1);
  });

  test('cuenta portales skipped (Circuit Breaker)', () => {
    const agg = new FeedAggregator();
    agg.addResult(makeSkippedResult('blocked-portal'));
    agg.addResult(makeOkResult('ok-portal', [makeOffer('https://example.com/job/1')]));

    const { stats } = agg.aggregate();
    assert.equal(stats.portalsSkipped, 1);
    assert.equal(stats.portalsSuccess, 1);
  });

  test('sanitiza campos null/undefined a string vacío', () => {
    const agg = new FeedAggregator();
    agg.addResult(makeOkResult('test', [{
      url:           'https://example.com/job/1',
      title:         null,
      company:       undefined,
      location:      null,
      date_found:    new Date().toISOString(),
      source_portal: 'test',
    }]));

    const { offers } = agg.aggregate();
    assert.equal(offers.length, 1);
    assert.equal(offers[0].title,    '', 'title null debe ser string vacío');
    assert.equal(offers[0].company,  '', 'company undefined debe ser string vacío');
    assert.equal(offers[0].location, '', 'location null debe ser string vacío');
  });

  test('reset() limpia el estado para nueva ejecución', () => {
    const agg = new FeedAggregator();
    agg.addResult(makeOkResult('p1', [makeOffer('https://example.com/job/1')]));
    agg.reset();
    const { offers } = agg.aggregate();
    assert.equal(offers.length, 0, 'después de reset() debe estar vacío');
  });

  test('stats.totalDurationMs suma duraciones de todos los portales', () => {
    const agg = new FeedAggregator();
    agg.addResult({ status: 'ok', portal: 'p1', offers: [], duration: 200 });
    agg.addResult({ status: 'ok', portal: 'p2', offers: [], duration: 350 });
    const { stats } = agg.aggregate();
    assert.equal(stats.totalDurationMs, 550);
  });
});

console.log('✅ feed-aggregator.test.mjs: todos los tests definidos');
