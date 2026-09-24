// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

/**
 * GetOnBoard provider — hits the public v0 API.
 * Fetches job listings from data-science-analytics and machine-learning-ai categories.
 *
 * Auto-detects from careers_url pattern `getonbrd.com` OR via explicit `provider: getonboard`.
 * Supports optional `gob_categories` field to override default categories.
 *
 * API: https://www.getonbrd.com/api/v0/categories/{cat}/jobs?per_page=100
 * Company: https://www.getonbrd.com/api/v0/companies/{id}
 */

const BASE_URL = 'https://www.getonbrd.com/api/v0';

// Categories to pull from GetOnBoard. These map directly to their API category slugs.
const DEFAULT_CATEGORIES = ['data-science-analytics', 'machine-learning-ai'];

// Broad pre-filter before making company API calls (reduces extra requests)
const PRE_FILTER_KEYWORDS = [
  'data analyst', 'bi analyst', 'analytics', 'data engineer', 'ai ',
  'automation', 'business intelligence', 'analista', 'datos', 'inteligencia',
  'machine learning', 'reporting', 'dashboard', 'insights', 'sql', 'etl',
  'power bi', 'tableau', 'qlik', 'warehouse', 'pipeline', 'mlops', 'llm',
];

/** @type {Provider} */
export default {
  id: 'getonboard',

  detect(entry) {
    const url = entry.careers_url ?? '';
    if (url.includes('getonbrd.com')) return { url };
    return null;
  },

  async fetch(entry, ctx) {
    const categories = entry.gob_categories ?? DEFAULT_CATEGORIES;
    const companyCache = new Map();
    const allJobs = [];

    async function getCompanyName(companyId) {
      if (companyCache.has(companyId)) return companyCache.get(companyId);
      try {
        const data = await ctx.fetchJson(`${BASE_URL}/companies/${companyId}`);
        const name = data?.data?.attributes?.name ?? 'GetOnBoard';
        companyCache.set(companyId, name);
        return name;
      } catch {
        companyCache.set(companyId, 'GetOnBoard');
        return 'GetOnBoard';
      }
    }

    for (let ci = 0; ci < categories.length; ci++) {
      const category = categories[ci];

      // Small delay between categories to avoid rate-limiting (429)
      if (ci > 0) await new Promise(r => setTimeout(r, 2000));

      try {
        // Fetch jobs — cap at 2 pages (200 jobs) per category to avoid runaway
        let page = 1;
        let totalPages = 1;

        while (page <= totalPages) {
          // Retry once on 429 with a longer back-off
          let data;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              data = await ctx.fetchJson(
                `${BASE_URL}/categories/${category}/jobs?per_page=100&page=${page}`
              );
              break; // success
            } catch (err) {
              if (attempt === 0 && err.message.includes('429')) {
                // Back off 5 s and retry once
                await new Promise(r => setTimeout(r, 5000));
                continue;
              }
              throw err; // re-throw on second failure or non-429 error
            }
          }

          const jobs = Array.isArray(data?.data) ? data.data : [];
          totalPages = Math.min(data?.meta?.total_pages ?? 1, 2);

          for (const job of jobs) {
            const title = job.attributes?.title ?? '';
            const url = job.links?.public_url ?? '';
            if (!title || !url) continue;

            // Pre-filter: only resolve company for relevant titles (reduces API calls)
            const titleLow = title.toLowerCase();
            const relevant = PRE_FILTER_KEYWORDS.some(kw => titleLow.includes(kw));
            if (!relevant) continue;

            // Resolve company name (cached)
            const companyId = job.attributes?.company?.data?.id;
            const company = companyId ? await getCompanyName(companyId) : 'GetOnBoard';

            // Build location string
            const countries = Array.isArray(job.attributes?.countries) ? job.attributes.countries : [];
            const modality = job.attributes?.remote_modality ?? '';
            const location = countries.length > 0
              ? countries.join(', ')
              : (modality === 'remote_local' ? 'Remote' : '');

            allJobs.push({ title, url, company, location });
          }

          page++;
          if (page <= totalPages) await new Promise(r => setTimeout(r, 500)); // small page delay
        }
      } catch (err) {
        // Log the category error but continue scanning remaining categories
        console.error(`  ⚠️  getonboard category "${category}": ${err.message}`);
      }
    }

    return allJobs;
  },
};
