import { listDailyQuests } from "@adapters/quests";
import { createAgentRoute } from "../../route-factory";

export const GET = createAgentRoute({
  routeId: "quests.list",
  handler: async (ctx) => {
    // An unscoped 'quests.read' row grants every template; scoped rows confine
    // discovery to those templates so the agent is never shown a run it would
    // be denied on start.
    const scoped = ctx.actor.permissions
      .filter((p) => p.capability === "quests.read")
      .map((p) => p.dailyQuestTemplateId);
    const allowed = scoped.includes(null)
      ? undefined
      : (scoped.filter(Boolean) as string[]);

    return listDailyQuests(ctx.principal, allowed);
  },
});
