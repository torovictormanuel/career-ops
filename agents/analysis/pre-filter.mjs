#!/usr/bin/env node
/**
 * pre-filter.mjs — Motor de reglas de pre-filtrado (rule-based, sin LLM)
 *
 * Lee config/filter_rules.yml y aplica reglas duras a cada oferta.
 * Si la oferta viola alguna regla → { pass: false } — no llega al LLM Scorer.
 * Tiempo de ejecución: < 5ms por oferta (sin I/O, sólo string operations).
 *
 * Reglas soportadas:
 *   reject_if_title_contains  — keywords en el TÍTULO (case-insensitive)
 *   reject_if_jd_contains     — keywords en el JD/body (case-insensitive)
 *   reject_if_location        — keywords en la UBICACIÓN (case-insensitive)
 *   require_any_title         — el TÍTULO debe contener al menos uno (positivo)
 *   company_blacklist         — empresas descartadas directamente por nombre
 *   min_jd_chars              — mínimo de caracteres del JD para ser evaluada
 *
 * Uso:
 *   import { PreFilter } from './agents/analysis/pre-filter.mjs';
 *   const pf = new PreFilter();
 *   const result = pf.evaluate({ title, jd, location, company });
 *   // result: { pass: true } | { pass: false, reason: '...', rule: '...' }
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '../..');

// ── PreFilter ──────────────────────────────────────────────────────────────────

export class PreFilter {
  /**
   * @param {string} [rulesPath] Path to filter_rules.yml (default: config/filter_rules.yml)
   */
  constructor(rulesPath) {
    this._rulesPath = rulesPath ?? path.join(ROOT, 'config', 'filter_rules.yml');
    this._rules     = null;   // lazy-loaded on first evaluate()
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Evaluate a single offer against all filter rules.
   *
   * @param {{ title?: string, jd?: string, location?: string, company?: string }} offer
   * @returns {{ pass: boolean, reason?: string, rule?: string }}
   */
  evaluate(offer) {
    const rules    = this._loadRulesOnce();
    const title    = (offer.title    ?? '').toLowerCase();
    const jd       = (offer.jd       ?? '').toLowerCase();
    const location = (offer.location ?? '').toLowerCase();
    const company  = (offer.company  ?? '').toLowerCase();

    // ── Rule 1: min_jd_chars ──────────────────────────────────────────────────
    const jdLen = (offer.jd ?? '').length;
    if (rules.min_jd_chars && jdLen < rules.min_jd_chars) {
      return this._reject(
        `JD demasiado corto (${jdLen} chars < mínimo ${rules.min_jd_chars})`,
        'min_jd_chars'
      );
    }

    // ── Rule 2: company_blacklist ─────────────────────────────────────────────
    if (rules.company_blacklist?.length) {
      for (const blocked of rules.company_blacklist) {
        if (company.includes(blocked.toLowerCase())) {
          return this._reject(`Empresa en blacklist: "${blocked}"`, 'company_blacklist');
        }
      }
    }

    // ── Rule 3: reject_if_title_contains ─────────────────────────────────────
    if (rules.reject_if_title_contains?.length) {
      for (const kw of rules.reject_if_title_contains) {
        if (title.includes(kw.toLowerCase())) {
          return this._reject(
            `Título contiene keyword rechazada: "${kw}"`,
            'reject_if_title_contains'
          );
        }
      }
    }

    // ── Rule 4: reject_if_jd_contains ────────────────────────────────────────
    if (rules.reject_if_jd_contains?.length) {
      for (const kw of rules.reject_if_jd_contains) {
        if (jd.includes(kw.toLowerCase())) {
          return this._reject(
            `JD contiene keyword rechazada: "${kw}"`,
            'reject_if_jd_contains'
          );
        }
      }
    }

    // ── Rule 5: reject_if_location ───────────────────────────────────────────
    if (rules.reject_if_location?.length) {
      for (const kw of rules.reject_if_location) {
        if (location.includes(kw.toLowerCase())) {
          return this._reject(
            `Ubicación rechazada: "${kw}"`,
            'reject_if_location'
          );
        }
      }
    }

    // ── Rule 6: require_any_title (positive filter — disabled by default) ─────
    if (rules.require_any_title?.length) {
      const hasAny = rules.require_any_title.some(kw => title.includes(kw.toLowerCase()));
      if (!hasAny) {
        return this._reject(
          `Título no contiene ninguna keyword requerida: [${rules.require_any_title.join(', ')}]`,
          'require_any_title'
        );
      }
    }

    return { pass: true };
  }

  /**
   * Evaluate a batch of offers, returning passed and rejected groups.
   *
   * @param {Array<object>} offers
   * @returns {{ passed: Array, rejected: Array<{offer, reason, rule}> }}
   */
  evaluateBatch(offers) {
    const passed   = [];
    const rejected = [];

    for (const offer of offers) {
      const result = this.evaluate(offer);
      if (result.pass) {
        passed.push(offer);
      } else {
        rejected.push({ offer, reason: result.reason, rule: result.rule });
      }
    }

    return { passed, rejected };
  }

  /**
   * Return a stats summary of the current rules.
   * Useful for debugging / logging.
   */
  rulesSummary() {
    const rules = this._loadRulesOnce();
    return {
      reject_if_title_contains: (rules.reject_if_title_contains ?? []).length,
      reject_if_jd_contains:    (rules.reject_if_jd_contains    ?? []).length,
      reject_if_location:       (rules.reject_if_location        ?? []).length,
      require_any_title:        (rules.require_any_title         ?? []).length,
      company_blacklist:        (rules.company_blacklist          ?? []).length,
      min_jd_chars:             rules.min_jd_chars               ?? 0,
    };
  }

  /**
   * Force-reload the rules file (useful in tests or after hot edits).
   */
  reloadRules() {
    this._rules = null;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  _reject(reason, rule) {
    return { pass: false, reason, rule };
  }

  _loadRulesOnce() {
    if (this._rules) return this._rules;

    try {
      const raw    = readFileSync(this._rulesPath, 'utf8');
      this._rules  = yaml.load(raw) ?? {};
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Fail-open: if rules file not found, pass everything through
        console.warn(`[PreFilter] Rules file not found at ${this._rulesPath} — running without rules (fail-open)`);
        this._rules = {};
      } else {
        throw new Error(`[PreFilter] Cannot load rules from ${this._rulesPath}: ${err.message}`);
      }
    }

    return this._rules;
  }
}

// ── Default singleton ──────────────────────────────────────────────────────────

export const preFilter = new PreFilter();
