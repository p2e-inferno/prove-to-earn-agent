/**
 * @jest-environment node
 */
// jest.setup.ts stubs `jose` globally with a fixed payload; this suite is
// specifically about real signing and verification.
jest.unmock("jose");

import { issueAgentSession, verifyAgentSession } from "./session";

describe("agent session tokens", () => {
  const original = process.env.AGENT_SESSION_JWT_SECRET;

  beforeAll(() => {
    process.env.AGENT_SESSION_JWT_SECRET =
      "test-secret-value-for-agent-session";
  });

  afterAll(() => {
    if (original === undefined) delete process.env.AGENT_SESSION_JWT_SECRET;
    else process.env.AGENT_SESSION_JWT_SECRET = original;
  });

  it("round-trips agent claims", async () => {
    const { token } = await issueAgentSession({
      agentId: "agent-1",
      agentWallet: "0xAbC0000000000000000000000000000000000001",
    });

    const claims = await verifyAgentSession(token);
    expect(claims?.agentId).toBe("agent-1");
    expect(claims?.agentWallet).toBe(
      "0xabc0000000000000000000000000000000000001",
    );
  });

  it("rejects a tampered token", async () => {
    const { token } = await issueAgentSession({
      agentId: "agent-1",
      agentWallet: "0xabc0000000000000000000000000000000000001",
    });
    expect(await verifyAgentSession(`${token}x`)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const { token } = await issueAgentSession(
      {
        agentId: "agent-1",
        agentWallet: "0xabc0000000000000000000000000000000000001",
      },
      -1,
    );
    expect(await verifyAgentSession(token)).toBeNull();
  });
});
