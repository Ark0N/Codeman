/**
 * @fileoverview Centralized API fetch helpers mixed into CodemanApp.prototype.
 *
 * Provides _api(), _apiJson(), _apiPost(), _apiPut(), _apiDelete() methods that handle
 * JSON serialization, Content-Type headers, and error swallowing. All API calls in the
 * frontend route through these helpers.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class must be defined)
 * @loadorder 8 of 9 — loaded after app.js
 */

// Codeman — Centralized API fetch helpers for CodemanApp
// Loaded after app.js (needs CodemanApp class defined)

Object.assign(CodemanApp.prototype, {
  /**
   * Send a JSON API request. Handles Content-Type, JSON serialization, and error swallowing.
   * @param {string} path - API path (e.g., '/api/sessions/123/input')
   * @param {object} [opts] - { method, body, signal }
   * @returns {Promise<Response|null>} Response or null on error
   */
  async _api(path, opts = {}) {
    const { method = 'GET', body, signal } = opts;
    const fetchOpts = { method, signal };
    if (body !== undefined) {
      fetchOpts.headers = { 'Content-Type': 'application/json' };
      fetchOpts.body = JSON.stringify(body);
    }
    try {
      const res = await fetch(path, fetchOpts);
      return res;
    } catch {
      return null;
    }
  },

  /**
   * Send a JSON API request and parse the response as JSON.
   * @param {string} path - API path
   * @param {object} [opts] - { method, body, signal }
   * @returns {Promise<any|null>} Parsed JSON or null on error
   */
  async _apiJson(path, opts = {}) {
    const res = await this._api(path, opts);
    if (!res || !res.ok) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  },

  /**
   * POST JSON to an API endpoint (most common pattern).
   * @param {string} path - API path
   * @param {object} body - JSON body
   * @returns {Promise<Response|null>}
   */
  async _apiPost(path, body) {
    return this._api(path, { method: 'POST', body });
  },

  /**
   * PUT JSON to an API endpoint.
   * @param {string} path - API path
   * @param {object} body - JSON body
   * @returns {Promise<Response|null>}
   */
  async _apiPut(path, body) {
    return this._api(path, { method: 'PUT', body });
  },

  /**
   * DELETE an API resource.
   * @param {string} path - API path
   * @returns {Promise<Response|null>}
   */
  async _apiDelete(path) {
    return this._api(path, { method: 'DELETE' });
  },
});
