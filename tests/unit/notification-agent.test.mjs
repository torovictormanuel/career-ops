/**
 * notification-agent.test.mjs — Tests unitarios para Notification Agent
 *
 * Cubre: MessageFormatter, WhatsAppSender, NotificationAgent
 * 100% sin I/O real: sender mockeado, sent-log en TMP_DIR.
 *
 * Correr: node --test tests/unit/notification-agent.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { MessageFormatter }                    from '../../agents/notification/message-formatter.mjs';
import { WhatsAppSender, SenderError }         from '../../agents/notification/whatsapp-sender.mjs';
import { NotificationAgent }                   from '../../agents/notification/notification-agent.mjs';

// ── Setup ─────────────────────────────────────────────────────────────────────

const TMP_DIR      = 'tests/tmp-notification';
const TMP_SENT_LOG = `${TMP_DIR}/notifications-sent.json`;

before(() => mkdirSync(TMP_DIR, { recursive: true }));
after(()  => { if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true }); });

// ── Factories ─────────────────────────────────────────────────────────────────

function makeOffer(overrides = {}) {
  return {
    url:                  'https://example.com/jobs/1',
    title:                'Data Analyst',
    company:              'Nubank',
    location:             'Remote - LATAM',
    score:                4.2,
    apply_recommendation: true,
    tags:                 ['power-bi', 'sql', 'remote', 'fintech'],
    company_info:         { glassdoor_rating: 4.5 },
    priority_score:       0.82,
    justification:        'Excelente match.',
    ...overrides,
  };
}

function makeSender(responseOverride = null) {
  let calls = [];
  const mockFetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (responseOverride?.error) throw new Error(responseOverride.error);
    return { ok: responseOverride?.ok ?? true, status: responseOverride?.status ?? 200 };
  };
  return {
    sender: new WhatsAppSender({ webhookUrl: 'https://n8n.test/webhook', _fetch: mockFetch }),
    getCalls: () => calls,
  };
}

function freshAgent(senderOverride = null) {
  const { sender } = senderOverride ?? makeSender();
  return new NotificationAgent({
    sentLogPath: TMP_SENT_LOG,
    sender,
  });
}

// ── Tests: MessageFormatter ───────────────────────────────────────────────────

describe('MessageFormatter — formatOffer()', () => {
  const fmt = new MessageFormatter();

  test('incluye empresa y título en el mensaje', () => {
    const msg = fmt.formatOffer(makeOffer());
    assert.ok(msg.includes('Nubank'),       'debe incluir la empresa');
    assert.ok(msg.includes('Data Analyst'), 'debe incluir el título');
  });

  test('incluye la URL de la oferta', () => {
    const msg = fmt.formatOffer(makeOffer({ url: 'https://jobs.test/123' }));
    assert.ok(msg.includes('https://jobs.test/123'), 'debe incluir la URL');
  });

  test('incluye score y estrellas', () => {
    const msg = fmt.formatOffer(makeOffer({ score: 4.2 }));
    assert.ok(msg.includes('4.2'), 'debe incluir el score numérico');
    assert.ok(msg.includes('⭐'),  'debe incluir estrellas');
  });

  test('trunca al maxChars configurado', () => {
    const fmt100 = new MessageFormatter({ maxChars: 100 });
    const msg    = fmt100.formatOffer(makeOffer());
    assert.ok(msg.length <= 100, `mensaje debe ser <= 100 chars, fue ${msg.length}`);
  });

  test('incluye tags como itálica', () => {
    const msg = fmt.formatOffer(makeOffer({ tags: ['power-bi', 'sql'] }));
    assert.ok(msg.includes('power-bi'), 'debe incluir tags');
  });
});

describe('MessageFormatter — formatBatch()', () => {
  const fmt = new MessageFormatter();

  test('mensaje especial cuando no hay ofertas', () => {
    const msg = fmt.formatBatch([]);
    assert.ok(msg.includes('no se encontraron'), 'debe indicar que no hay nuevas ofertas');
  });

  test('incluye el conteo correcto de ofertas', () => {
    const offers = [makeOffer(), makeOffer({ company: 'Rappi' })];
    const msg    = fmt.formatBatch(offers, 'run-001');
    assert.ok(msg.includes('2'), 'debe incluir el número de ofertas');
  });

  test('lista cada oferta con número de orden', () => {
    const offers = [makeOffer(), makeOffer({ company: 'Rappi', title: 'BI Engineer' })];
    const msg    = fmt.formatBatch(offers);
    assert.ok(msg.includes('1.'), 'debe incluir "1."');
    assert.ok(msg.includes('2.'), 'debe incluir "2."');
  });
});

describe('MessageFormatter — formatDigest()', () => {
  const fmt = new MessageFormatter();

  test('digest vacío tiene mensaje especial', () => {
    const msg = fmt.formatDigest([], { received: 5, scored: 0 });
    assert.ok(msg.includes('Sin nuevas ofertas'), 'debe indicar que no hay ofertas');
  });

  test('digest incluye contadores del stats', () => {
    const msg = fmt.formatDigest([makeOffer()], { received: 10, scored: 3, errors: 1 });
    assert.ok(msg.includes('10'), 'debe incluir el total recibidas');
    assert.ok(msg.includes('3'),  'debe incluir las calificadas');
  });

  test('digest lista las ofertas con empresa y score', () => {
    const msg = fmt.formatDigest([makeOffer({ company: 'Mercado Libre', score: 4.5 })], {});
    assert.ok(msg.includes('Mercado Libre'), 'debe incluir empresa');
    assert.ok(msg.includes('4.5'),           'debe incluir score');
  });
});

describe('MessageFormatter — formatWeeklyReport()', () => {
  const fmt = new MessageFormatter();

  test('reporte vacío tiene mensaje especial', () => {
    const msg = fmt.formatWeeklyReport({ total: 0, byStatus: {}, avgScore: 0, topCompanies: [], scoreDistribution: {} });
    assert.ok(msg.includes('Sin aplicaciones'), 'debe indicar que no hay datos');
  });

  test('reporte incluye total y avgScore', () => {
    const metrics = {
      total: 8, byStatus: { Sent: 3, Interview: 1 }, avgScore: 4.1,
      topCompanies: [{ company: 'Nubank', count: 2 }],
      scoreDistribution: { '4.0-5.0': 6 },
    };
    const msg = fmt.formatWeeklyReport(metrics);
    assert.ok(msg.includes('8'),   'debe incluir total');
    assert.ok(msg.includes('4.1'), 'debe incluir avgScore');
  });

  test('reporte incluye estados con emojis', () => {
    const metrics = {
      total: 3, byStatus: { Interview: 1, Sent: 2 }, avgScore: 4.0,
      topCompanies: [], scoreDistribution: {},
    };
    const msg = fmt.formatWeeklyReport(metrics);
    assert.ok(msg.includes('Interview'), 'debe incluir el estado Interview');
  });

  test('formatError incluye timestamp y mensaje', () => {
    const err = new Error('Test error');
    const msg = fmt.formatError(err, 'AnalysisAgent');
    assert.ok(msg.includes('Test error'),    'debe incluir el mensaje del error');
    assert.ok(msg.includes('AnalysisAgent'), 'debe incluir el contexto');
    assert.ok(msg.includes('🚨'),            'debe incluir el emoji de error');
  });
});

// ── Tests: WhatsAppSender ─────────────────────────────────────────────────────

describe('WhatsAppSender — send()', () => {
  test('envía correctamente al webhook', async () => {
    const { sender, getCalls } = makeSender();
    const result = await sender.send('Hola desde test');
    assert.equal(result.sent, true,            'debe reportar sent=true');
    assert.equal(getCalls().length, 1,         'debe hacer exactamente 1 request');
    assert.equal(getCalls()[0].body.message, 'Hola desde test');
  });

  test('retorna sent=false con mensaje vacío', async () => {
    const { sender } = makeSender();
    const result = await sender.send('');
    assert.equal(result.sent, false,         'mensaje vacío no debe enviarse');
    assert.ok(result.error,                  'debe retornar un error descriptivo');
  });

  test('retorna sent=false sin webhookUrl configurado', async () => {
    const sender = new WhatsAppSender();   // sin webhookUrl, sin env var
    // Temporalmente asegurar que la env var no exista
    const original = process.env.WHATSAPP_WEBHOOK_URL;
    delete process.env.WHATSAPP_WEBHOOK_URL;

    const result = await sender.send('Test sin config');
    process.env.WHATSAPP_WEBHOOK_URL = original;

    assert.equal(result.sent, false, 'sin webhook debe retornar sent=false');
  });

  test('dry-run retorna sent=true sin hacer fetch', async () => {
    let called = false;
    const mockFetch = async () => { called = true; return { ok: true, status: 200 }; };
    const sender = new WhatsAppSender({
      webhookUrl: 'https://test.com/hook',
      dryRun:     true,
      _fetch:     mockFetch,
    });
    const result = await sender.send('Dry run test');
    assert.equal(result.sent,   true,  'dryRun debe retornar sent=true');
    assert.equal(result.dryRun, true,  'debe marcar dryRun=true');
    assert.equal(called,        false, 'no debe llamar al fetch real');
  });

  test('reintenta en caso de error HTTP', async () => {
    let attempts = 0;
    const mockFetch = async () => {
      attempts++;
      if (attempts < 3) throw new Error('Connection refused');
      return { ok: true, status: 200 };
    };
    const sender = new WhatsAppSender({
      webhookUrl:    'https://test.com/hook',
      maxRetries:    3,
      retryDelaysMs: [0, 0, 0],
      _fetch:        mockFetch,
    });
    const result = await sender.send('Test retry');
    assert.equal(result.sent,     true, 'debe tener éxito en el 3er intento');
    assert.equal(result.attempts, 3,    'debe reportar 3 intentos');
  });

  test('retorna sent=false si todos los reintentos fallan', async () => {
    const mockFetch = async () => { throw new Error('Siempre falla'); };
    const sender = new WhatsAppSender({
      webhookUrl:    'https://test.com/hook',
      maxRetries:    2,
      retryDelaysMs: [0, 0],
      _fetch:        mockFetch,
    });
    const result = await sender.send('Test fail');
    assert.equal(result.sent, false, 'debe retornar sent=false');
    assert.ok(result.error,          'debe incluir mensaje de error');
  });
});

// ── Tests: NotificationAgent ──────────────────────────────────────────────────

describe('NotificationAgent — notifyOffers()', () => {
  test('filtra ofertas bajo el umbral', async () => {
    const { sender, getCalls } = makeSender();
    const agent = new NotificationAgent({
      sentLogPath:    `${TMP_DIR}/sent-threshold.json`,
      sender,
      scoreThreshold: 4.0,
    });
    const offers = [
      makeOffer({ score: 4.5, url: 'https://a.com/1' }),
      makeOffer({ score: 3.2, url: 'https://a.com/2' }),  // bajo umbral
    ];
    const result = await agent.notifyOffers(offers);
    assert.equal(getCalls().length, 1,  'solo 1 oferta pasa el umbral');
    assert.equal(result.stats.sent,    1, 'stats.sent debe ser 1');
    assert.equal(result.stats.skipped, 1, 'stats.skipped debe ser 1');
  });

  test('no reenvía ofertas ya notificadas', async () => {
    const { sender, getCalls } = makeSender();
    const agent = new NotificationAgent({
      sentLogPath: `${TMP_DIR}/sent-dedup.json`,
      sender,
    });
    const offer = makeOffer({ url: 'https://dedup.com/1' });

    await agent.notifyOffers([offer]);   // primer envío
    await agent.notifyOffers([offer]);   // segundo envío — debe deduplicar

    assert.equal(getCalls().length, 1, 'debe enviarse solo 1 vez');
  });

  test('respeta maxOffersPerRun', async () => {
    const { sender, getCalls } = makeSender();
    const agent = new NotificationAgent({
      sentLogPath:    `${TMP_DIR}/sent-max.json`,
      sender,
      maxOffersPerRun: 2,
    });
    const offers = [1, 2, 3, 4].map(i =>
      makeOffer({ url: `https://max.com/${i}`, score: 4.5 })
    );
    await agent.notifyOffers(offers);
    assert.equal(getCalls().length, 2, 'debe enviar máximo 2 mensajes');
  });

  test('persiste el sent log en disco', async () => {
    const logPath = `${TMP_DIR}/sent-persist.json`;
    const { sender } = makeSender();
    const agent = new NotificationAgent({ sentLogPath: logPath, sender });
    await agent.notifyOffers([makeOffer({ url: 'https://persist.com/1' })]);
    assert.ok(existsSync(logPath), 'debe crear el archivo sent log');
    const log = JSON.parse(readFileSync(logPath, 'utf8'));
    assert.ok('https://persist.com/1' in log, 'debe contener la URL enviada');
  });

  test('dryRun no persiste el sent log', async () => {
    const logPath = `${TMP_DIR}/sent-dryrun.json`;
    const { sender } = makeSender();
    const agent = new NotificationAgent({ sentLogPath: logPath, sender, dryRun: true });
    await agent.notifyOffers([makeOffer({ url: 'https://dryrun.com/1' })]);
    assert.ok(!existsSync(logPath), 'dryRun no debe crear el archivo sent log');
  });
});

describe('NotificationAgent — dailyDigest() / weeklyReport()', () => {
  test('dailyDigest envía un solo mensaje', async () => {
    const { sender, getCalls } = makeSender();
    const agent = new NotificationAgent({ sentLogPath: `${TMP_DIR}/sent-digest.json`, sender });
    await agent.dailyDigest([makeOffer(), makeOffer({ company: 'Rappi' })], { received: 10, scored: 2 });
    assert.equal(getCalls().length, 1, 'digest debe ser 1 solo mensaje');
  });

  test('weeklyReport envía un solo mensaje', async () => {
    const { sender, getCalls } = makeSender();
    const agent = new NotificationAgent({ sentLogPath: `${TMP_DIR}/sent-weekly.json`, sender });
    const metrics = {
      total: 5, byStatus: { Sent: 3, Interview: 2 }, avgScore: 4.0,
      topCompanies: [], scoreDistribution: {},
    };
    await agent.weeklyReport(metrics);
    assert.equal(getCalls().length, 1, 'weekly report debe ser 1 solo mensaje');
  });

  test('alertError incluye el mensaje del error en el envío', async () => {
    const { sender, getCalls } = makeSender();
    const agent = new NotificationAgent({ sentLogPath: `${TMP_DIR}/sent-err.json`, sender });
    await agent.alertError(new Error('DB crashed'), 'DiscoveryAgent');
    assert.equal(getCalls().length, 1,                      'debe enviar 1 mensaje');
    assert.ok(getCalls()[0].body.message.includes('DB crashed'), 'mensaje debe incluir el error');
  });
});
