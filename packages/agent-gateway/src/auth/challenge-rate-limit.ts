import type { NextRequest } from "next/server";
import { getUpstashRedis } from "@vendor/upstash-redis";
import { rateLimiter } from "@vendor/rate-limiter";

const LIMIT = 10;
const WINDOW_SECONDS = 60;
const INCREMENT = `
local value = redis.call('INCR', KEYS[1])
if value == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return value
`;

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export async function checkChallengeRateLimit(
  req: NextRequest,
  wallet: string,
): Promise<{ allowed: boolean }> {
  const keys = [
    `agent-challenge:ip:${clientIp(req)}`,
    `agent-challenge:wallet:${wallet.toLowerCase()}`,
  ];

  const redis = getUpstashRedis();
  if (redis) {
    const counts = await Promise.all(
      keys.map((key) => redis.eval(INCREMENT, [key], [String(WINDOW_SECONDS)])),
    );
    return { allowed: counts.every((count) => Number(count) <= LIMIT) };
  }

  const results = await Promise.all(
    keys.map((key) => rateLimiter.check(key, LIMIT, WINDOW_SECONDS * 1000)),
  );
  return { allowed: results.every((result) => result.success) };
}
