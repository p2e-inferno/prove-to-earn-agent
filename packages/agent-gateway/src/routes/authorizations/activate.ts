import { z } from "zod";
import { activateAuthorization } from "../../auth/headless-authorization";
import {
  createHeadlessOwnerRoute,
  headlessOwnerJson,
} from "../../auth/owner-headless-route";

const activationSchema = z
  .object({
    authorizationId: z.string().uuid(),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(2048),
  })
  .strict();

export const POST = createHeadlessOwnerRoute(
  async (req, params, context) => {
    if (!params.agentId) {
      return headlessOwnerJson({ error: "INVALID_REQUEST" }, 400);
    }
    const parsed = activationSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return headlessOwnerJson({ error: "INVALID_REQUEST" }, 400);
    }
    const result = await activateAuthorization({
      authorizationId: parsed.data.authorizationId,
      signature: parsed.data.signature,
      agentId: params.agentId,
      ownerUserId: context.ownerUserId,
      ownerWallet: context.ownerWallet,
    });
    if (result.outcome !== "active") {
      return headlessOwnerJson({ error: "AUTHORIZATION_CONFLICT" }, 409);
    }
    return headlessOwnerJson({ authorizationId: result.authorization_id, status: "active" });
  },
);
