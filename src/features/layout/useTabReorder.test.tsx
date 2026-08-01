/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useTabReorder } from "./useTabReorder";

function Harness({ onReorder }: { onReorder: (from: number, to: number) => void }) {
  const { draggingIndex, bindTab } = useTabReorder(onReorder);
  const items = ["a", "b", "c"];
  return (
    <div>
      {items.map((label, i) => {
        const drag = bindTab(i);
        return (
          <button
            key={label}
            type="button"
            data-testid={`tab-${label}`}
            data-tab-index={drag["data-tab-index"]}
            onPointerDown={drag.onPointerDown}
          >
            {label}
            {draggingIndex === i ? " dragging" : ""}
          </button>
        );
      })}
    </div>
  );
}

afterEach(() => cleanup());

describe("useTabReorder", () => {
  it("reorders after moving past the drag threshold onto another tab", () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    const a = screen.getByTestId("tab-a");
    const c = screen.getByTestId("tab-c");

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => c,
    });

    fireEvent.pointerDown(a, { button: 0, clientX: 10, clientY: 10 });
    // Below threshold — no reorder yet
    fireEvent.pointerMove(window, { clientX: 12, clientY: 10 });
    expect(onReorder).not.toHaveBeenCalled();

    act(() => {
      fireEvent.pointerMove(window, { clientX: 80, clientY: 10 });
    });
    expect(onReorder).toHaveBeenCalledWith(0, 2);

    fireEvent.pointerUp(window);
  });

  it("ignores pointerdowns that start on the close control", () => {
    const onReorder = vi.fn();
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => null,
    });
    function WithClose() {
      const { bindTab } = useTabReorder(onReorder);
      const drag = bindTab(0);
      return (
        <button type="button" data-tab-index={drag["data-tab-index"]} onPointerDown={drag.onPointerDown}>
          a
          <span data-tab-close data-testid="close">×</span>
        </button>
      );
    }
    render(<WithClose />);
    fireEvent.pointerDown(screen.getByTestId("close"), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 100, clientY: 10 });
    expect(onReorder).not.toHaveBeenCalled();
  });
});
