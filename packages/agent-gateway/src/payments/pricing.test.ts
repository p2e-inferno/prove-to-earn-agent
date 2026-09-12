import { AGENT_ROUTES, TIER_PRICE, priceFor } from "./pricing";

describe("agent route pricing", () => {
  it("keeps each canonical route on its reviewed tier", () => {
    expect(
      Object.fromEntries(AGENT_ROUTES.map((route) => [route.id, route.tier])),
    ).toEqual({
      "executions.write": "free",
      "reports.write": "free",
      "balance.read": "T1",
      "quests.detail": "T2",
      "quests.assessment": "T3",
      "quests.list": "T3",
      "quests.start": "T3",
      "tasks.claim.intent": "T1",
      "tasks.complete": "T4",
      "tasks.claim": "T4",
      "quests.complete": "T4",
    });
  });

  it("derives every route price from the canonical tier table", () => {
    for (const route of AGENT_ROUTES) {
      expect(priceFor(route.id)).toBe(TIER_PRICE[route.tier]);
    }
  });
});
