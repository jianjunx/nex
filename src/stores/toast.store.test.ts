import { beforeEach, describe, expect, it } from "vitest";
import { useToastStore } from "./toast.store";

const items = () => useToastStore.getState().items;

describe("toast.store", () => {
  beforeEach(() => {
    useToastStore.setState({ items: [] });
  });

  it("keeps the newest toast on top", () => {
    useToastStore.getState().push({ variant: "info", message: "first" });
    useToastStore.getState().push({ variant: "info", message: "second" });
    expect(items().map((t) => t.message)).toEqual(["second", "first"]);
  });

  it("merges a repeated identical toast instead of stacking", () => {
    useToastStore.getState().push({ variant: "success", message: "推送成功" });
    useToastStore.getState().push({ variant: "success", message: "推送成功" });
    expect(items()).toHaveLength(1);
  });

  it("keeps different variants of the same message apart", () => {
    useToastStore.getState().push({ variant: "error", message: "拉取" });
    useToastStore.getState().push({ variant: "success", message: "拉取" });
    expect(items()).toHaveLength(2);
  });

  it("caps the stack", () => {
    for (let i = 0; i < 8; i++) {
      useToastStore.getState().push({ variant: "info", message: `m${i}` });
    }
    expect(items()).toHaveLength(4);
  });

  it("dismisses by id", () => {
    useToastStore.getState().push({ variant: "info", message: "keep" });
    useToastStore.getState().push({ variant: "info", message: "drop" });
    const id = items()[0]!.id;
    useToastStore.getState().dismiss(id);
    expect(items().map((t) => t.message)).toEqual(["keep"]);
  });
});
