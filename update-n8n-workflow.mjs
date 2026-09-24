#!/usr/bin/env node
/**
 * update-n8n-workflow.mjs
 * Reemplaza los nodos "Ejecutar Scanner" y "Evaluar y Notificar WhatsApp"
 * (executeCommand) por un único nodo httpRequest POST /run-scan.
 *
 * Esto desacopla n8n del tiempo de ejecución del batch:
 * el bot responde 202 de inmediato y corre scan+batch de forma asíncrona.
 *
 * Uso: node update-n8n-workflow.mjs
 */

import { execSync } from 'child_process';

const SQLITE   = 'C:\\Users\\victo\\AppData\\Local\\platform-tools\\sqlite3.exe';
const DB       = 'C:\\Users\\victo\\.n8n\\database.sqlite';
const WF_ID    = '9fb6fd11-3a0e-4cf6-b2f9-8d56f6d40bdc';

function sqlite(query) {
  return execSync(`"${SQLITE}" "${DB}" "${query.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

// ── 1. Leer workflow actual ───────────────────────────────────────────────────
const rawNodes = sqlite(`SELECT nodes FROM workflow_entity WHERE id='${WF_ID}';`).trim();
const rawConns = sqlite(`SELECT connections FROM workflow_entity WHERE id='${WF_ID}';`).trim();

const nodes = JSON.parse(rawNodes);
const conns = JSON.parse(rawConns);

console.log('Workflow actual:');
nodes.forEach(n => console.log(`  [${n.type}] ${n.name}`));

// ── 2. Construir nuevos nodos ─────────────────────────────────────────────────
// Mantener: Schedule Trigger, Verificar Bot WhatsApp, Notificar Postulaciones
// Reemplazar: Ejecutar Scanner + Evaluar y Notificar WhatsApp → Disparar Pipeline
const keepNames = new Set(['Schedule Trigger', 'Verificar Bot WhatsApp', 'Notificar Postulaciones']);
const filteredNodes = nodes.filter(n => keepNames.has(n.name));

const newNode = {
  id          : 'e1f2a3b4-c5d6-7890-abcd-ef1234567890',
  name        : 'Disparar Pipeline',
  type        : 'n8n-nodes-base.httpRequest',
  typeVersion : 4.2,
  continueOnFail: true,
  position    : [700, 300],
  parameters  : {
    method  : 'POST',
    url     : 'http://127.0.0.1:3099/run-scan',
    options : {
      timeout  : 5000,
      response : { response: { neverError: true } },
    },
  },
};

// Insertar después de "Verificar Bot WhatsApp"
const verifyIdx = filteredNodes.findIndex(n => n.name === 'Verificar Bot WhatsApp');
filteredNodes.splice(verifyIdx + 1, 0, newNode);

// ── 3. Construir nuevas conexiones ───────────────────────────────────────────
const newConns = {
  'Schedule Trigger'       : { main: [[{ node: 'Verificar Bot WhatsApp', type: 'main', index: 0 }]] },
  'Verificar Bot WhatsApp' : { main: [[{ node: 'Disparar Pipeline',      type: 'main', index: 0 }]] },
  // "Notificar Postulaciones" queda desconectado — fue reemplazado por WA inline
};

console.log('\nNuevos nodos:');
filteredNodes.forEach(n => console.log(`  [${n.type}] ${n.name}`));

// ── 4. Actualizar SQLite via archivo temporal ─────────────────────────────────
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join as pathJoin } from 'path';
import { spawnSync as spawnSyncProc } from 'child_process';

const nodesJson = JSON.stringify(filteredNodes).replace(/'/g, "''");
const connsJson = JSON.stringify(newConns).replace(/'/g, "''");

const sql = `UPDATE workflow_entity SET nodes='${nodesJson}', connections='${connsJson}', updatedAt=datetime('now') WHERE id='${WF_ID}';\n`;

const tmpFile = pathJoin(tmpdir(), 'n8n-update.sql');
writeFileSync(tmpFile, sql, 'utf8');

const result = spawnSyncProc(SQLITE, [DB], {
  input   : sql,
  encoding: 'utf8',
  shell   : false,
});

try { unlinkSync(tmpFile); } catch {}

if (result.status !== 0) {
  console.error('Error SQLite:', result.stderr);
  process.exit(1);
}

console.log('\n✅ Workflow actualizado en SQLite.');
console.log('⚠️  Reiniciá n8n para que recargue el workflow:');
console.log('   schtasks /run /tn "\\n8n AutoStart"');
console.log('\nNuevo flujo:');
console.log('  Schedule Trigger → Verificar Bot WhatsApp → Disparar Pipeline (POST /run-scan)');
console.log('  El bot responde 202 inmediatamente y corre scan+batch de forma async.');
