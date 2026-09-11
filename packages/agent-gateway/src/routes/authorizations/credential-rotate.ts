import { z } from "zod";
import { rotateHeadlessCredential } from "../../auth/headless-authorization";
import {
  createHeadlessOwnerRoute,
  headlessOwnerJson,
} from "../../auth/owner-headless-route";

const rotateSchema = z
  .object({
    challengeId: z.string().uuid(),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(2048),
  })
  .strict();

export const POST = createHeadlessOwnerRoute(
  async (req, params, context) => {
    if (!params.agentId) {
      return headlessOwnerJson({ error: "INVALID_REQUEST" }, 400);
    }
    const parsed = rotateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return headlessOwnerJson({ error: "INVALID_REQUEST" }, 400);
    }
    const credential = await rotateHeadlessCredential({
      agentId: params.agentId,
      ownerUserId: context.ownerUserId,
      ownerWallet: context.ownerWallet,
      challengeId: parsed.data.challengeId,
      signature: parsed.data.signature,
    });
    return headlessOwnerJson({ credential }, 201);
  },
);
