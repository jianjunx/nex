/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let gitState: {
  opRunning: string | null;
  stashes: { index: number; message: string; id: string }[];
  opLog: string[];
  opLogOpen: boolean;
  setOpLogOpen: ReturnType<typeof vi.fn>;
  clearLog: ReturnType<typeof vi.fn>;
  loadStashes: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  pull: ReturnType<typeof vi.fn>;
  push: ReturnType<typeof vi.fn>;
  clone: ReturnType<typeof vi.fn>;
  stashSave: ReturnType<typeof vi.fn>;
  stashApply: ReturnType<typeof vi.fn>;
  stashPop: ReturnType<typeof vi.fn>;
  stashDrop: ReturnType<typeof vi.fn>;
};
vi.mock("../../stores/git.store", () => ({
  useGitStore: (selector?: (s: typeof gitState) => unknown) => (selector ? selector(gitState) : gitState),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setFocus: vi.fn().mockResolvedValue(undefined) }),
}));

import { GitActionsMenu } from "./GitActionsMenu";

beforeEach(() => {
  vi.clearAllMocks();
  gitState = {
    opRunning: null,
    stashes: [],
    opLog: [],
    opLogOpen: false,
    setOpLogOpen: vi.fn(),
    clearLog: vi.fn(),
    loadStashes: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockResolvedValue(undefined),
    pull: vi.fn().mockResolvedValue(true),
    push: vi.fn().mockResolvedValue(true),
    clone: vi.fn().mockResolvedValue(true),
    stashSave: vi.fn().mockResolvedValue(true),
    stashApply: vi.fn().mockResolvedValue(true),
    stashPop: vi.fn().mockResolvedValue(true),
    stashDrop: vi.fn().mockResolvedValue(true),
  };
});
afterEach(() => cleanup());

const openMenu = async () => {
  render(<GitActionsMenu projectPath="/p" onOpenBranchSelector={() => {}} />);
  // radix DropdownMenuTrigger 只以 onPointerDown/onKeyDown 开启，无 onClick 路径
  fireEvent.pointerDown(screen.getByTitle("更多操作"));
  await screen.findByText("拉取");
};

describe("GitActionsMenu", () => {
  it("renders the remote ops, stash submenu and log toggle", async () => {
    await openMenu();
    expect(screen.getByText("推送")).toBeTruthy();
    expect(screen.getByText("获取")).toBeTruthy();
    expect(screen.getByText("克隆…")).toBeTruthy();
    expect(screen.getByText("存储")).toBeTruthy();
    expect(screen.getByText("显示操作日志")).toBeTruthy();
  });

  it("clicking 拉取 calls store.pull with the project path", async () => {
    await openMenu();
    fireEvent.click(screen.getByText("拉取"));
    expect(gitState.pull).toHaveBeenCalledWith("/p");
  });

  it("a running op shows its spinner and disables the other network items", async () => {
    gitState.opRunning = "推送";
    await openMenu();
    const pushItem = screen.getByText("推送").closest("[role=menuitem]")!;
    expect(pushItem.querySelector("svg.animate-spin")).toBeTruthy();
    expect(pushItem.hasAttribute("data-disabled")).toBe(false);
    const fetchItem = screen.getByText("获取").closest("[role=menuitem]")!;
    expect(fetchItem.hasAttribute("data-disabled")).toBe(true);
  });

  it("dropping a stash goes through the confirm dialog", async () => {
    gitState.stashes = [{ index: 0, message: "wip", id: "oid-0" }];
    await openMenu();
    fireEvent.click(screen.getByText("存储"));
    fireEvent.click(await screen.findByTestId("stash-0"));
    fireEvent.click(screen.getByTestId("stash-drop"));
    expect(await screen.findByText(/永久删除存储条目 stash@\{0\}/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(gitState.stashDrop).toHaveBeenCalledWith("/p", "oid-0"));
  });
});
