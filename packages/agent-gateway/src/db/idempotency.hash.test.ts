import { hashRequest } from "./idempotency";

const base = {
  method: "POST",
  route: "quests.start",
  pathname: "/api/agent/v1/quests/run-1/start",
  body: { note: "a" },
};

describe("hashRequest", () => {
  it("is stable for an identical request", () => {
    expect(hashRequest(base)).toBe(hashRequest({ ...base }));
  });

  it("changes when the body changes, so a reused key is a conflict", () => {
    expect(hashRequest(base)).not.toBe(
      hashRequest({ ...base, body: { note: "b" } }),
    );
  });

  it("changes across routes, so one key cannot span endpoints", () => {
    expect(hashRequest(base)).not.toBe(
      hashRequest({ ...base, route: "quests.complete" }),
    );
  });

  it("changes across path parameters, so one key cannot span two runs", () => {
    expect(hashRequest(base)).not.toBe(
      hashRequest({
        ...base,
        pathname: "/api/agent/v1/quests/run-2/start",
      }),
    );
  });
});
