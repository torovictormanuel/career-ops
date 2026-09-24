#!/usr/bin/env node
/**
 * scan-boards.mjs — LATAM job board scanner pack
 *
 * Extiende scan.mjs con portales públicos: LinkedIn, Computrabajo, ZonaJobs.
 * Escribe al mismo data/pipeline.md y data/scan-history.tsv.
 * Cada board corre en su propio try/catch — si uno falla los otros siguen.
 *
 * Zero Claude tokens — fetch HTTP + Playwright solo para ZonaJobs.
 *
 * Uso:
 *   node scan-boards.mjs                      # escanea todos los boards
 *   node scan-boards.mjs --dry-run            # preview sin escribir
 *   node scan-boards.mjs --board linkedin
 *   node scan-boards.mjs --board computrabajo
 *   node scan-boards.mjs --board zonajobs
 *
 * Vars requeridas en .env:
 *   ZONAJOBS_EMAIL, ZONAJOBS_PASS   (Computrabajo no requiere login)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = __dirname;

// ── Load .env (mismo patrón que whatsapp-bot.mjs) ───────────────────────────
const envPath = join(BASE, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

// ── Paths (compartidos con scan.mjs) ────────────────────────────────────────
const PORTALS_PATH      = join(BASE, 'portals.yml');
const SCAN_HISTORY_PATH = join(BASE, 'data', 'scan-history.tsv');
const PIPELINE_PATH     = join(BASE, 'data', 'pipeline.md');
const APPLICATIONS_PATH = join(BASE, 'data', 'applications.md');

mkdirSync(join(BASE, 'data'), { recursive: true });

// ── Credenciales ─────────────────────────────────────────────────────────────
const ZJ_EMAIL = process.env.ZONAJOBS_EMAIL;
const ZJ_PASS  = process.env.ZONAJOBS_PASS;

// ── Keywords de búsqueda ─────────────────────────────────────────────────────
const KW_EN = [
  'data analyst',
  'bi analyst',
  'analytics engineer',
  'data engineer',
  'business intelligence',
  'power bi',
  'ai agent',
  'automation engineer',
];

const KW_ES = [
  'analista de datos',
  'analista bi',
  'analista de negocios',
  'inteligencia de negocios',
  'automatizacion',
];

const FETCH_TIMEOUT_MS = 20_000;
const DELAY_MS = 1500;

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Title filter (misma lógica que scan.mjs) ─────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map((k) => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map((k) => k.toLowerCase());
  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some((k) => lower.includes(k));
    const hasNegative = negative.some((k) => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup (misma lógica que scan.mjs) ────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  if (existsSync(SCAN_HISTORY_PATH)) {
    for (const line of readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(url.trim());
    }
  }

  if (existsSync(PIPELINE_PATH)) {
    for (const m of readFileSync(PIPELINE_PATH, 'utf-8').matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(m[1]);
    }
  }

  if (existsSync(APPLICATIONS_PATH)) {
    for (const m of readFileSync(APPLICATIONS_PATH, 'utf-8').matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(m[0]);
    }
  }

  return seen;
}

// ── Pipeline writer (misma lógica que scan.mjs) ──────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf-8') : '';
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);

  if (idx === -1) {
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block =
      `\n${marker}\n\n` +
      offers.map((o) => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n') +
      '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    const block =
      '\n' +
      offers.map((o) => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n') +
      '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }
  const lines =
    offers.map((o) => `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── LinkedIn — API pública guest (sin login) ─────────────────────────────────

async function scanLinkedIn(titleFilter, seenUrls) {
  const found = [];
  const keywords = [...KW_EN, ...KW_ES];

  // Dos pasadas: Argentina (todos los modos) + LATAM remoto
  const searches = [
    { location: 'Argentina', extra: '' },
    { location: 'Latin+America', extra: '&f_WT=2' },
  ];

  for (const { location, extra } of searches) {
    for (const kw of keywords) {
      const url =
        `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search` +
        `?keywords=${encodeURIComponent(kw)}&location=${location}&start=0&count=25${extra}`;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
          },
        });
        clearTimeout(timer);

        if (!res.ok) {
          console.warn(`  LinkedIn [${kw}/${location}]: HTTP ${res.status}`);
          await sleep(DELAY_MS);
          continue;
        }

        const html = await res.text();

        const ids = [...html.matchAll(/data-entity-urn="urn:li:jobPosting:(\d+)"/g)].map((m) => m[1]);
        const titles = [
          ...html.matchAll(/class="[^"]*base-search-card__title[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/h3>/g),
        ].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
        const companies = [
          ...html.matchAll(
            /class="[^"]*base-search-card__subtitle[^"]*"[^>]*>[\s\S]*?<a[^>]*>\s*([\s\S]*?)\s*<\/a>/g
          ),
        ].map((m) => m[1].replace(/<[^>]+>/g, '').trim());

        for (let i = 0; i < ids.length; i++) {
          const jobUrl = `https://www.linkedin.com/jobs/view/${ids[i]}`;
          const title = titles[i] || 'LinkedIn Job';
          const company = companies[i] || 'Desconocida';

          if (seenUrls.has(jobUrl)) continue;
          if (!titleFilter(title)) continue;

          seenUrls.add(jobUrl);
          found.push({ url: jobUrl, title, company, source: 'linkedin' });
        }
      } catch (err) {
        console.warn(`  LinkedIn [${kw}]: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
      }

      await sleep(DELAY_MS);
    }
  }

  return found;
}

// ── Computrabajo — fetch puro, sin login ni Playwright ───────────────────────
// Usa /trabajo-de-{slug}: URL pública con HTML server-rendered (sin bot-block).
// El bloqueo anti-bot afecta solo a /trabajos/?q= y al login.

function kwToSlug(kw) {
  return kw.trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/\s+/g, '-');
}

async function scanComputrabajo(titleFilter, seenUrls) {
  const found = [];
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'es-AR,es;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
  };

  for (const kw of [...KW_EN, ...KW_ES]) {
    const slug = kwToSlug(kw);
    const url = `https://ar.computrabajo.com/trabajo-de-${slug}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        console.warn(`  Computrabajo ["${kw}"]: HTTP ${res.status}`);
        await sleep(DELAY_MS);
        continue;
      }

      const html = await res.text();

      // Parsear cada <article class="box_offer...">
      for (const m of html.matchAll(/<article[^>]*class="box_offer[^"]*"[^>]*>([\s\S]*?)<\/article>/g)) {
        const art = m[0];

        // Título + URL relativa de <a class="js-o-link fc_base" href="...">
        const linkMatch = art.match(/class="js-o-link[^"]*"\s+href="([^"#]+)[^"]*"[^>]*>\s*([^<]+)/);
        if (!linkMatch) continue;

        const title = linkMatch[2].replace(/&#x[0-9A-Fa-f]+;/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
        const jobUrl = `https://ar.computrabajo.com${linkMatch[1]}`;

        // Empresa: primer <p class="...fc_base..."> después del h2
        const companyMatch = art.match(/<p class="[^"]*fc_base[^"]*"[^>]*>\s*([^<]+)\s*<\/p>/);
        const company = companyMatch ? companyMatch[1].trim() : 'Computrabajo';

        if (!title || seenUrls.has(jobUrl)) continue;
        if (!titleFilter(title)) continue;
        seenUrls.add(jobUrl);
        found.push({ url: jobUrl, title, company, source: 'computrabajo' });
      }
    } catch (err) {
      console.warn(`  Computrabajo ["${kw}"]: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
    }

    await sleep(DELAY_MS);
  }

  return found;
}

// ── ZonaJobs — Playwright + login ────────────────────────────────────────────

async function scanZonaJobs(browser, titleFilter, seenUrls) {
  const found = [];
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'es-AR',
  });
  const page = await context.newPage();

  try {
    // Login en /login (URL real del formulario React)
    await page.goto('https://www.zonajobs.com.ar/login', {
      timeout: 30_000,
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('input[name="user"]', { timeout: 15_000 });
    await page.fill('input[name="user"]', ZJ_EMAIL);
    await page.fill('input[name="password"]', ZJ_PASS);
    await page.click('#form-signin button[type="submit"]');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    console.log('  ZonaJobs: sesión iniciada');

    for (const kw of [...KW_EN, ...KW_ES]) {
      const searchUrl = `https://www.zonajobs.com.ar/empleos.html?q=${encodeURIComponent(kw)}`;

      try {
        await page.goto(searchUrl, { timeout: 30_000, waitUntil: 'networkidle' });
        await sleep(2000); // esperar render de React

        const jobs = await page.evaluate(() => {
          const results = [];
          // ZonaJobs: job detail links siguen el patrón /empleos/{slug}-{id}.html
          const links = document.querySelectorAll('a[href*="/empleos/"]');
          for (const link of links) {
            const href = link.href || '';
            if (!href || !href.match(/\/empleos\/[^.]+\.html/)) continue;

            // El texto del link incluye "Publicado hace X días{Título}{Empresa}..."
            // Buscamos el elemento interno que tenga solo el título del puesto
            const allText = link.textContent?.trim() || '';

            // Intentar encontrar un heading o span dentro del link
            const heading = link.querySelector('h2, h3, [class*="title"], [class*="titulo"], [class*="Title"]');
            let title = heading?.textContent?.trim() || '';

            if (!title) {
              // Fallback: limpiar el texto del link (quitar fecha y empresa)
              title = allText
                .replace(/^(Publicado|Actualizado)[^a-záéíóúA-Z]+(hace \d+ días?|ayer|hace \d+ horas?)\s*/i, '')
                .split('\n')[0]
                .trim()
                .slice(0, 100);
            }

            if (!title || title.length < 3) continue;

            // Empresa: buscar texto corto en elemento hermano
            const card = link.closest('li, article, [class*="card"], [class*="aviso"]');
            const companyEl = card?.querySelector('[class*="empresa"], [class*="company"], [class*="razon"]');
            const company = companyEl?.textContent?.trim() || 'ZonaJobs';

            results.push({ title, url: href.split('?')[0], company });
          }
          return results;
        });

        for (const job of jobs) {
          if (seenUrls.has(job.url)) continue;
          if (!titleFilter(job.title)) continue;
          seenUrls.add(job.url);
          found.push({ ...job, source: 'zonajobs' });
        }
      } catch (err) {
        console.warn(`  ZonaJobs ["${kw}"]: ${err.message}`);
      }

      await sleep(DELAY_MS);
    }
  } finally {
    await context.close();
  }

  return found;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const boardIdx = args.indexOf('--board');
  const onlyBoard = boardIdx !== -1 ? args[boardIdx + 1]?.toLowerCase() : null;

  const today = new Date().toISOString().split('T')[0];

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` career-ops Board Scanner  ${today}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (dryRun) console.log('(dry run — no se escriben archivos)\n');

  const config = existsSync(PORTALS_PATH)
    ? yaml.load(readFileSync(PORTALS_PATH, 'utf-8'))
    : {};
  const titleFilter = buildTitleFilter(config.title_filter);
  const seenUrls = loadSeenUrls();

  const results = { linkedin: [], computrabajo: [], zonajobs: [] };
  const errors = [];

  // ── LinkedIn (fetch puro) ──
  if (!onlyBoard || onlyBoard === 'linkedin') {
    console.log('▶ LinkedIn (público)...');
    try {
      results.linkedin = await scanLinkedIn(titleFilter, seenUrls);
      console.log(`  ✓ ${results.linkedin.length} nueva(s)`);
    } catch (err) {
      errors.push({ board: 'LinkedIn', error: err.message });
      console.error(`  ✗ LinkedIn: ${err.message}`);
    }
  }

  // ── Computrabajo (fetch puro, sin Playwright) ──
  if (!onlyBoard || onlyBoard === 'computrabajo') {
    console.log('▶ Computrabajo (público)...');
    try {
      results.computrabajo = await scanComputrabajo(titleFilter, seenUrls);
      console.log(`  ✓ ${results.computrabajo.length} nueva(s)`);
    } catch (err) {
      errors.push({ board: 'Computrabajo', error: err.message });
      console.error(`  ✗ Computrabajo: ${err.message}`);
    }
  }

  // ── ZonaJobs (Playwright + login) ──
  const wantZJ = !onlyBoard || onlyBoard === 'zonajobs';
  if (wantZJ) {
    if (ZJ_EMAIL) {
      console.log('▶ ZonaJobs...');
      let browser;
      try {
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: true });
        results.zonajobs = await scanZonaJobs(browser, titleFilter, seenUrls);
        console.log(`  ✓ ${results.zonajobs.length} nueva(s)`);
      } catch (err) {
        errors.push({ board: 'ZonaJobs', error: err.message });
        console.error(`  ✗ ZonaJobs: ${err.message}`);
      } finally {
        await browser?.close();
      }
    } else {
      console.log('▶ ZonaJobs: omitido — ZONAJOBS_EMAIL no está en .env');
    }
  }

  // ── Resumen ──
  const allNew = [...results.linkedin, ...results.computrabajo, ...results.zonajobs];

  console.log('\n─────────────────────────────────────────');
  console.log(`LinkedIn:     ${results.linkedin.length}`);
  console.log(`Computrabajo: ${results.computrabajo.length}`);
  console.log(`ZonaJobs:     ${results.zonajobs.length}`);
  console.log('─────────────────────────────────────────');
  console.log(`New offers added: ${allNew.length}`);

  if (errors.length) {
    console.log('\nErrores por plataforma:');
    for (const e of errors) console.error(`  ✗ ${e.board}: ${e.error}`);
  }

  if (dryRun) {
    if (allNew.length) {
      console.log('\nPreview (no se escribe nada):');
      for (const o of allNew) console.log(`  [${o.source}] ${o.company} | ${o.title}`);
    }
    return;
  }

  if (allNew.length) {
    appendToPipeline(allNew);
    appendToScanHistory(allNew, today);
  }
}

main().catch((err) => {
  console.error('Error fatal en scan-boards:', err.message);
  process.exit(1);
});
