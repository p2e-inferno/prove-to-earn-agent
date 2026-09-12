import { rateLimiter } from "./agent-rate-limiter";
const evaluate = jest.fn();
jest.mock("@vendor/upstash-redis", () => ({
  getUpstashRedis: () => ({ eval: evaluate }),
}));
jest.mock("./rate-limiter", () => ({ rateLimiter: { check: jest.fn() } }));
it("uses the same distributed key across requests", async () => {
  evaluate.mockResolvedValueOnce([1, 60000]).mockResolvedValueOnce([2, 59999]);
  expect((await rateLimiter.check("owner", 1, 60000)).success).toBe(true);
  expect((await rateLimiter.check("owner", 1, 60000)).success).toBe(false);
  expect(evaluate.mock.calls[0][1]).toEqual(evaluate.mock.calls[1][1]);
});
it("fails closed when Redis is unavailable", async () => {
  evaluate.mockRejectedValue(new Error("Unavailable"));
  expect((await rateLimiter.check("owner", 20, 60000)).success).toBe(false);
});
