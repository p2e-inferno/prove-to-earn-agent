jest.mock("../../control/route", () => ({
  createHeadlessControlRoute: jest.fn((options: unknown) => options),
}));

import { ASSESS, GET } from "./quests";

describe("headless economic quest routes", () => {
  it("maps list and assessment to canonical economic route IDs", () => {
    expect(GET).toMatchObject({
      economicRoute: { id: "quests.list" },
      scope: "quests:read",
    });
    expect(ASSESS).toMatchObject({
      economicRoute: { id: "quests.assessment" },
      scope: "quests:read",
    });
    expect(
      (
        ASSESS as unknown as {
          economicRoute: { params: (input: { runId: string }) => unknown };
        }
      ).economicRoute.params({ runId: "run-1" }),
    ).toEqual({ runId: "run-1" });
  });
});
