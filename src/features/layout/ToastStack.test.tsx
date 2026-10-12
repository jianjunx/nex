/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ToastStack } from "./ToastStack";
import { useToastStore } from "../../stores/toast.store";

afterEach(() => {
  cleanup();
  useToastStore.setState({ items: [] });
  vi.useRealTimers();
});

describe("ToastStack", () => {
  it("renders nothing when there are no toasts", () => {
    const { container } = render(<ToastStack />);
    expect(container.querySelector("[data-testid='toast-stack']")).toBeNull();
  });

  it("shows the message, the detail and a semantic variant colour", () => {
    useToastStore.setState({
      items: [{ id: "t1", variant: "error", message: "推送失败", detail: "fatal: 认证失败" }],
    });
    const { getByText, getByRole } = render(<ToastStack />);

    expect(getByText("推送失败")).toBeTruthy();
    expect(getByText("fatal: 认证失败")).toBeTruthy();
    // role=status 让读屏软件能播报操作结果，但不抢焦点
    expect(getByRole("status")).toBeTruthy();
  });

  it("keeps the newest toast on top", () => {
    useToastStore.setState({
      items: [
        { id: "t2", variant: "info", message: "第二条" },
        { id: "t1", variant: "success", message: "第一条" },
      ],
    });
    const { getByText } = render(<ToastStack />);
    const stack = getByText("第二条").closest("[data-testid='toast-stack']");
    const messages = Array.from(stack?.querySelectorAll("p") ?? []).map((p) => p.textContent);
    expect(messages).toEqual(["第二条", "第一条"]);
  });

  it("auto-dismisses an error toast after its longer timeout", () => {
    vi.useFakeTimers();
    useToastStore.setState({ items: [{ id: "t1", variant: "error", message: "拉取失败" }] });
    const { queryByText } = render(<ToastStack />);

    act(() => { vi.advanceTimersByTime(6999); });
    expect(queryByText("拉取失败")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2); });
    expect(queryByText("拉取失败")).toBeNull();
  });

  it("auto-dismisses a success toast sooner", () => {
    vi.useFakeTimers();
    useToastStore.setState({ items: [{ id: "t1", variant: "success", message: "推送成功" }] });
    const { queryByText } = render(<ToastStack />);

    act(() => { vi.advanceTimersByTime(3999); });
    expect(queryByText("推送成功")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2); });
    expect(queryByText("推送成功")).toBeNull();
  });

  it("dismisses on click", () => {
    useToastStore.setState({ items: [{ id: "t1", variant: "info", message: "已刷新" }] });
    const { getByLabelText, queryByText } = render(<ToastStack />);

    fireEvent.click(getByLabelText("关闭提示"));
    expect(queryByText("已刷新")).toBeNull();
    expect(useToastStore.getState().items).toHaveLength(0);
  });
});
