#!/usr/bin/env node
/**
 * message-formatter.mjs — WhatsApp Message Formatter (career-ops v2.0)
 *
 * Convierte ScoredOffer[], ApplicationResult y TrackerMetrics en
 * mensajes de WhatsApp con formato legible.
 *
 * Formatos soportados:
 *   - formatOffer(offer)           → mensaje individual para una oferta
 *   - formatBatch(offers, runId)   → notificación de lote (N ofertas nuevas)
 *   - formatDigest(offers, stats)  → digest diario con resumen
 *   - formatWeeklyReport(metrics)  → reporte semanal de métricas
 *
 * Convenciones WhatsApp:
 *   *texto* = negrita   _texto_ = itálica   ~texto~ = tachado
 *   Máximo ~1000 chars por mensaje para legibilidad óptima.
 */

// ── Constants ──────────────────────────────────────────────────────────────────

const SCORE_STARS = {
  5.0: '⭐⭐⭐⭐⭐',
  4.5: '⭐⭐⭐⭐½',
  4.0: '⭐⭐⭐⭐',
  3.5: '⭐⭐⭐½',
  3.0: '⭐⭐⭐',
};

const STATUS_EMOJI = {
  QUEUED:        '🔔',
  NOTIFIED:      '📬',
  APPLY_PENDING: '⏳',
  Sent:          '📤',
  Interview:     '🤝',
  Offer:         '🎉',
  Rejected:      '❌',
  Discarded:     '🗑️',
  SKIP:          '⏭️',
  Evaluated:     '✅',
};

// ── MessageFormatter ──────────────────────────────────────────────────────────

export class MessageFormatter {
  /**
   * @param {object} [options]
   * @param {number} [options.maxChars=1000]  Max chars per message
   */
  constructor(options = {}) {
    this.maxChars = options.maxChars ?? 1000;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Format a single scored/prioritized offer into a WhatsApp message.
   *
   * @param {ScoredOffer} offer
   * @returns {string}
   */
  formatOffer(offer) {
    const score   = offer.priority_score != null
      ? offer.priority_score.toFixed(2)
      : offer.score?.toFixed(1) ?? '?';

    const stars   = this._stars(offer.score ?? 0);
    const tags    = (offer.tags ?? []).slice(0, 4).join(' · ');
    const company = offer.company ?? 'Empresa desconocida';
    const title   = offer.title   ?? 'Rol no especificado';
    const loc     = offer.location ? `📍 ${offer.location}` : '';
    const rating  = offer.company_info?.glassdoor_rating
      ? `| 🏢 Glassdoor: ${offer.company_info.glassdoor_rating}/5`
      : '';

    const lines = [
      `🎯 *Nueva Oferta* ${stars}`,
      '',
      `*${title}* @ ${company}`,
      [loc, rating].filter(Boolean).join(' '),
      tags ? `🏷 _${tags}_` : '',
      '',
      `📊 Score LLM: ${offer.score?.toFixed(1) ?? '?'}/5`,
      offer.apply_recommendation === false ? '⚠️ _Sin recomendación de aplicar_' : '',
      '',
      `🔗 ${offer.url ?? ''}`,
    ].filter(l => l !== undefined && !(l === '' && false));

    return this._trim(lines.join('\n'));
  }

  /**
   * Format a batch notification (N new offers above threshold).
   *
   * @param {ScoredOffer[]} offers   Already filtered/sorted
   * @param {string} [runId]
   * @returns {string}
   */
  formatBatch(offers, runId = '') {
    if (offers.length === 0) {
      return '🔍 Escaneo completado — no se encontraron nuevas ofertas calificadas.';
    }

    const date     = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
    const header   = `🔔 *${offers.length} nueva${offers.length > 1 ? 's' : ''} oferta${offers.length > 1 ? 's' : ''}* — ${date}`;

    const items = offers.map((o, i) => {
      const stars = this._stars(o.score ?? 0);
      const title = (o.title ?? 'Rol').slice(0, 35);
      const co    = (o.company ?? '?').slice(0, 20);
      return `${i + 1}. ${stars} *${title}* @ ${co}`;
    });

    const footer = runId ? `\n_run: ${runId}_` : '';
    return this._trim([header, '', ...items, footer].join('\n'));
  }

  /**
   * Format a daily digest with summary stats.
   *
   * @param {ScoredOffer[]} topOffers   Offers above threshold, sorted by priority
   * @param {object} stats              AnalysisResult.stats
   * @returns {string}
   */
  formatDigest(topOffers, stats = {}) {
    const date = new Date().toLocaleDateString('es-AR', {
      weekday: 'long', day: '2-digit', month: 'long',
    });

    const count  = topOffers.length;
    const scored = stats.scored  ?? stats.toScore ?? '?';
    const recv   = stats.received ?? '?';
    const errs   = stats.errors   ?? 0;

    const header = [
      `📋 *Daily Digest* — ${date}`,
      '',
      `📥 Analizadas: *${recv}* | Calificadas: *${scored}* | Aptas: *${count}*`,
      errs > 0 ? `⚠️ Errores: ${errs}` : '',
    ].filter(Boolean).join('\n');

    if (count === 0) {
      return this._trim(header + '\n\n_Sin nuevas ofertas calificadas hoy._');
    }

    const offerLines = topOffers.slice(0, 5).map((o, i) => {
      const title = (o.title   ?? 'Rol').slice(0, 30);
      const co    = (o.company ?? '?').slice(0, 18);
      const score = o.score?.toFixed(1) ?? '?';
      const emoji = o.apply_recommendation !== false ? '✅' : '⚠️';
      return `${i + 1}. ${emoji} *${title}* @ ${co} → ${score}/5`;
    });

    const more = count > 5 ? `\n_...y ${count - 5} más_` : '';

    const footer = [
      '',
      '---',
      '_Responde con el número de la oferta para ver el detalle._',
    ].join('\n');

    return this._trim([header, '', ...offerLines, more, footer].join('\n'));
  }

  /**
   * Format the weekly metrics report.
   *
   * @param {TrackerMetrics} metrics   From ApplicationTracker.readMetrics()
   * @returns {string}
   */
  formatWeeklyReport(metrics) {
    const week = this._isoWeek();
    const header = `📊 *Weekly Report* — Semana ${week}`;

    if (metrics.total === 0) {
      return this._trim(header + '\n\n_Sin aplicaciones registradas esta semana._');
    }

    const statusLines = Object.entries(metrics.byStatus ?? {})
      .sort(([, a], [, b]) => b - a)
      .map(([status, count]) => {
        const emoji = STATUS_EMOJI[status] ?? '📌';
        return `  ${emoji} ${status}: *${count}*`;
      });

    const top = (metrics.topCompanies ?? []).slice(0, 3)
      .map((c, i) => `  ${i + 1}. ${c.company} (${c.count})`)
      .join('\n');

    const dist = metrics.scoreDistribution ?? {};
    const distLine = Object.entries(dist)
      .map(([range, n]) => `${range}:${n}`)
      .join(' | ');

    const lines = [
      header,
      '',
      `📁 Total aplicaciones: *${metrics.total}*`,
      `⭐ Score promedio: *${metrics.avgScore ?? 0}/5*`,
      '',
      '*Por estado:*',
      ...statusLines,
      '',
      top ? `*Top empresas:*\n${top}` : '',
      '',
      distLine ? `*Distribución de scores:* ${distLine}` : '',
    ].filter(l => l !== undefined);

    return this._trim(lines.join('\n'));
  }

  /**
   * Format a critical error alert.
   *
   * @param {Error} err
   * @param {string} [context]
   * @returns {string}
   */
  formatError(err, context = '') {
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    return [
      '🚨 *career-ops ERROR*',
      '',
      `⏰ ${ts}`,
      context ? `📍 ${context}` : '',
      '',
      `❌ ${err.message ?? String(err)}`,
    ].filter(Boolean).join('\n');
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _stars(score) {
    const thresholds = [4.75, 4.25, 3.75, 3.25, 0];
    const labels     = ['⭐⭐⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐', '⭐⭐', '⭐'];
    for (let i = 0; i < thresholds.length; i++) {
      if (score >= thresholds[i]) return labels[i];
    }
    return '⭐';
  }

  _trim(text) {
    if (text.length <= this.maxChars) return text;
    return text.slice(0, this.maxChars - 3) + '...';
  }

  _isoWeek() {
    const d = new Date();
    const jan1 = new Date(d.getFullYear(), 0, 1);
    return Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  }
}

// ── Default singleton ──────────────────────────────────────────────────────────

export const messageFormatter = new MessageFormatter();
