/**
 * @jest-environment node
 */

jest.mock("@/lib/utils/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import {
  BAZAAR,
  validateBazaarRouteExtensions,
  validateDiscoveryExtension,
  validateDiscoveryExtensionSpec,
} from "@x402/extensions/bazaar";

// BAZAAR is the extension descriptor, not the key it registers under.
const BAZAAR_KEY = (BAZAAR as unknown as { key: string }).key;
import { AGENT_ROUTES } from "./pricing";
import { allRouteConfigs, routeConfigFor } from "./x402";

const ORIGINAL_ENV = { ...process.env };

/**
 * Bazaar is how an agent finds these routes at all, and a malformed
 * declaration is not rejected loudly — it simply never lists. The SDK's own
 * validators are the only authority on the shape, so they gate the build
 * rather than a hand-written assertion that can drift from the spec.
 */
describe("Bazaar discovery metadata", () => {
  beforeAll(() => {
    process.env.X402_PAY_TO_ADDRESS =
      "0x0000000000000000000000000000000000000042";
    process.env.AGENT_AUDIENCE_ORIGIN = "https://p2einferno.test";
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("declares every route in a shape the official validator accepts", () => {
    expect(() =>
      validateBazaarRouteExtensions(allRouteConfigs() as never),
    ).not.toThrow();
  });

  it.each(AGENT_ROUTES.map((spec) => [spec.id, spec.method] as const))(
    "%s declares a spec-valid extension that stays valid once served",
    (routeId, method) => {
      const extension = routeConfigFor(routeId).extensions?.[BAZAAR_KEY] as {
        info: { input: Record<string, unknown> };
      };

      expect(extension).toBeDefined();

      // Pre-enrichment: the route config as written here.
      expect(validateDiscoveryExtensionSpec(extension as never)).toEqual({
        valid: true,
      });

      // Post-enrichment: the resource server stamps the method on before the
      // declaration ever reaches a client, and only then is the stricter
      // info-against-schema check meaningful.
      const served = {
        ...extension,
        info: { ...extension.info, input: { ...extension.info.input, method } },
      };
      expect(validateDiscoveryExtension(served as never)).toEqual({
        valid: true,
      });
    },
  );

  // The concrete method is stamped on at 402-enrichment time; what the route
  // must supply is the body contract, without which a discovering agent knows
  // the endpoint exists but not how to call it.
  it("gives every POST route a JSON body contract", () => {
    for (const spec of AGENT_ROUTES) {
      if (spec.method === "GET") continue;

      const info = (
        routeConfigFor(spec.id).extensions?.[BAZAAR_KEY] as {
          info?: { input?: Record<string, unknown> };
        }
      )?.info;

      expect(info?.input).toMatchObject({ type: "http", bodyType: "json" });
      expect(info?.input?.body).toBeDefined();
    }
  });
});
