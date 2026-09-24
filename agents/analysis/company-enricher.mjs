#!/usr/bin/env node
/**
 * company-enricher.mjs — Company Enricher (cache-first)
 *
 * Responsabilidades:
 *   1. Buscar datos de empresa en caché local (data/company-cache.json, TTL 7 días)
 *   2. Si hay cache miss: intentar enriquecimiento via Clearbit Logo API (zero-auth)
 *      y DuckDuckGo Instant Answer API (zero-auth, zero-cost)
 *   3. Guardar resultado en caché para próximas consultas
 *   4. Retornar siempre un CompanyInfo válido (puede tener campos vacíos)
 *
 * Diseño:
 *   - Fail-open: si el enriquecimiento falla, retorna datos básicos sin error
 *   - Cache-first: prioriza velocidad sobre frescura (TTL 7 días)
 *   - Zero-cost: no requiere API keys (Clearbit Logo API y DDG son gratuitos)
 *
 * Uso:
 *   import { CompanyEnricher } from './agents/analysis/company-enricher.mjs';
 *   const enricher = new CompanyEnricher();
 *   const info = await enricher.enrich('Nubank', 'https://nubank.com.br');
 */

import https from 'node:https';
import http  from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '../..');

// ── Config ─────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  cachePath:   path.join(ROOT, 'data', 'company-cache.json'),
  cacheTtlMs:  7 * 24 * 60 * 60 * 1000,   // 7 days in ms
  timeoutMs:   8000,
};

// ── CompanyEnricher ────────────────────────────────────────────────────────────

export class CompanyEnricher {
  /**
   * @param {object} [options]
   * @param {string} [options.cachePath]    Path to company-cache.json
   * @param {number} [options.cacheTtlMs]  Cache TTL in milliseconds
   * @param {number} [options.timeoutMs]   HTTP timeout for enrichment requests
   */
  constructor(options = {}) {
    this.cachePath  = options.cachePath  ?? DEFAULTS.cachePath;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULTS.cacheTtlMs;
    this.timeoutMs  = options.timeoutMs  ?? DEFAULTS.timeoutMs;
    this._cache     = null;  // lazy-loaded
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Enrich company data. Cache-first, API fallback.
   *
   * @param {string} companyName  Human-readable name (e.g. "Nubank")
   * @param {string} [careersUrl] Careers URL to derive domain (optional)
   * @returns {Promise<CompanyInfo>}
   */
  async enrich(companyName, careersUrl = '') {
    if (!companyName) return this._emptyInfo(companyName);

    const cacheKey = this._normalizeKey(companyName);

    // 1. Check cache
    const cached = this._getCached(cacheKey);
    if (cached) return cached;

    // 2. Try to derive domain from URL
    const domain = this._extractDomain(careersUrl) || this._guessDomain(companyName);

    // 3. Enrich (fail-open)
    let info = this._emptyInfo(companyName, domain);
    try {
      info = await this._fetchEnrichmentData(companyName, domain);
    } catch {
      // Enrichment failed silently — return basic info
    }

    // 4. Cache and return
    this._setCached(cacheKey, info);
    return info;
  }

  /**
   * Return cache statistics.
   */
  cacheStats() {
    const cache = this._loadCacheOnce();
    const now   = Date.now();
    const entries = Object.values(cache.entries ?? {});
    return {
      total:   entries.length,
      fresh:   entries.filter(e => now - new Date(e.cached_at).getTime() < this.cacheTtlMs).length,
      expired: entries.filter(e => now - new Date(e.cached_at).getTime() >= this.cacheTtlMs).length,
    };
  }

  /**
   * Evict expired entries from cache.
   */
  pruneCache() {
    const cache = this._loadCacheOnce();
    const now   = Date.now();
    let pruned  = 0;

    for (const [key, entry] of Object.entries(cache.entries ?? {})) {
      if (now - new Date(entry.cached_at).getTime() >= this.cacheTtlMs) {
        delete cache.entries[key];
        pruned++;
      }
    }

    if (pruned > 0) this._saveCache(cache);
    return pruned;
  }

  // ── Private: enrichment ──────────────────────────────────────────────────────

  async _fetchEnrichmentData(companyName, domain) {
    const results = await Promise.allSettled([
      domain ? this._fetchClearbitLogo(domain) : Promise.reject('no domain'),
      this._fetchDdgInstantAnswer(companyName),
    ]);

    const clearbit = results[0].status === 'fulfilled' ? results[0].value : null;
    const ddg      = results[1].status === 'fulfilled' ? results[1].value : null;

    return {
      name:             companyName,
      domain:           domain || (clearbit?.domain ?? ''),
      logo_url:         clearbit?.logo_url ?? '',
      description:      ddg?.abstract ?? '',
      source_url:       ddg?.abstract_url ?? '',
      size:             '',              // not available without paid API
      industry:         ddg?.category ?? '',
      glassdoor_rating: null,            // not available without paid API
      cached_at:        new Date().toISOString(),
    };
  }

  /**
   * Clearbit Logo API — free, no auth.
   * Returns { domain, logo_url } or throws.
   */
  async _fetchClearbitLogo(domain) {
    // Just verify the logo URL is accessible (200 = company exists in Clearbit)
    const logoUrl = `https://logo.clearbit.com/${domain}`;
    const resp    = await this._fetchHead(logoUrl);

    if (resp.statusCode === 200) {
      return { domain, logo_url: logoUrl };
    }
    throw new Error(`Clearbit: no logo for ${domain}`);
  }

  /**
   * DuckDuckGo Instant Answer API — free, no auth.
   * Returns { abstract, abstract_url, category } or throws.
   */
  async _fetchDdgInstantAnswer(companyName) {
    const query  = encodeURIComponent(companyName + ' company');
    const url    = `https://api.duckduckgo.com/?q=${query}&format=json&no_html=1&skip_disambig=1`;
    const body   = await this._fetchJson(url);

    if (!body || (!body.Abstract && !body.AbstractText)) {
      throw new Error('DDG: no abstract found');
    }

    return {
      abstract:     body.Abstract || body.AbstractText || '',
      abstract_url: body.AbstractURL || '',
      category:     body.Entity || '',
    };
  }

  // ── Private: HTTP helpers ────────────────────────────────────────────────────

  _fetchHead(url) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib    = parsed.protocol === 'https:' ? https : http;
      const opts   = {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   'HEAD',
        timeout:  this.timeoutMs,
        headers: { 'User-Agent': 'career-ops/2.0 (company-enricher)' },
      };

      const req = lib.request(opts, res => resolve({ statusCode: res.statusCode }));
      req.on('timeout', () => { req.destroy(); reject(new Error('HEAD timeout')); });
      req.on('error', reject);
      req.end();
    });
  }

  _fetchJson(url) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib    = parsed.protocol === 'https:' ? https : http;
      const opts   = {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        timeout:  this.timeoutMs,
        headers: {
          'User-Agent': 'career-ops/2.0 (company-enricher)',
          'Accept':     'application/json',
        },
      };

      const req = lib.request(opts, (res) => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('JSON parse failed'));
          }
        });
        res.on('error', reject);
      });

      req.on('timeout', () => { req.destroy(); reject(new Error('GET timeout')); });
      req.on('error', reject);
      req.end();
    });
  }

  // ── Private: cache ───────────────────────────────────────────────────────────

  _getCached(key) {
    const cache = this._loadCacheOnce();
    const entry = cache.entries?.[key];
    if (!entry) return null;

    const age = Date.now() - new Date(entry.cached_at).getTime();
    if (age >= this.cacheTtlMs) return null;  // expired

    return entry;
  }

  _setCached(key, info) {
    const cache = this._loadCacheOnce();
    cache.entries       = cache.entries ?? {};
    cache.entries[key]  = info;
    cache._meta         = { updated_at: new Date().toISOString(), total: Object.keys(cache.entries).length };
    this._saveCache(cache);
  }

  _loadCacheOnce() {
    if (this._cache) return this._cache;

    if (existsSync(this.cachePath)) {
      try {
        this._cache = JSON.parse(readFileSync(this.cachePath, 'utf8'));
        return this._cache;
      } catch {
        // Corrupted cache — start fresh
      }
    }

    this._cache = { _meta: { created_at: new Date().toISOString() }, entries: {} };
    return this._cache;
  }

  _saveCache(cache) {
    const dir = path.dirname(this.cachePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(cache, null, 2), 'utf8');
  }

  // ── Private: helpers ─────────────────────────────────────────────────────────

  _normalizeKey(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  _extractDomain(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
      // Remove www. and job-portal domains (greenhouse, lever, etc.)
      const hostname = parsed.hostname.replace(/^www\./, '');
      const JOB_PORTALS = ['greenhouse.io', 'lever.co', 'ashby.io', 'workable.com', 'smartrecruiters.com'];
      if (JOB_PORTALS.some(p => hostname.endsWith(p))) return '';
      return hostname;
    } catch {
      return '';
    }
  }

  _guessDomain(companyName) {
    if (!companyName) return '';
    // Very rough heuristic: "Nubank" → "nubank.com"
    const slug = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    return slug ? `${slug}.com` : '';
  }

  _emptyInfo(name, domain = '') {
    return {
      name:             name ?? '',
      domain:           domain,
      logo_url:         '',
      description:      '',
      source_url:       '',
      size:             '',
      industry:         '',
      glassdoor_rating: null,
      cached_at:        new Date().toISOString(),
    };
  }
}

// ── JSDoc types ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} CompanyInfo
 * @property {string}      name
 * @property {string}      domain
 * @property {string}      logo_url
 * @property {string}      description
 * @property {string}      source_url
 * @property {string}      size
 * @property {string}      industry
 * @property {number|null} glassdoor_rating
 * @property {string}      cached_at         - ISO timestamp
 */

// ── Default singleton ──────────────────────────────────────────────────────────

export const companyEnricher = new CompanyEnricher();
