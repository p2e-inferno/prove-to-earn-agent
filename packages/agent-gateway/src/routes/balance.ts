import { getOwnerBalance } from "@/lib/quests/daily-quests/services/balance";
import { createAgentRoute } from "../route-factory";

export const GET = createAgentRoute({
  routeId: "balance.read",
  handler: async (ctx) => getOwnerBalance(ctx.principal),
});
