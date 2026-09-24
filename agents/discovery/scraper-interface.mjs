/**
 * scraper-interface.mjs — Contrato v2.0 para scrapers del Discovery Agent
 *
 * Define la interface que todo scraper de v2.0 debe implementar,
 * y el BaseScraperAdapter que envuelve los providers existentes (v1.x)
 * al contrato v2.0 sin reescribirlos.
 *
 * Contrato de salida (NormalizedOffer):
 *   { url, title, company, location, date_found, source_portal }
 */

// ── Tipos (JSDoc) ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} NormalizedOffer
 * @property {string}  url           - URL canónica de la oferta
 * @property {string}  title         - Título del rol
 * @property {string}  company       - Nombre de la empresa
 * @property {string}  location      - Ubicación (string vacío si no disponible)
 * @property {string}  date_found    - ISO 8601 — timestamp de descubrimiento
 * @property {string}  source_portal - ID del proveedor: greenhouse | getonboard | lever | ashby | websearch
 */

/**
 * @typedef {object} ScraperResult
 * @property {NormalizedOffer[]} offers   - Ofertas encontradas
 * @property {number}            duration - Tiempo de ejecución en ms
 * @property {string}            portal   - ID del portal
 * @property {'ok'|'error'}      status
 * @property {string}           [error]   - Mensaje de error si status === 'error'
 */

// ── Validación ────────────────────────────────────────────────────────────────

/**
 * Valida que un objeto cumple el contrato NormalizedOffer.
 * Lanza TypeError si falta algún campo requerido.
 * @param {*} obj
 * @returns {NormalizedOffer}
 */
export function assertNormalizedOffer(obj) {
  const required = ['url', 'title', 'company', 'location', 'date_found', 'source_portal'];
  for (const field of required) {
    if (obj[field] === undefined || obj[field] === null) {
      throw new TypeError(`NormalizedOffer: campo requerido faltante: "${field}" en ${JSON.stringify(obj)}`);
    }
  }
  if (typeof obj.url !== 'string' || !obj.url.startsWith('http')) {
    throw new TypeError(`NormalizedOffer: "url" debe ser una URL HTTP válida, recibido: ${obj.url}`);
  }
  return obj;
}

// ── BaseScraperAdapter ────────────────────────────────────────────────────────

/**
 * Adapta un provider v1.x al contrato v2.0.
 *
 * Los providers v1.x retornan: [{ title, url, company, location }]
 * Este adapter agrega: date_found, source_portal
 * y valida el contrato de salida.
 */
export class BaseScraperAdapter {
  /**
   * @param {object} provider - Provider v1.x (greenhouse, getonboard, lever, ashby)
   * @param {object} httpCtx  - Contexto HTTP (makeHttpCtx)
   */
  constructor(provider, httpCtx) {
    if (!provider || typeof provider.fetch !== 'function') {
      throw new Error('BaseScraperAdapter requiere un provider con método fetch()');
    }
    this.provider = provider;
    this.httpCtx  = httpCtx;
    this.id       = provider.id;
  }

  /**
   * Ejecuta el scraping de una entrada de portals.yml.
   * Normaliza la salida al contrato v2.0.
   *
   * @param {object} portalEntry - Entrada de portals.yml (tracked_companies)
   * @returns {Promise<ScraperResult>}
   */
  async scrape(portalEntry) {
    const start = Date.now();
    const dateFound = new Date().toISOString();

    try {
      // Llamada al provider v1.x
      const rawOffers = await this.provider.fetch(portalEntry, this.httpCtx);

      // Normalizar a contrato v2.0
      const offers = rawOffers.map(raw => ({
        url:           (raw.url ?? '').trim(),
        title:         (raw.title ?? '').trim(),
        company:       (raw.company ?? portalEntry.name ?? '').trim(),
        location:      (raw.location ?? '').trim(),
        date_found:    dateFound,
        source_portal: this.id,
      }));

      // Validar cada oferta (en dev/debug; en prod, filtrar silenciosamente)
      const validOffers = [];
      for (const offer of offers) {
        try {
          assertNormalizedOffer(offer);
          validOffers.push(offer);
        } catch (err) {
          console.warn(`[${this.id}] Oferta inválida descartada: ${err.message}`);
        }
      }

      return {
        offers:   validOffers,
        duration: Date.now() - start,
        portal:   this.id,
        status:   'ok',
      };

    } catch (err) {
      return {
        offers:   [],
        duration: Date.now() - start,
        portal:   this.id,
        status:   'error',
        error:    err.message,
      };
    }
  }
}

// ── Interface pura (para scrapers nuevos que no usan providers v1.x) ──────────

/**
 * Clase base abstracta para scrapers nativos v2.0.
 * Extender e implementar `fetch(portalEntry)`.
 */
export class ScraperV2 {
  constructor(id) {
    if (!id) throw new Error('ScraperV2 requiere un id');
    this.id = id;
  }

  /**
   * @param {object} portalEntry
   * @returns {Promise<NormalizedOffer[]>}
   * @abstract
   */
  async fetch(portalEntry) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}: fetch() no implementado`);
  }

  /**
   * Wrapper que agrega date_found y source_portal, y valida el contrato.
   * @param {object} portalEntry
   * @returns {Promise<ScraperResult>}
   */
  async scrape(portalEntry) {
    const start = Date.now();
    const dateFound = new Date().toISOString();
    try {
      const raw = await this.fetch(portalEntry);
      const offers = raw.map(o => ({
        ...o,
        date_found:    o.date_found ?? dateFound,
        source_portal: o.source_portal ?? this.id,
        location:      o.location ?? '',
      }));
      offers.forEach(assertNormalizedOffer);
      return { offers, duration: Date.now() - start, portal: this.id, status: 'ok' };
    } catch (err) {
      return { offers: [], duration: Date.now() - start, portal: this.id, status: 'error', error: err.message };
    }
  }
}
