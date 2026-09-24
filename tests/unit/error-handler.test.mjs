/**
 * error-handler.test.mjs — Tests unitarios para Error Handler Agent
 *
 * Cubre: ErrorClassifier, DeadLetterQueue, ErrorHandlerAgent
 * Sin I/O real: DLQ en TMP_DIR, notifier mockeado.
 *
 * Correr: node --test tests/unit/error-handler.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';

import { ErrorClassifier, CATEGORY }   from '../../agents/error-handler/error-classifier.mjs';
import { DeadLetterQueue }             from '../../agents/error-handler/dead-letter-queue.mjs';
import { ErrorHandlerAgent }           from '../../agents/error-handler/error-handler-agent.mjs';

// ── Setup ─────────────────────────────────────────────────────────────────────

const TMP_DIR = 'tests/tmp-error-handler';
const TMP_DLQ = `${TMP_DIR}/dead-letter.json`;

before(() => mkdirSync(TMP_DIR, { recursive: true }));
after(()  => { if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true }); });

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeErr(msg, extra = {}) {
  const err = new Error(msg);
  return Object.assign(err, extra);
}

function freshDlq(suffix = '') {
  return new DeadLetterQueue({ filePath: `${TMP_DIR}/dlq${suffix}.json` });
}

function freshHandler(opts = {}) {
  const notifierCalls = [];
  const mockNotifier  = {
    alertError: async (err, ctx) => { notifierCalls.push({ err, ctx }); },
  };
  const handler = new ErrorHandlerAgent({
    dlq:          new DeadLetterQueue({ filePath: `${TMP_DIR}/dlq-handler-${Math.random().toString(36).slice(2)}.json` }),
    notifier:     mockNotifier,
    retryConfig:  opts.retryConfig ?? { maxAttempts: 3, delaysMs: [0, 0, 0] },
    notifyOnFatal: opts.notifyOnFatal ?? true,
    dryRun:        opts.dryRun       ?? false,
  });
  return { handler, notifierCalls };
}

// ── Tests: ErrorClassifier ────────────────────────────────────────────────────

describe('ErrorClassifier — classify()', () => {
  const cls = new ErrorClassifier();

  test('HTTP 429 → RATE_LIMIT, retryable', () => {
    const r = cls.classify(makeErr('HTTP 429', { status: 429 }));
    assert.equal(r.category, CATEGORY.RATE_LIMIT);
    assert.equal(r.retryable, true);
    assert.equal(r.fatal, false);
  });

  test('HTTP 401 → AUTH, fatal, notify', () => {
    const r = cls.classify(makeErr('Unauthorized', { status: 401 }));
    assert.equal(r.category, CATEGORY.AUTH);
    assert.equal(r.fatal, true);
    assert.equal(r.notify, true);
  });

  test('HTTP 404 → NOT_FOUND, no reintento, no DLQ', () => {
    const r = cls.classify(makeErr('Not found', { status: 404 }));
    assert.equal(r.category, CATEGORY.NOT_FOUND);
    assert.equal(r.retryable, false);
    assert.equal(r.enqueueDlq, false);
  });

  test('HTTP 503 → SERVER_ERR, retryable', () => {
    const r = cls.classify(makeErr('Service Unavailable', { status: 503 }));
    assert.equal(r.category, CATEGORY.SERVER_ERR);
    assert.equal(r.retryable, true);
  });

  test('mensaje "rate limit" → RATE_LIMIT', () => {
    const r = cls.classify(makeErr('You have exceeded the rate limit for this API'));
    assert.equal(r.category, CATEGORY.RATE_LIMIT);
  });

  test('ECONNREFUSED → NETWORK, retryable', () => {
    const r = cls.classify(makeErr('connect ECONNREFUSED 127.0.0.1:3000', { code: 'ECONNREFUSED' }));
    assert.equal(r.category, CATEGORY.NETWORK);
    assert.equal(r.retryable, true);
  });

  test('AbortError → TIMEOUT, retryable', () => {
    const err = makeErr('The operation was aborted');
    err.name  = 'AbortError';
    const r   = cls.classify(err);
    assert.equal(r.category, CATEGORY.TIMEOUT);
    assert.equal(r.retryable, true);
  });

  test('code=CONFIG_ERROR → CONFIG, fatal, DLQ', () => {
    const r = cls.classify(makeErr('ANTHROPIC_API_KEY not set', { code: 'CONFIG_ERROR' }));
    assert.equal(r.category, CATEGORY.CONFIG);
    assert.equal(r.fatal, true);
    assert.equal(r.enqueueDlq, true);
  });

  test('code=SCORE_ERROR → VALIDATION, no reintento', () => {
    const r = cls.classify(makeErr('Score schema invalid', { code: 'SCORE_ERROR' }));
    assert.equal(r.category, CATEGORY.VALIDATION);
    assert.equal(r.retryable, false);
  });

  test('error desconocido → UNKNOWN, retryable', () => {
    const r = cls.classify(makeErr('Something totally random'));
    assert.equal(r.category, CATEGORY.UNKNOWN);
    assert.equal(r.retryable, true);
  });

  test('null → UNKNOWN', () => {
    const r = cls.classify(null);
    assert.equal(r.category, CATEGORY.UNKNOWN);
  });
});

// ── Tests: DeadLetterQueue ────────────────────────────────────────────────────

describe('DeadLetterQueue — enqueue() / peek() / stats()', () => {
  test('encola un item y lo persiste en disco', () => {
    const dlq   = freshDlq('-persist');
    const entry = dlq.enqueue({ url: 'https://fail.com/1' }, makeErr('timeout'), { type: 'analysis', attempts: 3 });
    assert.ok(entry.id,               'debe tener un id generado');
    assert.equal(entry.status, 'pending');
    assert.equal(entry.type,   'analysis');
    assert.equal(entry.attempts, 3);
    assert.ok(existsSync(`${TMP_DIR}/dlq-persist.json`), 'debe crear el archivo');
  });

  test('peek() retorna items por status', () => {
    const dlq = freshDlq('-peek');
    dlq.enqueue({ url: 'https://a.com' }, makeErr('err1'), { type: 'discovery' });
    dlq.enqueue({ url: 'https://b.com' }, makeErr('err2'), { type: 'analysis' });

    const pending = dlq.peek({ status: 'pending' });
    assert.equal(pending.length, 2, 'debe retornar 2 items pending');
  });

  test('peek() filtra por type', () => {
    const dlq = freshDlq('-type');
    dlq.enqueue({ url: 'https://c.com' }, makeErr('err'), { type: 'discovery' });
    dlq.enqueue({ url: 'https://d.com' }, makeErr('err'), { type: 'analysis' });

    const discovery = dlq.peek({ type: 'discovery' });
    assert.equal(discovery.length, 1);
    assert.equal(discovery[0].type, 'discovery');
  });

  test('updateStatus cambia el status de un entry', () => {
    const dlq   = freshDlq('-update');
    const entry = dlq.enqueue({ url: 'https://e.com' }, makeErr('err'));
    const ok    = dlq.updateStatus(entry.id, 'resolved');
    assert.equal(ok, true, 'debe retornar true');
    assert.equal(dlq.peek({ status: 'resolved' }).length, 1);
  });

  test('updateStatus retorna false para id inexistente', () => {
    const dlq = freshDlq('-missing');
    const ok  = dlq.updateStatus('no-existe', 'resolved');
    assert.equal(ok, false);
  });

  test('stats() cuenta correctamente', () => {
    const dlq = freshDlq('-stats');
    const e1  = dlq.enqueue({ url: 'https://f.com' }, makeErr('err'));
    const e2  = dlq.enqueue({ url: 'https://g.com' }, makeErr('err'));
    dlq.updateStatus(e1.id, 'resolved');

    const s = dlq.stats();
    assert.equal(s.total,    2);
    assert.equal(s.pending,  1);
    assert.equal(s.resolved, 1);
  });

  test('purge() elimina entries antiguos', () => {
    const dlq = new DeadLetterQueue({
      filePath:  `${TMP_DIR}/dlq-purge.json`,
      maxAgeMs:  1,   // 1ms — todos expirarán inmediatamente
    });
    dlq.enqueue({ url: 'https://old.com' }, makeErr('old error'));
    // Esperar 5ms para que el entry expire
    return new Promise(resolve => setTimeout(() => {
      const removed = dlq.purge();
      assert.ok(removed >= 1, `debe eliminar al menos 1 entry, eliminó: ${removed}`);
      assert.equal(dlq.stats().total, 0);
      resolve();
    }, 5));
  });

  test('dryRun no escribe en disco', () => {
    const logPath = `${TMP_DIR}/dlq-dry.json`;
    const dlq = new DeadLetterQueue({ filePath: logPath, dryRun: true });
    dlq.enqueue({ url: 'https://dry.com' }, makeErr('err'));
    assert.ok(!existsSync(logPath), 'dryRun no debe crear archivo');
  });
});

// ── Tests: ErrorHandlerAgent ──────────────────────────────────────────────────

describe('ErrorHandlerAgent — withRetry()', () => {
  test('fn exitosa retorna { ok: true, result }', async () => {
    const { handler } = freshHandler();
    const r = await handler.withRetry(() => Promise.resolve(42), { context: 'test' });
    assert.equal(r.ok, true);
    assert.equal(r.result, 42);
  });

  test('reintenta N veces antes de fallar', async () => {
    const { handler } = freshHandler({ retryConfig: { maxAttempts: 3, delaysMs: [0, 0, 0] } });
    let calls = 0;
    const r = await handler.withRetry(async () => {
      calls++;
      throw makeErr('Network error', { code: 'ECONNREFUSED' });
    }, { context: 'test-retry', type: 'test' });

    assert.equal(r.ok, false);
    assert.equal(calls, 3, 'debe intentar exactamente maxAttempts veces');
  });

  test('error no-retryable aborta sin reintentar', async () => {
    const { handler } = freshHandler();
    let calls = 0;
    await handler.withRetry(async () => {
      calls++;
      throw makeErr('Not found', { status: 404 });
    }, { context: 'test-no-retry' });

    assert.equal(calls, 1, 'solo debe intentar 1 vez para errores no-retryables');
  });

  test('éxito en segundo intento retorna ok=true', async () => {
    const { handler } = freshHandler({ retryConfig: { maxAttempts: 3, delaysMs: [0, 0, 0] } });
    let calls = 0;
    const r = await handler.withRetry(async () => {
      calls++;
      if (calls < 2) throw makeErr('Temp error', { code: 'ECONNRESET' });
      return 'success';
    }, { context: 'test-success-2nd' });

    assert.equal(r.ok, true);
    assert.equal(r.result, 'success');
    assert.equal(calls, 2);
  });

  test('error fatal encola en DLQ', async () => {
    const { handler } = freshHandler();
    const r = await handler.withRetry(async () => {
      throw makeErr('ANTHROPIC_API_KEY not set', { code: 'CONFIG_ERROR' });
    }, { context: 'test-dlq', type: 'analysis', item: { url: 'https://test.com' } });

    assert.equal(r.ok, false);
    assert.ok(r.dlqId, 'debe asignar un dlqId');
    assert.equal(handler.dlqPending().length, 1, 'debe haber 1 item en DLQ');
  });

  test('error fatal dispara alerta de notificación', async () => {
    const { handler, notifierCalls } = freshHandler();
    await handler.withRetry(async () => {
      throw makeErr('API key invalid', { status: 401 });
    }, { context: 'test-notify', type: 'test' });

    assert.equal(notifierCalls.length, 1, 'debe enviar 1 alerta');
    assert.ok(notifierCalls[0].ctx.includes('test-notify'));
  });

  test('dlqStats() retorna conteos correctos', async () => {
    const { handler } = freshHandler();
    await handler.withRetry(async () => {
      throw makeErr('Fatal config error', { code: 'CONFIG_ERROR' });
    }, { type: 'test', item: { url: 'https://a.com' } });

    const stats = handler.dlqStats();
    assert.equal(stats.total,   1);
    assert.equal(stats.pending, 1);
  });
});

describe('ErrorHandlerAgent — handle()', () => {
  test('clasifica error y retorna ClassifiedError', () => {
    const { handler } = freshHandler();
    const classified = handler.handle(makeErr('rate limit exceeded'), { context: 'Discovery' });
    assert.equal(classified.category, CATEGORY.RATE_LIMIT);
    assert.equal(classified.retryable, true);
  });

  test('error fatal con item → encola en DLQ', () => {
    const { handler } = freshHandler();
    handler.handle(
      makeErr('Config missing', { code: 'CONFIG_ERROR' }),
      { type: 'discovery', context: 'Scraper', item: { url: 'https://test.com' }, attempts: 1 }
    );
    assert.equal(handler.dlqPending().length, 1);
  });
});
