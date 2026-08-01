import { beforeEach, describe, expect, it } from "vitest";
import { useToolCardExpansionStore } from "./toolCardExpansion";

beforeEach(() => {
  useToolCardExpansionStore.setState({ overrides: {} });
});

describe("useToolCardExpansionStore", () => {
  it("setExpanded 写入覆盖值", () => {
    useToolCardExpansionStore.getState().setExpanded("tc1", false);
    expect(useToolCardExpansionStore.getState().overrides["tc1"]).toBe(false);
    useToolCardExpansionStore.getState().setExpanded("tc1", true);
    expect(useToolCardExpansionStore.getState().overrides["tc1"]).toBe(true);
  });

  it("未显式设置的 id 返回 undefined(回退默认规则)", () => {
    expect(useToolCardExpansionStore.getState().overrides["nope"]).toBeUndefined();
  });
});
