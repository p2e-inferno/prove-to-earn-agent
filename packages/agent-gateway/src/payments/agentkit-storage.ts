import { AGENT_ROUTES } from "./pricing";
import type { AgentKitStorage } from "@worldcoin/agentkit";
import { getUpstashRedis } from "@/lib/upstash/redis";
import { getLogger } from "@/lib/utils/logger";

const log = getLogger("agent-gateway:payments:agentkit-storage");

const USAGE_PREFIX = "agentkit:usage";
const NONCE_PREFIX = "agentkit:nonce";
const NONCE_TTL_SECONDS = 60 * 60 * 24;

// INCR then compare would let two concurrent requests both pass the limit, so
// the check and the increment are one server-side script. A non-numeric limit
// means unlimited rather than an error: `tonumber("Infinity")` is nil in Lua,
// and comparing against nil would raise and refuse every discount.
const TRY_INCREMENT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[1])
if limit ~= nil and current >= limit then
  return 0
end
local next_value = redis.call('INCR', KEYS[1])
return 1
`;

/**
 * Persistent AgentKit storage. InMemoryAgentKitStorage is documented as
 * development-only: with more than one server instance it would grant each
 * instance its own copy of every human's discount allowance.
 */
export class RedisAgentKitStorage implements AgentKitStorage {
  async tryIncrementUsage(
    endpoint: string,
    humanId: string,
    limit: number,
  ): Promise<boolean> {
    const redis = getUpstashRedis();
    if (!redis) {
      // Fail closed: an unmetered discount is worse than no discount.
      log.warn("Redis unavailable; refusing AgentKit discount");
      return false;
    }

    const canonical =
      AGENT_ROUTES.find((route) =>
        new RegExp(`^${route.path.replace(/\[[^\]]+\]/g, "[^/]+")}$`).test(
          endpoint,
        ),
      )?.path ?? endpoint;
    const key = `${USAGE_PREFIX}:${canonical}:${humanId}`;
    try {
      const result = await redis.eval(TRY_INCREMENT, [key], [String(limit)]);
      return Number(result) === 1;
    } catch (error) {
      log.error("AgentKit usage increment failed", { endpoint, error });
      return false;
    }
  }

  // Fail closed, like tryIncrementUsage: AgentKit treats "not used" as a fresh
  // nonce, so answering false when the store is unreadable would waive replay
  // protection. Refusing the discount is the safe answer.
  async hasUsedNonce(nonce: string): Promise<boolean> {
    const redis = getUpstashRedis();
    if (!redis) return true;
    try {
      const seen = await redis.get(`${NONCE_PREFIX}:${nonce}`);
      return seen !== null && seen !== undefined;
    } catch (error) {
      log.error("AgentKit nonce read failed", { error });
      return true;
    }
  }

  async recordNonce(nonce: string): Promise<void> {
    const redis = getUpstashRedis();
    if (!redis) return;
    try {
      await redis.set(`${NONCE_PREFIX}:${nonce}`, "1", {
        ex: NONCE_TTL_SECONDS,
      });
    } catch (error) {
      log.error("AgentKit nonce write failed", { error });
    }
  }
}

export const redisAgentKitStorage = new RedisAgentKitStorage();
