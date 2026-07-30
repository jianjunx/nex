import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@codemirror/search", () => ({ searchPanelOpen: () => true }));

import { isFindBarOpen, registerFindBarAccessor } from "./editorKeybindings";

afterEach(() => registerFindBarAccessor(null));

describe("editor find-bar accessor", () => {
  it("reports closed when no view registered", () => {
    expect(isFindBarOpen()).toBe(false);
  });
  it("delegates to the registered view", () => {
    registerFindBarAccessor(() => ({ state: {} } as never));
    // searchPanelOpen is mocked to always return true; assert the accessor forwards it.
    expect(isFindBarOpen()).toBe(true);
  });
});
