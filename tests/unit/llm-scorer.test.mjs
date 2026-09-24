/**
 * llm-scorer.test.mjs — Tests unitarios para LlmScorer
 *
 * Todos los tests usan un cliente Anthropic mockeado — sin llamadas reales a la API.
 * Correr: node --test tests/unit/llm-scorer.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LlmScorer, ScorerError } from '../../agents/analysis/llm-scorer.mjs';

// ── Mock helpers ──────────────────────────────────────────────────────────────

const VALID_SCORE_RESPONSE = JSON.stringify({
  score: 4.2,
  justification: 'El rol usa Power BI y SQL, stack central de Victor. Modalidad remota compatible con GMT-3.',
  tags: ['power-bi', 'sql', 'remote', 'fintech', 'data-analyst'],
  apply_recommendation: true,
  score_factors: {
    stack_match:     'alto',
    seniority_match: 'alineado',
    modality_match:  'remoto',
    salary_signal:   'en-rango',
  },
});

const VALID_SCORE_FENCED = `Aquí está la evaluación:\n\`\`\`json\n${VALID_SCORE_RESPONSE}\n\`\`\``;

function makeClient(responses) {
  // responses: array of strings (one per call, in order)
  let callIndex = 0;
  return {
    messages: {
      create: async () => {
        const text = responses[callIndex] ?? responses[responses.length - 1];
        callIndex++;
        return { content: [{ text }] };
      },
    },
  };
}

function makeErrorClient(error) {
  return {
    messages: {
      create: async () => { throw error; },
    },
  };
}

function makeOffer(overrides = {}) {
  return {
    url:           'https://example.com/jobs/123',
    title:         'Data Analyst',
    company:       'ACME Corp',
    location:      'Remote',
    date_found:    '2026-05-23T10:00:00.000Z',
    source_portal: 'greenhouse',
    ...overrides,
  };
}

const SAMPLE_JD = 'We are looking for a Data Analyst to join our remote team. '
  + 'You will work with Power BI, SQL, and help us build dashboards for our executive team. '
  + 'Experience with Python is a plus. Salary: USD 1500-2500/month.';

function makeScorerWithMock(clientResponses, options = {}) {
  return new LlmScorer({
    _client: makeClient(clientResponses),
    promptTemplate: 'prompts/scorer/system-prompt.md',
    profilePath:    'config/victor_profile.md',
    ...options,
  });
}

// ── Tests: score() happy path ─────────────────────────────────────────────────

describe('LlmScorer — score() happy path', () => {
  test('retorna ScoredOffer válido con JSON directo', async () => {
    const scorer = makeScorerWithMock([VALID_SCORE_RESPONSE]);
    const result = await scorer.score(makeOffer(), SAMPLE_JD);

    assert.equal(result.score,                4.2);
    assert.equal(result.apply_recommendation, true);
    assert.equal(result.company,              'ACME Corp');
    assert.equal(result.url,                  'https://example.com/jobs/123');
    assert.ok(Array.isArray(result.tags),     'tags debe ser array');
    assert.ok(result.tags.length >= 1,        'tags debe tener al menos 1 elemento');
    assert.ok(result.scored_at,               'debe tener scored_at');
    assert.ok(result.model,                   'debe tener model');
  });

  test('extrae JSON de markdown code fence (```json ... ```)', async () => {
    const scorer = makeScorerWithMock([VALID_SCORE_FENCED]);
    const result = await scorer.score(makeOffer(), SAMPLE_JD);
    assert.equal(result.score, 4.2);
  });

  test('score_factors está presente con todos los campos', async () => {
    const scorer = makeScorerWithMock([VALID_SCORE_RESPONSE]);
    const result = await scorer.score(makeOffer(), SAMPLE_JD);

    assert.ok(result.score_factors.stack_match,     'stack_match faltante');
    assert.ok(result.score_factors.seniority_match, 'seniority_match faltante');
    assert.ok(result.score_factors.modality_match,  'modality_match faltante');
    assert.ok(result.score_factors.salary_signal,   'salary_signal faltante');
  });

  test('preserva campos originales de la oferta', async () => {
    const offer  = makeOffer({ source_portal: 'lever', location: 'Buenos Aires (Remote)' });
    const scorer = makeScorerWithMock([VALID_SCORE_RESPONSE]);
    const result = await scorer.score(offer, SAMPLE_JD);

    assert.equal(result.source_portal, 'lever');
    assert.equal(result.location,      'Buenos Aires (Remote)');
    assert.equal(result.date_found,    offer.date_found);
  });
});

// ── Tests: retry logic ────────────────────────────────────────────────────────

describe('LlmScorer — retry logic', () => {
  test('reintenta si el primer intento devuelve JSON inválido', async () => {
    // First call: invalid JSON → second call: valid JSON
    const scorer = makeScorerWithMock(['not valid json at all', VALID_SCORE_RESPONSE]);
    const result = await scorer.score(makeOffer(), SAMPLE_JD);
    assert.equal(result.score, 4.2);
  });

  test('reintenta hasta maxRetries veces', async () => {
    // 2 bad calls → 1 good call (maxRetries=2 means 3 total attempts)
    const scorer = makeScorerWithMock([
      'bad json #1',
      'bad json #2',
      VALID_SCORE_RESPONSE,
    ], { maxRetries: 2 });
    const result = await scorer.score(makeOffer(), SAMPLE_JD);
    assert.equal(result.score, 4.2);
  });

  test('lanza ScorerError después de agotar todos los reintentos', async () => {
    // All calls return invalid JSON
    const scorer = makeScorerWithMock(['bad', 'bad', 'bad'], { maxRetries: 2 });
    await assert.rejects(
      () => scorer.score(makeOffer(), SAMPLE_JD),
      (err) => {
        assert.ok(err instanceof ScorerError, 'debe ser ScorerError');
        assert.equal(err.code, 'SCORE_ERROR');
        return true;
      }
    );
  });
});

// ── Tests: JSON extraction ────────────────────────────────────────────────────

describe('LlmScorer — _extractJson()', () => {
  test('extrae JSON de texto plano', () => {
    const scorer   = new LlmScorer({ _client: makeClient([]) });
    const result   = scorer._extractJson(VALID_SCORE_RESPONSE);
    assert.equal(result.score, 4.2);
  });

  test('extrae JSON de markdown fence con "json"', () => {
    const scorer = new LlmScorer({ _client: makeClient([]) });
    const result = scorer._extractJson('```json\n{"score": 3.5, "justification": "ok", "tags": ["t"], "apply_recommendation": true, "score_factors": {"stack_match": "alto", "seniority_match": "alineado", "modality_match": "remoto", "salary_signal": "en-rango"}}\n```');
    assert.equal(result.score, 3.5);
  });

  test('extrae JSON de fence sin especificador de lenguaje', () => {
    const scorer = new LlmScorer({ _client: makeClient([]) });
    const result = scorer._extractJson('```\n{"score": 2.0, "justification": "x", "tags": ["t"], "apply_recommendation": false, "score_factors": {"stack_match": "bajo", "seniority_match": "alineado", "modality_match": "presencial", "salary_signal": "no-especificado"}}\n```');
    assert.equal(result.score, 2.0);
  });

  test('retorna null para string vacío', () => {
    const scorer = new LlmScorer({ _client: makeClient([]) });
    assert.equal(scorer._extractJson(''), null);
    assert.equal(scorer._extractJson(null), null);
  });

  test('retorna null para JSON inválido', () => {
    const scorer = new LlmScorer({ _client: makeClient([]) });
    assert.equal(scorer._extractJson('not json at all'), null);
    assert.equal(scorer._extractJson('{incomplete:'), null);
  });

  test('extrae JSON cuando hay texto antes y después', () => {
    const scorer = new LlmScorer({ _client: makeClient([]) });
    const text   = `Aquí está mi análisis:\n${VALID_SCORE_RESPONSE}\nEspero que sea útil.`;
    const result = scorer._extractJson(text);
    assert.equal(result?.score, 4.2);
  });
});

// ── Tests: schema validation ──────────────────────────────────────────────────

describe('LlmScorer — _validateSchema()', () => {
  const scorer = new LlmScorer({ _client: makeClient([]) });

  function validObj(overrides = {}) {
    return {
      score:                4.0,
      justification:        'Buen match de stack.',
      tags:                 ['power-bi', 'remote'],
      apply_recommendation: true,
      score_factors: {
        stack_match:     'alto',
        seniority_match: 'alineado',
        modality_match:  'remoto',
        salary_signal:   'en-rango',
      },
      ...overrides,
    };
  }

  test('objeto válido retorna null (sin errores)', () => {
    assert.equal(scorer._validateSchema(validObj()), null);
  });

  test('score fuera de rango 1.0–5.0 es inválido', () => {
    assert.ok(scorer._validateSchema(validObj({ score: 0.5 })));
    assert.ok(scorer._validateSchema(validObj({ score: 5.5 })));
    assert.ok(scorer._validateSchema(validObj({ score: 'high' })));
  });

  test('campo requerido faltante es inválido', () => {
    const { justification: _, ...noJustification } = validObj();
    assert.ok(scorer._validateSchema(noJustification));
  });

  test('tags vacío es inválido', () => {
    assert.ok(scorer._validateSchema(validObj({ tags: [] })));
  });

  test('tags no-array es inválido', () => {
    assert.ok(scorer._validateSchema(validObj({ tags: 'power-bi' })));
  });

  test('apply_recommendation como string es inválido', () => {
    assert.ok(scorer._validateSchema(validObj({ apply_recommendation: 'true' })));
  });

  test('score_factors faltante un campo es inválido', () => {
    const sf = { stack_match: 'alto', seniority_match: 'alineado', modality_match: 'remoto' };
    // salary_signal missing
    assert.ok(scorer._validateSchema(validObj({ score_factors: sf })));
  });

  test('score exactamente en límites (1.0 y 5.0) es válido', () => {
    assert.equal(scorer._validateSchema(validObj({ score: 1.0 })), null);
    assert.equal(scorer._validateSchema(validObj({ score: 5.0 })), null);
  });
});

// ── Tests: API errors ────────────────────────────────────────────────────────

describe('LlmScorer — errores de API', () => {
  test('lanza ScorerError con code API_ERROR si la API falla', async () => {
    const scorer = new LlmScorer({
      _client: makeErrorClient(new Error('Network timeout')),
      promptTemplate: 'prompts/scorer/system-prompt.md',
      profilePath:    'config/victor_profile.md',
    });

    await assert.rejects(
      () => scorer.score(makeOffer(), SAMPLE_JD),
      (err) => {
        assert.ok(err instanceof ScorerError);
        assert.equal(err.code, 'API_ERROR');
        assert.ok(err.message.includes('Network timeout'));
        return true;
      }
    );
  });

  test('ScorerError incluye offerUrl', async () => {
    const scorer = new LlmScorer({
      _client:        makeClient(['bad json']),
      promptTemplate: 'prompts/scorer/system-prompt.md',
      profilePath:    'config/victor_profile.md',
      maxRetries:     0,
    });

    await assert.rejects(
      () => scorer.score(makeOffer(), SAMPLE_JD),
      (err) => {
        assert.equal(err.offerUrl, 'https://example.com/jobs/123');
        return true;
      }
    );
  });
});

// ── Tests: apply_recommendation logic ────────────────────────────────────────

describe('LlmScorer — apply_recommendation', () => {
  test('apply_recommendation=false se preserva en el resultado', async () => {
    const lowScoreResponse = JSON.stringify({
      score:                2.1,
      justification:        'Stack incompatible con el perfil.',
      tags:                 ['legacy', 'on-site'],
      apply_recommendation: false,
      score_factors: {
        stack_match:     'bajo',
        seniority_match: 'alineado',
        modality_match:  'presencial',
        salary_signal:   'no-especificado',
      },
    });

    const scorer = makeScorerWithMock([lowScoreResponse]);
    const result = await scorer.score(makeOffer(), SAMPLE_JD);

    assert.equal(result.score,                2.1);
    assert.equal(result.apply_recommendation, false);
  });
});

console.log('✅ llm-scorer.test.mjs: todos los tests definidos');
