/**
 * @jest-environment node
 */

import {
  AGENT_ACTIONS,
  actionForTaskType,
  executableTaskTypes,
} from "./registry";

describe("agent action registry", () => {
  it("gives every action a unique name and an explicit version", () => {
    const names = AGENT_ACTIONS.map((a) => a.name);

    expect(new Set(names).size).toBe(names.length);
    for (const action of AGENT_ACTIONS) {
      expect(action.name).toMatch(/^p2e_[a-z0-9_]+$/);
      // A changed input shape must bump this, not redefine the name: the
      // version is hashed into every candidate id and rechecked at execution,
      // so a stored candidate can never replay against different semantics.
      expect(Number.isInteger(action.version)).toBe(true);
      expect(action.version).toBeGreaterThan(0);
    }
  });

  it("claims each task type exactly once", () => {
    const claimed = AGENT_ACTIONS.flatMap((a) => [...a.taskTypes]);

    expect(new Set(claimed).size).toBe(claimed.length);
    expect(executableTaskTypes()).toEqual([...new Set(claimed)].sort());
  });

  it("registers nothing the agent could point anywhere", () => {
    // A generic transfer or arbitrary-call action would undo the safety the
    // typed layer exists to provide.
    for (const action of AGENT_ACTIONS) {
      expect(action.name).not.toMatch(
        /generic|arbitrary|raw_|call_contract|execute_tx|transfer_any/,
      );
    }
    expect(actionForTaskType("arbitrary_call")).toBeUndefined();
    expect(actionForTaskType("unknown_task")).toBeUndefined();
  });

  it("covers the vendor task types the daily quests actually use", () => {
    for (const type of [
      "vendor_buy",
      "vendor_sell",
      "vendor_light_up",
      "vendor_level_up",
      "uniswap_swap",
      "gas_drop",
    ]) {
      expect(actionForTaskType(type)).toBeDefined();
    }
  });

  describe("input parsing", () => {
    it.each([
      ["vendor_buy", {}],
      ["vendor_buy", { required_amount: "0" }],
      ["vendor_buy", { required_amount: "not-a-number" }],
      ["vendor_sell", { required_amount: -5 }],
      ["uniswap_swap", { pair: "DOGE_MOON", direction: "A_TO_B" }],
      ["uniswap_swap", { pair: "ETH_UP", direction: "SIDEWAYS" }],
      ["uniswap_swap", { pair: "ETH_UP", direction: "A_TO_B" }],
    ])("%s refuses %p", (taskType, config) => {
      const parsed = actionForTaskType(taskType)!.parse(config);

      expect(parsed.ok).toBe(false);
    });

    it("accepts a well-formed vendor amount", () => {
      const parsed = actionForTaskType("vendor_buy")!.parse({
        required_amount: "1000",
      });

      expect(parsed).toEqual({ ok: true, input: { amountRaw: "1000" } });
    });

    it("needs no configuration to light up", () => {
      // The burn amount comes from the contract's own stage config, so there
      // is nothing here to get wrong.
      expect(actionForTaskType("vendor_light_up")!.parse({}).ok).toBe(true);
    });
  });
});
