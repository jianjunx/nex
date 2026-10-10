// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Collapse } from "./Collapse";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("omits closed content and shows it when opened", () => {
  const view = render(<Collapse open={false}>正文</Collapse>);
  expect(screen.queryByText("正文")).toBeNull();
  view.rerender(<Collapse open>正文</Collapse>);
  expect(screen.getByText("正文")).toBeTruthy();
  view.rerender(<Collapse open={false}>正文</Collapse>);
  expect(screen.queryByText("正文")).toBeNull();
});

it("holds closing content until the height transition ends", () => {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
    const style = real(el);
    return new Proxy(style, {
      get(target, prop, receiver) {
        if (prop === "transitionDuration") return "200ms";
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  vi.useFakeTimers();
  const view = render(<Collapse open>正文</Collapse>);
  view.rerender(<Collapse open={false}>正文</Collapse>);
  expect(screen.getByText("正文")).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(200);
  });
  expect(screen.queryByText("正文")).toBeNull();
});
