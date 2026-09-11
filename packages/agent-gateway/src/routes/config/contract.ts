import { NextResponse, type NextRequest } from "next/server";
import { rateLimiter } from "@/lib/utils/agent-rate-limiter";
import { AGENT_ROUTES } from "../../payments/pricing";
import { agentError, agentOk } from "../../errors";
import { createPairingRoute } from "../../route-factory";

const RATE_LIMIT = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export const GET = createPairingRoute({
  guard: "public",
  handler: async (req: NextRequest): Promise<NextResponse> => {
    const rateLimit = await rateLimiter.check(
      `agent-config:${clientIp(req)}`,
      RATE_LIMIT,
      RATE_LIMIT_WINDOW_MS,
    );
    if (!rateLimit.success) {
      return agentError(
        429,
        "RATE_LIMITED",
        "Too many config requests. Retry shortly.",
      );
    }

    return agentOk({
      version: "v1",
      routes: AGENT_ROUTES,
      invariants: [
        "capability_scope",
        "wallet_binding",
        "idempotency",
        "single_flight_execution",
        "x402_settlement",
        "bounded_execution_loop",
      ],
    });
  },
});
