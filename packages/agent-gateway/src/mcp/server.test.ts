const registerTool = jest.fn();

jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: jest.fn(() => ({ registerTool })),
}));

jest.mock("../control/service", () => ({
  assessHeadlessQuest: jest.fn(),
  cancelHeadlessRun: jest.fn(),
  chooseHeadlessCandidate: jest.fn(),
  getHeadlessConfig: jest.fn(),
  getHeadlessRun: jest.fn(),
  getHeadlessUsage: jest.fn(),
  listHeadlessQuests: jest.fn(),
  resolveHeadlessAdmission: jest.fn(),
  resolveHeadlessRunDecision: jest.fn(),
  startHeadlessRun: jest.fn(),
}));

import { createHeadlessMcpServer } from "./server";

describe("headless MCP tool names", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("publishes the agent run tool names without legacy aliases", () => {
    createHeadlessMcpServer({
      authorization: {} as never,
      agent: {} as never,
      clientId: "client",
      scopes: [],
    });

    const names = registerTool.mock.calls.map(([name]) => name);

    expect(names).toEqual([
      "agent_get_config",
      "quest_list",
      "quest_assess",
      "agent_run_start",
      "agent_run_status",
      "agent_run_choose",
      "agent_run_cancel",
      "agent_get_usage",
    ]);
  });
});
