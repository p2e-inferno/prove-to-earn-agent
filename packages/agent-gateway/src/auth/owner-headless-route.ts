import { NextResponse, type NextRequest } from "next/server";
import { ensureWalletBoundOrRespond } from "@adapters/identity";
import { headlessAgentAuthEnabled, agentAudienceOrigin } from "../env";

export type HeadlessOwnerContext = {
  ownerUserId: string;
  ownerWallet: string;
};

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store, private");
  response.headers.set("Pragma", "no-cache");
  return response;
}

export function headlessOwnerJson(body: unknown, status = 200): NextResponse {
  return noStore(NextResponse.json(body, { status }));
}

export function createHeadlessOwnerRoute(
  handler: (
    req: NextRequest,
    params: Record<string, string>,
    context: HeadlessOwnerContext,
  ) => Promise<NextResponse>,
) {
  return async (
    req: NextRequest,
    routeContext?: {
      params?: Promise<Record<string, string>> | Record<string, string>;
    },
  ): Promise<NextResponse> => {
    if (!headlessAgentAuthEnabled()) {
      return headlessOwnerJson({ error: "NOT_FOUND" }, 404);
    }
    const origin = req.headers.get("origin");
    if (origin && origin !== new URL(agentAudienceOrigin()).origin) {
      return headlessOwnerJson({ error: "ORIGIN_DENIED" }, 403);
    }
    const guard = await ensureWalletBoundOrRespond(req, {
      context: "headless-agent-authorization",
    });
    if (guard.response || !guard.context) {
      return noStore(
        guard.response ??
          NextResponse.json(
            { error: "AUTHENTICATION_REQUIRED" },
            { status: 401 },
          ),
      );
    }
    const params = routeContext?.params ? await routeContext.params : {};
    try {
      return noStore(
        await handler(req, params, {
          ownerUserId: guard.context.userId,
          ownerWallet: guard.context.walletAddress,
        }),
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
      const clientCodes = new Set([
        "TEMPLATE_SCOPE_DENIED",
        "POLICY_RESOURCE_MISMATCH",
        "AUTHORIZATION_EXPIRY_INVALID",
        "AUTHORIZATION_NOT_FOUND",
        "AUTHORIZATION_REQUIRED",
        "CREDENTIAL_CHALLENGE_INVALID",
        "SIGNATURE_INVALID",
        "AGENT_NOT_READY",
        "OWNER_WALLET_INVALID",
      ]);
      return headlessOwnerJson(
        {
          error: clientCodes.has(code) ? code : "INTERNAL_ERROR",
          message: clientCodes.has(code)
            ? "The authorization request was rejected"
            : "The authorization service is temporarily unavailable",
        },
        clientCodes.has(code) ? (code.includes("NOT_FOUND") ? 404 : 400) : 503,
      );
    }
  };
}
