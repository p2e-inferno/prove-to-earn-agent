import { createHeadlessControlRoute } from "../../control/route";
import { getHeadlessConfig } from "../../control/service";

export const GET = createHeadlessControlRoute({
  scope: "agent:read",
  handler: async (_req, _params, context) => getHeadlessConfig(context),
});
