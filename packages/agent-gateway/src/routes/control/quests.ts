import { createHeadlessControlRoute } from "../../control/route";
import { assessHeadlessQuest, listHeadlessQuests } from "../../control/service";

export const GET = createHeadlessControlRoute({
  scope: "quests:read",
  economicRoute: { id: "quests.list" },
  handler: async (_req, _params, context) => listHeadlessQuests(context),
});

export const ASSESS = createHeadlessControlRoute({
  scope: "quests:read",
  economicRoute: {
    id: "quests.assessment",
    params: ({ runId }) => ({ runId: runId! }),
  },
  handler: async (_req, params, context) => {
    if (!params.runId) throw new Error("QUEST_NOT_FOUND");
    return assessHeadlessQuest(context, params.runId);
  },
});
