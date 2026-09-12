import { AGENTKIT } from "@worldcoin/agentkit-core";

const createHeader = jest.fn(async () => "signed-identity-header");

jest.mock("@worldcoin/agentkit", () => ({
  createAgentkitClient: () => ({ createHeader }),
}));

jest.mock("@x402/evm/exact/client", () => ({
  registerExactEvmScheme: jest.fn(),
}));

const createPaymentPayload = jest.fn();

jest.mock("@x402/core/client", () => ({
  x402Client: class {},
  x402HTTPClient: class {
    getPaymentRequiredResponse(
      _getHeader: (name: string) => string | null,
      body: unknown,
    ) {
      return body;
    }
    createPaymentPayload(paymentRequired: { accepts: { amount: string }[] }) {
      return createPaymentPayload(paymentRequired);
    }
    encodePaymentSignatureHeader(payload: { accepted: { amount: string } }) {
      return { "PAYMENT-SIGNATURE": `signed:${payload.accepted.amount}` };
    }
  },
}));

import { applyDiscount, paidFetch } from "./paid-fetch";
import type { AgentWallet } from "./wallet";

const FULL_PRICE = "1000";

const wallet = {
  address: "0x1111111111111111111111111111111111111111",
  caip2: "eip155:8453",
  provider: "local",
  signMessage: jest.fn(async () => "0xsig"),
  x402Signer: {},
} as unknown as AgentWallet;

function quote(options: { mode?: unknown; amount?: string } = {}) {
  return {
    x402Version: 2,
    resource: { url: "https://gateway.test/api/agent/v1/quests" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0xusdc",
        amount: options.amount ?? FULL_PRICE,
        payTo: "0xpayto",
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
    ...(options.mode
      ? {
          extensions: {
            [AGENTKIT]: {
              info: {
                domain: "gateway.test",
                uri: "u",
                version: "1",
                nonce: "n1",
                issuedAt: "t",
              },
              supportedChains: [{ chainId: "eip155:8453", type: "eip191" }],
              schema: {},
              mode: options.mode,
            },
          },
        }
      : {}),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    headers: { get: () => null },
    clone() {
      return this;
    },
    json: async () => body,
  } as unknown as Response;
}

describe("applyDiscount", () => {
  it("floors with the same BigInt division the server uses", () => {
    // Server: requiredAmount * BigInt(100 - percent) / 100n
    const discounted = applyDiscount(quote({ amount: "1001" }) as never, 30);
    expect(discounted?.accepts[0]?.amount).toBe(String((1001n * 70n) / 100n));
  });

  it("refuses a percentage outside the SDK's own 1-100 bound", () => {
    expect(applyDiscount(quote() as never, 0)).toBeNull();
    expect(applyDiscount(quote() as never, 101)).toBeNull();
  });

  it("refuses a discount that rounds the quote to nothing", () => {
    expect(applyDiscount(quote({ amount: "1" }) as never, 50)).toBeNull();
  });
});

describe("paidFetch discount negotiation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createPaymentPayload.mockImplementation(
      async (required: { accepts: { amount: string }[] }) => ({
        accepted: required.accepts[0],
      }),
    );
  });

  it("pays the discounted amount and sends the identity header in one request", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(402, quote({ mode: { type: "discount", percent: 40 } })),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { ok: true, data: { runs: [] } }),
      );
    global.fetch = fetchMock as never;

    const result = await paidFetch(wallet, "https://gateway.test/x");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const paidHeaders = fetchMock.mock.calls[1]![1].headers;

    // Both headers must ride together: the protected-request hook runs before
    // verification, so a separate probe would spend the nonce for nothing.
    expect(paidHeaders[AGENTKIT]).toBe("signed-identity-header");
    expect(paidHeaders["PAYMENT-SIGNATURE"]).toBe("signed:600");
    expect(result.discounted).toBe(true);
    expect(result.paid).toBe(true);
    expect(result.paidAmountRaw).toBe("600");
    expect(result.savedAmountRaw).toBe(String(BigInt(FULL_PRICE) - 600n));
    expect(result.ok).toBe(true);
  });

  it("signs the challenge exactly once, so the nonce is never replayed", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(402, quote({ mode: { type: "discount", percent: 50 } })),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true })) as never;

    await paidFetch(wallet, "https://gateway.test/x");

    expect(createHeader).toHaveBeenCalledTimes(1);
  });

  it("retries at full price when the discount is refused", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(402, quote({ mode: { type: "discount", percent: 50 } })),
      )
      .mockResolvedValueOnce(jsonResponse(402, { ok: false }))
      .mockResolvedValueOnce(jsonResponse(402, quote()))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    global.fetch = fetchMock as never;

    const result = await paidFetch(wallet, "https://gateway.test/x");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3]![1].headers["PAYMENT-SIGNATURE"]).toBe(
      `signed:${FULL_PRICE}`,
    );
    // The short payment was never settled, so claiming a discount would be a lie.
    expect(result.discounted).toBe(false);
    expect(result.paid).toBe(true);
    expect(result.paidAmountRaw).toBe(FULL_PRICE);
    expect(result.savedAmountRaw).toBeUndefined();
  });

  it("pays full price and reports no discount when World is not offered", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(402, quote()))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    global.fetch = fetchMock as never;

    const result = await paidFetch(wallet, "https://gateway.test/x");

    expect(createHeader).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[1]![1].headers["PAYMENT-SIGNATURE"]).toBe(
      `signed:${FULL_PRICE}`,
    );
    expect(result.discounted).toBe(false);
  });

  it("normalizes a final paid 402 so the worker does not retry an unknown error", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(402, quote()))
      .mockResolvedValueOnce(jsonResponse(402, { ok: false })) as never;

    await expect(
      paidFetch(wallet, "https://gateway.test/x"),
    ).resolves.toMatchObject({
      status: 402,
      ok: false,
      code: "X402_PAYMENT_VALIDATION_FAILED",
      retryable: false,
    });
  });

  it("takes free access from the identity header without paying", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(402, quote({ mode: { type: "free" } })),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    global.fetch = fetchMock as never;

    const result = await paidFetch(wallet, "https://gateway.test/x");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls[1]![1].headers["PAYMENT-SIGNATURE"],
    ).toBeUndefined();
    expect(result.paid).toBe(false);
    expect(result.discounted).toBe(true);
    expect(result.paidAmountRaw).toBeUndefined();
  });

  it("pays full price without a stale header once a free trial is exhausted", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(402, quote({ mode: { type: "free-trial", uses: 1 } })),
      )
      .mockResolvedValueOnce(jsonResponse(402, quote()))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    global.fetch = fetchMock as never;

    const result = await paidFetch(wallet, "https://gateway.test/x");

    // Replaying the spent nonce would be rejected, so it must not be resent.
    expect(fetchMock.mock.calls[2]![1].headers[AGENTKIT]).toBeUndefined();
    expect(result.paid).toBe(true);
    expect(result.discounted).toBe(false);
  });

  it("falls back to full price when the identity signature fails", async () => {
    createHeader.mockRejectedValueOnce(new Error("no World App"));
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(402, quote({ mode: { type: "discount", percent: 50 } })),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    global.fetch = fetchMock as never;

    const result = await paidFetch(wallet, "https://gateway.test/x");

    expect(fetchMock.mock.calls[1]![1].headers["PAYMENT-SIGNATURE"]).toBe(
      `signed:${FULL_PRICE}`,
    );
    expect(result.discounted).toBe(false);
  });

  it("does not pay when the first response is not a 402", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true })) as never;

    const result = await paidFetch(wallet, "https://gateway.test/x");

    expect(createPaymentPayload).not.toHaveBeenCalled();
    expect(result.paid).toBe(false);
  });
});
