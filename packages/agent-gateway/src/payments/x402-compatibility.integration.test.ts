/** @jest-environment node */
import {
  type FacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareAgentkitExtension } from "@worldcoin/agentkit";
import { AGENTKIT } from "@worldcoin/agentkit-core";
import { withX402FromHTTPServer } from "@x402/next";
import { NextRequest, NextResponse } from "next/server";
import {
  agentkitX402ResourceServerExtension,
  verifiedDiscountHook,
} from "./x402";

const NETWORK = "eip155:8453" as const;
const PATH = "/api/agent/v1/quests";
const ORIGIN = "https://gateway.test";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";

function signedAmount(payload: PaymentPayload): string {
  if (payload.x402Version !== 2) throw new Error("Expected x402 v2");
  return String(
    (payload.payload as { authorization: { value: string } }).authorization
      .value,
  );
}

function facilitator(): FacilitatorClient {
  return {
    getSupported: jest.fn(async () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
      extensions: [],
      signers: {},
    })),
    verify: jest.fn(async (payload, requirements) => {
      if (
        payload.x402Version !== 2 ||
        payload.accepted.amount !== requirements.amount ||
        signedAmount(payload) !== requirements.amount
      ) {
        throw new Error("invalid_exact_evm_payload_authorization_value");
      }
      return { isValid: true, payer: PAYER };
    }),
    settle: jest.fn(async (_payload, requirements) => ({
      success: true,
      payer: PAYER,
      transaction: "0xtest",
      network: requirements.network,
    })),
  };
}

function routeConfig() {
  return {
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        payTo: PAY_TO,
        price: {
          amount: "1000",
          asset: ASSET,
          extra: { name: "USD Coin", version: "2" },
        },
      },
    ],
    extensions: declareAgentkitExtension({
      domain: "gateway.test",
      resourceUri: `${ORIGIN}${PATH}`,
      network: NETWORK,
      mode: { type: "discount", percent: 50, uses: 100 },
    }),
  };
}

async function serverWith(recover: Parameters<typeof verifiedDiscountHook>[1]) {
  const client = facilitator();
  const resource = new x402ResourceServer(client);
  resource.register(NETWORK, new ExactEvmScheme());
  resource.registerExtension(agentkitX402ResourceServerExtension);
  resource.onVerifyFailure(verifiedDiscountHook(client, recover));
  const http = new x402HTTPResourceServer(resource, {
    [`GET ${PATH}`]: routeConfig(),
  });
  await http.initialize();
  return { client, http };
}

function requestContext(payment?: PaymentPayload) {
  const headers = new Headers(
    payment
      ? { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment) }
      : undefined,
  );
  return {
    adapter: {
      getHeader: (name: string) => headers.get(name) ?? undefined,
      getMethod: () => "GET",
      getPath: () => PATH,
      getUrl: () => `${ORIGIN}${PATH}`,
      getAcceptHeader: () => "application/json",
      getUserAgent: () => "jest",
    },
    path: PATH,
    method: "GET",
  };
}

function challengeFrom(
  result: Awaited<ReturnType<x402HTTPResourceServer["processHTTPRequest"]>>,
): PaymentRequired {
  if (result.type !== "payment-error") {
    throw new Error("Expected payment challenge");
  }
  return decodePaymentRequiredHeader(
    result.response.headers["PAYMENT-REQUIRED"]!,
  );
}

function payment(
  challenge: PaymentRequired,
  amount: string,
  extensions = challenge.extensions,
): PaymentPayload {
  return {
    x402Version: 2,
    resource: challenge.resource,
    accepted: challenge.accepts[0]!,
    payload: {
      signature: "0xtest",
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"1".repeat(64)}`,
      },
    },
    extensions,
  } as PaymentPayload;
}

describe("real x402 AgentKit compatibility", () => {
  it("ignores only regenerated AgentKit fields and still rejects static changes", async () => {
    const { client, http } = await serverWith(jest.fn());
    const first = challengeFrom(
      await http.processHTTPRequest(requestContext() as never),
    );

    const accepted = await http.processHTTPRequest(
      requestContext(payment(first, "1000")) as never,
    );
    expect(accepted.type).toBe("payment-verified");
    expect(client.verify).toHaveBeenCalledTimes(1);

    const badExtensions = structuredClone(first.extensions!);
    const agentkit = badExtensions[AGENTKIT] as {
      info: { domain: string };
    };
    agentkit.info.domain = "attacker.test";
    const rejected = await http.processHTTPRequest(
      requestContext(payment(first, "1000", badExtensions)) as never,
    );
    expect(rejected.type).toBe("payment-error");
    expect(challengeFrom(rejected).error).toBe("extension_echo_mismatch");
    expect(client.verify).toHaveBeenCalledTimes(1);
  });

  it("accepts a valid World-gated discount with canonical accepted amount", async () => {
    const recover = jest.fn(async (context) => {
      context.requirements.amount = "500";
      return {
        recovered: true as const,
        result: { isValid: true, payer: PAYER },
      };
    });
    const { client, http } = await serverWith(recover as never);
    const challenge = challengeFrom(
      await http.processHTTPRequest(requestContext() as never),
    );
    const discounted = payment(challenge, "500");

    const result = await http.processHTTPRequest(
      requestContext(discounted) as never,
    );

    expect(discounted.x402Version).toBe(2);
    if (discounted.x402Version === 2) {
      expect(discounted.accepted.amount).toBe("1000");
    }
    expect(result.type).toBe("payment-verified");
    expect(recover).toHaveBeenCalledTimes(1);
    expect(client.verify).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        accepted: expect.objectContaining({ amount: "500" }),
      }),
      expect.objectContaining({ amount: "500" }),
    );
  });

  it("rejects underpayment when World discount recovery is unavailable", async () => {
    const recover = jest.fn(async () => undefined);
    const { client, http } = await serverWith(recover as never);
    const challenge = challengeFrom(
      await http.processHTTPRequest(requestContext() as never),
    );

    const result = await http.processHTTPRequest(
      requestContext(payment(challenge, "500")) as never,
    );

    expect(result.type).toBe("payment-error");
    expect(recover).toHaveBeenCalledTimes(1);
    expect(client.verify).toHaveBeenCalledTimes(2);
  });

  it("falls back from unverified World to full price and settles after 2xx", async () => {
    const recover = jest.fn(async () => undefined);
    const { client, http } = await serverWith(recover as never);
    const handler = jest.fn(async () =>
      NextResponse.json({ ok: true, data: { runs: [] } }),
    );
    const route = withX402FromHTTPServer(
      handler,
      http,
      undefined,
      undefined,
      false,
    );
    const send = (payload?: PaymentPayload) =>
      route(
        new NextRequest(`${ORIGIN}${PATH}`, {
          headers: payload
            ? { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) }
            : undefined,
        }),
      );

    const initial = await send();
    const initialChallenge = decodePaymentRequiredHeader(
      initial.headers.get("PAYMENT-REQUIRED")!,
    );
    const discounted = await send(payment(initialChallenge, "500"));
    expect(discounted.status).toBe(402);
    const refreshed = await send();
    const fullChallenge = decodePaymentRequiredHeader(
      refreshed.headers.get("PAYMENT-REQUIRED")!,
    );
    const full = await send(payment(fullChallenge, "1000"));

    expect(full.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(client.settle).toHaveBeenCalledTimes(1);
    expect(client.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amount: "1000" }),
    );
  });
});
