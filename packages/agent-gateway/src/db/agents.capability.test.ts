import { hasCapability, type AgentPermission } from "./agents";

describe("hasCapability", () => {
  const unscoped: AgentPermission = {
    capability: "quests.start",
    dailyQuestTemplateId: null,
  };
  const scoped: AgentPermission = {
    capability: "quests.start",
    dailyQuestTemplateId: "template-a",
  };

  it("denies when the permission set is empty", () => {
    expect(hasCapability([], "quests.start", "template-a")).toBe(false);
  });

  it("denies a capability that was never granted", () => {
    expect(hasCapability([unscoped], "tasks.claim", "template-a")).toBe(false);
  });

  it("grants an unscoped permission across templates", () => {
    expect(hasCapability([unscoped], "quests.start", "template-b")).toBe(true);
    expect(hasCapability([unscoped], "quests.start", null)).toBe(true);
  });

  it("confines a scoped permission to its own template", () => {
    expect(hasCapability([scoped], "quests.start", "template-a")).toBe(true);
    expect(hasCapability([scoped], "quests.start", "template-b")).toBe(false);
  });

  it("denies a scoped permission when no template is in scope", () => {
    expect(hasCapability([scoped], "quests.start", null)).toBe(false);
  });
});
