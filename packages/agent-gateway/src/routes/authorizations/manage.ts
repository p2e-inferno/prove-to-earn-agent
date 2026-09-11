import { z } from "zod";
import {
  loadOwnerAuthorization,
  revokeHeadlessAccess,
} from "../../auth/headless-authorization";
import {
  createHeadlessOwnerRoute,
  headlessOwnerJson,
} from "../../auth/owner-headless-route";

export const GET = createHeadlessOwnerRoute(async (_req, params, context) => {
  if (!params.agentId) {
    return headlessOwnerJson({ error: "INVALID_REQUEST" }, 400);
  }
  const authorization = await loadOwnerAuthorization(
    params.agentId,
    context.ownerUserId,
  );
  if (!authorization) {
    return headlessOwnerJson({ authorization: null });
  }
  return headlessOwnerJson({
    authorization: {
      id: authorization.id,
      agentId: authorization.agentId,
      ownerWallet: authorization.ownerWallet,
      policy: authorization.policy,
      policyHash: authorization.policyHash,
      status:
        authorization.status === "active" &&
        Date.parse(authorization.expiresAt) <= Date.now()
          ? "expired"
          : authorization.status,
      expiresAt: authorization.expiresAt,
      activatedAt: authorization.activatedAt,
    },
  });
});

const revokeSchema = z
  .object({ revokeAuthorization: z.boolean().default(true) })
  .strict();

export const DELETE = createHeadlessOwnerRoute(
  async (req, params, context) => {
    if (!params.agentId) {
      return headlessOwnerJson({ error: "INVALID_REQUEST" }, 400);
    }
    const parsed = revokeSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return headlessOwnerJson({ error: "INVALID_REQUEST" }, 400);
    }
    const result = await revokeHeadlessAccess({
      agentId: params.agentId,
      ownerUserId: context.ownerUserId,
      revokeAuthorization: parsed.data.revokeAuthorization,
    });
    return result.outcome === "not_found"
      ? headlessOwnerJson({ error: "AGENT_UNKNOWN" }, 404)
      : headlessOwnerJson({ status: "revoked", ...result });
  },
);
