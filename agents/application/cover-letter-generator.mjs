#!/usr/bin/env node
/**
 * cover-letter-generator.mjs — Cover Letter Generator (career-ops v2.0)
 *
 * Responsabilidades:
 *   1. Cargar system prompt desde prompts/cover-letter/system-prompt.md
 *   2. Inyectar {{VICTOR_PROFILE}}, {{COMPANY_NAME}}, {{JOB_TITLE}}, {{JD_TEXT}}
 *   3. Llamar a la API de Claude (temperatura alta para creatividad)
 *   4. Parsear y validar el JSON de respuesta
 *   5. Guardar la carta en output/cover-letters/{date}-{slug}.md
 *
 * Reglas de idioma (del prompt):
 *   - JD en inglés  → carta en inglés
 *   - JD en español → carta en español
 *   - JD en portugués → carta en español (Victor no habla portugués)
 *   - Ambiguo → español por defecto
 *
 * Retorna CoverLetterResult:
 *   { subject_line, cover_letter, language, word_count, saved_path }
 *
 * Uso:
 *   import { CoverLetterGenerator } from './agents/application/cover-letter-generator.mjs';
 *   const gen = new CoverLetterGenerator();
 *   const result = await gen.generate(offer, jdText);
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '../..');

// ── Config ─────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  model:          'claude-opus-4-5',
  maxTokens:      800,
  temperature:    0.7,
  maxRetries:     1,
  promptTemplate: path.join(ROOT, 'prompts', 'cover-letter', 'system-prompt.md'),
  profilePath:    path.join(ROOT, 'config', 'victor_profile.md'),
  outputDir:      path.join(ROOT, 'output', 'cover-letters'),
};

const REQUIRED_FIELDS = ['subject_line', 'cover_letter', 'language', 'word_count'];

// ── CoverLetterGenerator ──────────────────────────────────────────────────────

export class CoverLetterGenerator {
  /**
   * @param {object} [options]
   * @param {string}  [options.model]
   * @param {number}  [options.maxTokens]
   * @param {number}  [options.temperature]
   * @param {number}  [options.maxRetries]
   * @param {string}  [options.promptTemplate]
   * @param {string}  [options.profilePath]
   * @param {string}  [options.outputDir]
   * @param {boolean} [options.saveToFile]    Save generated letters to disk (default true)
   * @param {object}  [options._client]       Injected Anthropic client (for tests)
   */
  constructor(options = {}) {
    this.model          = options.model          ?? DEFAULTS.model;
    this.maxTokens      = options.maxTokens      ?? DEFAULTS.maxTokens;
    this.temperature    = options.temperature    ?? DEFAULTS.temperature;
    this.maxRetries     = options.maxRetries     ?? DEFAULTS.maxRetries;
    this.promptTemplate = options.promptTemplate ?? DEFAULTS.promptTemplate;
    this.profilePath    = options.profilePath    ?? DEFAULTS.profilePath;
    this.outputDir      = options.outputDir      ?? DEFAULTS.outputDir;
    this.saveToFile     = options.saveToFile     ?? true;
    this._clientOverride = options._client       ?? null;

    // Lazy-loaded
    this._promptRaw = null;
    this._profile   = null;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Generate a cover letter for a scored offer.
   *
   * @param {{ url, title, company, location }} offer
   * @param {string} jdText  Clean JD text from JdExtractor
   * @returns {Promise<CoverLetterResult>}
   */
  async generate(offer, jdText) {
    const prompt = this._buildPrompt(offer, jdText);
    const client = await this._getClient();

    let lastError = null;
    let lastRaw   = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const messages = this._buildMessages(prompt, lastRaw, lastError, attempt);

      let responseText;
      try {
        const response = await client.messages.create({
          model:       this.model,
          max_tokens:  this.maxTokens,
          temperature: this.temperature,
          messages,
        });
        responseText = response.content[0]?.text ?? '';
      } catch (apiErr) {
        throw new CoverLetterError(
          `API call failed: ${apiErr.message}`,
          'API_ERROR',
          offer.url
        );
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

      const result = this._buildResult(offer, parsed);
      if (this.saveToFile) {
        result.saved_path = this._saveToFile(offer, result);
      }
      return result;
    }

    throw new CoverLetterError(
      `Cover letter generation failed after ${this.maxRetries + 1} attempts. Last error: ${lastError}`,
      'GENERATION_ERROR',
      offer.url
    );
  }

  // ── Private: prompt building ─────────────────────────────────────────────────

  _buildPrompt(offer, jdText) {
    const template = this._loadTemplate();
    const profile  = this._loadProfile();

    return template
      .replace('{{VICTOR_PROFILE}}', profile)
      .replace('{{COMPANY_NAME}}',   offer.company ?? '')
      .replace('{{JOB_TITLE}}',      offer.title   ?? '')
      .replace('{{JD_TEXT}}',        jdText);
  }

  _buildMessages(prompt, lastRaw, lastError, attempt) {
    const base = [{ role: 'user', content: prompt }];
    if (attempt === 0 || !lastRaw) return base;

    return [
      ...base,
      { role: 'assistant', content: lastRaw },
      {
        role: 'user',
        content: `Tu respuesta anterior no es JSON válido o tiene un error: "${lastError}". ` +
          'Responde ÚNICAMENTE con el JSON corregido según el esquema del prompt original.',
      },
    ];
  }

  // ── Private: JSON extraction & validation ────────────────────────────────────

  _extractJson(text) {
    if (!text) return null;

    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const candidate  = fenceMatch ? fenceMatch[1] : text.trim();
    const jsonMatch  = candidate.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) return null;

    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      return null;
    }
  }

  _validateSchema(obj) {
    for (const field of REQUIRED_FIELDS) {
      if (!(field in obj)) return `Campo requerido faltante: "${field}"`;
    }

    if (typeof obj.subject_line !== 'string' || obj.subject_line.trim().length === 0) {
      return '"subject_line" debe ser un string no vacío';
    }
    if (typeof obj.cover_letter !== 'string' || obj.cover_letter.trim().length === 0) {
      return '"cover_letter" debe ser un string no vacío';
    }
    if (!['es', 'en'].includes(obj.language)) {
      return `"language" debe ser "es" o "en", recibido: "${obj.language}"`;
    }
    if (typeof obj.word_count !== 'number' || obj.word_count < 1) {
      return '"word_count" debe ser un número positivo';
    }

    return null;
  }

  // ── Private: result building ─────────────────────────────────────────────────

  _buildResult(offer, parsed) {
    return {
      url:          offer.url,
      company:      offer.company,
      title:        offer.title,
      subject_line: parsed.subject_line,
      cover_letter: parsed.cover_letter,
      language:     parsed.language,
      word_count:   parsed.word_count,
      generated_at: new Date().toISOString(),
      model:        this.model,
      saved_path:   null,  // filled in by _saveToFile
    };
  }

  _saveToFile(offer, result) {
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }

    const date    = new Date().toISOString().slice(0, 10);
    const slug    = (offer.company ?? 'unknown')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 30);
    const filename = `${date}-${slug}.md`;
    const filePath = path.join(this.outputDir, filename);

    const content = [
      `# Cover Letter — ${offer.company}`,
      `**Rol:** ${offer.title}`,
      `**URL:** ${offer.url}`,
      `**Asunto:** ${result.subject_line}`,
      `**Idioma:** ${result.language}`,
      `**Palabras:** ${result.word_count}`,
      `**Generado:** ${result.generated_at}`,
      '',
      '---',
      '',
      result.cover_letter,
    ].join('\n');

    writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  // ── Private: lazy loaders ────────────────────────────────────────────────────

  _loadTemplate() {
    if (!this._promptRaw) {
      try {
        this._promptRaw = readFileSync(this.promptTemplate, 'utf8');
      } catch (err) {
        throw new Error(`[CoverLetterGenerator] Cannot load prompt from ${this.promptTemplate}: ${err.message}`);
      }
    }
    return this._promptRaw;
  }

  _loadProfile() {
    if (!this._profile) {
      try {
        this._profile = readFileSync(this.profilePath, 'utf8');
      } catch (err) {
        throw new Error(`[CoverLetterGenerator] Cannot load profile from ${this.profilePath}: ${err.message}`);
      }
    }
    return this._profile;
  }

  async _getClient() {
    if (this._clientOverride) return this._clientOverride;

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new CoverLetterError('ANTHROPIC_API_KEY not set', 'CONFIG_ERROR');
    }
    return new Anthropic({ apiKey });
  }
}

// ── CoverLetterError ──────────────────────────────────────────────────────────

export class CoverLetterError extends Error {
  constructor(message, code = 'GENERATION_ERROR', offerUrl = '') {
    super(message);
    this.name     = 'CoverLetterError';
    this.code     = code;
    this.offerUrl = offerUrl;
  }
}

// ── JSDoc types ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} CoverLetterResult
 * @property {string} url
 * @property {string} company
 * @property {string} title
 * @property {string} subject_line    - Email subject line (< 60 chars)
 * @property {string} cover_letter    - Full cover letter text
 * @property {'es'|'en'} language
 * @property {number} word_count
 * @property {string} generated_at   - ISO timestamp
 * @property {string} model
 * @property {string|null} saved_path - File path if saved, null otherwise
 */

// ── Default singleton ──────────────────────────────────────────────────────────

export const coverLetterGenerator = new CoverLetterGenerator();
