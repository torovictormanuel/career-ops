/**
 * pre-filter.test.mjs — Tests unitarios para PreFilter
 *
 * Correr: node --test tests/unit/pre-filter.test.mjs
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { PreFilter } from '../../agents/analysis/pre-filter.mjs';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TMP_DIR = 'tests/tmp-prefilter';

const SAMPLE_RULES_YAML = `
reject_if_title_contains:
  - "intern"
  - "trainee"
  - "pasante"
  - "blockchain developer"

reject_if_jd_contains:
  - "100% presencial"
  - "solo presencial"
  - "us work authorization required"

reject_if_location:
  - "only new york"
  - "only london"

require_any_title: []

company_blacklist:
  - "shadyco"
  - "scam corp"

min_jd_chars: 50
`.trim();

const EMPTY_RULES_YAML = `
reject_if_title_contains: []
reject_if_jd_contains: []
reject_if_location: []
require_any_title: []
company_blacklist: []
min_jd_chars: 0
`.trim();

before(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(`${TMP_DIR}/rules.yml`, SAMPLE_RULES_YAML, 'utf8');
  writeFileSync(`${TMP_DIR}/empty-rules.yml`, EMPTY_RULES_YAML, 'utf8');
});

function freshFilter(rulesFile = 'rules.yml') {
  return new PreFilter(`${TMP_DIR}/${rulesFile}`);
}

function makeOffer(overrides = {}) {
  return {
    title:    'Data Analyst',
    jd:       'We are looking for a data analyst with Power BI and SQL experience to join our remote team.',
    location: 'Remote',
    company:  'Nubank',
    ...overrides,
  };
}

// ── Tests: pass-through ───────────────────────────────────────────────────────

describe('PreFilter — ofertas válidas', () => {
  test('oferta limpia pasa todas las reglas', () => {
    const pf     = freshFilter();
    const result = pf.evaluate(makeOffer());
    assert.equal(result.pass, true);
  });

  test('oferta con campos opcionales vacíos pasa (fail-open)', () => {
    const pf     = freshFilter();
    // JD must be >= 50 chars (min_jd_chars rule), location and company empty = ok
    const result = pf.evaluate({ title: 'Data Analyst', jd: 'A reasonably long job description text that exceeds fifty characters.', location: '', company: '' });
    assert.equal(result.pass, true);
  });

  test('oferta sin campos retorna pass=true (fail-open, mejor que crash)', () => {
    const pf     = freshFilter('empty-rules.yml');
    const result = pf.evaluate({});
    assert.equal(result.pass, true);
  });
});

// ── Tests: reject_if_title_contains ─────────────────────────────────────────

describe('PreFilter — reject_if_title_contains', () => {
  test('título con "intern" es rechazado', () => {
    const pf     = freshFilter();
    const result = pf.evaluate(makeOffer({ title: 'Data Intern' }));
    assert.equal(result.pass, false);
    assert.equal(result.rule, 'reject_if_title_contains');
    assert.ok(result.reason.includes('intern'));
  });

  test('detección es case-insensitive (INTERN, Trainee)', () => {
    const pf = freshFilter();
    assert.equal(pf.evaluate(makeOffer({ title: 'DATA INTERN' })).pass, false);
    assert.equal(pf.evaluate(makeOffer({ title: 'Trainee Analyst' })).pass, false);
  });

  test('título con "pasante" en español es rechazado', () => {
    const pf     = freshFilter();
    const result = pf.evaluate(makeOffer({ title: 'Analista Pasante' }));
    assert.equal(result.pass, false);
  });

  test('título con "blockchain developer" es rechazado', () => {
    const pf     = freshFilter();
    const result = pf.evaluate(makeOffer({ title: 'Senior Blockchain Developer' }));
    assert.equal(result.pass, false);
  });

  test('partial match es suficiente (substring)', () => {
    // "internship" contains "intern"
    const pf     = freshFilter();
    const result = pf.evaluate(makeOffer({ title: 'Data Internship Program' }));
    assert.equal(result.pass, false);
  });
});

// ── Tests: reject_if_jd_contains ────────────────────────────────────────────

describe('PreFilter — reject_if_jd_contains', () => {
  test('JD con "100% presencial" es rechazado', () => {
    const pf     = freshFilter();
    const result = pf.evaluate(makeOffer({ jd: 'Este puesto es 100% presencial en CABA. Requisitos: SQL y Power BI.' }));
    assert.equal(result.pass, false);
    assert.equal(result.rule, 'reject_if_jd_contains');
  });

  test('JD con "solo presencial" es rechazado', () => {
    const pf     = freshFilter();
    const result = pf.evaluate(makeOffer({ jd: 'El trabajo es solo presencial en nuestras oficinas de Palermo.' }));
    assert.equal(result.pass, false);
  });

  test('JD con "us work authorization required" es rechazado', () => {
    const pf     = freshFilter();
    const result = pf.evaluate(makeOffer({ jd: 'US work authorization required. Must be located in the continental US.' }));
    assert.equal(result.pass, false);
  });

  test('JD limpio con esas palabras por separado no es rechazado', () => {
    // "solo" y "presencial" por separado no disparan la regla "solo presencial"
    const pf     = freshFilter();
    const result = pf.evaluate(makeOffer({ jd: 'El rol puede ser remoto. Preferimos candidatos solo con experiencia en BI. La modalidad no es presencial.' }));
    assert.equal(result.pass, true);
  });
});

// ── Tests: reject_if_location ────────────────────────────────────────────────

describe('PreFilter — reject_if_location', () => {
  test('ubicación "only new york" es rechazada', () => {
    const pf     = freshFilter();
    const result = pf.evaluate(makeOffer({ location: 'Only New York' }));
    assert.equal(result.pass, false);
    assert.equal(result.rule, 'reject_if_location');
  });

  test('ubicación "only london" es rechazada', () => {
    const pf     = freshFilter();
    const result = pf.evaluate(makeOffer({ location: 'Only London, UK' }));
    assert.equal(result.pass, false);
  });

  test('ubicación "Remote - LATAM" pasa', () => {
    const pf     = freshFilter();
    const result = pf.evaluate(makeOffer({ location: 'Remote - LATAM' }));
    assert.equal(result.pass, true);
  });
});

// ── Tests: company_blacklist ─────────────────────────────────────────────────

describe('PreFilter — company_blacklist', () => {
  test('empresa en blacklist es rechazada', () => {
    const pf     = freshFilter();
    const result = pf.evaluate(makeOffer({ company: 'ShadyCo' }));
    assert.equal(result.pass, false);
    assert.equal(result.rule, 'company_blacklist');
  });

  test('blacklist es case-insensitive', () => {
    const pf     = freshFilter();
    const result = pf.evaluate(makeOffer({ company: 'SCAM CORP' }));
    assert.equal(result.pass, false);
  });

  test('empresa legítima no está en blacklist', () => {
    const pf     = freshFilter();
    const result = pf.evaluate(makeOffer({ company: 'MercadoLibre' }));
    assert.equal(result.pass, true);
  });
});

// ── Tests: min_jd_chars ──────────────────────────────────────────────────────

describe('PreFilter — min_jd_chars', () => {
  test('JD muy corto es rechazado', () => {
    const pf     = freshFilter();
    const result = pf.evaluate(makeOffer({ jd: 'Short.' }));
    assert.equal(result.pass, false);
    assert.equal(result.rule, 'min_jd_chars');
  });

  test('JD exactamente en el límite (50 chars) pasa', () => {
    const pf  = freshFilter();
    const jd  = 'a'.repeat(50);  // exactly 50 chars
    const result = pf.evaluate(makeOffer({ jd }));
    assert.equal(result.pass, true);
  });

  test('JD de 49 chars es rechazado', () => {
    const pf  = freshFilter();
    const jd  = 'a'.repeat(49);
    const result = pf.evaluate(makeOffer({ jd }));
    assert.equal(result.pass, false);
  });
});

// ── Tests: evaluateBatch ─────────────────────────────────────────────────────

describe('PreFilter — evaluateBatch()', () => {
  test('batch mixto: pasan los válidos, rechazan los inválidos', () => {
    const pf = freshFilter();
    const offers = [
      makeOffer({ title: 'Data Analyst' }),         // pass
      makeOffer({ title: 'Data Intern' }),           // reject
      makeOffer({ title: 'BI Developer' }),          // pass
      makeOffer({ company: 'ShadyCo' }),             // reject (blacklist)
    ];

    const { passed, rejected } = pf.evaluateBatch(offers);
    assert.equal(passed.length,   2);
    assert.equal(rejected.length, 2);
    assert.equal(rejected[0].rule, 'reject_if_title_contains');
    assert.equal(rejected[1].rule, 'company_blacklist');
  });

  test('batch vacío retorna arrays vacíos', () => {
    const pf = freshFilter();
    const { passed, rejected } = pf.evaluateBatch([]);
    assert.equal(passed.length,   0);
    assert.equal(rejected.length, 0);
  });

  test('batch 100% válido retorna todo en passed', () => {
    const pf = freshFilter();
    const offers = Array.from({ length: 5 }, (_, i) =>
      makeOffer({ title: `Data Analyst ${i}`, company: `Company ${i}` })
    );
    const { passed, rejected } = pf.evaluateBatch(offers);
    assert.equal(passed.length,   5);
    assert.equal(rejected.length, 0);
  });
});

// ── Tests: rulesSummary / reloadRules ────────────────────────────────────────

describe('PreFilter — rulesSummary() / reloadRules()', () => {
  test('rulesSummary() retorna conteos correctos', () => {
    const pf      = freshFilter();
    const summary = pf.rulesSummary();
    assert.equal(summary.reject_if_title_contains, 4);
    assert.equal(summary.reject_if_jd_contains,    3);
    assert.equal(summary.reject_if_location,       2);
    assert.equal(summary.company_blacklist,         2);
    assert.equal(summary.min_jd_chars,             50);
  });

  test('reloadRules() fuerza re-lectura del archivo', () => {
    const pf = freshFilter();
    // First call populates cache
    pf.rulesSummary();
    // Reload should not throw
    pf.reloadRules();
    // And should work again
    const summary = pf.rulesSummary();
    assert.ok(summary.reject_if_title_contains >= 0);
  });

  test('archivo no encontrado → fail-open (no lanza error)', () => {
    const pf = new PreFilter(`${TMP_DIR}/nonexistent.yml`);
    // Should not throw, just pass everything
    const result = pf.evaluate(makeOffer());
    assert.equal(result.pass, true);
  });
});

console.log('✅ pre-filter.test.mjs: todos los tests definidos');
