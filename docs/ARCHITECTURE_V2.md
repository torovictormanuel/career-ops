# career-ops v2.0 — Arquitectura del Sistema de Agentes IA

> Documentación técnica de la arquitectura de agentes para búsqueda laboral automatizada.
> Victor Toro — Mayo 2026

---

## Visión General

career-ops v2.0 es un **sistema de agentes de IA modulares** que automatiza el ciclo completo de búsqueda laboral: desde el descubrimiento de ofertas hasta la gestión de postulaciones, con notificaciones en tiempo real vía WhatsApp.

**Diferencias clave con v1.x:**

| Aspecto | v1.8 | v2.0 |
|---|---|---|
| Arquitectura | Script monolítico `scan.mjs` | Agentes independientes por responsabilidad |
| Configuración | Hardcoded + varios archivos | `config/config.yml` único maestro |
| Deduplicación | `scan-history.tsv` (O(n) scan) | `dedup-index.json` (O(1) hash lookup) |
| Manejo de errores | Try/catch básico | Circuit Breaker + Dead Letter Queue + retry con backoff |
| Observabilidad | Logs de texto plano | Logs JSON estructurados con `run_id` trazable |
| Perfil candidato | `config/profile.yml` | `config/victor_profile.md` (LLM-ready context) |

---

## Diagrama de Arquitectura

```
┌──────────────────────────────────────────────────────────────────────┐
│                       MASTER ORCHESTRATOR                            │
│            n8n (cron 08:00 / 13:00 / 18:00 L-V GMT-3)              │
│                POST http://localhost:3099/run-scan                   │
└──────────┬───────────────────────────────────────────────────────────┘
           │ run_id generado aquí (UUID v4, incluido en todos los logs)
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     DISCOVERY AGENT                                  │
│   agents/discovery/discovery-agent.mjs                              │
│                                                                      │
│   ┌─────────────┐  ┌─────────────┐  ┌──────────────┐               │
│   │ Greenhouse  │  │  GetOnBoard │  │  Lever/Ashby │  (providers/) │
│   │   scraper   │  │   scraper   │  │   scrapers   │               │
│   └──────┬──────┘  └──────┬──────┘  └──────┬───────┘               │
│          └───────────────┴──────────────────┘                        │
│                           │                                           │
│                  ┌────────▼────────┐                                 │
│                  │ Feed Aggregator │ (normaliza + merge)             │
│                  └────────┬────────┘                                 │
│                           │                                           │
│                  ┌────────▼────────┐                                 │
│                  │  Dedup Engine  │ (dedup-index.json, O(1))         │
│                  └────────┬────────┘                                 │
│                           │ new_offers[]                              │
└───────────────────────────┼──────────────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      ANALYSIS AGENT                                  │
│   agents/analysis/                                                   │
│                                                                      │
│   ① JD Extractor    → extrae texto limpio del JD (HTML → text)      │
│   ② Pre-Filter      → reglas duras sin LLM (< 5ms por oferta)       │
│   ③ LLM Scorer      → Claude evalúa fit (score 1-5 + justificación) │
│   ④ Company Enricher → contexto de empresa (solo score ≥ 3.5)       │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ scored_offers[] (score ≥ threshold)
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    APPLICATION AGENT                                 │
│   agents/application/                                                │
│                                                                      │
│   ① Prioritization Engine  → ordena por score + señales             │
│   ② Cover Letter Generator → carta personalizada por oferta         │
│   ③ Application Tracker    → estado-machine en applications.md      │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ notify_batch[]
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   NOTIFICATION AGENT                                 │
│   whatsapp-bot.mjs + agents/notification/                            │
│                                                                      │
│   ① WhatsApp Notifier  → alerta inmediata por oferta (score ≥ 3.5) │
│   ② Daily Digest       → resumen a las 18:00 (último cron del día)  │
└──────────────────────────────────────────────────────────────────────┘
                            │ (transversal a todos los agentes)
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   INFRASTRUCTURE LAYER                               │
│                                                                      │
│  Data Manager         Error Handler          Logger                  │
│  ─────────────        ─────────────          ──────                  │
│  dedup-index.json     Circuit Breaker        logs/YYYY-MM-DD.json    │
│  pipeline.md          Retry (backoff exp.)   run_id trazable         │
│  applications.md      Dead Letter Queue      nivel configurable      │
│  company-cache.json   WA alert si crítico    rotación diaria         │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Estructura de Directorios

```
career-ops/
├── agents/                         # Agentes v2.0
│   ├── orchestrator/               # (futuro: orquestador local)
│   ├── discovery/                  # Discovery Agent
│   │   ├── discovery-agent.mjs     # Entry point del agente
│   │   ├── scraper-interface.mjs   # Contrato + BaseScraperAdapter
│   │   ├── feed-aggregator.mjs     # Merge + normalización de resultados
│   │   └── circuit-breaker.mjs     # Circuit Breaker por portal
│   ├── analysis/                   # Analysis Agent
│   │   ├── jd-extractor.mjs        # HTML → texto limpio del JD
│   │   ├── pre-filter.mjs          # Filtro rule-based sin LLM
│   │   ├── llm-scorer.mjs          # Claude API — score 1-5
│   │   └── company-enricher.mjs    # Enriquecimiento de empresa
│   ├── application/                # Application Agent
│   │   ├── prioritization-engine.mjs
│   │   ├── cover-letter-generator.mjs
│   │   └── application-tracker.mjs
│   ├── notification/               # Notification Agent
│   │   ├── whatsapp-notifier.mjs
│   │   └── daily-digest.mjs
│   ├── error-handler/              # Error Handler Agent
│   │   ├── retry.mjs
│   │   └── error-classifier.mjs
│   └── data-manager/               # Data Manager
│       ├── dedup-engine.mjs        # ✅ Implementado
│       ├── migrate-dedup.mjs       # ✅ Script de migración
│       └── validate-migration.mjs  # ✅ Validador
│
├── providers/                      # Scrapers base (v1.x, reutilizados por v2.0)
│   ├── greenhouse.mjs              # ✅ Greenhouse API
│   ├── getonboard.mjs              # ✅ GetOnBoard API
│   ├── lever.mjs                   # ✅ Lever API
│   ├── ashby.mjs                   # ✅ Ashby API
│   └── _http.mjs                   # ✅ HTTP helper compartido
│
├── prompts/                        # System prompts de los agentes LLM
│   ├── scorer/
│   │   └── system-prompt.md        # Prompt del LLM Scorer
│   ├── cover-letter/
│   │   └── system-prompt.md        # Prompt del Cover Letter Generator
│   └── pre-filter/
│       └── filter-rules.md
│
├── config/
│   ├── config.yml                  # ✅ Config maestro v2.0
│   ├── victor_profile.md           # ✅ Perfil LLM-ready del candidato
│   ├── profile.yml                 # Perfil estructurado (v1.x, compatibilidad)
│   └── filter_rules.yml            # Reglas Pre-Filter (a crear)
│
├── data/
│   ├── dedup-index.json            # ✅ Índice de deduplicación (O(1))
│   ├── pipeline.md                 # Cola de URLs pendientes (v1.x compat.)
│   ├── applications.md             # Tracker de postulaciones
│   └── scan-history.tsv            # Historial de scans (v1.x, backward compat)
│
├── tests/
│   ├── unit/                       # Tests unitarios por módulo
│   ├── integration/                # Tests end-to-end
│   └── fixtures/                   # HTML/JSON de prueba (sin llamadas reales)
│
├── logs/                           # Logs JSON rotados por día
├── docs/
│   └── ARCHITECTURE_V2.md          # ← Este documento
│
├── .env                            # Variables de entorno (no committear)
├── .env.example                    # ✅ Template completo v2.0
├── config/config.yml               # ✅ Config maestro
├── portals.yml                     # Configuración de portales/empresas
└── scan.mjs                        # Scanner v1.x (backward compat, no deprecar aún)
```

---

## Contratos de Datos

### Oferta Normalizada (v2.0)

Todos los scrapers deben devolver objetos que cumplan este esquema:

```typescript
interface NormalizedOffer {
  url:           string;   // URL canónica de la oferta (normalizada, sin UTMs)
  title:         string;   // Título del rol
  company:       string;   // Nombre de la empresa
  location:      string;   // Ubicación (puede ser vacío, nunca null)
  date_found:    string;   // ISO 8601 — cuándo fue descubierta esta ejecución
  source_portal: string;   // ID del proveedor: 'greenhouse' | 'getonboard' | 'lever' | 'ashby' | 'websearch'
  raw_text?:     string;   // Texto crudo del JD (poblado por JD Extractor, no por scrapers)
}
```

### Oferta Evaluada (salida del Analysis Agent)

```typescript
interface ScoredOffer extends NormalizedOffer {
  score:              number;   // 1.0 – 5.0
  justification:      string;   // Por qué ese score
  tags:               string[]; // ['power-bi', 'remote', 'fintech', ...]
  apply_recommendation: boolean;
  pre_filter_passed:  boolean;
  company_info?:      CompanyInfo;
}
```

### Entrada del Dedup Index

```json
{
  "url_hash": "abc123def456",
  "url": "https://boards.greenhouse.io/company/jobs/123",
  "source_portal": "greenhouse",
  "company": "Nubank",
  "title": "Data Analyst",
  "date_seen": "2026-05-23T12:00:00.000Z",
  "status": "added | skip_no_jd | scored | notified | applied"
}
```

---

## Flujo de Ejecución Detallado

```
1. n8n Cron Trigger (08:00 / 13:00 / 18:00)
   └─→ genera run_id = crypto.randomUUID()
   └─→ POST /run-scan con { run_id, timestamp }

2. Discovery Agent
   ├─→ Para cada portal en portals.yml (enabled: true):
   │   ├─→ Check Circuit Breaker → si OPEN, skip y loggear
   │   ├─→ Llamar provider.fetch() con HTTP context
   │   ├─→ Si error → retry(backoff) → si falla 3x → CIRCUIT_OPEN
   │   └─→ Retorna [{ url, title, company, location, source_portal }]
   ├─→ Feed Aggregator: merge + normalizar → raw_offers[]
   └─→ Dedup Engine: filterNew(raw_offers) → new_offers[]

3. Analysis Agent
   ├─→ Para cada oferta en new_offers[]:
   │   ├─→ JD Extractor: GET url → parsear HTML → jd_text
   │   │   └─→ Si jd_text < 100 chars → marcar SKIP_NO_JD, continuar
   │   ├─→ Pre-Filter: evaluar contra filter_rules.yml (< 5ms, sin LLM)
   │   │   └─→ Si falla regla dura → marcar SKIP_RULE, continuar
   │   ├─→ LLM Scorer: [jd_text + victor_profile.md] → Claude → score JSON
   │   │   └─→ Si JSON inválido → retry prompt corrección x2 → SCORE_ERROR
   │   └─→ Si score ≥ 3.5 → Company Enricher (cache primero, API si miss)
   └─→ Retorna scored_offers[] filtradas por score ≥ BATCH_MIN_SCORE

4. Application Agent
   ├─→ Prioritization: ordenar scored_offers por score * 0.7 + recency * 0.3
   ├─→ Cover Letter: para cada oferta → Claude → texto personalizado
   └─→ Application Tracker: registrar en applications.md con estado NOTIFIED

5. Notification Agent
   ├─→ WhatsApp Notifier: enviar mensaje por oferta (emoji score + URL + justif.)
   └─→ Si es el último cron del día → Daily Digest con métricas del día

6. Data Manager (transversal)
   └─→ Actualizar dedup-index.json con status final de cada URL procesada

7. Error Handler (transversal)
   ├─→ Circuit Breaker: actualizar estado por portal en circuit-breaker-state.json
   ├─→ Dead Letter: guardar en dead-letter.json las ofertas que fallaron 3x
   └─→ Si error crítico no recuperado → WA alert a Victor
```

---

## Manejo de Errores

### Clasificación de Errores

| Tipo | Ejemplos | Acción |
|---|---|---|
| `TRANSIENT` | Timeout HTTP, 503 temporal | Retry x3 con backoff (30s/2m/10m) |
| `PORTAL_DOWN` | 403 repetido, 404 en careers_url | Circuit Breaker OPEN 2h |
| `LLM_ERROR` | JSON inválido del scorer | Retry con prompt corrección x2 |
| `CONFIG_ERROR` | portals.yml malformado | Halt + WA alert |
| `CRITICAL` | Fallo no recuperado de >1 agente | WA alert inmediata a Victor |

### Circuit Breaker — Estados

```
CLOSED (normal)
  │
  │ 3 fallos consecutivos
  ▼
OPEN (portal bloqueado por 2h)
  │
  │ Tras 2h → primer intento
  ▼
HALF_OPEN
  │
  ├─→ Éxito → CLOSED (reset contador)
  └─→ Fallo  → OPEN (reset timer)
```

---

## Configuración Rápida

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Editar .env con tus valores (ANTHROPIC_API_KEY, WA_MY_NUMBER, etc.)

# 3. Migrar datos de v1.x al índice v2.0
node agents/data-manager/migrate-dedup.mjs

# 4. Validar migración
node agents/data-manager/validate-migration.mjs

# 5. Iniciar bot de WhatsApp
node whatsapp-bot.mjs

# 6. Iniciar n8n (orquestador)
# (Ver configuración en infra/n8n-workflow.json)
```

---

## Variables de Entorno Requeridas

| Variable | Descripción | Requerida |
|---|---|---|
| `ANTHROPIC_API_KEY` | API key de Claude (Scorer + Cover Letter) | Sí |
| `WA_MY_NUMBER` | Número de WhatsApp (con código país, sin +) | Sí |
| `BATCH_MIN_SCORE` | Score mínimo para notificar (default: 3.5) | No |
| `BATCH_MAX` | Máximo de ofertas por ejecución (default: 30) | No |
| `CAREER_OPS_DRY_RUN` | `true` para testing sin efectos secundarios | No |
| `LOG_LEVEL` | `debug \| info \| warn \| error` (default: info) | No |
| `GEMINI_API_KEY` | Alternativa a Claude (evaluación con Gemini) | No |

Ver `.env.example` para la lista completa con descripción de cada variable.

---

## Decisiones de Diseño

### ¿Por qué mantener `scan.mjs` y los `providers/`?
Los providers existentes (greenhouse, getonboard, lever, ashby) funcionan correctamente y están probados con 765+ URLs históricas. El Discovery Agent v2.0 los **reutiliza** vía `ScraperAdapter` en lugar de reescribirlos — reduciendo superficie de bugs y tiempo de migración.

### ¿Por qué JSON para el dedup index en vez de SQLite?
El sistema corre en Windows (Node.js sin native addons). JSON con lookup por hash es O(1) para el volumen actual (< 10k URLs) y no requiere dependencias adicionales. SQLite se considera si el índice supera 50k entradas.

### ¿Por qué `victor_profile.md` separado de `config/profile.yml`?
El YAML es ideal para configuración estructurada (campos tipados, validación). El Markdown es ideal para contexto narrativo que se inyecta en LLM prompts. Tienen propósitos distintos y deben editarse independientemente.

### ¿Por qué Circuit Breaker y no solo retry?
El retry protege ante fallos transitorios. El Circuit Breaker protege cuando un portal está sistemáticamente caído — evita desperdiciar tiempo y tokens evaluando errores que se sabe que van a fallar.

---

*Última actualización: 2026-05-23 | Victor Toro | career-ops v2.0*
