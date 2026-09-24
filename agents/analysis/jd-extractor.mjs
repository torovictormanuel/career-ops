#!/usr/bin/env node
/**
 * jd-extractor.mjs — Extractor de texto de Job Description
 *
 * Responsabilidades:
 *   1. Fetch del HTML de la URL de la oferta (sin Playwright — zero-dependency)
 *   2. Extracción del texto del JD usando selectores CSS (regex-based)
 *   3. Limpieza del texto: sin tags HTML, sin navigation/footer, sin emojis excesivos
 *   4. Manejo de errores: 404, 410, login wall, JD demasiado corto
 *
 * Retorna un JdResult:
 *   { status: 'ok' | 'SKIP_404' | 'SKIP_LOGIN_WALL' | 'SKIP_NO_JD' | 'SKIP_FETCH_ERROR',
 *     text: string, wordCount: number, note: string }
 *
 * Uso:
 *   const extractor = new JdExtractor();
 *   const result = await extractor.extract('https://boards.greenhouse.io/...');
 */

import https from 'node:https';
import http  from 'node:http';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

// ── Constants ──────────────────────────────────────────────────────────────────

/** CSS-style selectors tried in priority order */
const DEFAULT_SELECTORS = [
  // Greenhouse / Lever / Ashby semantic classes
  { type: 'class', keyword: 'job-description' },
  { type: 'class', keyword: 'job_description' },
  { type: 'class', keyword: 'jobDescription' },
  // Generic job portals
  { type: 'id',    keyword: 'job-description' },
  { type: 'id',    keyword: 'jobDescription' },
  { type: 'id',    keyword: 'job_description' },
  { type: 'class', keyword: 'description' },
  { type: 'class', keyword: 'posting-content' },
  { type: 'class', keyword: 'job-detail' },
  { type: 'class', keyword: 'jobDetail' },
  { type: 'class', keyword: 'job-content' },
  { type: 'class', keyword: 'content-description' },
  { type: 'class', keyword: 'vacancy-description' },
  // Fallback HTML tags (order matters — article is more specific than main)
  { type: 'tag',   keyword: 'article' },
  { type: 'tag',   keyword: 'main' },
];

/** Phrases that indicate a login wall (checked in the raw HTML, case-insensitive) */
const LOGIN_WALL_SIGNALS = [
  'sign in to view',
  'log in to see',
  'create an account to view',
  'please login',
  'please sign in',
  'access denied',
  'you must be logged in',
  'join to view',
  'register to apply',
  'inicia sesión para ver',
  'inicia sesión para continuar',
  'faça login para ver',
  '401 unauthorized',
  '403 forbidden',
];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
];

// ── JdExtractor ────────────────────────────────────────────────────────────────

export class JdExtractor {
  /**
   * @param {object} [options]
   * @param {number}  [options.minChars=100]        Minimum JD text length to be valid
   * @param {number}  [options.timeoutMs=15000]     HTTP fetch timeout
   * @param {number}  [options.maxBodyBytes]        Max response body size (default 2MB)
   * @param {Array}   [options.selectors]           Override default CSS selector list
   * @param {boolean} [options.playwrightFallback=true]  Use Playwright when static fetch < minChars
   */
  constructor(options = {}) {
    this.minChars            = options.minChars            ?? 100;
    this.timeoutMs           = options.timeoutMs           ?? 15000;
    this.maxBodyBytes        = options.maxBodyBytes        ?? 2_000_000;
    this.selectors           = options.selectors           ?? DEFAULT_SELECTORS;
    this.playwrightFallback  = options.playwrightFallback  ?? true;
    this._uaIndex            = 0;
    this._playwright         = null;   // lazy-loaded
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Extract JD text from a URL (or local file path with prefix "local:").
   * @param {string} url
   * @returns {Promise<JdResult>}
   */
  async extract(url) {
    if (!url || typeof url !== 'string') {
      return this._result('SKIP_FETCH_ERROR', '', 'No URL provided');
    }

    // Local file support (tests / offline processing)
    if (url.startsWith('local:')) {
      return this._extractLocal(url.slice(6));
    }

    // Validate URL before fetching
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return this._result('SKIP_FETCH_ERROR', '', `Invalid URL: ${url}`);
    }

    // Fetch HTML
    let resp;
    try {
      resp = await this._fetch(parsedUrl);
    } catch (err) {
      return this._result('SKIP_FETCH_ERROR', '', `Fetch failed: ${err.message}`);
    }

    const { statusCode, body } = resp;

    if (statusCode === 404 || statusCode === 410) {
      return this._result('SKIP_404', '', `HTTP ${statusCode}`);
    }
    if (statusCode === 401 || statusCode === 403) {
      return this._result('SKIP_LOGIN_WALL', '', `HTTP ${statusCode} — access denied`);
    }
    if (statusCode >= 400) {
      return this._result('SKIP_FETCH_ERROR', '', `HTTP ${statusCode}`);
    }

    const staticResult = this._parseHtml(body);

    // If static HTML didn't yield enough text, try Playwright (JS-rendered pages)
    if (staticResult.status !== 'ok' && this.playwrightFallback) {
      return this._fetchWithPlaywright(parsedUrl.href);
    }

    return staticResult;
  }

  // ── Private: parsing ─────────────────────────────────────────────────────────

  _parseHtml(html) {
    // 1. Check for login wall signals in raw HTML
    const lower = html.toLowerCase();
    if (LOGIN_WALL_SIGNALS.some(s => lower.includes(s))) {
      return this._result('SKIP_LOGIN_WALL', '', 'Login wall detected in content');
    }

    // 2. Strip noisy sections before selector matching
    const stripped = this._stripNoiseSections(html);

    // 3. Try each selector in priority order
    for (const sel of this.selectors) {
      const raw = this._extractBySelector(stripped, sel);
      if (raw && raw.length >= this.minChars) {
        const text = this._cleanText(raw);
        if (text.length >= this.minChars) {
          return this._result('ok', text, `selector:${sel.type}[${sel.keyword}]`);
        }
      }
    }

    // 4. Fallback: extract <body> and clean everything
    const bodyMatch = stripped.match(/<body[\s\S]*?<\/body>/i);
    const bodyHtml  = bodyMatch ? bodyMatch[0] : stripped;
    const fallback  = this._cleanText(bodyHtml);

    if (fallback.length < this.minChars) {
      return this._result('SKIP_NO_JD', '', `Too short after full-page fallback (${fallback.length} chars)`);
    }

    // Truncate to 8000 chars to avoid sending entire pages to LLM
    return this._result('ok', fallback.slice(0, 8_000), 'fallback-full-page');
  }

  /** Remove sections that are never part of the JD */
  _stripNoiseSections(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
  }

  /**
   * Minimal regex-based selector matching.
   * Supports { type: 'class'|'id'|'tag', keyword: string }.
   * Returns the inner HTML of the first match, or null.
   */
  _extractBySelector(html, { type, keyword }) {
    let re;

    if (type === 'tag') {
      // <article ...>...</article>  (greedy, first match only)
      re = new RegExp(`<${keyword}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${keyword}>`, 'i');
    } else if (type === 'class') {
      // <* class="...keyword...">...</*>
      re = new RegExp(
        `<(\\w+)[^>]+class="[^"]*${keyword}[^"]*"[^>]*>([\\s\\S]*?)<\\/\\1>`,
        'i'
      );
    } else if (type === 'id') {
      // <* id="...keyword...">...</*>
      re = new RegExp(
        `<(\\w+)[^>]+id="[^"]*${keyword}[^"]*"[^>]*>([\\s\\S]*?)<\\/\\1>`,
        'i'
      );
    } else {
      return null;
    }

    const m = html.match(re);
    if (!m) return null;
    // For tag matches, capture group 1 is the content
    // For class/id matches, capture group 2 is the content
    return type === 'tag' ? m[1] : m[2];
  }

  /** Strip HTML tags, decode entities, normalize whitespace */
  _cleanText(html) {
    return html
      .replace(/<[^>]+>/g, ' ')       // strip all tags
      .replace(/&amp;/g,  '&')
      .replace(/&lt;/g,   '<')
      .replace(/&gt;/g,   '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g,  "'")
      .replace(/&#x27;/g, "'")
      .replace(/\r\n/g,   '\n')
      .replace(/\r/g,     '\n')
      .replace(/[ \t]{2,}/g, ' ')      // collapse horizontal whitespace
      .replace(/\n{3,}/g, '\n\n')      // max 2 consecutive newlines
      .trim();
  }

  // ── Private: local file ──────────────────────────────────────────────────────

  _extractLocal(filePath) {
    try {
      const text = readFileSync(filePath, 'utf8').trim();
      if (text.length < this.minChars) {
        return Promise.resolve(this._result('SKIP_NO_JD', '', `Local file too short (${text.length} chars)`));
      }
      return Promise.resolve(this._result('ok', text, 'local-file'));
    } catch (err) {
      return Promise.resolve(this._result('SKIP_FETCH_ERROR', '', `Cannot read local file ${filePath}: ${err.message}`));
    }
  }

  // ── Private: HTTP fetch ──────────────────────────────────────────────────────

  _fetch(parsedUrl) {
    return new Promise((resolve, reject) => {
      const lib  = parsedUrl.protocol === 'https:' ? https : http;
      const opts = {
        hostname: parsedUrl.hostname,
        path:     parsedUrl.pathname + parsedUrl.search,
        port:     parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        method:   'GET',
        headers:  {
          'User-Agent':      this._nextUserAgent(),
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
          'Accept-Encoding': 'identity',  // no compression — simpler parsing
          'Cache-Control':   'no-cache',
        },
        timeout: this.timeoutMs,
      };

      const req = lib.request(opts, (res) => {
        // Follow single redirect (301/302/307/308)
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, parsedUrl.href);
          return this._fetch(redirectUrl).then(resolve).catch(reject);
        }

        const chunks = [];
        let totalBytes = 0;

        res.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > this.maxBodyBytes) {
            req.destroy();
            reject(new Error(`Response too large (>${this.maxBodyBytes} bytes)`));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body:       Buffer.concat(chunks).toString('utf8'),
          });
        });

        res.on('error', reject);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });
      req.on('error', reject);
      req.end();
    });
  }

  _nextUserAgent() {
    const ua = USER_AGENTS[this._uaIndex % USER_AGENTS.length];
    this._uaIndex++;
    return ua;
  }

  // ── Private: Playwright fallback ─────────────────────────────────────────────

  async _fetchWithPlaywright(url) {
    let browser;
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();

      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });

      // Wait for common JD containers to appear (up to 5s)
      await page.waitForSelector(
        '[class*="job-description"], [id*="job-description"], article, main',
        { timeout: 5_000 }
      ).catch(() => { /* not found — use full page */ });

      // Extract innerText from the most specific container available
      const text = await page.evaluate(() => {
        const selectors = [
          '[class*="job-description"]', '[id*="job-description"]',
          '[class*="jobDescription"]',  '[id*="jobDescription"]',
          '[class*="description"]',     '[class*="posting-content"]',
          '[class*="job-detail"]',      '[class*="content"]',
          'article', 'main',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            const t = el.innerText?.trim();
            if (t && t.length > 100) return t.slice(0, 8000);
          }
        }
        return document.body?.innerText?.trim()?.slice(0, 8000) ?? '';
      });

      if (!text || text.length < this.minChars) {
        return this._result('SKIP_NO_JD', '', `Playwright: too short (${text?.length ?? 0} chars)`);
      }

      return this._result('ok', text, 'playwright');
    } catch (err) {
      return this._result('SKIP_FETCH_ERROR', '', `Playwright failed: ${err.message}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  /** @returns {JdResult} */
  _result(status, text = '', note = '') {
    return {
      status,
      text,
      wordCount: text ? text.split(/\s+/).filter(Boolean).length : 0,
      note,
    };
  }
}

// ── JSDoc types ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} JdResult
 * @property {'ok'|'SKIP_404'|'SKIP_LOGIN_WALL'|'SKIP_NO_JD'|'SKIP_FETCH_ERROR'} status
 * @property {string} text        - Clean JD text (empty if not ok)
 * @property {number} wordCount   - Approximate word count
 * @property {string} note        - Debug note (selector used or error message)
 */

// ── Default singleton ──────────────────────────────────────────────────────────

export const jdExtractor = new JdExtractor();
