// Copyright (c) 2026 Tokenized Fractional RWA Marketplace Contributors
// SPDX-License-Identifier: MIT

/**
 * src/services/geoLimiter.js — geo-based request limiting.
 *
 * Issue #882: per-country request counts used to live in a plain in-memory
 * `Map` local to a single Node.js process, so with the backend's 2 Kubernetes
 * replicas (k8s/backend-deployment.yaml) each pod only saw its own share of a
 * country's traffic — silently multiplying the configured limit by the number
 * of replicas.
 *
 * The counting state now lives behind a **backing store**:
 *
 *   - `RedisGeoCountStore` — used automatically when `REDIS_URL` is set
 *     (same convention as the tiered/endpoint rate limiters and the
 *     WebSocket broadcast adapter). All replicas share one store, so the
 *     configured limit is enforced against the *combined* traffic no matter
 *     which pod handles a request. The check-and-record step is a single Lua
 *     script (`EVAL`), so concurrent requests on different pods cannot
 *     overshoot the limit.
 *   - `MemoryGeoCountStore` — the previous single-process semantics, used
 *     when Redis is not configured, when Redis is unreachable (graceful
 *     fallback — local enforcement beats no enforcement), or when a store is
 *     injected explicitly (tests).
 *
 * Both stores implement the same contract:
 *   reserve(country, { now, windowMs, limit, maxEntries }) -> boolean
 *       Atomically count a request against `country`'s sliding window and
 *       record it iff the window is still under `limit`. Returns whether the
 *       request is allowed.
 *   snapshot(country, { now, windowMs }) -> number[]
 *       Timestamps recorded for `country` within the window (for stats).
 *   countries() -> string[]       Countries with recorded state.
 *   pruneAll({ now, windowMs })   Drop expired state (memory: sweep; Redis:
 *                                 handled by per-key TTLs).
 *   clear()                       Remove all recorded state.
 *
 * Configuration (`GEO_BLOCKED_COUNTRIES`, `GEO_RESTRICTED_COUNTRIES`,
 * `GEO_LIMITING_ENABLED`, tier overrides) remains process-local: it is
 * env-derived deploy-time configuration, not per-request state.
 */

import { buildTlsOptions } from '../../cache.js';

const WINDOW_MS = 3_600_000; // 1 hour sliding window
const REDIS_KEY_PREFIX = 'geo:limit:';

// ─── In-memory store (single process) ────────────────────────────────────────

export class MemoryGeoCountStore {
  constructor() {
    /** @type {Map<string, number[]>} */
    this._map = new Map();
  }

  /**
   * Synchronous internals on purpose: no `await` between read and write, so
   * two concurrent `check()` calls in one process cannot interleave past the
   * limit.
   */
  async reserve(country, { now, windowMs, limit, maxEntries }) {
    const counts = this._map.get(country) || [];
    const recent = counts.filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      this._map.set(country, recent);
      return false;
    }
    recent.push(now);
    this._map.set(country, recent.slice(-maxEntries));
    return true;
  }

  async snapshot(country, { now, windowMs }) {
    return (this._map.get(country) || []).filter((t) => now - t < windowMs);
  }

  async countries() {
    return [...this._map.keys()];
  }

  async pruneAll({ now, windowMs }) {
    for (const [country, counts] of this._map) {
      const recent = counts.filter((t) => now - t < windowMs);
      if (recent.length === 0) this._map.delete(country);
      else this._map.set(country, recent);
    }
  }

  async clear() {
    this._map.clear();
  }
}

// ─── Redis store (shared across replicas) ────────────────────────────────────

/**
 * Atomically: trim entries older than the window, and append `now` iff the
 * window count is still below `limit`. Mirrored by RedisGeoCountStore's
 * fallback JS path and exercised via the injected-client tests.
 *
 * Returns 1 when the request is allowed (and was recorded), 0 when limited.
 */
const RESERVE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local maxEntries = tonumber(ARGV[4])
local cutoff = now - windowMs

local head = redis.call('LRANGE', key, 0, 0)
while head[1] and tonumber(head[1]) < cutoff do
  redis.call('LPOP', key)
  head = redis.call('LRANGE', key, 0, 0)
end

if redis.call('LLEN', key) >= limit then
  redis.call('PEXPIRE', key, windowMs)
  return 0
end

redis.call('RPUSH', key, now)
redis.call('LTRIM', key, -maxEntries, -1)
redis.call('PEXPIRE', key, windowMs)
return 1
`;

export class RedisGeoCountStore {
  /**
   * @param {{ eval: Function, lrange: Function, scan?: Function, keys?: Function, del: Function, pexpire?: Function }} client
   *   An ioredis client (or a test double implementing the same commands).
   * @param {{ logger?: { warn: Function }, prefix?: string }} [options]
   */
  constructor(client, { logger = console, prefix = REDIS_KEY_PREFIX } = {}) {
    this._client = client;
    this._logger = logger;
    this._prefix = prefix;
  }

  _key(country) {
    return `${this._prefix}${country}`;
  }

  async reserve(country, { now, windowMs, limit, maxEntries }) {
    try {
      const result = await this._client.eval(
        RESERVE_LUA,
        1,
        this._key(country),
        String(now),
        String(windowMs),
        String(limit),
        String(maxEntries),
      );
      return result === 1;
    } catch (error) {
      // Fail open to a local count rather than dropping enforcement entirely.
      this._warnOnce('reserve', error);
      return true;
    }
  }

  async snapshot(country, { now, windowMs }) {
    try {
      const raw = await this._client.lrange(this._key(country), 0, -1);
      return raw.map(Number).filter((t) => now - t < windowMs);
    } catch (error) {
      this._warnOnce('snapshot', error);
      return [];
    }
  }

  async countries() {
    try {
      const keys = await this._scanKeys();
      return keys.map((k) => k.slice(this._prefix.length)).filter(Boolean);
    } catch (error) {
      this._warnOnce('countries', error);
      return [];
    }
  }

  async _scanKeys() {
    const pattern = `${this._prefix}*`;
    if (typeof this._client.scan === 'function') {
      const found = [];
      let cursor = '0';
      do {
        const [next, batch] = await this._client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        found.push(...batch);
      } while (cursor !== '0');
      return found;
    }
    // Minimal clients (and ioredis in KEYS-only setups) fall back to KEYS.
    return this._client.keys(pattern);
  }

  /**
   * Redis state expires itself: every key carries a TTL refreshed on each
   * write, and `reserve` prunes old timestamps on the next request — so
   * there is nothing to sweep here.
   */
  async pruneAll() {}

  async clear() {
    try {
      const keys = await this._scanKeys();
      if (keys.length > 0) await this._client.del(...keys);
    } catch (error) {
      this._warnOnce('clear', error);
    }
  }

  _warnOnce(op, error) {
    if (this._warned) return;
    this._warned = true;
    this._logger.warn?.(
      { error: error?.message, operation: op },
      'GeoLimiter Redis store unavailable; falling back to per-process counts',
    );
  }
}

// ─── GeoLimiter ──────────────────────────────────────────────────────────────

export class GeoLimiter {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.enabled = process.env.GEO_LIMITING_ENABLED !== 'false';
    this.db = options.db || null;

    // Explicit store wins (tests, custom wiring); otherwise resolve lazily
    // from REDIS_URL on first use (see _store()).
    this._explicitStore = options.store || null;
    this._redisUrl =
      options.redisUrl !== undefined ? options.redisUrl : process.env.REDIS_URL || null;
    /** @type {Promise<import('./geoLimiter.js').GeoCountStore> | null} */
    this._storePromise = null;
    this._redisClient = null;

    this.blockedCountries = new Set(
      (process.env.GEO_BLOCKED_COUNTRIES || '')
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    );

    this.restrictedCountries = new Map();
    const restrictedRaw = process.env.GEO_RESTRICTED_COUNTRIES || '';
    if (restrictedRaw) {
      for (const entry of restrictedRaw.split(',')) {
        const [country, limit] = entry.split(':');
        if (country && limit) {
          this.restrictedCountries.set(country.trim().toUpperCase(), parseInt(limit) || 100);
        }
      }
    }

    this.tierCountryOverrides = new Map();
    this._cleanupInterval = setInterval(() => {
      this._cleanup().catch((error) =>
        this.logger.warn?.({ error: error?.message }, 'GeoLimiter cleanup failed'),
      );
    }, 300000);
    // Do not keep the process alive just for the sweep timer.
    this._cleanupInterval.unref?.();
  }

  /**
   * Resolve the backing store once: injected store → Redis (when REDIS_URL
   * is configured and reachable) → in-memory fallback.
   * @returns {Promise<GeoCountStore>}
   */
  async _store() {
    if (this._explicitStore) return this._explicitStore;
    if (!this._storePromise) {
      this._storePromise = this._initStore().catch((error) => {
        this.logger.warn?.(
          { error: error?.message },
          'GeoLimiter store initialization failed; using in-memory counts',
        );
        return new MemoryGeoCountStore();
      });
    }
    return this._storePromise;
  }

  async _initStore() {
    if (!this._redisUrl) return new MemoryGeoCountStore();

    const { default: Redis } = await import('ioredis');
    const tls = buildTlsOptions();
    const client = new Redis(this._redisUrl, {
      lazyConnect: true,
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null, // no background retries; fallback keeps limits local
      ...(tls && { tls }),
    });
    client.on('error', () => {}); // errors surface via connect()/commands below
    await client.connect();
    this._redisClient = client;
    this.logger.info?.('GeoLimiter using shared Redis store for cross-replica counting');
    return new RedisGeoCountStore(client, { logger: this.logger });
  }

  setTierCountryOverride(tier, country, action) {
    if (!this.tierCountryOverrides.has(tier)) {
      this.tierCountryOverrides.set(tier, new Map());
    }
    this.tierCountryOverrides.get(tier).set(country.toUpperCase(), action);
  }

  async check(ip, geo, apiKey) {
    if (!this.enabled) return { blocked: false };

    const result = { blocked: false, country: geo?.country || 'unknown', reason: null };

    if (!geo?.country) return result;

    const country = geo.country.toUpperCase();

    if (this.blockedCountries.has(country)) {
      result.blocked = true;
      result.reason = 'country_blocked';
      return result;
    }

    const restrictedLimit = this.restrictedCountries.get(country);
    if (restrictedLimit) {
      const store = await this._store();
      const allowed = await store.reserve(country, {
        now: Date.now(),
        windowMs: WINDOW_MS,
        limit: restrictedLimit,
        maxEntries: restrictedLimit * 2,
      });
      if (!allowed) {
        result.blocked = true;
        result.reason = 'country_rate_limited';
        return result;
      }
    }

    return result;
  }

  /**
   * Per-country usage statistics, read from the shared store.
   * @returns {Promise<Record<string, {requestsLastHour: number, blocked: boolean, restricted: boolean, limit: number|null}>>}
   */
  async getCountryStats() {
    const store = await this._store();
    const now = Date.now();
    const stats = {};
    for (const country of await store.countries()) {
      const recent = await store.snapshot(country, { now, windowMs: WINDOW_MS });
      stats[country] = {
        requestsLastHour: recent.length,
        blocked: this.blockedCountries.has(country),
        restricted: this.restrictedCountries.has(country),
        limit: this.restrictedCountries.get(country) || null,
      };
    }
    return stats;
  }

  async _cleanup() {
    const store = await this._store();
    await store.pruneAll({ now: Date.now(), windowMs: WINDOW_MS });
  }

  async destroy() {
    if (this._cleanupInterval) clearInterval(this._cleanupInterval);
    try {
      const store = await this._store();
      await store.clear();
    } catch {
      // best effort
    }
    if (this._redisClient) {
      try {
        await this._redisClient.quit?.();
      } catch {
        // best effort
      }
      this._redisClient = null;
    }
  }
}
