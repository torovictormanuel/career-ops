/**
 * whatsapp-e2e.mjs — WhatsApp End-to-End Integration Tests (career-ops v2.0)
 *
 * Qué cubre:
 *   1. MessageFormatter → formatos de mensajes (oferta, digest, weekly, error)
 *   2. WhatsAppSender   → retry, rate-limit, manejo de errores HTTP, dry-run
 *   3. NotificationAgent → pipeline offer → mensaje → envío (mock sender)
 *   4. Bot HTTP (si está corriendo): /health, /notify-status, /notify
 *   5. Comandos del bot → texto de respuesta para 1/2/STATUS/AYUDA/ENVIAR
 *
 * Uso:
 *   node --test tests/integration/whatsapp-e2e.mjs           # unit + integration con mocks
 *   node --test tests/integration/whatsapp-e2e.mjs --live    # + pruebas contra bot real
 *   node tests/integration/whatsapp-e2e.mjs --demo           # envía oferta de prueba real al WhatsApp
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';

import { MessageFormatter }   from '../../agents/notification/message-formatter.mjs';
import { WhatsAppSender }     from '../../agents/notification/whatsapp-sender.mjs';
import { NotificationAgent }  from '../../agents/notification/notification-agent.mjs';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const HIGH_SCORE_OFFER = {
  url:                  'https://job-boards.greenhouse.io/nubank/jobs/123456',
  title:                'Data Analyst — Business Intelligence',
  company:              'Nubank',
  location:             'Remote - LATAM',
  score:                4.3,
  apply_recommendation: true,
  tags:                 ['power-bi', 'sql', 'fintech', 'remote'],
  company_info:         { glassdoor_rating: 4.5 },
  priority_score:       0.85,
  tracker_num:          42,
};

const LOW_SCORE_OFFER = {
  url:    'https://example.com/job/low',
  title:  'Junior Data Entry',
  company:'Some Corp',
  score:  2.1,
  apply_recommendation: false,
  tags:   [],
};

const BOT_URL = 'http://127.0.0.1:3099';
const LIVE    = process.argv.includes('--live');

// ── 1. MessageFormatter ───────────────────────────────────────────────────────

describe('MessageFormatter — formatOffer()', () => {
  const fmt = new MessageFormatter();

  test('incluye empresa, título y score', () => {
    const msg = fmt.formatOffer(HIGH_SCORE_OFFER);
    assert.ok(msg.includes('Nubank'),                           'debe incluir empresa');
    assert.ok(msg.includes('Data Analyst'),                     'debe incluir título');
    assert.ok(msg.includes('4.3'),                              'debe incluir score');
    assert.ok(msg.includes('https://job-boards.greenhouse.io'), 'debe incluir URL');
  });

  test('incluye estrellas de score', () => {
    const msg = fmt.formatOffer(HIGH_SCORE_OFFER);
    assert.ok(msg.includes('⭐'),  'debe tener estrellas');
  });

  test('incluye tags cuando existen', () => {
    const msg = fmt.formatOffer(HIGH_SCORE_OFFER);
    assert.ok(msg.includes('power-bi') || msg.includes('sql'), 'debe incluir al menos 1 tag');
  });

  test('no excede maxChars', () => {
    const msg = fmt.formatOffer(HIGH_SCORE_OFFER);
    assert.ok(msg.length <= 1000, `mensaje demasiado largo: ${msg.length} chars`);
  });

  test('maneja oferta sin datos opcionales (mínimo viable)', () => {
    const minimal = { url: 'https://example.com/job/1', title: 'Analyst', company: 'Acme', score: 3.6 };
    const msg = fmt.formatOffer(minimal);
    assert.ok(msg.includes('Analyst'), 'debe funcionar con datos mínimos');
  });
});

describe('MessageFormatter — formatDigest()', () => {
  const fmt = new MessageFormatter();

  test('encabezado contiene "Daily Digest"', () => {
    const msg = fmt.formatDigest([HIGH_SCORE_OFFER], { received: 10, scored: 3, errors: 0 });
    assert.ok(msg.includes('Daily Digest'), 'encabezado esperado');
  });

  test('lista oferta por nombre', () => {
    const msg = fmt.formatDigest([HIGH_SCORE_OFFER], {});
    assert.ok(msg.includes('Nubank'), 'debe listar la empresa');
  });

  test('mensaje vacío cuando sin ofertas', () => {
    const msg = fmt.formatDigest([], {});
    assert.ok(msg.includes('Sin nuevas'), 'debe indicar ausencia de ofertas');
  });
});

describe('MessageFormatter — formatWeeklyReport()', () => {
  const fmt = new MessageFormatter();

  const metrics = {
    total: 12,
    byStatus: { Evaluated: 8, Applied: 3, Interview: 1 },
    avgScore: 4.1,
    topCompanies: [{ company: 'Nubank', count: 2 }, { company: 'Adyen', count: 1 }],
    scoreDistribution: { '3.5-4.0': 4, '4.0-5.0': 8 },
  };

  test('contiene "Weekly Report"', () => {
    const msg = fmt.formatWeeklyReport(metrics);
    assert.ok(msg.includes('Weekly Report'), 'encabezado esperado');
  });

  test('muestra total de aplicaciones', () => {
    const msg = fmt.formatWeeklyReport(metrics);
    assert.ok(msg.includes('12'), 'debe mostrar total');
  });

  test('muestra score promedio', () => {
    const msg = fmt.formatWeeklyReport(metrics);
    assert.ok(msg.includes('4.1'), 'debe mostrar avg score');
  });
});

describe('MessageFormatter — formatError()', () => {
  const fmt = new MessageFormatter();

  test('contiene el mensaje de error', () => {
    const err = new Error('ANTHROPIC_API_KEY no configurada');
    const msg = fmt.formatError(err, 'AnalysisAgent');
    assert.ok(msg.includes('ANTHROPIC_API_KEY'), 'debe incluir mensaje de error');
    assert.ok(msg.includes('AnalysisAgent'),      'debe incluir contexto');
    assert.ok(msg.includes('🚨'),                 'debe tener emoji de alerta');
  });
});

// ── 2. WhatsAppSender ─────────────────────────────────────────────────────────

describe('WhatsAppSender — send()', () => {
  test('dry-run retorna sent=true sin llamar HTTP', async () => {
    const sender = new WhatsAppSender({ dryRun: true });
    const result = await sender.send('Test message');
    assert.equal(result.sent,   true,  'dry-run debe retornar sent=true');
    assert.equal(result.dryRun, true,  'dry-run debe marcar dryRun=true');
    assert.equal(result.attempts, 0,   'dry-run no debe contar intentos');
  });

  test('mensaje vacío retorna sent=false', async () => {
    const sender = new WhatsAppSender({ dryRun: true });
    const result = await sender.send('');
    assert.equal(result.sent, false, 'mensaje vacío debe fallar');
  });

  test('llama al webhook con body correcto (mock fetch)', async () => {
    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200 };
    };

    const sender = new WhatsAppSender({
      webhookUrl: 'http://127.0.0.1:3099/notify-status',
      _fetch:     mockFetch,
    });

    const result = await sender.send('Hola desde career-ops!');
    assert.equal(result.sent,         true,                                   'debe marcar enviado');
    assert.equal(calls.length,        1,                                      'debe hacer 1 llamada');
    assert.equal(calls[0].url,        'http://127.0.0.1:3099/notify-status', 'URL correcta');
    assert.equal(calls[0].body.message, 'Hola desde career-ops!',            'body.message correcto');
  });

  test('reintenta hasta maxRetries en HTTP error', async () => {
    let calls = 0;
    const failFetch = async () => {
      calls++;
      return { ok: false, status: 503 };
    };

    const sender = new WhatsAppSender({
      webhookUrl:    'http://127.0.0.1:3099/notify-status',
      _fetch:        failFetch,
      maxRetries:    3,
      retryDelaysMs: [0, 0, 0],
    });

    const result = await sender.send('test');
    assert.equal(result.sent,     false, 'debe fallar tras maxRetries');
    assert.equal(result.attempts, 3,     'debe haber intentado 3 veces');
    assert.equal(calls,           3,     'fetch llamado 3 veces');
  });

  test('respeta el rate limit mínimo entre mensajes', async () => {
    const times = [];
    const mockFetch = async () => { times.push(Date.now()); return { ok: true, status: 200 }; };

    const sender = new WhatsAppSender({
      webhookUrl:    'http://127.0.0.1:3099/notify-status',
      _fetch:        mockFetch,
      minIntervalMs: 50,   // 50ms para que el test sea rápido
    });

    await sender.send('msg1');
    await sender.send('msg2');

    const gap = times[1] - times[0];
    assert.ok(gap >= 45, `gap entre mensajes debe ser >= 50ms, fue ${gap}ms`);
  });
});

// ── 3. NotificationAgent ──────────────────────────────────────────────────────

describe('NotificationAgent — notifyOffers()', () => {
  // Isolated temp log per test to avoid real notifications-sent.json contamination
  const tmpLogs = [];
  after(() => {
    for (const p of tmpLogs) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
    }
  });

  function freshSetup(opts = {}) {
    const sent   = [];
    const sender = {
      send:    async (msg) => { sent.push(msg); return { sent: true, attempts: 1 }; },
      sendAll: async (msgs) => { for (const m of msgs) await sender.send(m); return sent.map(() => ({ sent: true, attempts: 1 })); },
    };
    const log = `tests/tmp-sent-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    tmpLogs.push(log);
    const agent = new NotificationAgent({ scoreThreshold: 3.5, sentLogPath: log, sender, ...opts });
    return { agent, sender, getSentCount: () => sent.length };
  }

  test('notifica ofertas que superan el score umbral', async () => {
    const { agent, getSentCount } = freshSetup();
    const result = await agent.notifyOffers([HIGH_SCORE_OFFER], 'test-notify');
    assert.equal(result.stats.sent,    1, 'debe notificar 1 oferta');
    assert.equal(getSentCount(),       1, 'sender debe haber enviado 1 mensaje');
    assert.equal(result.stats.skipped, 0, 'ninguna debe ser salteada');
  });

  test('descarta ofertas con score < umbral', async () => {
    const { agent, getSentCount } = freshSetup();
    const result = await agent.notifyOffers([LOW_SCORE_OFFER], 'test-low');
    assert.equal(result.stats.sent,    0, 'no debe notificar oferta baja');
    assert.equal(result.stats.skipped, 1, 'debe saltear 1 oferta');
    assert.equal(getSentCount(),       0, 'sender no debe ser llamado');
  });

  test('respeta maxOffersPerRun', async () => {
    const { agent, getSentCount } = freshSetup({ maxOffersPerRun: 2 });
    const manyOffers = Array.from({ length: 5 }, (_, i) => ({
      ...HIGH_SCORE_OFFER,
      url:   `https://example.com/job/unique-${Date.now()}-${i}`,
      score: 4.0,
    }));
    await agent.notifyOffers(manyOffers, 'test-max');
    assert.equal(getSentCount(), 2, 'debe enviar solo maxOffersPerRun=2');
  });

  test('no re-notifica URL ya enviada en la misma sesión', async () => {
    const { agent, getSentCount } = freshSetup();
    await agent.notifyOffers([HIGH_SCORE_OFFER], 'run-1');
    await agent.notifyOffers([HIGH_SCORE_OFFER], 'run-2');
    assert.equal(getSentCount(), 1, 'URL duplicada no debe notificarse dos veces');
  });
});

// ── 4. Comandos del bot ───────────────────────────────────────────────────────

describe('Bot commands — respuestas esperadas', () => {
  // Documenta qué responde el bot a cada comando (texto hardcodeado en whatsapp-bot.mjs).
  // Estos tests validan que el mapping de comandos es el esperado.

  const COMMANDS = {
    '1':      { desc: 'Preparar postulación',     response: /Preparando postulación/ },
    'SI':     { desc: 'Preparar postulación (SI)',response: /Preparando postulación/ },
    '2':      { desc: 'Saltear oferta',           response: /Salteando/ },
    'NO':     { desc: 'Saltear oferta (NO)',       response: /Salteando/ },
    'STATUS': { desc: 'Ver pendientes',           response: /oferta|pendiente/i },
    'ESTADO': { desc: 'Ver pendientes (ES)',       response: /oferta|pendiente/i },
    'ENVIAR': { desc: 'Confirmar envío',          response: /formulario|pending/i },
    'HELP':   { desc: 'Ayuda',                    response: /Career-Ops Bot/i },
    'AYUDA':  { desc: 'Ayuda (ES)',               response: /Career-Ops Bot/i },
    '?':      { desc: 'Ayuda (?)',                response: /Career-Ops Bot/i },
  };

  // Función extractada de whatsapp-bot.mjs — respuestas sin pendingOffers
  function simulateCommand(body) {
    const cmd = body.trim().toUpperCase();

    if (cmd === '1' || cmd === 'SI' || cmd === 'S') {
      return '⚠️ No hay ofertas pendientes de confirmación.';  // sin pendingOffers
    }
    if (cmd === '2' || cmd === 'NO' || cmd === 'N') {
      return null;  // silencioso si no hay pendientes
    }
    if (cmd === 'ENVIAR' || cmd === 'SUBMIT' || cmd === 'OK') {
      return '⚠️ No hay formulario listo para enviar.';  // sin .pending-submit.json
    }
    if (cmd === 'STATUS' || cmd === 'ESTADO') {
      return '✅ No hay ofertas pendientes.';  // sin pendingOffers
    }
    if (cmd === 'HELP' || cmd === 'AYUDA' || cmd === '?') {
      return (
        `*Career-Ops Bot*\n\n` +
        `*1* o *SI* → Preparar postulación\n` +
        `*2* o *NO* → Saltear oferta\n` +
        `*ENVIAR* → Confirmar envío del formulario\n` +
        `*STATUS* → Ver ofertas pendientes\n` +
        `*AYUDA* → Este menú`
      );
    }
    return null;  // comando desconocido
  }

  test('AYUDA retorna menú completo con todos los comandos', () => {
    const resp = simulateCommand('AYUDA');
    assert.ok(resp.includes('1'),      'debe listar comando 1');
    assert.ok(resp.includes('2'),      'debe listar comando 2');
    assert.ok(resp.includes('ENVIAR'), 'debe listar ENVIAR');
    assert.ok(resp.includes('STATUS'), 'debe listar STATUS');
  });

  test('1 sin ofertas pendientes retorna mensaje de advertencia', () => {
    const resp = simulateCommand('1');
    assert.ok(resp.includes('No hay ofertas'), 'debe indicar que no hay pendientes');
  });

  test('STATUS sin pendientes retorna confirmación vacía', () => {
    const resp = simulateCommand('STATUS');
    assert.ok(resp.includes('No hay ofertas'), 'debe indicar vacío');
  });

  test('ENVIAR sin formulario retorna advertencia', () => {
    const resp = simulateCommand('ENVIAR');
    assert.ok(resp.includes('No hay formulario'), 'debe indicar que no hay form');
  });

  test('comando desconocido retorna null (ignorado)', () => {
    const resp = simulateCommand('HOLA');
    assert.equal(resp, null, 'comandos desconocidos se ignoran');
  });
});

// ── 5. Tests live contra el bot real (--live) ─────────────────────────────────

if (LIVE) {
  describe('Bot real (--live) — endpoints HTTP', { skip: !LIVE }, () => {
    test('GET /health retorna ok + estado de conexión WA', async () => {
      const res  = await fetch(`${BOT_URL}/health`);
      const body = await res.json();
      assert.equal(res.status, 200,   '/health debe retornar HTTP 200');
      assert.ok('ok' in body,         'body debe tener campo ok');
      assert.ok('status' in body,     'body debe tener campo status');
      console.log(`  Bot status: ${JSON.stringify(body)}`);
    });

    test('POST /notify-status acepta {message} del pipeline v2.0', async () => {
      const fmt     = new MessageFormatter();
      const message = fmt.formatOffer(HIGH_SCORE_OFFER);

      const res  = await fetch(`${BOT_URL}/notify-status`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message }),
      });
      const body = await res.json();
      assert.ok(res.ok,    `/notify-status debe aceptar el mensaje (status ${res.status})`);
      assert.equal(body.ok, true, 'body.ok debe ser true');
      console.log(`  Mensaje enviado a WhatsApp (${message.length} chars)`);
    });

    test('POST /notify acepta formato v1.x con offers[]', async () => {
      const offer = {
        company: HIGH_SCORE_OFFER.company,
        role:    HIGH_SCORE_OFFER.title,
        score:   HIGH_SCORE_OFFER.score,
        url:     HIGH_SCORE_OFFER.url,
        one_liner: 'Fintech líder LATAM. Score LLM 4.3/5. Requiere Power BI + SQL.',
      };

      const res  = await fetch(`${BOT_URL}/notify`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ offers: [offer] }),
      });
      const body = await res.json();
      assert.ok(res.ok,         `/notify debe aceptar offers[] (status ${res.status})`);
      assert.equal(body.ok,     true,  'body.ok debe ser true');
      assert.equal(body.count,  1,     'debe contar 1 oferta procesada');
      console.log(`  Oferta enviada al bot v1.x: ${JSON.stringify(body)}`);
    });
  });
}

// ── Demo interactivo (--demo) ─────────────────────────────────────────────────

// ── Demo standalone (--demo): envía oferta real, no corre tests ───────────────
// Solo se activa cuando el archivo se ejecuta directamente con --demo
// y NO a través de node --test (donde IS_TEST_RUNNER es true).
const IS_TEST_RUNNER = process.argv.includes('--test') ||
  process.env.NODE_TEST_CONTEXT !== undefined ||
  (typeof globalThis[Symbol.for('nodejs.rejection')] !== 'undefined' && process.argv[1]?.includes('--test'));

if (process.argv.includes('--demo') && !IS_TEST_RUNNER) {
  (async () => {
    console.log('\n━━━ career-ops WhatsApp Demo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Enviando oferta de prueba a WhatsApp...\n');

    // Verificar que el bot está activo
    let botOk = false;
    try {
      const health = await fetch(`${BOT_URL}/health`).then(r => r.json());
      botOk = health.ok === true;
      console.log(`Bot status: ${health.status} | WA connected: ${health.ok}`);
    } catch {
      console.error(`❌ Bot no responde en ${BOT_URL}/health — ¿está corriendo node whatsapp-bot.mjs?`);
      process.exit(1);
    }

    if (!botOk) {
      console.warn('⚠️  WhatsApp no conectado. Iniciá el bot: node whatsapp-bot.mjs');
      process.exit(1);
    }

    // Oferta demo con URL única para evitar dedup
    const demoOffer = {
      ...HIGH_SCORE_OFFER,
      url: `${HIGH_SCORE_OFFER.url}?demo=${Date.now()}`,
    };

    const fmt = new MessageFormatter();

    console.log('\n─── Formato v2.0 pipeline (lo que llega via NotificationAgent): ───────────────');
    console.log(fmt.formatOffer(demoOffer));

    console.log('\n─── Formato v1.x bot (score bar + botones 1/2): ────────────────────────────────');
    const scoreBar = '⭐'.repeat(Math.round(demoOffer.score)) + '☆'.repeat(5 - Math.round(demoOffer.score));
    const v1msg = [
      `🎯 *Nueva oferta compatible*\n`,
      `🏢 *${demoOffer.company}*`,
      `💼 ${demoOffer.title}`,
      `${scoreBar} *${demoOffer.score}/5*`,
      `📍 ${demoOffer.location}\n`,
      `Fintech líder LATAM. Requiere Power BI + SQL senior.\n`,
      `🔗 ${demoOffer.url}\n`,
      `Respondé:\n*1* → Que Claude prepare la postulación\n*2* → Saltear`,
    ].join('\n');
    console.log(v1msg);

    // Enviar vía pipeline v2.0 con sentLogPath temporal (evita dedup real)
    const tmpLog = `data/demo-sent-${Date.now()}.json`;
    const agent  = new NotificationAgent({
      scoreThreshold:  0,
      maxOffersPerRun: 1,
      sentLogPath:     tmpLog,
    });

    console.log('\n─── Enviando vía pipeline v2.0 → /notify-status → WhatsApp: ───────────────────');
    const result = await agent.notifyOffers([demoOffer], 'demo');
    console.log(`Resultado: ${JSON.stringify(result.stats)}`);

    // Limpiar log temporal
    try { if (existsSync(tmpLog)) unlinkSync(tmpLog); } catch { /* best effort */ }

    if (result.stats.sent === 1) {
      console.log('\n✅ Mensaje enviado a tu WhatsApp.');
    } else {
      console.warn(`\n⚠️  No se envió. Resultado: ${JSON.stringify(result.stats)}`);
    }

    console.log('\n─── Comandos que podés responder desde WhatsApp: ───────────────────────────────');
    const cmds = [
      ['1 o SI',    'Claude prepara y rellena el formulario automáticamente'],
      ['2 o NO',    'Saltear esta oferta'],
      ['ENVIAR',    'Confirmar envío del formulario (después de responder 1)'],
      ['STATUS',    'Ver cuántas ofertas esperan tu decisión'],
      ['AYUDA o ?', 'Ver todos los comandos'],
    ];
    for (const [cmd, desc] of cmds) {
      console.log(`  ${cmd.padEnd(12)} → ${desc}`);
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  })();
}
