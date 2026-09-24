// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

/**
 * Torre.co provider — hits the public job search API.
 *
 * API endpoint: POST https://torre.ai/api/opportunities/_search
 * Supports: keyword search, remote filter, pagination
 *
 * Auto-detects from careers_url pattern `torre.ai` OR explicit `provider: torre`.
 * Supports optional `torre_query` field to override default keyword.
 */

const SEARCH_URL = 'https://torre.ai/api/opportunities/_search';
const PAGE_SIZE  = 20;
const MAX_PAGES  = 3; // Cap a 60 resultados por búsqueda

const DEFAULT_QUERIES = [
  'data analyst',
  'business intelligence',
  'AI automation',
];

/** @type {Provider} */
export default {
  id: 'torre',

  detect(entry) {
    const url = entry.careers_url ?? '';
    if (url.includes('torre.ai') || url.includes('torre.co')) return { url };
    return null;
  },

  async fetch(entry, ctx) {
    const queries = entry.torre_queries ?? DEFAULT_QUERIES;
    const seenUrls = new Set();
    const allJobs  = [];

    for (let qi = 0; qi < queries.length; qi++) {
      const keyword = queries[qi];

      // Delay entre queries para no saturar la API
      if (qi > 0) await new Promise(r => setTimeout(r, 1500));

      for (let page = 0; page < MAX_PAGES; page++) {
        try {
          const body = JSON.stringify({
            q:      keyword,
            remote: true,
            offset: page * PAGE_SIZE,
            size:   PAGE_SIZE,
          });

          const json = await ctx.fetchJson(SEARCH_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          });

          const results = Array.isArray(json?.results) ? json.results : [];
          if (results.length === 0) break; // no más páginas

          for (const item of results) {
            // Torre devuelve "opportunity" objects
            const opportunity = item.opportunity ?? item;
            const id    = opportunity.id ?? opportunity.publicId;
            const title = opportunity.objective ?? opportunity.title ?? '';
            if (!title || !id) continue;

            const url = `https://torre.ai/opportunities/${id}`;
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);

            // Ubicación: preferir remoto si aplica
            const remote = opportunity.remote === true || opportunity.remote === 'yes';
            const loc    = remote
              ? 'Remote'
              : (opportunity.locationName ?? opportunity.location ?? '');

            // Empresa: puede estar anidada
            const org = opportunity.organizations?.[0]?.name
              ?? opportunity.organizations?.[0]
              ?? entry.name;

            allJobs.push({
              title,
              url,
              company:  typeof org === 'string' ? org : (org?.name ?? entry.name),
              location: loc,
            });
          }

          // Si devolvió menos de PAGE_SIZE, no hay más páginas
          if (results.length < PAGE_SIZE) break;

          // Delay entre páginas
          if (page < MAX_PAGES - 1) await new Promise(r => setTimeout(r, 800));

        } catch (err) {
          // Loggear el error de página pero continuar con la siguiente query
          console.warn(`  ⚠️  torre query "${keyword}" p${page}: ${err.message}`);
          break;
        }
      }
    }

    return allJobs;
  },
};
