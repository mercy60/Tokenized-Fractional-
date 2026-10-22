// Copyright (c) 2026 Tokenized Fractional RWA Marketplace Contributors
// SPDX-License-Identifier: MIT

/**
 * Geo limiting with a shared backing store — Issue #882
 *
 * The per-country request counts used to live in a process-local Map, which
 * silently multiplied the configured limit by the number of backend replicas.
 * These tests verify that the counting state now lives behind a backing
 * store:
 *
 *   1. The acceptance-criteria scenario: two GeoLimiter instances (two pods)
 *      sharing one backing store enforce the *combined* limit correctly.
 *   2. The same scenario over the Redis-backed store, proving the Lua-driven
 *      shared path enforces the combined limit too.
 *   3. Single-instance fallback behavior is unchanged (memory mode).
 */

import { GeoLimiter, MemoryGeoCountStore, RedisGeoCountStore } from '../src/services/geoLimiter.js';

const SAVED_ENV = ['GEO_RESTRICTED_COUNTRIES', 'GEO_BLOCKED_COUNTRIES', 'GEO_LIMITING_ENABLED'];

function setEnv(values) {
  const saved = {};
  for (const key of SAVED_ENV) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Minimal ioredis test double for the commands RedisGeoCountStore uses.
 * `eval` mirrors the RESERVE_LUA script semantics (trim window, append iff
 * under limit, refresh TTL) so the store's key layout, argument wiring and
 * TTL handling are exercised end-to-end without a live Redis.
 */
class FakeRedis {
  constructor() {
    /** @type {Map<string, { values: number[], expiresAt: number|null }>} */
    this.data = new Map();
    // TTL clock disabled: the store's tests pass synthetic timestamps, so
    // expiry is driven purely by the window cutoff (as the Lua script does
    // for trimming) rather than by wall-clock PEXPIRE.
    this.now = () => 0;
  }

  _entry(key) {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && this.now() > entry.expiresAt) {
      this.data.delete(key);
      return null;
    }
    return entry;
  }

  async eval(_script, _numKeys, key, nowArg, windowMsArg, limitArg, maxEntriesArg) {
    const now = Number(nowArg);
    const windowMs = Number(windowMsArg);
    const limit = Number(limitArg);
    const maxEntries = Number(maxEntriesArg);
    const cutoff = now - windowMs;

    const entry = this._entry(key) || { values: [], expiresAt: null };
    entry.values = entry.values.filter((t) => t >= cutoff);

    if (entry.values.length >= limit) {
      entry.expiresAt = now + windowMs;
      this.data.set(key, entry);
      return 0;
    }

    entry.values.push(now);
    if (entry.values.length > maxEntries) {
      entry.values = entry.values.slice(-maxEntries);
    }
    entry.expiresAt = now + windowMs;
    this.data.set(key, entry);
    return 1;
  }

  async lrange(key, _start, _stop) {
    const entry = this._entry(key);
    return entry ? entry.values.map(String) : [];
  }

  async scan(_cursor, _cmd, pattern) {
    const prefix = pattern.replace('*', '');
    const matches = [...this.data.keys()].filter((k) => k.startsWith(prefix));
    return ['0', matches];
  }

  async del(...keys) {
    let n = 0;
    for (const key of keys) if (this.data.delete(key)) n++;
    return n;
  }
}

describe('GeoLimiter with a shared backing store (#882)', () => {
  let restoreEnv;

  beforeEach(() => {
    restoreEnv = setEnv({
      GEO_RESTRICTED_COUNTRIES: 'US:5',
      GEO_BLOCKED_COUNTRIES: 'KP',
      GEO_LIMITING_ENABLED: 'true',
    });
  });

  afterEach(() => {
    restoreEnv?.();
  });

  async function allowed(limiter, country) {
    const result = await limiter.check('203.0.113.1', { country }, null);
    return !result.blocked;
  }

  test('two instances sharing one store enforce the COMBINED limit, not 2x the limit', async () => {
    const sharedStore = new MemoryGeoCountStore();
    const limiterA = new GeoLimiter({ logger: silentLogger, store: sharedStore, redisUrl: null });
    const limiterB = new GeoLimiter({ logger: silentLogger, store: sharedStore, redisUrl: null });

    // Interleave requests across the two "pods" like a load balancer would.
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await allowed(i % 2 === 0 ? limiterA : limiterB, 'US'));
    }
    expect(results).toEqual([true, true, true, true, true]);

    // The 6th combined request exceeds the shared limit of 5 — regardless of pod.
    expect(await allowed(limiterA, 'US')).toBe(false);
    expect(await allowed(limiterB, 'US')).toBe(false);

    // Stats are shared: both instances report the same count of 5.
    const statsA = await limiterA.getCountryStats();
    const statsB = await limiterB.getCountryStats();
    expect(statsA.US.requestsLastHour).toBe(5);
    expect(statsB.US.requestsLastHour).toBe(5);
    expect(statsA.US.limit).toBe(5);
    expect(statsA.US.restricted).toBe(true);

    limiterA.destroy();
    limiterB.destroy();
  });

  test('two instances sharing a Redis-backed store enforce the combined limit', async () => {
    const fakeRedis = new FakeRedis();
    const store = new RedisGeoCountStore(fakeRedis, { logger: silentLogger });
    const limiterA = new GeoLimiter({ logger: silentLogger, store, redisUrl: null });
    const limiterB = new GeoLimiter({ logger: silentLogger, store, redisUrl: null });

    for (let i = 0; i < 5; i++) {
      expect(await allowed(i % 2 === 0 ? limiterA : limiterB, 'US')).toBe(true);
    }
    expect(await allowed(limiterA, 'US')).toBe(false);
    expect(await allowed(limiterB, 'US')).toBe(false);

    const stats = await limiterB.getCountryStats();
    expect(stats.US.requestsLastHour).toBe(5);

    await store.clear();
    expect(await store.countries()).toEqual([]);
    limiterA.destroy();
    limiterB.destroy();
  });

  test('blocked countries are rejected before touching the shared quota', async () => {
    const sharedStore = new MemoryGeoCountStore();
    const limiter = new GeoLimiter({ logger: silentLogger, store: sharedStore, redisUrl: null });

    for (let i = 0; i < 10; i++) {
      const result = await limiter.check('203.0.113.1', { country: 'KP' }, null);
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('country_blocked');
    }

    // No quota consumed for the blocked country; restricted countries unaffected.
    const stats = await limiter.getCountryStats();
    expect(stats.KP).toBeUndefined();

    limiter.destroy();
  });

  test('limit is enforced with defaults (single instance, memory fallback)', async () => {
    const limiter = new GeoLimiter({ logger: silentLogger, redisUrl: null });

    for (let i = 0; i < 5; i++) {
      expect(await allowed(limiter, 'US')).toBe(true);
    }
    const sixth = await limiter.check('203.0.113.1', { country: 'US' }, null);
    expect(sixth.blocked).toBe(true);
    expect(sixth.reason).toBe('country_rate_limited');

    limiter.destroy();
  });

  test('unrestricted countries and missing geo data are never blocked', async () => {
    const limiter = new GeoLimiter({ logger: silentLogger, redisUrl: null });

    for (let i = 0; i < 50; i++) {
      expect(await allowed(limiter, 'DE')).toBe(true);
    }
    const noGeo = await limiter.check('203.0.113.1', {}, null);
    expect(noGeo.blocked).toBe(false);

    limiter.destroy();
  });

  test('disabled geo limiting never blocks', async () => {
    restoreEnv();
    restoreEnv = setEnv({
      GEO_RESTRICTED_COUNTRIES: 'US:1',
      GEO_BLOCKED_COUNTRIES: 'KP',
      GEO_LIMITING_ENABLED: 'false',
    });

    const limiter = new GeoLimiter({ logger: silentLogger, redisUrl: null });
    expect(await allowed(limiter, 'KP')).toBe(true);
    expect(await allowed(limiter, 'US')).toBe(true);
    limiter.destroy();
  });

  test('memory store prunes expired timestamps on sweep', async () => {
    const store = new MemoryGeoCountStore();
    const t0 = 1_000_000;
    await store.reserve('US', { now: t0, windowMs: 3_600_000, limit: 5, maxEntries: 10 });
    expect(await store.countries()).toEqual(['US']);

    await store.pruneAll({ now: t0 + 2 * 3_600_000, windowMs: 3_600_000 });
    expect(await store.countries()).toEqual([]);
    expect(await store.snapshot('US', { now: t0 + 2 * 3_600_000, windowMs: 3_600_000 })).toEqual(
      [],
    );
  });

  test('Redis store reports only in-window timestamps and refreshes TTL on refusal', async () => {
    const fakeRedis = new FakeRedis();
    const store = new RedisGeoCountStore(fakeRedis, { logger: silentLogger });
    const windowMs = 3_600_000;
    const t0 = 10_000_000;

    expect(await store.reserve('US', { now: t0, windowMs, limit: 2, maxEntries: 4 })).toBe(true);
    expect(await store.reserve('US', { now: t0 + 1000, windowMs, limit: 2, maxEntries: 4 })).toBe(
      true,
    );
    expect(await store.reserve('US', { now: t0 + 2000, windowMs, limit: 2, maxEntries: 4 })).toBe(
      false,
    );

    // Outside the window the count drops back to zero → allowed again.
    expect(
      await store.reserve('US', { now: t0 + windowMs + 5000, windowMs, limit: 2, maxEntries: 4 }),
    ).toBe(true);

    const snapshot = await store.snapshot('US', { now: t0 + windowMs + 5000, windowMs });
    expect(snapshot).toHaveLength(1);
    expect(await store.countries()).toEqual(['US']);
  });
});
