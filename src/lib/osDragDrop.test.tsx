// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { useOsDragDrop } from "./osDragDrop";

const api = vi.hoisted(() => ({
  scaleFactor: vi.fn(), onDragDropEvent: vi.fn(), listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => api }));
vi.mock("@tauri-apps/api/event", () => ({ listen: api.listen }));

let emit: (event: { payload: DragDropEvent }) => void;
let scaleChanged: (event: { payload: { scaleFactor: number } }) => void;
let unlistenDrop: ReturnType<typeof vi.fn>;
let unlistenScale: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("test");
  unlistenDrop = vi.fn();
  unlistenScale = vi.fn();
  api.scaleFactor.mockResolvedValue(2);
  api.onDragDropEvent.mockImplementation(async (handler) => { emit = handler; return unlistenDrop; });
  api.listen.mockImplementation(async (_name, handler) => { scaleChanged = handler; return unlistenScale; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function mount(platform: string) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const handler = vi.fn();
  const view = renderHook(() => useOsDragDrop(handler));
  await waitFor(() => expect(api.onDragDropEvent).toHaveBeenCalledOnce());
  return { ...view, handler };
}

describe("native drag coordinates", () => {
  it.each(["MacIntel", "Linux x86_64"])("preserves logical drop coordinates on a scaled %s display", async (platform) => {
    const { handler } = await mount(platform);
    for (const type of ["enter", "over", "drop"] as const) {
      const position = new PhysicalPosition(640, 480);
      const payload: DragDropEvent = type === "over"
        ? { type, position }
        : { type, position, paths: ["/external/file.txt", "/external/folder"] };
      act(() => emit({ payload }));
      expect(handler).toHaveBeenLastCalledWith({
        type, x: 640, y: 480,
        paths: type === "over" ? undefined : ["/external/file.txt", "/external/folder"],
      });
    }
    expect(api.scaleFactor).not.toHaveBeenCalled();
    expect(api.listen).not.toHaveBeenCalled();
  });

  it("converts Windows physical pixels and updates after moving between displays", async () => {
    const { handler, unmount } = await mount("Win32");
    act(() => emit({ payload: { type: "drop", paths: ["C:\\file.txt"], position: new PhysicalPosition(1280, 960) } }));
    expect(handler).toHaveBeenLastCalledWith({ type: "drop", paths: ["C:\\file.txt"], x: 640, y: 480 });
    act(() => scaleChanged({ payload: { scaleFactor: 1.25 } }));
    act(() => emit({ payload: { type: "over", position: new PhysicalPosition(800, 600) } }));
    expect(handler).toHaveBeenLastCalledWith({ type: "over", paths: undefined, x: 640, y: 480 });
    unmount();
    expect(unlistenDrop).toHaveBeenCalledOnce();
    expect(unlistenScale).toHaveBeenCalledOnce();
  });

  it("uses the current handler and clears hover on native leave", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const first = vi.fn();
    const next = vi.fn();
    const { rerender } = renderHook(({ handler }) => useOsDragDrop(handler), { initialProps: { handler: first } });
    await waitFor(() => expect(api.onDragDropEvent).toHaveBeenCalledOnce());
    rerender({ handler: next });
    act(() => emit({ payload: { type: "leave" } }));
    expect(first).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith({ type: "leave", x: -1, y: -1 });
  });
});
