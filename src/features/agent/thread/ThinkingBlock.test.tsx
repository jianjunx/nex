// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThinkingBlock } from "./ThinkingBlock";
vi.mock("./Markdown", () => ({
  Markdown: ({ children }: { children: string }) => <p>{children}</p>,
}));
afterEach(cleanup);
it("starts compact and exposes reasoning only when expanded", () => {
  render(<ThinkingBlock text="真实思考" />);
  const toggle = screen.getByRole("button", { name: "思考过程" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("真实思考")).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByText("真实思考")).toBeTruthy();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(toggle);
  expect(screen.queryByText("真实思考")).toBeNull();
});
it("does not jump to the bottom while reading earlier reasoning", () => {
  const view = render(<ThinkingBlock defaultOpen text="第一段" />);
  const body = view.container.querySelector(
    ".nex-trace-body",
  ) as HTMLDivElement;
  Object.defineProperties(body, {
    scrollHeight: { value: 1000, configurable: true },
    clientHeight: { value: 240, configurable: true },
  });
  body.scrollTop = 100;
  fireEvent.scroll(body);
  view.rerender(<ThinkingBlock defaultOpen text="第一段和新增内容" />);
  expect(body.scrollTop).toBe(100);
});
