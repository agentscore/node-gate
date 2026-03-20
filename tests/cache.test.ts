import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TTLCache } from '../src/cache';

describe('TTLCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined for a key that was never set', () => {
    const cache = new TTLCache<string>(1000);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('returns the value within TTL', () => {
    const cache = new TTLCache<string>(5000);
    cache.set('key', 'value');
    vi.advanceTimersByTime(4999);
    expect(cache.get('key')).toBe('value');
  });

  it('returns undefined after TTL has expired', () => {
    const cache = new TTLCache<string>(5000);
    cache.set('key', 'value');
    vi.advanceTimersByTime(5001);
    expect(cache.get('key')).toBeUndefined();
  });

  it('returns undefined at exactly the expiry instant', () => {
    const cache = new TTLCache<string>(1000);
    cache.set('key', 'value');
    vi.advanceTimersByTime(1001);
    expect(cache.get('key')).toBeUndefined();
  });

  it('different keys do not interfere with each other', () => {
    const cache = new TTLCache<number>(5000);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
  });

  it('expiring one key does not affect another', () => {
    const cache = new TTLCache<string>(10000);
    cache.set('short', 'gone', 500);
    cache.set('long', 'here');
    vi.advanceTimersByTime(501);
    expect(cache.get('short')).toBeUndefined();
    expect(cache.get('long')).toBe('here');
  });

  it('supports a per-entry ttlMs override', () => {
    const cache = new TTLCache<string>(60000);
    cache.set('custom', 'value', 200);
    vi.advanceTimersByTime(201);
    expect(cache.get('custom')).toBeUndefined();
  });

  it('overwrites an existing key with a fresh TTL', () => {
    const cache = new TTLCache<string>(1000);
    cache.set('key', 'first');
    vi.advanceTimersByTime(800);
    cache.set('key', 'second');
    vi.advanceTimersByTime(800);
    // 1600 ms total — original would have expired, but we reset at 800
    expect(cache.get('key')).toBe('second');
  });
});
