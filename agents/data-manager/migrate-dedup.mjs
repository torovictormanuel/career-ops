#!/usr/bin/env node
/**
 * migrate-dedup.mjs — Script de migración one-time
 *
 * Convierte data/scan-history.tsv → data/dedup-index.json
 * Mantiene backward compat: scan-history.tsv NO se elimina.
 *
 * Uso: node agents/data-manager/migrate-dedup.mjs [--dry-run]
 */

import { readFileSync, existsSync } from 'node:fs';
import { DedupEngine } from './dedup-engine.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';

console.log('🔄 Migración dedup: scan-history.tsv → dedup-index.json');
console.log(`   Modo: ${DRY_RUN ? 'DRY RUN (sin escritura)' : 'REAL'}\n`);

if (!existsSync(SCAN_HISTORY_PATH)) {
  console.log('⚠️  scan-history.tsv no encontrado. Nada que migrar.');
  process.exit(0);
}

const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
const dataLines = lines.slice(1).filter(l => l.trim()); // skip header

console.log(`📄 Entradas en scan-history.tsv: ${dataLines.length}`);

const engine = new DedupEngine();
let migrated = 0;
let skipped = 0;
let errors = 0;

for (const line of dataLines) {
  const cols = line.split('\t');
  const url = cols[0]?.trim();
  if (!url || !url.startsWith('http')) {
    skipped++;
    continue;
  }

  const date   = cols[1]?.trim() ?? new Date().toISOString().split('T')[0];
  const portal = cols[2]?.trim() ?? 'unknown';
  const title  = cols[3]?.trim() ?? null;
  const company = cols[4]?.trim() ?? null;
  const status  = cols[5]?.trim() ?? 'added';

  try {
    if (!DRY_RUN) {
      // Verificar si ya existe antes de sobrescribir
      const existing = engine.isSeen(url);
      if (existing.seen && existing.source === 'dedup-index') {
        skipped++;
        continue;
      }

      engine.markSeen(url, { source_portal: portal, company, title, status });
    }
    migrated++;
  } catch (err) {
    console.error(`   ❌ Error migrando ${url}: ${err.message}`);
    errors++;
  }
}

console.log('\n📊 Resultado:');
console.log(`   ✅ Migradas:  ${migrated}`);
console.log(`   ⏭️  Omitidas:  ${skipped}`);
console.log(`   ❌ Errores:   ${errors}`);

if (!DRY_RUN) {
  const stats = engine.stats();
  console.log(`\n📁 dedup-index.json: ${stats.total} entradas totales`);
  console.log('   Por portal:', stats.byPortal);
}

console.log('\n✅ Migración completada.');
console.log('   scan-history.tsv conservado para backward compatibility.');
