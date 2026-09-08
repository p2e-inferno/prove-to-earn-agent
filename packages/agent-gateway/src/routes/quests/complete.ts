import { completeDailyQuest } from "@/lib/quests/daily-quests/services/complete-quest";
import { templateIdForRun } from "../../db/agents";
import { createAgentRoute } from "../../route-factory";
import { fail } from "@/lib/quests/principal";

export const POST = createAgentRoute({
  routeId: "quests.complete",
  resolveTemplateId: async ({ params }) =>
    params.runId ? templateIdForRun(params.runId) : null,
  handler: async (ctx) => {
    const runId = ctx.params.runId;
    if (!runId) return fail(400, "INVALID_REQUEST", "Missing runId");
    return completeDailyQuest(ctx.principal, runId);
  },
});
