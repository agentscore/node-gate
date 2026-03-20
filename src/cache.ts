export class TTLCache<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();
  private maxSize: number;

  constructor(private defaultTtlMs: number, maxSize = 10000) {
    this.maxSize = maxSize;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    if (this.store.size >= this.maxSize) {
      this.sweep();
    }
    if (this.store.size >= this.maxSize) {
      this.evictOldest(this.store.size - this.maxSize + 1);
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  /** Remove all expired entries. */
  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (now > v.expiresAt) {
        this.store.delete(k);
      }
    }
  }

  /** Evict the oldest `count` entries by insertion order. */
  private evictOldest(count: number): void {
    let removed = 0;
    for (const key of this.store.keys()) {
      if (removed >= count) break;
      this.store.delete(key);
      removed++;
    }
  }
}
