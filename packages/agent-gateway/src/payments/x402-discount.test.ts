/** @jest-environment node */
import {
  canonicalAgentkitResourceUrl,
  verifiedDiscountHook,
  routeConfigFor,
} from "./x402";
import { priceFor } from "./pricing";
const verify = jest.fn();
const recover = jest.fn();
const hook = verifiedDiscountHook({ verify }, recover);
const context = (amount = "50") =>
  ({
    paymentPayload: {
      x402Version: 2,
      accepted: { amount: "100" },
      payload: { authorization: { value: amount } },
    },
    requirements: { amount: "100" },
    error: new Error("invalid_exact_evm_payload_authorization_value_mismatch"),
  }) as unknown as Parameters<typeof hook>[0];
beforeEach(() => {
  jest.clearAllMocks();
  process.env.AGENTKIT_DISCOUNT_PERCENT = "50";
  process.env.AGENTKIT_DISCOUNT_USES = "100";
  process.env.X402_PAY_TO_ADDRESS =
    "0x1111111111111111111111111111111111111111";
});
it("verifies the discounted authorization before invoking SDK recovery", async () => {
  verify.mockResolvedValue({ isValid: true });
  recover.mockResolvedValue({ recovered: true, result: { isValid: true } });
  await expect(hook(context())).resolves.toMatchObject({ recovered: true });
  expect(verify).toHaveBeenCalledWith(
    expect.objectContaining({
      accepted: expect.objectContaining({ amount: "50" }),
    }),
    { amount: "50" },
  );
  expect(verify.mock.invocationCallOrder[0]).toBeLessThan(
    recover.mock.invocationCallOrder[0]!,
  );
});
it("never recovers an invalid payment even when the original failure was an amount mismatch", async () => {
  verify.mockResolvedValue({
    isValid: false,
    invalidReason: "invalid_signature",
  });
  expect(await hook(context())).toBeUndefined();
  expect(recover).not.toHaveBeenCalled();
});
it.each(["0", "49", "100", "invalid"])(
  "does not recover an unsupported payment amount %s",
  async (amount) => {
    expect(await hook(context(amount))).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  },
);
it("propagates facilitator outages instead of granting a discount", async () => {
  verify.mockRejectedValue(new Error("Unavailable"));
  await expect(hook(context())).rejects.toThrow("Unavailable");
  expect(recover).not.toHaveBeenCalled();
});

describe("full-price fallback", () => {
  // The discount is a recovery from a failed verification, so a client that
  // cannot take it must still be quoted the undiscounted price rather than
  // being refused.
  it.each(["quests.detail", "quests.start", "quests.complete"])(
    "quotes %s at its undiscounted tier price",
    (routeId) => {
      const accepts = routeConfigFor(routeId).accepts as Array<{
        price: string;
      }>;
      expect(accepts[0]?.price).toBe(priceFor(routeId));
    },
  );

  it("quotes the same price whether or not a discount is configured", () => {
    const withDiscount = routeConfigFor("quests.start");
    process.env.AGENTKIT_DISCOUNT_PERCENT = "10";
    const withSmallerDiscount = routeConfigFor("quests.start");

    expect(
      (withSmallerDiscount.accepts as Array<{ price: string }>)[0]?.price,
    ).toBe((withDiscount.accepts as Array<{ price: string }>)[0]?.price);
  });

  // AgentKit falls back to `uses ?? Infinity`, and `tonumber("Infinity")` is
  // nil in Lua, which makes the usage script refuse every discount.
  it("declares a finite number of discounted uses", () => {
    const extensions = routeConfigFor("quests.start").extensions as Record<
      string,
      unknown
    >;
    const declared = JSON.stringify(extensions);
    expect(declared).toContain('"percent":50');
    expect(declared).toContain('"uses":100');
    expect(declared).not.toContain("Infinity");
  });

  it("leaves the payment refused when the allowance is spent", async () => {
    verify.mockResolvedValue({ isValid: true });
    // AgentKit's own hook declines once the human's uses are exhausted.
    recover.mockResolvedValue(undefined);

    expect(await hook(context())).toBeUndefined();
    expect(verify).toHaveBeenCalled();
    expect(recover).toHaveBeenCalled();
  });
});

describe("canonical AgentKit origin", () => {
  const originalOrigin = process.env.NEXT_PUBLIC_APP_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = originalOrigin;
    Object.defineProperty(process.env, "NODE_ENV", {
      configurable: true,
      value: originalNodeEnv,
    });
  });

  it.each([
    {
      name: "direct local requests",
      configured: "http://localhost:3000",
      incoming: "http://localhost:3000/api/agent/v1/quests?limit=1",
      expected: "http://localhost:3000/api/agent/v1/quests?limit=1",
    },
    {
      name: "a local public proxy",
      configured: "https://public-tunnel.example",
      incoming: "http://localhost:3000/api/agent/v1/quests?limit=1",
      expected: "https://public-tunnel.example/api/agent/v1/quests?limit=1",
    },
    {
      name: "production",
      configured: "https://app.p2einferno.com",
      incoming: "http://internal-next:3000/api/agent/v1/quests?limit=1",
      expected: "https://app.p2einferno.com/api/agent/v1/quests?limit=1",
    },
  ])(
    "uses the configured origin for $name",
    ({ configured, incoming, expected }) => {
      process.env.NEXT_PUBLIC_APP_URL = configured;

      expect(canonicalAgentkitResourceUrl(incoming)).toBe(expected);
    },
  );
});
