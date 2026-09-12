import { getOwnerBalance } from "@vendor/quests/balance";
import { createAgentRoute } from "../route-factory";

export const GET = createAgentRoute({
  routeId: "balance.read",
  handler: async (ctx) => getOwnerBalance(ctx.principal),
});
