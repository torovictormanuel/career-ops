/**
 * circuit-breaker.mjs — Circuit Breaker por portal (career-ops v2.0)
 *
 * Implementa el patrón Circuit Breaker para proteger el pipeline cuando
 * un portal falla sistemáticamente.
 *
 * Estados:
 *   CLOSED    → normal, permite requests
 *   OPEN      → bloqueado por N ms, no intenta requests
 *   HALF_OPEN → permite un intento de prueba tras el timeout
 *
 * El estado se persiste en disco para sobrevivir reinicios del proceso.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Constantes ────────────────────────────────────────────────────────────────

const STATE_CLOSED    = 'CLOSED';
const STATE_OPEN      = 'OPEN';
const STATE_HALF_OPEN = 'HALF_OPEN';

// ── CircuitBreaker ────────────────────────────────────────────────────────────

export class CircuitBreaker {
  /**
   * @param {object} options
   * @param {string} [options.stateFile]        - Path al JSON de estado persistido
   * @param {number} [options.failureThreshold] - Fallos consecutivos para abrir (default: 3)
   * @param {number} [options.openDurationMs]   - Ms en OPEN antes de pasar a HALF_OPEN (default: 2h)
   */
  constructor(options = {}) {
    this.stateFile        = resolve(options.stateFile ?? 'data/circuit-breaker-state.json');
    this.failureThreshold = options.failureThreshold ?? 3;
    this.openDurationMs   = options.openDurationMs   ?? 2 * 60 * 60 * 1000; // 2h
    this._state           = null; // lazy load
  }

  // ── Persistencia ────────────────────────────────────────────────────────────

  _load() {
    if (this._state) return this._state;
    if (existsSync(this.stateFile)) {
      try {
        this._state = JSON.parse(readFileSync(this.stateFile, 'utf-8'));
        return this._state;
      } catch { /* fallback a estado vacío */ }
    }
    this._state = {};
    return this._state;
  }

  _save() {
    writeFileSync(this.stateFile, JSON.stringify(this._state, null, 2), 'utf-8');
  }

  _getPortal(portalId) {
    const state = this._load();
    if (!state[portalId]) {
      state[portalId] = {
        state:          STATE_CLOSED,
        failures:       0,
        last_failure:   null,
        opened_at:      null,
        total_opens:    0,
      };
    }
    return state[portalId];
  }

  // ── API pública ─────────────────────────────────────────────────────────────

  /**
   * ¿Está el circuito cerrado (permite requests) para este portal?
   * También transiciona OPEN → HALF_OPEN si expiró el timeout.
   *
   * @param {string} portalId
   * @returns {{ allowed: boolean, state: string, reason?: string }}
   */
  canRequest(portalId) {
    const portal = this._getPortal(portalId);

    if (portal.state === STATE_CLOSED) {
      return { allowed: true, state: STATE_CLOSED };
    }

    if (portal.state === STATE_OPEN) {
      const elapsed = Date.now() - new Date(portal.opened_at).getTime();
      if (elapsed >= this.openDurationMs) {
        // Transición a HALF_OPEN — permitir un intento de prueba
        portal.state = STATE_HALF_OPEN;
        this._save();
        console.log(`[CircuitBreaker] ${portalId}: OPEN → HALF_OPEN (intento de prueba)`);
        return { allowed: true, state: STATE_HALF_OPEN };
      }
      const remainingMin = Math.ceil((this.openDurationMs - elapsed) / 60000);
      return {
        allowed: false,
        state: STATE_OPEN,
        reason: `Circuit OPEN — ${remainingMin}min restantes`,
      };
    }

    if (portal.state === STATE_HALF_OPEN) {
      // Ya hay un intento en curso — bloquear requests adicionales
      return { allowed: true, state: STATE_HALF_OPEN };
    }

    return { allowed: true, state: portal.state };
  }

  /**
   * Registrar éxito de un request.
   * Transiciona HALF_OPEN → CLOSED y resetea el contador de fallos.
   *
   * @param {string} portalId
   */
  onSuccess(portalId) {
    const portal = this._getPortal(portalId);
    const prevState = portal.state;

    portal.state    = STATE_CLOSED;
    portal.failures = 0;
    portal.last_failure = null;

    this._save();

    if (prevState !== STATE_CLOSED) {
      console.log(`[CircuitBreaker] ${portalId}: ${prevState} → CLOSED (éxito recuperado)`);
    }
  }

  /**
   * Registrar fallo de un request.
   * Incrementa contador; si supera threshold → OPEN.
   * En HALF_OPEN → vuelve a OPEN inmediatamente.
   *
   * @param {string} portalId
   * @param {string} [errorMsg]
   */
  onFailure(portalId, errorMsg = '') {
    const portal = this._getPortal(portalId);

    portal.failures++;
    portal.last_failure = new Date().toISOString();

    if (portal.state === STATE_HALF_OPEN || portal.failures >= this.failureThreshold) {
      portal.state     = STATE_OPEN;
      portal.opened_at = new Date().toISOString();
      portal.total_opens++;
      console.warn(`[CircuitBreaker] ${portalId}: → OPEN (fallos: ${portal.failures}, error: ${errorMsg})`);
    } else {
      console.warn(`[CircuitBreaker] ${portalId}: fallo ${portal.failures}/${this.failureThreshold} (${errorMsg})`);
    }

    this._save();
  }

  /**
   * Resetea manualmente el circuit breaker para un portal.
   * @param {string} portalId
   */
  reset(portalId) {
    const state = this._load();
    state[portalId] = {
      state:       STATE_CLOSED,
      failures:    0,
      last_failure: null,
      opened_at:   null,
      total_opens:  (state[portalId]?.total_opens ?? 0),
    };
    this._save();
    console.log(`[CircuitBreaker] ${portalId}: reseteado manualmente → CLOSED`);
  }

  /**
   * Resumen de estado de todos los portales.
   * @returns {object}
   */
  summary() {
    const state = this._load();
    return Object.entries(state).reduce((acc, [id, data]) => {
      acc[id] = { state: data.state, failures: data.failures, total_opens: data.total_opens };
      return acc;
    }, {});
  }
}

// ── Singleton por defecto ─────────────────────────────────────────────────────
export const circuitBreaker = new CircuitBreaker();
