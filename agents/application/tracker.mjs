#!/usr/bin/env node
/**
 * tracker.mjs — Application Tracker (career-ops v2.0)
 *
 * Responsabilidades:
 *   WRITE: Registrar ofertas calificadas en batch/tracker-additions/ como TSV.
 *          El archivo se mergea en data/applications.md con merge-tracker.mjs.
 *   READ:  Parsear data/applications.md y retornar métricas/estado.
 *
 * Integración con v1.x:
 *   Usa el mismo formato TSV de 9 columnas que el sistema original:
 *   num | date | company | role | status | score/5 | pdf | report | notes
 *   (nota: en applications.md score va ANTES de status — merge-tracker.mjs lo invierte)
 *
 * Estados canonicos (de templates/states.yml):
 *   QUEUED → NOTIFIED → APPLY_PENDING → SENT → INTERVIEW → OFFER
 *   → REJECTED | DISCARDED | SKIP
 *
 * Uso:
 *   import { ApplicationTracker } from './agents/application/tracker.mjs';
 *   const tracker = new ApplicationTracker();
 *   tracker.queueOffer(scoredOffer);  // → escribe TSV
 *   const metrics = tracker.readMetrics();
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '../..');

// ── Constants ──────────────────────────────────────────────────────────────────

const TRACKER_PATH = path.join(ROOT, 'data', 'applications.md');
const TSV_DIR      = path.join(ROOT, 'batch', 'tracker-additions');

const TRACKER_HEADER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`;

/** Canonical status values (from templates/states.yml) */
export const STATUS = {
  QUEUED:        'QUEUED',
  NOTIFIED:      'NOTIFIED',
  APPLY_PENDING: 'APPLY_PENDING',
  SENT:          'Sent',
  INTERVIEW:     'Interview',
  OFFER:         'Offer',
  REJECTED:      'Rejected',
  DISCARDED:     'Discarded',
  SKIP:          'SKIP',
  EVALUATED:     'Evaluated',
};

// ── ApplicationTracker ────────────────────────────────────────────────────────

export class ApplicationTracker {
  /**
   * @param {object} [options]
   * @param {string} [options.trackerPath]  Path to applications.md
   * @param {string} [options.tsvDir]       Path to batch/tracker-additions/
   * @param {boolean} [options.dryRun]      Don't write files
   */
  constructor(options = {}) {
    this.trackerPath = options.trackerPath ?? TRACKER_PATH;
    this.tsvDir      = options.tsvDir      ?? TSV_DIR;
    this.dryRun      = options.dryRun      ?? false;
  }

  // ── Write API ─────────────────────────────────────────────────────────────────

  /**
   * Register a scored offer in the tracker (writes a TSV file).
   * Does NOT write directly to applications.md — uses merge-tracker.mjs pattern.
   *
   * @param {PrioritizedOffer} offer
   * @param {object} [options]
   * @param {string} [options.status]  Initial status (default: QUEUED)
   * @param {string} [options.notes]   Custom notes
   * @returns {{ num: number, tsvPath: string }}
   */
  queueOffer(offer, options = {}) {
    this._ensureTrackerExists();

    const num    = this._nextEntryNumber();
    const date   = new Date().toISOString().slice(0, 10);
    const slug   = this._slugify(offer.company);
    const status = options.status ?? STATUS.QUEUED;
    const score  = offer.score?.toFixed(1) ?? '0.0';
    const notes  = options.notes ?? offer.justification?.slice(0, 80) ?? '';

    const tsvLine = [
      num,
      date,
      offer.company ?? '',
      (offer.title  ?? '').slice(0, 60),
      status,
      `${score}/5`,
      '❌',                                // PDF: no generado aún
      '',                                  // Report: no generado aún
      notes,
    ].join('\t');

    const tsvPath = path.join(this.tsvDir, `${String(num).padStart(3, '0')}-${slug}.tsv`);

    if (!this.dryRun) {
      if (!existsSync(this.tsvDir)) mkdirSync(this.tsvDir, { recursive: true });
      writeFileSync(tsvPath, tsvLine + '\n', 'utf8');
    }

    return { num, tsvPath };
  }

  /**
   * Queue multiple offers at once.
   *
   * @param {PrioritizedOffer[]} offers
   * @param {object} [options]
   * @returns {Array<{ num: number, tsvPath: string, url: string }>}
   */
  queueBatch(offers, options = {}) {
    return offers.map(offer => ({
      ...this.queueOffer(offer, options),
      url: offer.url,
    }));
  }

  /**
   * Update the status of an existing entry in applications.md.
   * Only updates STATUS field of matching company+role rows.
   *
   * @param {string} company
   * @param {string} role
   * @param {string} newStatus
   * @param {string} [notes]
   */
  updateStatus(company, role, newStatus, notes = '') {
    if (!existsSync(this.trackerPath)) return false;

    const content  = readFileSync(this.trackerPath, 'utf8');
    const lines    = content.split('\n');
    let   updated  = false;

    const result = lines.map(line => {
      if (!line.startsWith('|') || line.startsWith('| #') || line.startsWith('|---')) return line;

      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      // cols: [#, date, company, role, score, status, pdf, report, notes]
      if (cols.length < 6) return line;

      const rowCompany = cols[2] ?? '';
      const rowRole    = cols[3] ?? '';

      if (
        rowCompany.toLowerCase().includes(company.toLowerCase()) &&
        rowRole.toLowerCase().includes(role.toLowerCase())
      ) {
        cols[5] = newStatus;
        if (notes) cols[8] = notes;
        updated = true;
        return '| ' + cols.join(' | ') + ' |';
      }
      return line;
    });

    if (updated && !this.dryRun) {
      writeFileSync(this.trackerPath, result.join('\n'), 'utf8');
    }

    return updated;
  }

  // ── Read API ──────────────────────────────────────────────────────────────────

  /**
   * Parse applications.md and return all entries.
   *
   * @returns {TrackerEntry[]}
   */
  readEntries() {
    if (!existsSync(this.trackerPath)) return [];

    const content = readFileSync(this.trackerPath, 'utf8');
    const entries = [];

    for (const line of content.split('\n')) {
      if (!line.startsWith('|') || line.startsWith('| #') || line.startsWith('|---')) continue;

      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length < 6) continue;

      const scoreStr = cols[4] ?? '';
      const score    = parseFloat(scoreStr.replace('/5', '')) || 0;

      entries.push({
        num:     parseInt(cols[0]) || 0,
        date:    cols[1] ?? '',
        company: cols[2] ?? '',
        role:    cols[3] ?? '',
        score,
        status:  cols[5] ?? '',
        pdf:     cols[6] ?? '',
        report:  cols[7] ?? '',
        notes:   cols[8] ?? '',
      });
    }

    return entries;
  }

  /**
   * Return aggregate metrics for the tracker.
   *
   * @returns {TrackerMetrics}
   */
  readMetrics() {
    const entries = this.readEntries();
    if (entries.length === 0) {
      return { total: 0, byStatus: {}, avgScore: 0, topCompanies: [], scoreDistribution: {} };
    }

    const byStatus      = {};
    const scoresByStatus = {};
    const companyCounts = {};

    for (const e of entries) {
      byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;

      if (e.score > 0) {
        if (!scoresByStatus[e.status]) scoresByStatus[e.status] = [];
        scoresByStatus[e.status].push(e.score);
      }

      if (e.company) {
        companyCounts[e.company] = (companyCounts[e.company] ?? 0) + 1;
      }
    }

    const scores     = entries.filter(e => e.score > 0).map(e => e.score);
    const avgScore   = scores.length > 0
      ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)
      : 0;

    const topCompanies = Object.entries(companyCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([company, count]) => ({ company, count }));

    const scoreDist = { '1.0-2.0': 0, '2.0-3.0': 0, '3.0-4.0': 0, '4.0-5.0': 0 };
    for (const s of scores) {
      if (s < 2)      scoreDist['1.0-2.0']++;
      else if (s < 3) scoreDist['2.0-3.0']++;
      else if (s < 4) scoreDist['3.0-4.0']++;
      else            scoreDist['4.0-5.0']++;
    }

    return {
      total:             entries.length,
      byStatus,
      avgScore,
      topCompanies,
      scoreDistribution: scoreDist,
    };
  }

  /**
   * Check if a company+role combination already exists in the tracker.
   *
   * @param {string} company
   * @param {string} role
   * @returns {TrackerEntry|null}
   */
  findEntry(company, role) {
    const entries = this.readEntries();
    return entries.find(e =>
      e.company.toLowerCase() === company.toLowerCase() &&
      e.role.toLowerCase().includes(role.toLowerCase())
    ) ?? null;
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _ensureTrackerExists() {
    if (!existsSync(this.trackerPath)) {
      if (!this.dryRun) {
        const dir = path.dirname(this.trackerPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(this.trackerPath, TRACKER_HEADER, 'utf8');
      }
    }
  }

  _nextEntryNumber() {
    const entries = this.readEntries();
    const maxFromTracker = entries.length > 0 ? Math.max(...entries.map(e => e.num || 0)) : 0;

    let maxFromTsv = 0;
    if (existsSync(this.tsvDir)) {
      for (const file of readdirSync(this.tsvDir).filter(f => f.endsWith('.tsv'))) {
        const m = file.match(/^(\d+)-/);
        if (m) maxFromTsv = Math.max(maxFromTsv, parseInt(m[1], 10));
      }
    }

    return Math.max(maxFromTracker, maxFromTsv) + 1;
  }

  _slugify(str) {
    return (str ?? 'unknown')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30);
  }
}

// ── JSDoc types ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} TrackerEntry
 * @property {number} num
 * @property {string} date
 * @property {string} company
 * @property {string} role
 * @property {number} score
 * @property {string} status
 * @property {string} pdf
 * @property {string} report
 * @property {string} notes
 */

/**
 * @typedef {object} TrackerMetrics
 * @property {number} total
 * @property {Record<string,number>} byStatus
 * @property {number} avgScore
 * @property {Array<{company:string,count:number}>} topCompanies
 * @property {Record<string,number>} scoreDistribution
 */

// ── Default singleton ──────────────────────────────────────────────────────────

export const applicationTracker = new ApplicationTracker();
