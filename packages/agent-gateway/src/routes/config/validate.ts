import { NextResponse, type NextRequest } from "next/server";
import { validateAgentPlatformConfig } from "../../config-validation";
import { agentOk } from "../../errors";
import { createPairingRoute } from "../../route-factory";

// Admin-only: the report is an infrastructure inventory, so it tells any caller
// which platform dependencies are unconfigured.
export const GET = createPairingRoute({
  guard: "admin-session",
  handler: async (_req: NextRequest): Promise<NextResponse> =>
    agentOk(validateAgentPlatformConfig()),
});
