import { Redis } from "@upstash/redis";

let cachedRedis: Redis | null | undefined;

function shouldFailFastForMissingRedisConfig() {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.REQUIRE_REDIS_RATE_LIMIT === "1"
  );
}

function resolveRedisEnv() {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL ?? null;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? null;
  const kvUrl = process.env.KV_REST_API_URL ?? null;
  const kvToken = process.env.KV_REST_API_TOKEN ?? null;

  const hasCompleteUpstashPair = Boolean(upstashUrl && upstashToken);
  const hasCompleteKvPair = Boolean(kvUrl && kvToken);
  const hasPartialConfig = Boolean(
    (upstashUrl && !upstashToken) ||
      (!upstashUrl && upstashToken) ||
      (kvUrl && !kvToken) ||
      (!kvUrl && kvToken),
  );

  if (hasCompleteUpstashPair) {
    return { url: upstashUrl as string, token: upstashToken as string };
  }

  if (hasCompleteKvPair) {
    return { url: kvUrl as string, token: kvToken as string };
  }

  if (hasPartialConfig && shouldFailFastForMissingRedisConfig()) {
    throw new Error(
      "Incomplete Upstash Redis configuration. Set either UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN or KV_REST_API_URL + KV_REST_API_TOKEN.",
    );
  }

  if (shouldFailFastForMissingRedisConfig()) {
    throw new Error(
      "Missing Upstash Redis configuration for distributed chat rate limiting. Set either UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN or KV_REST_API_URL + KV_REST_API_TOKEN.",
    );
  }

  return null;
}

export function isUpstashRedisConfigured() {
  try {
    return resolveRedisEnv() !== null;
  } catch {
    return false;
  }
}

export function getUpstashRedis() {
  if (cachedRedis !== undefined) {
    return cachedRedis;
  }

  // In production or when REQUIRE_REDIS_RATE_LIMIT=1, a missing/partial Redis
  // config is treated as a request-time hard failure rather than silently
  // degrading chat rate limiting to per-instance memory.
  const env = resolveRedisEnv();
  if (!env) {
    cachedRedis = null;
    return cachedRedis;
  }

  cachedRedis = new Redis({
    url: env.url,
    token: env.token,
  });

  return cachedRedis;
}
