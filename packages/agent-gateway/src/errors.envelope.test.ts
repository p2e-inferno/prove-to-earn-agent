import { toEnvelope } from "./errors";

describe("toEnvelope", () => {
  it("wraps a success body", () => {
    const { status, envelope } = toEnvelope(200, { success: true });
    expect(status).toBe(200);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ success: true });
  });

  it("normalises handlers that return the code in `code`", () => {
    const { envelope } = toEnvelope(400, {
      error: "This transaction has already been used",
      code: "TX_ALREADY_USED",
    });
    expect(envelope.code).toBe("TX_ALREADY_USED");
    expect(envelope.retryable).toBe(false);
  });

  it("normalises handlers that return the code in `error`", () => {
    const { envelope } = toEnvelope(403, {
      error: "TRIAL_EXHAUSTED",
      message: "All free trial runs have been used.",
    });
    expect(envelope.code).toBe("TRIAL_EXHAUSTED");
    expect(envelope.message).toBe("All free trial runs have been used.");
  });

  it("marks 5xx and known transient codes retryable", () => {
    expect(toEnvelope(503, { error: "RPC_ERROR" }).envelope.retryable).toBe(
      true,
    );
    expect(toEnvelope(500, { error: "BOOM" }).envelope.retryable).toBe(true);
  });

  it("marks a refusal non-retryable so an agent stops instead of looping", () => {
    expect(toEnvelope(403, { code: "AGENT_REVOKED" }).envelope.retryable).toBe(
      false,
    );
  });
});
