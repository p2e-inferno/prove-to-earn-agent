import { randomUUID } from "crypto";
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
} from "jose";
import type { NextRequest } from "next/server";
import { findAgentById } from "../db/agents";
import { headlessAgentIssuer, headlessAgentResource } from "../env";
import {
  credentialIsActive,
  loadActiveAuthorization,
} from "./headless-authorization";

const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;

type SigningKeys = {
  kid: string;
  privateKey: Awaited<ReturnType<typeof importJWK>>;
  publicKey: Awaited<ReturnType<typeof importJWK>>;
  publicJwk: JWK;
};

let keysPromise: Promise<SigningKeys> | null = null;

function parseJwk(value: string, label: string): JWK {
  const parsed = JSON.parse(value) as JWK;
  if (!parsed || typeof parsed !== "object") throw new Error(`${label} is invalid`);
  return parsed;
}

async function loadSigningKeys(): Promise<SigningKeys> {
  const privateRaw = process.env.HEADLESS_AGENT_JWT_PRIVATE_JWK?.trim();
  const publicRaw = process.env.HEADLESS_AGENT_JWT_PUBLIC_JWK?.trim();
  const configuredKid = process.env.HEADLESS_AGENT_JWT_KID?.trim();
  if (privateRaw && publicRaw && configuredKid) {
    const privateJwk = parseJwk(privateRaw, "HEADLESS_AGENT_JWT_PRIVATE_JWK");
    const publicJwk = parseJwk(publicRaw, "HEADLESS_AGENT_JWT_PUBLIC_JWK");
    if (
      privateJwk.kty !== "OKP" ||
      privateJwk.crv !== "Ed25519" ||
      publicJwk.kty !== "OKP" ||
      publicJwk.crv !== "Ed25519"
    ) {
      throw new Error("Headless JWT keys must be Ed25519 JWKs");
    }
    return {
      kid: configuredKid,
      privateKey: await importJWK(privateJwk, "EdDSA"),
      publicKey: await importJWK(publicJwk, "EdDSA"),
      publicJwk: { ...publicJwk, kid: configuredKid, alg: "EdDSA", use: "sig" },
    };
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Headless JWT signing keys are required in production");
  }
  const generated = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const publicJwk = await exportJWK(generated.publicKey);
  return {
    kid: "dev-ephemeral-v1",
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
    publicJwk: {
      ...publicJwk,
      kid: "dev-ephemeral-v1",
      alg: "EdDSA",
      use: "sig",
    },
  };
}

function signingKeys(): Promise<SigningKeys> {
  return (keysPromise ??= loadSigningKeys());
}

export interface HeadlessAccessClaims {
  agentId: string;
  authorizationId: string;
  credentialId: string;
  clientId: string;
  scopes: string[];
}

export async function issueHeadlessAccessToken(claims: HeadlessAccessClaims) {
  const keys = await signingKeys();
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    agent_id: claims.agentId,
    authorization_id: claims.authorizationId,
    credential_id: claims.credentialId,
    client_id: claims.clientId,
    scope: claims.scopes.join(" "),
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: keys.kid })
    .setIssuer(headlessAgentIssuer())
    .setAudience(headlessAgentResource())
    .setSubject(claims.clientId)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
    .sign(keys.privateKey);
  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

export async function headlessJwks() {
  const keys = await signingKeys();
  return { keys: [keys.publicJwk] };
}

export async function verifyHeadlessAccessToken(
  token: string,
): Promise<HeadlessAccessClaims | null> {
  try {
    const keys = await signingKeys();
    const { payload } = await jwtVerify(token, keys.publicKey, {
      algorithms: ["EdDSA"],
      issuer: headlessAgentIssuer(),
      audience: headlessAgentResource(),
    });
    const agentId = payload.agent_id;
    const authorizationId = payload.authorization_id;
    const credentialId = payload.credential_id;
    const clientId = payload.client_id;
    const scope = payload.scope;
    if (
      typeof agentId !== "string" ||
      typeof authorizationId !== "string" ||
      typeof credentialId !== "string" ||
      typeof clientId !== "string" ||
      typeof scope !== "string"
    ) return null;
    return {
      agentId,
      authorizationId,
      credentialId,
      clientId,
      scopes: scope.split(" ").filter(Boolean),
    };
  } catch {
    return null;
  }
}

function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ?? null;
}

export async function resolveHeadlessActor(req: NextRequest) {
  const token = bearerToken(req);
  if (!token) return null;
  const claims = await verifyHeadlessAccessToken(token);
  if (!claims) return null;
  const [authorization, agent, credentialActive] = await Promise.all([
    loadActiveAuthorization(claims.agentId),
    findAgentById(claims.agentId),
    credentialIsActive(
      claims.credentialId,
      claims.agentId,
      claims.authorizationId,
    ),
  ]);
  if (
    !authorization ||
    authorization.id !== claims.authorizationId ||
    !credentialActive ||
    !agent ||
    agent.status !== "ready" ||
    !agent.agentWallet
  ) return null;
  return { claims, authorization, agent };
}
