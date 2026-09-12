import { completeDailyTask } from "@adapters/quests";
import { templateIdForRun } from "../../db/agents";
import { createAgentRoute } from "../../route-factory";
import { fail } from "@vendor/quests/principal";

type Body = {
  dailyQuestRunId?: string;
  dailyQuestRunTaskId?: string;
  transactionHash?: string;
};

export const POST = createAgentRoute({
  routeId: "tasks.complete",
  resolveTemplateId: async ({ body }) => {
    const runId = (body as Body | null)?.dailyQuestRunId;
    return runId ? templateIdForRun(runId) : null;
  },
  handler: async (ctx) => {
    const body = (ctx.body ?? {}) as Body;
    if (!body.dailyQuestRunId || !body.dailyQuestRunTaskId) {
      return fail(
        400,
        "INVALID_REQUEST",
        "dailyQuestRunId and dailyQuestRunTaskId are required",
      );
    }
    return completeDailyTask(ctx.principal, {
      dailyQuestRunId: body.dailyQuestRunId,
      dailyQuestRunTaskId: body.dailyQuestRunTaskId,
      transactionHash: body.transactionHash ?? null,
    });
  },
});
