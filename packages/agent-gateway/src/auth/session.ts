import { SignJWT, jwtVerify } from "jose";
import type { NextRequest } from "next/server";
import {
  AGENT_SESSION_AUDIENCE,
  AGENT_SESSION_ISSUER,
  AGENT_SESSION_TTL_SECONDS,
  agentSessionSecret,
} from "../env";

export interface AgentSessionClaims {
  agentId: string;
  agentWallet: string;
}

export async function issueAgentSession(
  claims: AgentSessionClaims,
  ttlSeconds: number = AGENT_SESSION_TTL_SECONDS,
): Promise<{ token: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({
    agentId: claims.agentId,
    agentWallet: claims.agentWallet.toLowerCase(),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .setSubject(claims.agentId)
    .setIssuer(AGENT_SESSION_ISSUER)
    .setAudience(AGENT_SESSION_AUDIENCE)
    .sign(agentSessionSecret());

  return { token, expiresIn: ttlSeconds };
}

export async function verifyAgentSession(
  token: string,
): Promise<AgentSessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, agentSessionSecret(), {
      issuer: AGENT_SESSION_ISSUER,
      audience: AGENT_SESSION_AUDIENCE,
    });

    const agentId = payload.agentId;
    const agentWallet = payload.agentWallet;
    if (typeof agentId !== "string" || typeof agentWallet !== "string") {
      return null;
    }
    return { agentId, agentWallet };
  } catch {
    return null;
  }
}

/** Header-only by design: a cookie jar would follow the agent surface into every non-browser client. */
export function getBearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (!value || scheme?.toLowerCase() !== "bearer") return null;
  return value.trim() || null;
}
