import {
  HTTPFacilitatorClient,
  x402ResourceServer,
  x402HTTPResourceServer,
  type RouteConfig,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { withX402FromHTTPServer } from "@x402/next";
import {
  createAgentkitHooks,
  agentkitResourceServerExtension,
  declareAgentkitExtension,
} from "@worldcoin/agentkit";
import { createAgentBookVerifier } from "@worldcoin/agentkit-core";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { NextRequest, type NextResponse } from "next/server";
import { getLogger } from "@/lib/utils/logger";
import {
  AGENT_NETWORK,
  agentkitDiscountPercent,
  agentkitDiscountUses,
  agentAudienceOrigin,
  x402FacilitatorUrl,
  x402PayToAddress,
  cdpFacilitatorConfigured,
  worldChainRpcUrl,
} from "../env";
import { AGENT_ROUTES, priceFor, routeSpec } from "./pricing";
import { redisAgentKitStorage } from "./agentkit-storage";

const log = getLogger("agent-gateway:payments:x402");

type AgentkitHooks = ReturnType<typeof createAgentkitHooks>;

let cachedServer: x402ResourceServer | null = null;
let cachedHooks: AgentkitHooks | null = null;
const httpServers = new Map<string, x402HTTPResourceServer>();

/**
 * A finite `uses` is required, not cosmetic.
 *
 * AgentKit falls back to `mode.uses ?? Infinity` and passes that straight to
 * the storage limit; `tonumber("Infinity")` is nil in Lua, so the usage script
 * raises and every discount is refused.
 */
function discountMode(): { type: "discount"; percent: number; uses: number } {
  return {
    type: "discount",
    percent: agentkitDiscountPercent(),
    uses: agentkitDiscountUses(),
  };
}

function agentkitHooks(): AgentkitHooks | null {
  if (cachedHooks) return cachedHooks;

  try {
    const rpcUrl = worldChainRpcUrl();
    const agentBook = createAgentBookVerifier(rpcUrl ? { rpcUrl } : undefined);

    cachedHooks = createAgentkitHooks({
      agentBook,
      mode: discountMode(),
      storage: redisAgentKitStorage,
      onEvent: (event) =>
        log.info("agentkit", {
          type: event.type,
          resource: event.resource,
        }),
    });
    return cachedHooks;
  } catch (error) {
    // A misconfigured World integration must not take payment down with it.
    log.error("AgentKit wiring failed; continuing at full price", { error });
    return null;
  }
}

/**
 * CDP's hosted facilitator when credentials are present, otherwise the URL in
 * the environment. The public x402.org facilitator is testnet-oriented and this
 * gateway settles on Base mainnet, so production needs one that can.
 *
 * Built by hand rather than with `createCdpFacilitatorClient`: that entry point
 * eagerly requires `@x402/svm`, whose `@solana/kit` peer conflicts with the
 * version `@privy-io/react-auth` pins. Only the JWT helper is needed, and it
 * carries no Solana dependency.
 */
const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

function buildFacilitator() {
  if (!cdpFacilitatorConfigured()) {
    return new HTTPFacilitatorClient({ url: x402FacilitatorUrl() });
  }

  const url = new URL(CDP_FACILITATOR_URL);
  const apiKeyId = process.env.CDP_API_KEY_ID as string;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET as string;

  // Each JWT is bound to one method, host and path, so every facilitator
  // operation gets its own token.
  const tokenFor = async (method: string, path: string) => {
    const { generateJwt } = await import("@coinbase/cdp-sdk/auth");
    const jwt = await generateJwt({
      apiKeyId,
      apiKeySecret,
      requestMethod: method,
      requestHost: url.host,
      requestPath: path,
    });
    return { Authorization: `Bearer ${jwt}` };
  };

  log.info("Using the CDP hosted x402 facilitator");

  return new HTTPFacilitatorClient({
    url: CDP_FACILITATOR_URL,
    createAuthHeaders: async () => ({
      verify: await tokenFor("POST", `${url.pathname}/verify`),
      settle: await tokenFor("POST", `${url.pathname}/settle`),
      supported: await tokenFor("GET", `${url.pathname}/supported`),
      bazaar: await tokenFor("GET", `${url.pathname}/discovery/resources`),
    }),
  });
}

/**
 * The core resource server, wired once per process.
 *
 * Discount mode deliberately lets verification fail on the reduced amount and
 * recovers it in `onVerifyFailure`, so that hook is mandatory — without it the
 * discount silently never applies.
 */
export function getResourceServer(): x402ResourceServer {
  if (cachedServer) return cachedServer;

  const facilitator = buildFacilitator();
  const server = new x402ResourceServer(facilitator);
  server.register(AGENT_NETWORK, new ExactEvmScheme());

  const hooks = agentkitHooks();
  if (hooks) {
    server.registerExtension(agentkitResourceServerExtension);
    if (hooks.verifyFailureHook) {
      const recover = hooks.verifyFailureHook as unknown as Parameters<
        typeof server.onVerifyFailure
      >[0];
      server.onVerifyFailure(verifiedDiscountHook(facilitator, recover));
    }
  }

  cachedServer = server;
  return server;
}

/**
 * Per-route HTTP resource server.
 *
 * The protected-request hook — the half of AgentKit that grants free/discounted
 * access — only exists on the HTTP server, not on the core resource server, so
 * routes must be mounted through this rather than through the plain
 * `withX402(handler, routes, server)` form.
 */
export function getHttpResourceServer(routeId: string): x402HTTPResourceServer {
  const spec = routeSpec(routeId);
  const routeKey = `${spec.method} ${spec.path}`;

  const cached = httpServers.get(routeId);
  if (cached) return cached;

  const httpServer = new x402HTTPResourceServer(getResourceServer(), {
    [routeKey]: routeConfigFor(routeId),
  });

  const hooks = agentkitHooks();
  if (hooks?.requestHook) {
    httpServer.onProtectedRequest(
      hooks.requestHook as unknown as Parameters<
        typeof httpServer.onProtectedRequest
      >[0],
    );
  }

  httpServers.set(routeId, httpServer);
  return httpServer;
}

export function canonicalRoutePath(
  routeId: string,
  params: Record<string, string> = {},
): string {
  return routeSpec(routeId).path.replace(/\[([^\]]+)\]/g, (_match, name) => {
    const value = params[name];
    if (!value) throw new Error(`Missing canonical route parameter: ${name}`);
    return encodeURIComponent(value);
  });
}

export async function invokeCanonicalEconomicRoute(
  request: NextRequest,
  options: {
    routeId: string;
    params?: Record<string, string>;
    handler: () => Promise<NextResponse>;
  },
): Promise<NextResponse> {
  const spec = routeSpec(options.routeId);
  const url = new URL(request.url);
  url.pathname = canonicalRoutePath(options.routeId, options.params);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const paymentRequest = new NextRequest(url, {
    method: spec.method,
    headers,
  });
  return withX402FromHTTPServer(
    options.handler,
    getHttpResourceServer(options.routeId),
  )(paymentRequest) as Promise<NextResponse>;
}

/**
 * Route pricing plus discovery and identity metadata.
 *
 * Bazaar is what makes a resource discoverable: an agent's
 * `discover_x402_services` reads a facilitator's `/discovery/resources`, not a
 * well-known file on this origin. The agentkit declaration is what tells a
 * client which identity challenge to sign.
 */
export function routeConfigFor(routeId: string): RouteConfig {
  const spec = routeSpec(routeId);

  // Bazaar is the real discovery path: an agent's `discover_x402_services`
  // reads a facilitator's /discovery/resources, not a well-known file here.
  const extensions: Record<string, unknown> = {
    ...declareDiscoveryExtension(
      spec.method === "GET"
        ? { output: { example: { ok: true, data: {} } } }
        : {
            bodyType: "json",
            input: discoveryInputExample(spec.id),
            inputSchema: discoveryInputSchema(spec.id),
            output: { example: { ok: true, data: {} } },
          },
    ),
  };

  Object.assign(
    extensions,
    declareAgentkitExtension({
      domain: new URL(agentAudienceOrigin()).hostname,
      resourceUri: `${agentAudienceOrigin()}${spec.path}`,
      network: AGENT_NETWORK,
      mode: discountMode(),
    }),
  );

  return {
    accepts: [
      {
        scheme: "exact",
        price: priceFor(routeId),
        network: AGENT_NETWORK,
        payTo: x402PayToAddress(),
      },
    ],
    description: spec.description,
    mimeType: "application/json",
    serviceName: "P2E Inferno Agent Gateway",
    tags: ["quests", "base", "uniswap", "p2e-inferno"],
    extensions,
  };
}

/** Example bodies so a discovering agent knows how to call each route. */
function discoveryInputExample(routeId: string): Record<string, unknown> {
  switch (routeId) {
    case "tasks.complete":
      return {
        dailyQuestRunId: "uuid",
        dailyQuestRunTaskId: "uuid",
        transactionHash: "0x…",
      };
    case "tasks.claim":
      return { completionId: "uuid" };
    default:
      return {};
  }
}

function discoveryInputSchema(routeId: string): Record<string, unknown> {
  switch (routeId) {
    case "tasks.complete":
      return {
        properties: {
          dailyQuestRunId: { type: "string" },
          dailyQuestRunTaskId: { type: "string" },
          transactionHash: { type: "string" },
        },
        required: ["dailyQuestRunId", "dailyQuestRunTaskId"],
      };
    case "tasks.claim":
      return {
        properties: {
          completionId: { type: "string" },
          attestationSignature: { type: "object" },
        },
        required: ["completionId"],
      };
    default:
      return { properties: {} };
  }
}

export function allRouteConfigs(): Record<string, RouteConfig> {
  const config: Record<string, RouteConfig> = {};
  for (const spec of AGENT_ROUTES) {
    config[`${spec.method} ${spec.path}`] = routeConfigFor(spec.id);
  }
  return config;
}

type VerifyFailureHook = Parameters<x402ResourceServer["onVerifyFailure"]>[0];

export function verifiedDiscountHook(
  facilitator: Pick<ReturnType<typeof buildFacilitator>, "verify">,
  recover: VerifyFailureHook,
): VerifyFailureHook {
  return async (context) => {
    const payload = context.paymentPayload.payload as {
      authorization?: { value?: unknown };
      permit2Authorization?: { permitted?: { amount?: unknown } };
    };
    const raw =
      payload.authorization?.value ??
      payload.permit2Authorization?.permitted?.amount;
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) return;
    const amount = BigInt(raw);
    const full = BigInt(context.requirements.amount);
    const minimum = (full * BigInt(100 - agentkitDiscountPercent())) / 100n;
    if (amount < minimum || amount >= full) return;
    const verified = await facilitator.verify(
      JSON.parse(JSON.stringify(context.paymentPayload)) as Parameters<
        typeof facilitator.verify
      >[0],
      {
        ...context.requirements,
        amount: raw,
      },
    );
    if (!verified.isValid) return;
    return recover({
      ...context,
      error: new Error("invalid_exact_evm_payload_authorization_value"),
    });
  };
}
