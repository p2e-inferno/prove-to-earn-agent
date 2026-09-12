import { getUpstashRedis } from "@vendor/upstash-redis";
import { rateLimiter as localLimiter } from "./rate-limiter";

const SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}
`;

export const rateLimiter = {
  async check(
    identifier: string,
    maxRequests: number,
    windowMs: number,
  ): Promise<{
    success: boolean;
    remaining: number;
    resetAt: number;
    unavailable?: boolean;
  }> {
    try {
      const redis = getUpstashRedis();
      if (!redis) {
        if (process.env.NODE_ENV === "production")
          throw new Error("Rate limiter unavailable");
        return localLimiter.check(identifier, maxRequests, windowMs);
      }
      const [count, ttl] = await redis.eval<[number], [number, number]>(
        SCRIPT,
        [`agent-limit:${identifier}`],
        [windowMs],
      );
      return {
        success: count <= maxRequests,
        remaining: Math.max(0, maxRequests - count),
        resetAt: Date.now() + Math.max(0, ttl),
      };
    } catch {
      return {
        success: false,
        remaining: 0,
        resetAt: Date.now() + windowMs,
        unavailable: true,
      };
    }
  },
};
