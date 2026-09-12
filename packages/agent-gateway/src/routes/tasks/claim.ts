import { claimDailyTaskReward } from "@adapters/quests";
import { templateIdForCompletion } from "../../db/agents";
import { createAgentRoute } from "../../route-factory";
import { fail } from "@vendor/quests/principal";
import type { DelegatedAttestationSignature } from "@adapters/attestation-types";

type Body = {
  completionId?: string;
  attestationSignature?: DelegatedAttestationSignature | null;
};

export const POST = createAgentRoute({
  routeId: "tasks.claim",
  resolveTemplateId: async ({ body, principal }) => {
    const completionId = (body as Body | null)?.completionId;
    return completionId
      ? templateIdForCompletion(completionId, principal.userId)
      : null;
  },
  handler: async (ctx) => {
    const body = (ctx.body ?? {}) as Body;
    if (!body.completionId) {
      return fail(400, "INVALID_REQUEST", "completionId is required");
    }

    // A signature is not always required: with EAS disabled there is nothing to
    // attest, and the service resolves that itself. Refusing an unsigned claim
    // here would leave that deployment unable to claim at all. What to sign,
    // when it is required, comes from tasks.claim.intent.
    return claimDailyTaskReward(ctx.principal, {
      completionId: body.completionId,
      attestationSignature: body.attestationSignature,
    });
  },
});
