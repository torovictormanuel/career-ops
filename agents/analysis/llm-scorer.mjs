#!/usr/bin/env node
/**
 * llm-scorer.mjs — LLM Scorer (Gemini free tier / Anthropic fallback)
 *
 * Provider selection (priority order):
 *   1. GEMINI_API_KEY set  → Google Gemini 1.5 Flash (free, 1500 req/day)
 *   2. ANTHROPIC_API_KEY set → Claude (paid)
 *   3. Neither set → CONFIG_ERROR
 *
 * Responsabilidades:
 *   1. Cargar system prompt desde prompts/scorer/system-prompt.md
 *   2. Inyectar {{VICTOR_PROFILE}} y {{JD_TEXT}} en el prompt
 *   3. Llamar a la API del LLM configurado
 *   4. Parsear y validar el JSON de respuesta
 *   5. Reintentar hasta MAX_RETRIES veces con un prompt de corrección si el JSON es inválido
 *   6. Clasificar errores: SCORE_ERROR (recuperable) vs críticos
 *
 * Uso:
 *   import { LlmScorer } from './agents/analysis/llm-scorer.mjs';
 *   const scorer = new LlmScorer();
 *   const scored = await scorer.score(offer, jdText);
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '../..');

// ── Config defaults ────────────────────────────────────────────────────────────

const DEFAULTS = {
  model:          'gemini-flash-lite-latest',  // free; alias siempre apunta al flash lite más reciente
  maxTokens:      1024,
  temperature:    0.2,
  maxRetries:     3,
  promptTemplate: path.join(ROOT, 'prompts', 'scorer', 'system-prompt.md'),
  profilePath:    path.join(ROOT, 'config', 'victor_profile.md'),
};

// Required fields in the LLM response JSON
const REQUIRED_FIELDS = ['score', 'justification', 'tags', 'apply_recommendation', 'score_factors'];
const SCORE_FACTORS   = ['stack_match', 'seniority_match', 'modality_match', 'salary_signal'];

// ── LlmScorer ─────────────────────────────────────────────────────────────────

export class LlmScorer {
  /**
   * @param {object} [options]
   * @param {string} [options.model]           LLM model name (Gemini or Claude)
   * @param {number} [options.maxTokens]       Max tokens for the response
   * @param {number} [options.temperature]     Temperature (0–1)
   * @param {number} [options.maxRetries]      Max JSON validation retries
   * @param {string} [options.promptTemplate]  Path to scorer system-prompt.md
   * @param {string} [options.profilePath]     Path to victor_profile.md
   * @param {object} [options._client]         Injected client (for tests)
   */
  constructor(options = {}) {
    this.model          = options.model          ?? DEFAULTS.model;
    this.maxTokens      = options.maxTokens      ?? DEFAULTS.maxTokens;
    this.temperature    = options.temperature    ?? DEFAULTS.temperature;
    this.maxRetries     = options.maxRetries     ?? DEFAULTS.maxRetries;
    this.promptTemplate = options.promptTemplate ?? DEFAULTS.promptTemplate;
    this.profilePath    = options.profilePath    ?? DEFAULTS.profilePath;
    this._clientOverride = options._client       ?? null;

    // Lazy-loaded
    this._systemPromptRaw = null;
    this._profile         = null;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Score a job offer using the LLM.
   *
   * @param {{ url: string, title: string, company: string, location: string }} offer
   * @param {string} jdText  Clean JD text from JdExtractor
   * @returns {Promise<ScoredOffer>}
   * @throws {ScorerError} If all retries fail or the API call errors
   */
  async score(offer, jdText) {
    const prompt  = this._buildPrompt(jdText);
    const backend = await this._getClient();

    let lastError = null;
    let lastRaw   = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let responseText;
      try {
        if (backend.provider === 'gemini') {
          const retryCtx = (attempt > 0 && lastRaw)
            ? { lastRaw, correctionMsg: this._correctionMsg(lastError) }
            : null;
          responseText = await this._callGemini(backend.genAI, backend.modelUsed, prompt, retryCtx);
        } else {
          const messages = this._buildMessages(prompt, lastRaw, lastError, attempt);
          responseText = await this._callAnthropic(backend.client, messages);
        }
      } catch (apiErr) {
        // Retry on 503 (high demand) with backoff; throw immediately on other API errors
        if (attempt < this.maxRetries && apiErr.message.includes('503')) {
          await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
          continue;
        }
        throw new ScorerError(`API call failed: ${apiErr.message}`, 'API_ERROR', offer.url);
      }

      const parsed = this._extractJson(responseText);
      if (!parsed) {
        lastError = 'Response was not valid JSON';
        lastRaw   = responseText;
        continue;
      }

      const validationError = this._validateSchema(parsed);
      if (validationError) {
        lastError = validationError;
        lastRaw   = responseText;
        continue;
      }

      return this._buildScoredOffer(offer, parsed, backend.modelUsed);
    }

    throw new ScorerError(
      `LLM returned invalid JSON after ${this.maxRetries + 1} attempts. Last error: ${lastError}`,
      'SCORE_ERROR',
      offer.url
    );
  }

  // ── Private: API calls ───────────────────────────────────────────────────────

  async _callGemini(genAI, modelName, prompt, retryCtx) {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature:     this.temperature,
        maxOutputTokens: this.maxTokens,
      },
    });

    let contents;
    if (!retryCtx) {
      contents = [{ role: 'user', parts: [{ text: prompt }] }];
    } else {
      contents = [
        { role: 'user',  parts: [{ text: prompt }] },
        { role: 'model', parts: [{ text: retryCtx.lastRaw }] },
        { role: 'user',  parts: [{ text: retryCtx.correctionMsg }] },
      ];
    }

    const result = await model.generateContent({ contents });
    return result.response.text();
  }

  async _callAnthropic(client, messages) {
    const response = await client.messages.create({
      model:       this.model,
      max_tokens:  this.maxTokens,
      temperature: this.temperature,
      messages,
    });
    return response.content[0]?.text ?? '';
  }

  _correctionMsg(lastError) {
    return [
      `Tu respuesta anterior no es un JSON válido o tiene un error de esquema: "${lastError}".`,
      'Responde ÚNICAMENTE con el JSON corregido, sin ningún texto adicional.',
      'El JSON debe seguir exactamente el esquema especificado en el prompt original.',
    ].join(' ');
  }

  // ── Private: prompt building ─────────────────────────────────────────────────

  _buildPrompt(jdText) {
    const template = this._loadPromptTemplate();
    const profile  = this._loadProfile();

    return template
      .replace('{{VICTOR_PROFILE}}', profile)
      .replace('{{JD_TEXT}}', jdText);
  }

  /**
   * Build the messages array for the API call.
   * On retry, add the previous bad response and a correction request.
   */
  _buildMessages(systemPrompt, lastRaw, lastError, attempt) {
    const base = [{ role: 'user', content: systemPrompt }];

    if (attempt === 0 || !lastRaw) return base;

    // Correction prompt for retries
    return [
      ...base,
      { role: 'assistant', content: lastRaw },
      {
        role: 'user',
        content: [
          `Tu respuesta anterior no es un JSON válido o tiene un error de esquema: "${lastError}".`,
          'Responde ÚNICAMENTE con el JSON corregido, sin ningún texto adicional.',
          'El JSON debe seguir exactamente el esquema especificado en el prompt original.',
        ].join(' '),
      },
    ];
  }

  // ── Private: JSON extraction & validation ────────────────────────────────────

  /**
   * Extract JSON from the LLM response (handles markdown code fences and raw JSON).
   */
  _extractJson(text) {
    if (!text) return null;

    // Try to find JSON inside ```json ... ``` fences
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const candidate  = fenceMatch ? fenceMatch[1] : text.trim();

    // Find the first { } block (in case there's preamble text)
    const jsonMatch = candidate.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) return null;

    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      return null;
    }
  }

  /**
   * Validate the parsed JSON against the expected schema.
   * Returns null if valid, or an error string describing the problem.
   */
  _validateSchema(obj) {
    // Check required top-level fields
    for (const field of REQUIRED_FIELDS) {
      if (!(field in obj)) {
        return `Campo requerido faltante: "${field}"`;
      }
    }

    // Validate score
    const score = obj.score;
    if (typeof score !== 'number' || score < 1.0 || score > 5.0) {
      return `"score" debe ser un número entre 1.0 y 5.0, recibido: ${JSON.stringify(score)}`;
    }

    // Validate justification
    if (typeof obj.justification !== 'string' || obj.justification.trim().length === 0) {
      return '"justification" debe ser un string no vacío';
    }

    // Validate tags
    if (!Array.isArray(obj.tags) || obj.tags.length < 1) {
      return '"tags" debe ser un array con al menos 1 elemento';
    }

    // Validate apply_recommendation
    if (typeof obj.apply_recommendation !== 'boolean') {
      return '"apply_recommendation" debe ser true o false';
    }

    // Validate score_factors
    if (typeof obj.score_factors !== 'object' || obj.score_factors === null) {
      return '"score_factors" debe ser un objeto';
    }
    for (const factor of SCORE_FACTORS) {
      if (!(factor in obj.score_factors)) {
        return `"score_factors.${factor}" faltante`;
      }
    }

    return null; // valid
  }

  // ── Private: result building ─────────────────────────────────────────────────

  _buildScoredOffer(offer, parsed, modelUsed) {
    return {
      url:            offer.url,
      title:          offer.title,
      company:        offer.company,
      location:       offer.location,
      date_found:     offer.date_found,
      source_portal:  offer.source_portal,

      score:                parsed.score,
      justification:        parsed.justification,
      tags:                 parsed.tags,
      apply_recommendation: parsed.apply_recommendation,
      score_factors:        parsed.score_factors,

      scored_at: new Date().toISOString(),
      model:     modelUsed ?? this.model,
    };
  }

  // ── Private: lazy loaders ────────────────────────────────────────────────────

  _loadPromptTemplate() {
    if (!this._systemPromptRaw) {
      try {
        this._systemPromptRaw = readFileSync(this.promptTemplate, 'utf8');
      } catch (err) {
        throw new Error(`[LlmScorer] Cannot load prompt template from ${this.promptTemplate}: ${err.message}`);
      }
    }
    return this._systemPromptRaw;
  }

  _loadProfile() {
    if (!this._profile) {
      try {
        this._profile = readFileSync(this.profilePath, 'utf8');
      } catch (err) {
        throw new Error(`[LlmScorer] Cannot load candidate profile from ${this.profilePath}: ${err.message}`);
      }
    }
    return this._profile;
  }

  async _getClient() {
    if (this._clientOverride) return this._clientOverride;

    const geminiKey    = process.env.GEMINI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    if (geminiKey) {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      // Remap any claude-* model name to the Gemini default
      const modelUsed = this.model.startsWith('claude') ? 'gemini-flash-lite-latest' : this.model;
      return { provider: 'gemini', genAI: new GoogleGenerativeAI(geminiKey), modelUsed };
    }

    if (anthropicKey) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      return { provider: 'anthropic', client: new Anthropic({ apiKey: anthropicKey }), modelUsed: this.model };
    }

    throw new ScorerError(
      'No LLM key found. Set GEMINI_API_KEY (free at aistudio.google.com) or ANTHROPIC_API_KEY in .env',
      'CONFIG_ERROR'
    );
  }
}

// ── ScorerError ────────────────────────────────────────────────────────────────

export class ScorerError extends Error {
  /**
   * @param {string} message
   * @param {'SCORE_ERROR'|'API_ERROR'|'CONFIG_ERROR'} code
   * @param {string} [offerUrl]
   */
  constructor(message, code = 'SCORE_ERROR', offerUrl = '') {
    super(message);
    this.name     = 'ScorerError';
    this.code     = code;
    this.offerUrl = offerUrl;
  }
}

// ── JSDoc types ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ScoredOffer
 * @property {string}  url
 * @property {string}  title
 * @property {string}  company
 * @property {string}  location
 * @property {string}  date_found
 * @property {string}  source_portal
 * @property {number}  score               - 1.0–5.0
 * @property {string}  justification       - 2-3 sentences in Spanish
 * @property {string[]} tags               - e.g. ['power-bi', 'remote', 'fintech']
 * @property {boolean} apply_recommendation
 * @property {object}  score_factors       - { stack_match, seniority_match, modality_match, salary_signal }
 * @property {string}  scored_at           - ISO timestamp
 * @property {string}  model               - Claude model used
 */

// ── Default singleton ──────────────────────────────────────────────────────────

export const llmScorer = new LlmScorer();
