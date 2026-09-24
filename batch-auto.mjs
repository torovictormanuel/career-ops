#!/usr/bin/env node
/**
 * batch-auto.mjs — Automated batch evaluator for career-ops (Windows)
 *
 * Uses the `claude` CLI (Claude Code) already authenticated on this machine.
 * No separate API key required.
 *
 * Usage:  node batch-auto.mjs
 * Env:    BATCH_MAX          (default 10)
 *         BATCH_MIN_SCORE    (default 3.5)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env file manually (no extra dependency)
const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();  // .env always wins over inherited env
  }
}
import { execSync, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE      = __dirname;

// ── Config ────────────────────────────────────────────────────────────────────
const MAX_PER_BATCH = parseInt(process.env.BATCH_MAX        ?? '10');
const MIN_SCORE     = parseFloat(process.env.BATCH_MIN_SCORE ?? '3.5');

// Target role keywords aligned with Victor's profile (Data Analyst / BI / AI Automation)
// Deliberately excludes "data scientist" — those roles score low and waste evaluations
const TARGET_KEYWORDS = [
  'data analyst', 'bi analyst', 'business intelligence', 'analytics engineer',
  'ai automation', 'automation analyst', 'reporting analyst',
  'insights analyst', 'data visualization', 'power bi', 'qlik',
  'bi developer', 'bi engineer', 'etl', 'dashboard', 'analista de datos',
  'analista bi', 'automatización', 'automatizacion', 'data warehouse',
  'analytics', 'applied ai', 'ai analyst', 'ai solutions', 'product analyst',
  'revenue operations', 'revops', 'data platform', 'data product',
  // Spanish variants that split across words (e.g. "Analista Senior BI")
  'senior bi', 'analista datos', 'ciencia de datos', 'inteligencia de negocios',
  'analista de automatizacion', 'analista de automatización',
];

// ── Pipeline reader ───────────────────────────────────────────────────────────
function readPipeline() {
  const content = readFileSync(join(BASE, 'data', 'pipeline.md'), 'utf8').replace(/\r/g, '');
  const lines   = content.split('\n');
  const items   = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- \[ \] (https?:\/\/[^\s|]+)(?:\s*\|\s*([^|]+?))?(?:\s*\|\s*(.+?))?$/);
    if (m) items.push({ lineIndex: i, url: m[1].trim(), company: m[2]?.trim() ?? '', title: m[3]?.trim() ?? '' });
  }
  return { lines, items };
}

function markProcessed(pipelineLines, idx, score, rec) {
  pipelineLines[idx] = pipelineLines[idx].replace('- [ ]', `- [x] [${score}/5 ${rec}]`);
}

// ── JD fetcher — chain: LinkedIn → Ashby → Lever → Greenhouse → HTML ─────────
async function fetchJD(url) {
  // ── LinkedIn guest posting API ──────────────────────────────────────────────
  if (url.includes('linkedin.com/jobs/view/')) {
    const jobId = url.match(/\/jobs\/view\/(\d+)/)?.[1];
    if (jobId) {
      try {
        const res = await fetch(
          `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`,
          { headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
          }}
        );
        if (res.ok) {
          const html = await res.text();
          const titleMatch   = html.match(/<h2[^>]*class="[^"]*top-card-layout__title[^"]*"[^>]*>([^<]+)<\/h2>/);
          const companyMatch = html.match(/<a[^>]*class="[^"]*topcard__org-name-link[^"]*"[^>]*>([^<]+)<\/a>/);
          const content = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 6000);
          if (content.length > 100) {
            return { title: titleMatch?.[1]?.trim() ?? '', company: companyMatch?.[1]?.trim() ?? '', location: '', content, url };
          }
        }
      } catch { /* fall through to HTML */ }
    }
    // fall through to HTML fallback
  }

  // ── Ashby — fetch board listing and find job by ID (descriptionHtml is in list)
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([a-f0-9-]{36})/i);
  if (ashbyMatch) {
    const [, board, jobId] = ashbyMatch;
    try {
      const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${board}`,
        { headers: { 'User-Agent': 'career-ops-batch/1.0' } });
      if (res.ok) {
        const d = await res.json();
        const job = (d.jobs ?? []).find(j => j.id === jobId || (j.jobUrl ?? '').includes(jobId));
        if (job) {
          const content = (job.descriptionHtml ?? job.descriptionPlain ?? '')
            .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
          if (content.length > 50) {
            return { title: job.title ?? '', company: board, location: job.location ?? '', content, url };
          }
        }
      }
    } catch { /* fall through to HTML */ }
    // fall through to HTML fallback
  }

  // ── Lever posting API ───────────────────────────────────────────────────────
  if (url.includes('lever.co')) {
    const m = url.match(/lever\.co\/([^/]+)\/([a-f0-9-]{36})/i);
    if (m) {
      const [, company, id] = m;
      try {
        const res = await fetch(`https://api.lever.co/v0/postings/${company}/${id}?mode=json`,
          { headers: { 'User-Agent': 'career-ops-batch/1.0' } });
        if (res.ok) {
          const d = await res.json();
          const text = [d.descriptionBody ?? '', ...(d.lists ?? []).map(l => l.content)].join(' ');
          return {
            title   : d.text ?? '',
            company,
            location: d.categories?.location ?? d.categories?.commitment ?? '',
            content : text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000),
            url,
          };
        }
      } catch { /* fall through to HTML */ }
    }
    // fall through to HTML fallback
  }

  // ── Greenhouse posting API ──────────────────────────────────────────────────
  const ghJid = url.match(/[?&]gh_jid=(\d+)/)?.[1];
  let ghCompany, ghJobId;
  const ghPath  = url.match(/greenhouse\.io\/([^/?]+)\/jobs\/(\d+)/);
  const ghQuery = url.match(/greenhouse\.io\/([^/?]+)\/jobs\?.*?gh_jid=(\d+)/);
  if (ghPath)       { ghCompany = ghPath[1];  ghJobId = ghPath[2]; }
  else if (ghQuery) { ghCompany = ghQuery[1]; ghJobId = ghQuery[2]; }
  else if (ghJid) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
      ghCompany = host; ghJobId = ghJid;
    } catch { /* ignore */ }
  }

  if (ghCompany && ghJobId) {
    try {
      const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${ghCompany}/jobs/${ghJobId}`,
        { headers: { 'User-Agent': 'career-ops-batch/1.0' } });
      if (res.ok) {
        const data = await res.json();
        return {
          title   : data.title ?? '',
          company : ghCompany,
          location: data.location?.name ?? '',
          content : (data.content ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000),
          url,
        };
      }
    } catch { /* fall through to HTML */ }
  }

  // ── HTML fallback — universal last resort for any job board ────────────────
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal : controller.signal,
      headers: {
        'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();

    // Extract Next.js SSR data first (Ashby, BambooHR, Greenhouse custom pages, etc.)
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextDataMatch) {
      try {
        const nd = JSON.parse(nextDataMatch[1]);
        const pp = nd?.props?.pageProps;
        const job = pp?.job ?? pp?.posting ?? pp?.jobPosting;
        if (job) {
          const raw = job.descriptionHtml ?? job.description ?? job.content ?? '';
          const content = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
          if (content.length > 50) {
            return { title: job.title ?? '', company: '', location: job.locationName ?? job.location ?? '', content, url };
          }
        }
      } catch { /* ignore, continue with plain HTML */ }
    }

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
    const content = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000);

    if (content.length > 100) return { title, company: '', location: '', content, url };
  } catch { /* silent */ }

  return null;
}

// ── Context ───────────────────────────────────────────────────────────────────
function readContext() {
  const r = (p) => existsSync(join(BASE, p)) ? readFileSync(join(BASE, p), 'utf8').slice(0, 4000) : '';
  return { cv: r('cv.md'), profile: r('config/profile.yml') };
}

// ── Report numbering ──────────────────────────────────────────────────────────
function getNextReportNum() {
  const dir = join(BASE, 'reports');
  if (!existsSync(dir)) { mkdirSync(dir); return 1; }
  const nums = readdirSync(dir).map(f => parseInt(f.match(/^(\d+)-/)?.[1] ?? '0')).filter(n => n > 0);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

// ── Build evaluation prompt ───────────────────────────────────────────────────
function buildPrompt(jd, ctx) {
  return `You are evaluating a job offer for a candidate. Read the candidate profile and job description, then produce a concise evaluation.

## Candidate Profile
\`\`\`yaml
${ctx.profile}
\`\`\`

## Candidate CV
${ctx.cv}

## Job to Evaluate
URL: ${jd.url}
Company: ${jd.company}
Role: ${jd.title}
Location: ${jd.location}

### Job Description
${jd.content}

---

## Your Output (follow this format exactly)

### A) Role Summary
One-line TL;DR. Archetype (Data Analyst / BI / AI Automation / Analytics Engineer / other). Seniority. Remote policy.

### B) Match Analysis
List the top 3 requirements from the JD and whether the candidate meets them (cite CV lines). List up to 2 gaps.

### C) Score
| Dimension | Score |
|-----------|-------|
| Role match | X/5 |
| Seniority | X/5 |
| Remote / location | X/5 |
| Comp alignment | X/5 |
| **Global** | **X.X/5** |

### D) Recommendation
APPLY or SKIP — one direct sentence of reasoning.

---

End your response with this JSON block (no extra text after it):
\`\`\`json
{"status":"completed","score":<number>,"recommendation":"APPLY or SKIP","company":"<name>","role":"<title>","one_liner":"<one sentence>"}
\`\`\``;
}

// ── Run claude CLI ────────────────────────────────────────────────────────────
function runClaude(prompt) {
  // Pass prompt via stdin using Node.js `input` option — no shell, no arg limits,
  // no path-with-spaces issues. `claude --print` reads the prompt from stdin
  // when no argument is provided.
  const result = spawnSync('claude', ['--print'], {
    input    : prompt,
    cwd      : BASE,
    encoding : 'utf8',
    shell    : true,            // Required on Windows: claude is a .cmd file
    timeout  : 180000,          // 3 min per offer
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.status !== 0 || result.error) {
    throw new Error(result.stderr?.trim() || result.error?.message || `claude exited ${result.status}`);
  }
  return result.stdout ?? '';
}

// ── Parse output ──────────────────────────────────────────────────────────────
function parseResult(output, fallbackCompany, fallbackRole) {
  const m = output.match(/```json\s*([\s\S]*?)\s*```\s*$/);
  if (m) {
    try { return JSON.parse(m[1]); } catch {}
  }
  // Fallback: extract score from text
  const sm = output.match(/\*\*Global\*\*[^|]*\|\s*\*\*([0-9.]+)/);
  const score = sm ? parseFloat(sm[1]) : null;
  return { status: 'completed', score, recommendation: (score ?? 0) >= 4 ? 'APPLY' : 'SKIP',
           company: fallbackCompany, role: fallbackRole, one_liner: '' };
}

// ── Writers ───────────────────────────────────────────────────────────────────
function writeReport(num, company, date, content) {
  const dir  = join(BASE, 'reports');
  if (!existsSync(dir)) mkdirSync(dir);
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const file = `${String(num).padStart(3,'0')}-${slug}-${date}.md`;
  writeFileSync(join(dir, file), content, 'utf8');
  return file;
}

function writeTrackerTSV(num, date, company, role, score, reportLink) {
  const dir = join(BASE, 'batch', 'tracker-additions');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const file = `${String(num).padStart(3,'0')}-${slug}.tsv`;
  const row  = [num, date, company, role, 'Evaluated', `${score}/5`, '❌', reportLink, 'Batch auto-eval'].join('\t');
  writeFileSync(join(dir, file), row + '\n', 'utf8');
}

// ── Notify WhatsApp when no qualifying offers found ───────────────────────────
async function notifyNone(evaluated, total) {
  const botUrl = `http://127.0.0.1:${process.env.WA_BOT_PORT ?? '3099'}/notify-status`;
  const msg = evaluated === 0
    ? `📭 *Career-Ops*: Scan completado — ninguna oferta matcheó keywords de perfil (${total} revisadas).`
    : `📭 *Career-Ops*: ${evaluated} ofertas evaluadas, ninguna superó el score mínimo de ${process.env.BATCH_MIN_SCORE ?? '3.5'}/5.`;
  try {
    await fetch(botUrl, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ message: msg }),
      signal : AbortSignal.timeout(5000),
    });
  } catch { /* bot not running — skip silently */ }
}

// ── Notify via WhatsApp bot (or fallback to Windows balloon) ─────────────────
async function notifyOffers(applyList) {
  const botUrl = `http://127.0.0.1:${process.env.WA_BOT_PORT ?? '3099'}/notify`;
  try {
    const res = await fetch(botUrl, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ offers: applyList }),
      signal : AbortSignal.timeout(5000),
    });
    if (res.ok) {
      console.log(`📱 ${applyList.length} oferta(s) enviadas a WhatsApp`);
      return;
    }
  } catch {
    // WhatsApp bot not running — fallback to Windows balloon
    console.log('WhatsApp bot no disponible — usando notificación Windows');
  }

  // Fallback: Windows balloon
  if (applyList.length > 0) {
    const top = applyList.slice(0,3).map(r => `${r.company} (${r.score}/5)`).join(', ');
    const title = `Career-Ops: ${applyList.length} oferta(s) para revisar`;
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(10000,'${title.replace(/'/g,"''")}','${top.replace(/'/g,"''")}','Info'); Start-Sleep 11; $n.Dispose()`;
    spawnSync('powershell', ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 15000 });

    // Guardar ofertas en disco para que no se pierdan si WA está caído
    const pendingPath = join(BASE, 'data', 'pending-notifications.json');
    try {
      const existing = existsSync(pendingPath) ? JSON.parse(readFileSync(pendingPath, 'utf8')) : [];
      const timestamped = applyList.map(o => ({ ...o, queued_at: new Date().toISOString() }));
      writeFileSync(pendingPath, JSON.stringify([...existing, ...timestamped], null, 2), 'utf8');
      console.log(`💾 ${applyList.length} oferta(s) guardadas en data/pending-notifications.json`);
    } catch { /* non-fatal */ }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const today = new Date().toISOString().split('T')[0];
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(` career-ops Batch Auto-Evaluator  ${today}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Max: ${MAX_PER_BATCH} | Notify threshold: ≥${MIN_SCORE}\n`);

  const { lines: pipelineLines, items: pending } = readPipeline();
  console.log(`Pipeline: ${pending.length} unchecked items`);

  // Normalize mojibake (latin-1 chars read as UTF-8) so "AutomatizaciÃ³n" → "automatizacion"
  function normalizeText(s) {
    return s.toLowerCase()
      .replace(/ã³/g, 'o').replace(/ã¡/g, 'a').replace(/ã©/g, 'e')
      .replace(/ã­/g, 'i').replace(/ãº/g, 'u').replace(/ã±/g, 'n')
      .replace(/ã¼/g, 'u').replace(/â€"/g, '-').replace(/ã/g, 'a');
  }

  const filtered = pending.filter(({ title, company }) => {
    const text = normalizeText(title + ' ' + company);
    return TARGET_KEYWORDS.some(kw => text.includes(kw));
  });
  console.log(`After role filter: ${filtered.length} target matches`);

  const toEvaluate = filtered.slice(0, MAX_PER_BATCH);
  if (!toEvaluate.length) { console.log('Nothing to evaluate — done.\n'); return; }
  console.log(`Evaluating: ${toEvaluate.length} offers\n`);

  const ctx     = readContext();
  const results = [];
  let   counter = getNextReportNum();

  for (let i = 0; i < toEvaluate.length; i++) {
    const item = toEvaluate[i];
    const num  = counter + i;
    process.stdout.write(`[${i+1}/${toEvaluate.length}] ${item.company} | ${item.title} ... `);

    try {
      const jd = await fetchJD(item.url);
      if (!jd?.content) { console.log('⚠️  JD unavailable — skipped'); results.push({ status: 'skipped' }); continue; }

      const prompt = buildPrompt(jd, ctx);
      const output = runClaude(prompt);
      const result = parseResult(output, jd.company, jd.title);

      const reportFile = writeReport(num, result.company, today, output);
      const reportLink = `[${String(num).padStart(3,'0')}](reports/${reportFile})`;
      writeTrackerTSV(num, today, result.company, result.role, result.score ?? 'N/A', reportLink);
      markProcessed(pipelineLines, item.lineIndex, result.score ?? '?', result.recommendation);

      console.log(`${result.recommendation === 'APPLY' ? '✅' : '⏭️ '} ${result.score}/5 — ${result.recommendation}`);
      results.push(result);

      if (i < toEvaluate.length - 1) await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      console.log(`❌ ${err.message}`);
      results.push({ status: 'failed' });
    }
  }

  // Save pipeline
  writeFileSync(join(BASE, 'data', 'pipeline.md'), pipelineLines.join('\n'), 'utf8');

  // Merge tracker
  try { execSync('node merge-tracker.mjs', { cwd: BASE, stdio: 'inherit' }); console.log('\nTracker merged ✅'); }
  catch { console.log('\nTracker additions saved — run: node merge-tracker.mjs'); }

  // Summary
  const done      = results.filter(r => r.score != null);
  const applyList = done.filter(r => parseFloat(r.score) >= MIN_SCORE)
                        .sort((a, b) => parseFloat(b.score) - parseFloat(a.score));

  console.log(`\n━━━━ Summary ━━━━`);
  console.log(`Evaluated: ${done.length}/${toEvaluate.length}`);
  console.log(`APPLY ≥${MIN_SCORE}: ${applyList.length}`);
  applyList.forEach(r => console.log(`  ★ ${r.score}/5 — ${r.company} | ${r.role}`));

  if (applyList.length > 0) {
    await notifyOffers(applyList);
  } else {
    // Notify WhatsApp that the run completed even when nothing qualifies
    await notifyNone(done.length, toEvaluate.length);
  }

  console.log(`\n${applyList.length} high-score offers found`);
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
