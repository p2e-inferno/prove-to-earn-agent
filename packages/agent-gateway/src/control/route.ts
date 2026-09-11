import { createHash } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { rateLimiter } from "@/lib/utils/agent-rate-limiter";
import { resolveHeadlessActor } from "../auth/headless-session";
import { headlessAgentApiEnabled, headlessAgentIssuer } from "../env";
import type { HeadlessControlContext } from "./service";

export function controlJson(body: unknown, status = 200): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store, private");
  response.headers.set("Pragma", "no-cache");
  return response;
}

export function createHeadlessControlRoute(options: {
  scope: string;
  mutation?: boolean;
  handler: (
    req: NextRequest,
    params: Record<string, string>,
    context: HeadlessControlContext,
  ) => Promise<unknown>;
}) {
  return async (
    req: NextRequest,
    routeContext?: { params?: Promise<Record<string, string>> | Record<string, string> },
  ): Promise<NextResponse> => {
    if (!headlessAgentApiEnabled()) return controlJson({ ok: false, code: "NOT_FOUND" }, 404);
    const actor = await resolveHeadlessActor(req);
    if (!actor) {
      const response = controlJson({ ok: false, code: "INVALID_TOKEN", retryable: false }, 401);
      response.headers.set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${headlessAgentIssuer()}/.well-known/oauth-protected-resource"`,
      );
      return response;
    }
    if (!actor.claims.scopes.includes(options.scope)) {
      return controlJson({ ok: false, code: "INSUFFICIENT_SCOPE", retryable: false }, 403);
    }
    const clientHash = createHash("sha256").update(actor.claims.clientId).digest("hex");
    const limit = await rateLimiter.check(`headless-api:${clientHash}`, 120, 60_000);
    if (limit.unavailable) return controlJson({ ok: false, code: "RATE_LIMIT_UNAVAILABLE", retryable: true }, 503);
    if (!limit.success) return controlJson({ ok: false, code: "RATE_LIMITED", retryable: true }, 429);
    if (options.mutation) {
      const requestId = req.headers.get("idempotency-key");
      if (!requestId || requestId.length > 200) {
        return controlJson({ ok: false, code: "IDEMPOTENCY_KEY_REQUIRED", retryable: false }, 400);
      }
    }
    const params = routeContext?.params ? await routeContext.params : {};
    try {
      const data = await options.handler(req, params, {
        authorization: actor.authorization,
        agent: actor.agent,
        clientId: actor.claims.clientId,
        scopes: actor.claims.scopes,
      });
      if (data instanceof NextResponse) return data;
      return controlJson({ ok: true, data }, options.mutation ? 202 : 200);
    } catch (error) {
      const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
      const status =
        code === "PAID_ACCESS_REQUIRED" || code === "POLICY_DENIED"
          ? 403
          : code.includes("NOT_FOUND")
            ? 404
            : code.includes("CONFLICT") || code === "busy" || code === "DECISION_STALE"
              ? 409
              : 503;
      return controlJson({ ok: false, code, retryable: status >= 500 }, status);
    }
  };
}
