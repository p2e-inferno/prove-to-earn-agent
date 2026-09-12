type RateLimitEntry = {
  count: number;
  resetAt: number;
};

class InMemoryRateLimiter {
  private store = new Map<string, RateLimitEntry>();
  private cleanup: NodeJS.Timeout;

  constructor() {
    this.cleanup = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store.entries()) {
        if (entry.resetAt <= now) this.store.delete(key);
      }
    }, 60_000);
    this.cleanup.unref();
  }

  async check(
    identifier: string,
    maxRequests: number,
    windowMs: number,
  ): Promise<{ success: boolean; remaining: number; resetAt: number }> {
    const now = Date.now();
    const existing = this.store.get(identifier);
    if (!existing || existing.resetAt <= now) {
      const resetAt = now + windowMs;
      this.store.set(identifier, { count: 1, resetAt });
      return {
        success: true,
        remaining: Math.max(0, maxRequests - 1),
        resetAt,
      };
    }
    if (existing.count >= maxRequests) {
      return { success: false, remaining: 0, resetAt: existing.resetAt };
    }
    existing.count += 1;
    return {
      success: true,
      remaining: Math.max(0, maxRequests - existing.count),
      resetAt: existing.resetAt,
    };
  }

  destroy() {
    clearInterval(this.cleanup);
  }
}

export const rateLimiter = new InMemoryRateLimiter();
