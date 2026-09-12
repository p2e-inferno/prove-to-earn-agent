/**
 * @jest-environment node
 */

jest.mock("@vendor/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { NextRequest } from "next/server";
import { AGENT_ROUTES } from "../../payments/pricing";
import { GET } from "./contract";

describe("agent route contract", () => {
  it("publishes descriptions and override semantics for every agent route", async () => {
    const response = await GET(
      new NextRequest("https://p2einferno.test/api/agent/v1/config"),
    );
    // Re-parsed through JSON rather than used directly: NextResponse's Web
    // Response.json() can hand back arrays from a different realm than this
    // test file's, which fails jest's realm-sensitive `expect.any(Array)`
    // even though the values are behaviorally identical (Array.isArray is
    // true either way). This carve-out surfaced it; not a logic change.
    const body = JSON.parse(JSON.stringify(await response.json()));

    expect(response.status).toBe(200);
    expect(body.data.routes).toHaveLength(AGENT_ROUTES.length);
    for (const route of body.data.routes) {
      expect(route).toEqual(
        expect.objectContaining({
          request: expect.any(String),
          response: expect.any(String),
          overrides: expect.any(Array),
        }),
      );
    }
    expect(
      body.data.routes.find(
        (route: { id: string }) => route.id === "quests.assessment",
      ).overrides,
    ).toEqual(["proceed", "cancel"]);
  });
});
