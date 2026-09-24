// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

/**
 * Workana provider — parsea el feed RSS público de ofertas remotas.
 *
 * RSS endpoint: https://www.workana.com/jobs/feed?category=it-programming&remote=yes&lang=es
 * No requiere autenticación, no tiene rate-limiting agresivo.
 *
 * Auto-detects desde careers_url que contenga `workana.com`.
 * Soporta campo opcional `workana_categories` para sobrescribir categorías.
 */

const DEFAULT_FEEDS = [
  'https://www.workana.com/jobs/feed?category=it-programming&remote=yes&lang=es',
  'https://www.workana.com/jobs/feed?category=it-programming&remote=yes&lang=en',
];

// Palabras clave para filtrar títulos relevantes (pre-LLM)
const RELEVANT_KEYWORDS = [
  'data', 'analyst', 'analytics', 'bi ', 'business intelligence',
  'ai ', 'automation', 'machine learning', 'sql', 'etl', 'tableau',
  'power bi', 'qlik', 'dashboard', 'reporting', 'python', 'automatización',
  'analista', 'datos', 'inteligencia', 'ml ', 'llm', 'automatizaci',
];

/** @type {Provider} */
export default {
  id: 'workana',

  detect(entry) {
    const url = entry.careers_url ?? '';
    if (url.includes('workana.com')) return { url };
    return null;
  },

  async fetch(entry, ctx) {
    const feedUrls = entry.workana_feeds ?? DEFAULT_FEEDS;
    const seenUrls = new Set();
    const allJobs  = [];

    for (let fi = 0; fi < feedUrls.length; fi++) {
      if (fi > 0) await new Promise(r => setTimeout(r, 1000));

      try {
        const xml = await ctx.fetchText(feedUrls[fi], {
          headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
        });

        const items = parseRssItems(xml);

        for (const item of items) {
          if (!item.link || !item.title) continue;
          if (seenUrls.has(item.link)) continue;
          seenUrls.add(item.link);

          // Pre-filtrar por keywords relevantes
          const titleLow = item.title.toLowerCase();
          const relevant = RELEVANT_KEYWORDS.some(kw => titleLow.includes(kw));
          if (!relevant) continue;

          // Extraer empresa del campo <author> o del título si está presente
          const company = item.author
            ?? extractCompanyFromTitle(item.title)
            ?? 'Workana';

          allJobs.push({
            title:    item.title.trim(),
            url:      item.link.trim(),
            company:  company.trim(),
            location: 'Remote',  // Workana remote feed → siempre remoto
          });
        }
      } catch (err) {
        console.warn(`  ⚠️  workana feed ${feedUrls[fi]}: ${err.message}`);
      }
    }

    return allJobs;
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parser RSS mínimo sin dependencias externas.
 * Extrae <item> blocks del XML y retorna objetos con title, link, author.
 * @param {string} xml
 * @returns {Array<{title:string, link:string, author?:string}>}
 */
function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];

  for (const block of itemBlocks) {
    const title  = extractTag(block, 'title');
    const link   = extractTag(block, 'link') || extractTag(block, 'guid');
    const author = extractTag(block, 'dc:creator') || extractTag(block, 'author');

    if (title && link) {
      items.push({ title: cleanCdata(title), link: cleanCdata(link), author: author ? cleanCdata(author) : undefined });
    }
  }

  return items;
}

/** Extrae el contenido de un tag XML simple o con CDATA */
function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1].trim() : null;
}

/** Limpia envoltura CDATA: <![CDATA[ ... ]]> */
function cleanCdata(str) {
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').trim();
}

/** Intenta extraer el nombre de empresa si el título contiene " at Company" o "@ Company" */
function extractCompanyFromTitle(title) {
  const atMatch = title.match(/ (?:at|@|en|para) (.+?)(?:\s*[-–|]|$)/i);
  return atMatch ? atMatch[1].trim() : null;
}
