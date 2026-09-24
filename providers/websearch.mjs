// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

/**
 * WebSearch provider — DuckDuckGo HTML scraper para portales sin API.
 *
 * Maneja entradas de portals.yml con `scan_method: websearch`.
 * Parsea resultados HTML de DuckDuckGo sin API key ni cuenta.
 *
 * Cubre: LinkedIn Jobs, Wellfound, InfoJobs, Bumeran, Empleo Clarín,
 *        y cualquier empresa con `scan_method: websearch` en portals.yml.
 *
 * Limitaciones conocidas:
 *   - DuckDuckGo puede devolver resultados desactualizados (caché de días/semanas)
 *   - Máx ~10 resultados por query sin paginación agresiva
 *   - Para resultados en tiempo real usar providers con API directa (greenhouse, lever, ashby)
 *
 * Rate limiting: 2s de delay entre requests para evitar bloqueos.
 */

const DDG_URL     = 'https://html.duckduckgo.com/html/';
const DELAY_MS    = 2500; // Entre requests
const MAX_RESULTS = 10;   // Resultados máximos por query

/** @type {Provider} */
export default {
  id: 'websearch',

  detect(entry) {
    // Solo activar para entradas con scan_method: websearch explícito
    if (entry.scan_method === 'websearch') return { url: entry.careers_url ?? '' };
    return null;
  },

  async fetch(entry, ctx) {
    const query = entry.scan_query;
    if (!query) {
      console.warn(`  ⚠️  websearch: "${entry.name}" sin scan_query definida — saltando`);
      return [];
    }

    try {
      // DuckDuckGo HTML endpoint (POST con form data)
      const formBody = new URLSearchParams({ q: query, b: '', kl: '' }).toString();
      const html = await ctx.fetchText(DDG_URL, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept':        'text/html',
          'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
        },
        body: formBody,
      });

      const results = parseDdgResults(html, entry.name);

      // Delay para no saturar DDG
      await new Promise(r => setTimeout(r, DELAY_MS));

      return results.slice(0, MAX_RESULTS);

    } catch (err) {
      console.warn(`  ⚠️  websearch "${entry.name}": ${err.message}`);
      return [];
    }
  },
};

// ── Parser de resultados DDG ──────────────────────────────────────────────────

/**
 * Parsea el HTML de DuckDuckGo y extrae URLs y títulos de resultados.
 * Estructura DDG HTML: divs con clase "result__body" > "result__title" > <a class="result__a">
 *
 * @param {string} html
 * @param {string} companyName - nombre de empresa para fallback
 * @returns {Array<{title:string, url:string, company:string, location:string}>}
 */
function parseDdgResults(html, companyName) {
  const results = [];
  const seenUrls = new Set();

  // Regex para extraer bloques de resultado DDG
  // Patrón: <a class="result__a" href="...">Título</a>
  const linkPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    const rawUrl   = match[1];
    const rawTitle = match[2].replace(/<[^>]+>/g, '').trim(); // strip inner HTML tags

    // DDG a veces devuelve URLs relativas de redirección — extraer URL real
    const url = extractRealUrl(rawUrl);
    if (!url || !rawTitle) continue;

    // Filtrar: solo URLs que parecen job postings
    if (!looksLikeJobUrl(url)) continue;
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    results.push({
      title:    decodeHtmlEntities(rawTitle),
      url,
      company:  companyName,
      location: '',         // websearch no provee ubicación directamente
    });
  }

  return results;
}

/**
 * Extrae la URL real de un resultado DDG (que puede venir envuelta en redirect).
 * @param {string} rawUrl
 * @returns {string|null}
 */
function extractRealUrl(rawUrl) {
  if (!rawUrl) return null;

  // DDG HTML: /l/?kh=-1&uddg=https%3A%2F%2F...
  const uddg = rawUrl.match(/[?&]uddg=([^&]+)/);
  if (uddg) {
    try { return decodeURIComponent(uddg[1]); } catch { /* skip */ }
  }

  // URL directa
  if (rawUrl.startsWith('http')) return rawUrl;

  return null;
}

/**
 * Heurística: ¿parece esta URL un job posting?
 * Filtra URLs de DDG que sean páginas de empresa genéricas o de ayuda.
 * @param {string} url
 * @returns {boolean}
 */
function looksLikeJobUrl(url) {
  // Incluir si contiene patrones de job boards
  const jobPatterns = [
    'linkedin.com/jobs', 'greenhouse.io', 'lever.co', 'ashbyhq.com',
    'wellfound.com/jobs', 'wellfound.com/l/', 'getonbrd.com',
    '/careers/', '/jobs/', '/empleo/', '/trabajo/', '/vagas/',
    'bumeran.com', 'zonajobs.com', 'computrabajo.com', 'infojobs',
    'himalayas.app', 'remoteok.com', 'weworkremotely.com',
  ];
  const urlLow = url.toLowerCase();
  return jobPatterns.some(p => urlLow.includes(p));
}

/** Decodifica entidades HTML básicas */
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}
