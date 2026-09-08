import { buildRewardClaimIntent } from "../../intents/attestation";
import { templateIdForCompletion } from "../../db/agents";
import { createAgentRoute } from "../../route-factory";
import { fail, ok } from "@/lib/quests/principal";
import { isUuid } from "../../validation";

/**
 * What the agent must sign to claim this reward.
 *
 * Split from the claim itself because it changes nothing: the server encodes
 * the schema data (the encoding has to match the deployed schema) and the agent
 * only signs. Keeping it a GET is also what stops one reward claim being billed
 * at the claim tier twice.
 */
export const GET = createAgentRoute({
  routeId: "tasks.claim.intent",
  resolveTemplateId: async ({ params, principal }) =>
    isUuid(params.completionId)
      ? templateIdForCompletion(params.completionId, principal.userId)
      : null,
  handler: async (ctx) => {
    const completionId = ctx.params.completionId;
    if (!isUuid(completionId)) {
      return fail(400, "INVALID_REQUEST", "A valid completionId is required");
    }

    const intent = await buildRewardClaimIntent(ctx.principal, completionId);
    if (!intent.ok) return fail(intent.status, intent.code, intent.message);

    return ok({ intent: intent.intent, data: null });
  },
});
