import { fail } from "@/lib/quests/principal";
import { mutateAgentRunExecution } from "@/lib/quests/daily-quests/services/agent-execution";
import { templateIdForRun } from "../../db/agents";
import { createAgentRoute } from "../../route-factory";

export const POST = createAgentRoute({
  routeId: "executions.write",
  idempotency: false,
  resolveTemplateId: async ({ params }) =>
    params.runId ? templateIdForRun(params.runId) : null,
  handler: async (ctx) => {
    if (!ctx.params.runId) return fail(400, "INVALID_REQUEST", "Missing runId");
    return mutateAgentRunExecution(ctx.principal, ctx.params.runId, ctx.body);
  },
});
